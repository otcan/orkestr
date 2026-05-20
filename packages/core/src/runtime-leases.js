import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { ensureRuntimeAgentsFile } from "./agent-context.js";
import { assertCodexAuthenticated } from "../../connectors/src/codex.js";
import { paneBackgroundWork, publicPaneProgress, samplePaneProgress } from "./pane-progress.js";
import {
  appendThreadMessage,
  getThread,
  listThreadMessages,
  listThreads,
  updateThread,
  updateThreadMessage,
} from "./threads.js";
import { parseThreadInputCommand } from "./thread-commands.js";

const execFileAsync = promisify(execFile);
const deliveryLocks = new Set();
const deliveryTimers = new Map();
let runtimeSyncInFlight = null;
let connectorDeliverySignalCount = 0;
let threadInputDeliveryFailureHandler = null;
const pendingInputStates = new Set(["queued", "pending_delivery", "awaiting_ack"]);
const needInputPhases = new Set(["need_input", "awaiting_input", "question", "request_user_input"]);
const proposedPlanOpenTagPattern = /^\s*<\s*proposed[\s_-]*plan\s*>/i;
const deliveryRetryDefaultsMs = [1000, 3000, 8000, 20_000, 60_000];
const defaultRuntimeIdleSleepMs = 15 * 60 * 1000;
const defaultRolloutSyncLookbackBytes = 2 * 1024 * 1024;
const whatsappSources = new Set(["whatsapp", "whatsapp_inbound", "whatsapp_client"]);

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isoAfter(ms) {
  return new Date(Date.now() + Math.max(0, ms)).toISOString();
}

function whatsappOrigin(message = {}) {
  return String(message.connector || "").trim().toLowerCase() === "whatsapp" ||
    whatsappSources.has(String(message.source || "").trim().toLowerCase());
}

function markConnectorDeliverySignal(message = {}) {
  if (whatsappOrigin(message)) connectorDeliverySignalCount += 1;
}

export function consumeThreadConnectorDeliverySignalCount() {
  const count = connectorDeliverySignalCount;
  connectorDeliverySignalCount = 0;
  return count;
}

export function setThreadInputDeliveryFailureHandler(handler) {
  threadInputDeliveryFailureHandler = typeof handler === "function" ? handler : null;
  return () => {
    if (threadInputDeliveryFailureHandler === handler) threadInputDeliveryFailureHandler = null;
  };
}

function notifyThreadInputDeliveryFailure({ thread, message, reason, observedVia, env = process.env }) {
  if (!threadInputDeliveryFailureHandler || !thread || !message) return;
  if (!whatsappOrigin(message) && !String(message.chatId || "").trim()) return;
  Promise.resolve(threadInputDeliveryFailureHandler({
    threadId: thread.id,
    messageId: message.id,
    reason,
    observedVia,
    connector: message.connector || "",
    chatId: message.chatId || "",
    accountId: message.accountId || "",
    env,
  })).catch(() => {});
}

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function timestampMs(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function messageCursor(value) {
  const parsed = Number(value?.cursor || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function messageTimeMs(value) {
  return Math.max(timestampMs(value?.createdAt), timestampMs(value?.timestamp));
}

function runtimeIdleSleepMs(env = process.env) {
  const raw = String(env.ORKESTR_RUNTIME_IDLE_SLEEP_MS ?? "").trim().toLowerCase();
  if (["0", "off", "false", "disabled"].includes(raw)) return 0;
  return positiveNumber(raw) || defaultRuntimeIdleSleepMs;
}

function rolloutSyncLookbackBytes(env = process.env) {
  const raw = String(env.ORKESTR_ROLLOUT_SYNC_LOOKBACK_BYTES ?? "").trim().toLowerCase();
  if (["0", "off", "false", "disabled"].includes(raw)) return 0;
  return Math.floor(positiveNumber(raw) || defaultRolloutSyncLookbackBytes);
}

function safeName(value) {
  return String(value || "default").replace(/[^a-zA-Z0-9_.-]/g, "_") || "default";
}

function codexThreadId(thread) {
  return String(thread?.executor?.codexThreadId || thread?.codexThreadId || "").trim();
}

function threadName(thread) {
  return String(thread?.bindingName || thread?.binding?.displayName || thread?.name || thread?.title || thread?.id || "").trim();
}

function compactLabel(value) {
  return String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tmuxWindowName(thread) {
  const label = compactLabel(threadName(thread) || "Orkestr");
  return Array.from(label).slice(0, 48).join("") || "Orkestr";
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function tomlBasicString(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function runtimeHome(env = process.env) {
  return String(env.HOME || process.env.HOME || os.homedir() || "").trim();
}

function defaultCodexHome(env = process.env) {
  return path.join(runtimeHome(env), ".codex");
}

function codexHomes(env = process.env) {
  return [...new Set([env.CODEX_HOME, process.env.CODEX_HOME, defaultCodexHome(env)].filter(Boolean).map((home) => path.resolve(home)))];
}

async function ensureCodexWorkspaceTrusted(workspace, env = process.env) {
  if (String(env.ORKESTR_CODEX_AUTO_TRUST_WORKSPACE || "1").trim() === "0") return;
  const codexHome = env.CODEX_HOME || process.env.CODEX_HOME || defaultCodexHome(env);
  const configPath = path.join(codexHome, "config.toml");
  const normalized = path.resolve(String(workspace || ""));
  if (!normalized) return;
  const sectionHeader = `[projects."${tomlBasicString(normalized)}"]`;
  const existing = await fs.readFile(configPath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  if (existing.includes(sectionHeader)) return;
  const suffix = existing.endsWith("\n") || !existing ? "" : "\n";
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${existing}${suffix}\n${sectionHeader}\ntrust_level = "trusted"\n`, "utf8");
}

function eventId({ threadId = "", timestamp = "", role = "", phase = "", text = "" }) {
  return crypto
    .createHash("sha256")
    .update(`${threadId}\n${timestamp}\n${role}\n${phase}\n${String(text || "").replace(/\s+/g, " ").trim()}`)
    .digest("hex");
}

function normalizedTextKey(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function hasProposedPlanEnvelope(value) {
  return proposedPlanOpenTagPattern.test(String(value || ""));
}

function rolloutMessageEventKey(message) {
  return [
    message.eventId || "",
    message.role,
    String(message.phase || ""),
    normalizedTextKey(message.text),
  ].join("\n");
}

function rolloutMessageTimestampBucket(message) {
  const ms = timestampMs(message.timestamp || message.createdAt);
  return ms > 0 ? Math.floor(ms / 5000) : "";
}

function rolloutMessageNearTextKey(message) {
  return [
    message.role,
    String(message.phase || ""),
    normalizedTextKey(message.text),
    rolloutMessageTimestampBucket(message),
  ].join("\n");
}

async function runtimeLeasesPath(env) {
  const paths = await ensureDataDirs(env);
  return paths.runtimeLeases;
}

async function saveRuntimeLeases(leases, env = process.env) {
  await writeJson(await runtimeLeasesPath(env), leases);
  return leases;
}

export async function listRuntimeLeases(env = process.env) {
  return readJson(await runtimeLeasesPath(env), []);
}

async function tmuxHasSession(sessionName) {
  try {
    await execFileAsync("tmux", ["has-session", "-t", sessionName]);
    return true;
  } catch {
    return false;
  }
}

async function tmuxPaneId(sessionName) {
  return (await tmuxPaneIds(sessionName))[0] || null;
}

async function tmuxPaneIds(sessionName) {
  const target = String(sessionName || "").trim();
  if (!target) return [];
  const { stdout } = await execFileAsync("tmux", ["list-panes", "-t", target, "-F", "#{pane_id}"]);
  return String(stdout || "").trim().split("\n").map((line) => line.trim()).filter(Boolean);
}

async function renameTmuxWindow(sessionName, windowName) {
  const target = String(sessionName || "").trim();
  const name = compactLabel(windowName);
  if (!target || !name) return;
  await execFileAsync("tmux", ["set-window-option", "-t", target, "automatic-rename", "off"]).catch(() => {});
  await execFileAsync("tmux", ["set-window-option", "-t", target, "allow-rename", "off"]).catch(() => {});
  await execFileAsync("tmux", ["rename-window", "-t", target, name]);
}

async function saveLeaseWindowName(leaseId, windowName, env = process.env) {
  if (!leaseId) return;
  const leases = await listRuntimeLeases(env);
  let changed = false;
  const next = leases.map((lease) => {
    if (lease.id !== leaseId || lease.windowName === windowName) return lease;
    changed = true;
    return { ...lease, windowName };
  });
  if (changed) await saveRuntimeLeases(next, env);
}

async function saveLeasePaneId(leaseId, paneId, env = process.env) {
  if (!leaseId || !paneId) return;
  const leases = await listRuntimeLeases(env);
  let changed = false;
  const next = leases.map((lease) => {
    if (lease.id !== leaseId || lease.paneId === paneId) return lease;
    changed = true;
    return { ...lease, paneId };
  });
  if (changed) await saveRuntimeLeases(next, env);
}

async function resolveLivePaneId(lease, env = process.env) {
  const panes = await tmuxPaneIds(lease?.sessionName).catch(() => []);
  const storedPaneId = String(lease?.paneId || "").trim();
  const paneId = storedPaneId && panes.includes(storedPaneId) ? storedPaneId : panes[0] || null;
  if (paneId && paneId !== storedPaneId) await saveLeasePaneId(lease?.id, paneId, env).catch(() => {});
  return paneId;
}

async function refreshTmuxWindowName(thread, lease, env = process.env) {
  const windowName = tmuxWindowName(thread);
  if (!lease?.sessionName) return windowName;
  try {
    await renameTmuxWindow(lease.sessionName, windowName);
  } catch {
    // Naming is best-effort and should not make a thread unattachable.
  }
  await saveLeaseWindowName(lease.id, windowName, env).catch(() => {});
  return windowName;
}

export async function syncRuntimeWindowName(threadId, env = process.env) {
  const thread = await getThread(threadId, env);
  if (!thread) {
    const error = new Error("thread_not_found");
    error.statusCode = 404;
    throw error;
  }
  const lease = await activeLeaseForThread(thread.id, env);
  if (!lease) return null;
  const windowName = await refreshTmuxWindowName(thread, lease, env);
  return { sessionName: lease.sessionName, windowName };
}

async function capturePane(paneId, lines = 80) {
  if (!paneId) return "";
  const { stdout } = await execFileAsync("tmux", ["capture-pane", "-t", paneId, "-p", "-S", `-${Math.max(20, lines)}`]);
  return String(stdout || "");
}

function paneWorkingLine(line) {
  return (
    /^[•◦]\s*(?:Working|Thinking|Running|Processing)\b/i.test(line) ||
    /^Codex is still preparing (?:a )?response\b/i.test(line) ||
    /^(?:Waiting for background terminal|Working|Thinking|Running|Processing)\b.*\b(?:esc|ctrl-c) to interrupt\b/i.test(line)
  );
}

function panePromptLine(line) {
  return /^(?:›|>)(?:\s|$)/.test(line) && !/^(?:›|>)\s*\d+[.)]/.test(line);
}

function paneWorking(text) {
  const lines = String(text || "").split("\n").map((line) => line.trim()).filter(Boolean).slice(-20);
  if (paneNeedInputMenuVisible(text)) return true;
  const lastWorkingIndex = lines.findLastIndex(paneWorkingLine);
  if (lastWorkingIndex < 0) return false;
  const lastPromptIndex = lines.findLastIndex(panePromptLine);
  return lastWorkingIndex > lastPromptIndex;
}

function panePromptReady(text) {
  const lines = String(text || "").split("\n").map((line) => line.trim()).filter(Boolean).slice(-8);
  return lines.some(panePromptLine);
}

function recentPaneText(text, lines = 16) {
  return String(text || "")
    .split("\n")
    .slice(-Math.max(1, lines))
    .join("\n");
}

function paneNeedInputMenuVisible(text) {
  const body = String(text || "");
  return /^Question\s+\d+\/\d+\s+\(\d+\s+unanswered\)/im.test(body) &&
    /^\s*(?:›\s*)?\d+\.\s+\S+/im.test(body) &&
    /\benter to submit answer\b/i.test(body);
}

function panePlanImplementationMenuVisible(text) {
  return /Implement this plan\?/i.test(recentPaneText(text));
}

function panePlanImplementationSelectedChoice(text) {
  const match = recentPaneText(text).match(/^\s*›\s*([123])\.\s+/im);
  return match?.[1] || null;
}

function panePlanImplementationReady(text) {
  const body = recentPaneText(text);
  return panePlanImplementationMenuVisible(body) && panePlanImplementationSelectedChoice(body) === "1";
}

function isPlanImplementationIntent(text) {
  const body = String(text || "").trim();
  if (!body || body.length > 80) return false;
  return /^(?:yes[,]?\s*)?(?:please\s+)?implement(?:\s+(?:this|the)(?:\s+plan)?)?(?:\s+please)?[.!?]?$/i.test(body);
}

function planImplementationChoiceForInput(text) {
  const raw = String(text || "").trim();
  const body = raw.toLowerCase();
  if (!body || body.length > 120) return null;
  if (body === "1" || body === "/implement" || isPlanImplementationIntent(raw)) return "1";
  if (
    body === "2" ||
    /^(?:yes[,]?\s*)?(?:clear|reset|fresh|new)\b.*\b(?:context|thread)\b.*\bimplement\b/i.test(raw) ||
    /^(?:implement|code)\b.*\b(?:clear|reset|fresh|new)\b.*\b(?:context|thread)\b/i.test(raw)
  ) return "2";
  if (
    body === "3" ||
    body === "/plan" ||
    /^(?:no|nope|cancel|stop|stay|keep planning|do not implement|don't implement|not now)\b/i.test(raw)
  ) return "3";
  return null;
}

function planImplementationChoiceObservedVia(choice) {
  if (choice === "1") return "codex_plan_implementation_confirmed";
  if (choice === "2") return "codex_plan_implementation_clear_context_confirmed";
  if (choice === "3") return "codex_plan_implementation_choice_stay_plan";
  return "codex_plan_implementation_choice";
}

function paneResumeDirectoryPrompt(text) {
  const body = String(text || "");
  return /Choose working directory to resume this session/i.test(body) && /Press enter to continue/i.test(body);
}

function paneCodexUpdatePromptChoice(text) {
  const lines = String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-12);
  const pressIndex = lines.findIndex((line) => /Press enter to continue/i.test(line));
  if (pressIndex < 0 || pressIndex !== lines.length - 1) return null;
  const updateIndex = lines.findIndex((line) => /Update available!/i.test(line));
  if (updateIndex < 0 || pressIndex - updateIndex > 8) return null;
  const skipUntilLine = lines
    .slice(updateIndex, pressIndex)
    .find((line) => /(?:^|[\s›>])\d+\.\s*Skip until next version\b/i.test(line));
  const skipMatch = skipUntilLine?.match(/(?:^|[\s›>])(\d+)\.\s*Skip until next version\b/i);
  if (skipMatch?.[1]) return skipMatch[1];
  const skipLine = lines
    .slice(updateIndex, pressIndex)
    .find((line) => /(?:^|[\s›>])\d+\.\s*Skip\b/i.test(line));
  const fallbackMatch = skipLine?.match(/(?:^|[\s›>])(\d+)\.\s*Skip\b/i);
  return fallbackMatch?.[1] || null;
}

function paneCodexUpdatePrompt(text) {
  return Boolean(paneCodexUpdatePromptChoice(text));
}

async function activeLeaseForThread(threadId, env = process.env) {
  const leases = await listRuntimeLeases(env);
  const active = [...leases].reverse().find((lease) => lease.threadId === threadId && !lease.endedAt) || null;
  if (!active) return null;
  if (await tmuxHasSession(active.sessionName)) return active;
  const ended = leases.map((lease) => lease.id === active.id ? { ...lease, endedAt: nowIso(), endReason: "tmux_session_missing" } : lease);
  await saveRuntimeLeases(ended, env);
  await updateThread(threadId, {
    state: "sleeping",
    activeRuntimeLeaseId: null,
    runtime: { ...(active || {}), state: "sleeping", endedAt: nowIso(), endReason: "tmux_session_missing" },
  }, env).catch(() => {});
  return null;
}

/**
 * @param {string} threadId
 * @param {any} [env]
 * @param {any[] | null} [messagesOverride]
 */
export async function runtimeStatus(threadId, env = process.env, messagesOverride = null) {
  const thread = await getThread(threadId, env);
  if (!thread) {
    const error = new Error("thread_not_found");
    error.statusCode = 404;
    throw error;
  }
  const messages = Array.isArray(messagesOverride) ? messagesOverride : await listThreadMessages(thread.id, env);
  const pendingCount = messages.filter((message) => pendingInputStates.has(message.state)).length;
  const awaitingAckCount = messages.filter((message) => message.state === "awaiting_ack").length;
  const nextDeliveryAttemptAt = messages
    .filter((message) => message.role === "user" && message.state === "awaiting_ack" && message.deliveryNextAttemptAt)
    .map((message) => String(message.deliveryNextAttemptAt))
    .sort()[0] || null;
  const runningCount = messages.filter((message) => message.state === "running").length;
  const lease = await activeLeaseForThread(thread.id, env);
  if (!lease) {
    const state = pendingCount > 0 ? "waking" : "sleeping";
    return {
      state,
      status: state,
      runtimeState: "none",
      lease: null,
      sessionName: null,
      paneId: null,
      promptReady: false,
      promptReadyStable: false,
      working: false,
      foregroundWorking: false,
      typingActive: false,
      backgroundWork: false,
      pendingCount,
      awaitingAckCount,
      nextDeliveryAttemptAt,
      runningCount,
      wakePolicy: thread.wakePolicy || "wake-on-message",
      hibernated: state === "sleeping",
      codexMode: null,
      codexModeSource: null,
      planImplementationReady: false,
      planImplementationMenuVisible: false,
      planImplementationSelectedChoice: null,
      progress: null,
    };
  }

  const paneId = await resolveLivePaneId(lease, env);
  const progressSample = await samplePaneProgress({
    threadId: thread.id,
    leaseId: lease.id,
    sessionName: lease.sessionName,
    paneId,
    pendingCount,
    runningCount,
    awaitingAckCount,
  }, env).catch(() => null);
  const paneText = String(progressSample?.paneText || "");
  const codexMode = codexModeFromPaneText(paneText);
  const planImplementationReady = panePlanImplementationReady(paneText);
  const planImplementationMenuVisible = panePlanImplementationMenuVisible(paneText);
  const planImplementationSelectedChoice = planImplementationMenuVisible ? panePlanImplementationSelectedChoice(paneText) : null;
  const needsResumeDirectoryConfirmation = paneResumeDirectoryPrompt(paneText);
  const codexUpdatePromptChoice = paneCodexUpdatePromptChoice(paneText);
  const needsCodexUpdatePromptSkip = Boolean(codexUpdatePromptChoice);
  const backgroundWork = paneBackgroundWork(paneText) || progressSample?.backgroundWork === true;
  const foregroundWorking = paneWorking(paneText) && !backgroundWork;
  const promptReadyCandidate = panePromptReady(paneText);
  const working = foregroundWorking || backgroundWork || (!promptReadyCandidate && runningCount > 0);
  const promptReady = promptReadyCandidate && !foregroundWorking && !needsResumeDirectoryConfirmation && !needsCodexUpdatePromptSkip;
  const recentlyStarted = Date.now() - (Date.parse(lease.startedAt || "") || Date.now()) < 20_000;
  const state = working
    ? "working"
    : needsResumeDirectoryConfirmation || needsCodexUpdatePromptSkip
      ? "waking"
      : promptReady
        ? "ready"
        : recentlyStarted || pendingCount > 0 ? "waking" : "ready";
  return {
    state,
    status: state,
    runtimeState: "live",
    lease: { ...lease, paneId, windowName: lease.windowName || tmuxWindowName(thread) },
    sessionName: lease.sessionName,
    paneId,
    windowName: lease.windowName || tmuxWindowName(thread),
    promptReady,
    promptReadyStable: promptReady,
    needsResumeDirectoryConfirmation,
    needsCodexUpdatePromptSkip,
    codexUpdatePromptChoice,
    working,
    foregroundWorking,
    typingActive: foregroundWorking,
    backgroundWork,
    pendingCount,
    awaitingAckCount,
    nextDeliveryAttemptAt,
    runningCount,
    wakePolicy: thread.wakePolicy || "wake-on-message",
    hibernated: false,
    codexMode,
    codexModeSource: codexMode ? "runtime-pane" : null,
    planImplementationReady,
    planImplementationMenuVisible,
    planImplementationSelectedChoice,
    progress: publicPaneProgress(progressSample),
  };
}

async function resolveCodexRolloutPath(threadId) {
  const id = String(threadId || "").trim();
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  for (const home of codexHomes()) {
    const dbPath = path.join(home, "state_5.sqlite");
    try {
      const { stdout } = await execFileAsync("sqlite3", ["-readonly", dbPath, `select rollout_path from threads where id='${id.replaceAll("'", "''")}' limit 1;`]);
      const rolloutPath = String(stdout || "").trim();
      if (rolloutPath) return rolloutPath;
    } catch {
      // Ignore missing sqlite or stale homes.
    }
  }
  return null;
}

function sqlString(value) {
  return String(value || "").replaceAll("'", "''");
}

function recordValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function numberValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function tokenCountMetadata(payload) {
  const info = recordValue(payload?.info);
  const rateLimits = recordValue(payload?.rate_limits);
  const totalUsage = recordValue(info?.total_token_usage);
  const latestUsage = recordValue(info?.last_token_usage);
  const usage = latestUsage || totalUsage;
  const contextWindow = numberValue(info?.model_context_window);
  const metadata = {};
  if (usage) metadata.codexTokenUsage = usage;
  if (totalUsage && totalUsage !== usage) metadata.codexTotalTokenUsage = totalUsage;
  if (contextWindow && contextWindow > 0) metadata.codexContextWindow = contextWindow;
  if (rateLimits) metadata.codexRateLimits = rateLimits;
  return metadata;
}

async function resolveCodexRolloutMetadata(rolloutPath) {
  const filePath = String(rolloutPath || "").trim();
  if (!filePath) return {};
  const stats = await fs.stat(filePath).catch(() => null);
  if (!stats?.isFile() || Number(stats.size || 0) <= 0) return {};
  const tailBytes = 1024 * 1024;
  const start = Math.max(0, Number(stats.size) - tailBytes);
  const length = Number(stats.size) - start;
  const handle = await fs.open(filePath, "r").catch(() => null);
  if (!handle) return {};
  let body = "";
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    body = buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close().catch(() => {});
  }
  const lines = body.split("\n");
  if (start > 0) lines.shift();
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed?.type !== "event_msg" || parsed.payload?.type !== "token_count") continue;
    const metadata = tokenCountMetadata(parsed.payload);
    if (Object.keys(metadata).length) return metadata;
  }
  return {};
}

async function resolveCodexThreadMetadataById(id, env = process.env) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return {};
  for (const home of codexHomes(env)) {
    const dbPath = path.join(home, "state_5.sqlite");
    try {
      const query = [
        "select model, reasoning_effort, model_provider, tokens_used, rollout_path",
        "from threads",
        `where id='${sqlString(id)}'`,
        "limit 1;",
      ].join(" ");
      const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-separator", "\t", dbPath, query]);
      const [model, reasoningEffort, modelProvider, tokensUsed, rolloutPath] = String(stdout || "").trim().split("\t");
      const normalizedRolloutPath = rolloutPath && path.isAbsolute(rolloutPath) ? rolloutPath : rolloutPath ? path.resolve(home, rolloutPath) : "";
      const metadata = { codexThreadId: id };
      if (model) metadata.codexModel = model;
      if (reasoningEffort) metadata.codexReasoningEffort = reasoningEffort;
      if (modelProvider) metadata.codexModelProvider = modelProvider;
      const parsedTokens = Number(tokensUsed || 0);
      if (Number.isFinite(parsedTokens) && parsedTokens > 0) metadata.codexTokenUsage = { total_tokens: parsedTokens };
      if (normalizedRolloutPath) metadata.codexRolloutPath = normalizedRolloutPath;
      return { ...metadata, ...(await resolveCodexRolloutMetadata(normalizedRolloutPath)) };
    } catch {
      // Ignore missing sqlite, stale homes, or older Codex schemas.
    }
  }
  return {};
}

export async function resolveCodexThreadMetadata(threadOrId, env = process.env) {
  const thread = threadOrId && typeof threadOrId === "object" ? threadOrId : null;
  const threadId = typeof threadOrId === "string" ? threadOrId : codexThreadId(threadOrId);
  const id = String(threadId || "").trim();
  const metadata = await resolveCodexThreadMetadataById(id, env);
  if (Object.keys(metadata).length) return metadata;
  if (!thread) return {};
  const workspace = thread.workspace || thread.cwd || thread.worktreePath || thread.repoPath || thread.runtime?.workspace;
  const startedAt = thread.runtime?.startedAt || thread.startedAt || thread.updatedAt || thread.createdAt;
  const discovered = await resolveCodexThreadByWorkspace(workspace, startedAt, env);
  if (!discovered?.codexThreadId) return {};
  return resolveCodexThreadMetadataById(discovered.codexThreadId, env);
}

async function resolveCodexThreadByWorkspace(workspace, startedAt, env = process.env) {
  const cwd = String(workspace || "").trim();
  if (!cwd) return null;
  const startedMs = Date.parse(startedAt || "") || 0;
  const minCreatedMs = Math.max(0, startedMs - 60_000);
  for (const home of codexHomes(env)) {
    const dbPath = path.join(home, "state_5.sqlite");
    try {
      const query = [
        "select id, rollout_path",
        "from threads",
        `where archived=0 and cwd='${sqlString(cwd)}' and coalesce(created_at_ms, created_at * 1000) >= ${minCreatedMs}`,
        "order by coalesce(created_at_ms, created_at * 1000) desc, id desc",
        "limit 1;",
      ].join(" ");
      const { stdout } = await execFileAsync("sqlite3", ["-readonly", "-separator", "\t", dbPath, query]);
      const [id, rolloutPath] = String(stdout || "").trim().split("\t");
      if (id && rolloutPath) return { codexThreadId: id, rolloutPath };
    } catch {
      // Ignore missing sqlite, stale homes, or races before Codex has written the thread row.
    }
  }
  return null;
}

async function rolloutOffsetForThread(thread, env = process.env) {
  const rolloutPath = await resolveCodexRolloutPath(codexThreadId(thread));
  if (!rolloutPath) return { rolloutPath: null, rolloutOffset: 0 };
  const stats = await fs.stat(rolloutPath).catch(() => null);
  const size = Number(stats?.size || 0) || 0;
  const lookbackBytes = rolloutSyncLookbackBytes(env);
  return {
    rolloutPath,
    rolloutOffset: Math.max(0, size - lookbackBytes),
    rolloutOffsetLookbackApplied: lookbackBytes > 0,
    rolloutOffsetLookbackBytes: lookbackBytes,
  };
}

function runtimeWorkspace(thread, env) {
  const paths = dataPaths(env);
  const explicit = thread.cwd || thread.workspace || thread.executor?.metadata?.cwd || "";
  const root = env.ORKESTR_RUNTIME_WORKSPACE_ROOT || paths.workspaces;
  if (!explicit) return path.resolve(path.join(root, safeName(thread.id)));
  return path.resolve(path.isAbsolute(explicit) ? explicit : path.join(root, explicit));
}

function runtimeCommand(thread, workspace = "", env = process.env) {
  const base = String(env.ORKESTR_RUNTIME_CODEX_COMMAND || "codex --dangerously-bypass-approvals-and-sandbox").trim();
  const threadId = codexThreadId(thread);
  const workspaceArg = String(workspace || "").trim() ? ` -C ${shellQuote(workspace)}` : "";
  return threadId ? `${base} resume${workspaceArg} ${shellQuote(threadId)}` : base;
}

function codexModeSetting(value) {
  const mode = String(value || "").trim().toLowerCase();
  return mode === "code" || mode === "plan" ? mode : "";
}

function desiredCodexModeForWake(thread) {
  return codexModeSetting(thread?.desiredCodexMode) || codexModeSetting(thread?.codexMode);
}

function codexModePersistencePatch(mode, source, result = {}) {
  const desired = codexModeSetting(mode);
  if (!desired) return {};
  return {
    codexMode: desired,
    codexModeSource: source,
    codexModeUpdatedAt: nowIso(),
    desiredCodexMode: null,
    desiredCodexModeUpdatedAt: null,
    codexModeLiveApplied: true,
    codexModeLiveChanged: Boolean(result.changed),
    codexModeApplyReason: result.reason || null,
  };
}

function commandUsesCodex(command) {
  return /(^|[/"'\s])codex(["'\s]|$)/.test(String(command || ""));
}

async function ensureRuntimeCodexAuthenticated(command, env = process.env) {
  if (!commandUsesCodex(command)) return;
  const home = runtimeHome(env);
  await assertCodexAuthenticated({
    env: {
      ...process.env,
      ...env,
      HOME: home,
      CODEX_HOME: env.CODEX_HOME || process.env.CODEX_HOME || defaultCodexHome(env),
    },
    home,
  });
}

export async function wakeThread(threadId, options = {}, env = process.env) {
  const thread = await getThread(threadId, env);
  if (!thread) {
    const error = new Error("thread_not_found");
    error.statusCode = 404;
    throw error;
  }
  const existing = await activeLeaseForThread(thread.id, env);
  if (existing) {
    const windowName = await refreshTmuxWindowName(thread, existing, env);
    return {
      thread,
      lease: { ...existing, windowName },
      reused: true,
      status: await runtimeStatus(thread.id, env),
    };
  }

  const paths = await ensureDataDirs(env);
  const desiredMode = desiredCodexModeForWake(thread);
  const desiredModeUpdatedAt = desiredMode ? nowIso() : null;
  const sessionName = `orkestr-${safeName(thread.id).slice(0, 48)}`;
  const workspace = runtimeWorkspace(thread, env);
  await fs.mkdir(workspace, { recursive: true });
  await ensureRuntimeAgentsFile(workspace, env).catch(() => {});
  await ensureCodexWorkspaceTrusted(workspace, env);
  const command = runtimeCommand(thread, workspace, env);
  await ensureRuntimeCodexAuthenticated(command, env);
  await updateThread(thread.id, {
    state: "waking",
    wakePolicy: thread.wakePolicy || "wake-on-message",
    ...(desiredMode
      ? {
        desiredCodexMode: desiredMode,
        desiredCodexModeUpdatedAt: desiredModeUpdatedAt,
      }
      : {}),
    runtime: { state: "waking", sessionName, workspace, reason: options.reason || "wake" },
  }, env);

  if (await tmuxHasSession(sessionName)) {
    await execFileAsync("tmux", ["kill-session", "-t", sessionName]).catch(() => {});
  }
  await execFileAsync("tmux", ["new-session", "-d", "-s", sessionName, "-c", workspace, command], {
    env: {
      ...process.env,
      ...env,
      HOME: runtimeHome(env),
      CODEX_HOME: env.CODEX_HOME || process.env.CODEX_HOME || defaultCodexHome(env),
    },
  });
  const windowName = tmuxWindowName(thread);
  await renameTmuxWindow(sessionName, windowName).catch(() => {});
  const paneId = await tmuxPaneId(sessionName).catch(() => null);
  const {
    rolloutPath,
    rolloutOffset,
    rolloutOffsetLookbackApplied,
    rolloutOffsetLookbackBytes,
  } = await rolloutOffsetForThread(thread, env);
  const lease = {
    id: crypto.randomUUID(),
    threadId: thread.id,
    threadName: threadName(thread),
    sessionName,
    paneId,
    windowName,
    workspace,
    repoPath: thread.repoPath || thread.executor?.metadata?.repoPath || null,
    branchName: thread.branchName || thread.executor?.metadata?.branchName || null,
    baseBranch: thread.baseBranch || thread.executor?.metadata?.baseBranch || null,
    baseCommit: thread.baseCommit || thread.executor?.metadata?.baseCommit || null,
    worktreePath: thread.worktreePath || thread.executor?.metadata?.worktreePath || null,
    command,
    resourceClass: "light",
    reason: String(options.reason || "wake"),
    startedAt: nowIso(),
    heartbeatAt: nowIso(),
    rolloutPath,
    rolloutOffset,
    rolloutOffsetLookbackApplied,
    rolloutOffsetLookbackBytes,
  };
  const leases = await listRuntimeLeases(env);
  leases.push(lease);
  await saveRuntimeLeases(leases, env);
  const updatedThread = await updateThread(thread.id, {
    state: "ready",
    wakePolicy: thread.wakePolicy || "wake-on-message",
    activeRuntimeLeaseId: lease.id,
    ...(desiredMode
      ? {
        desiredCodexMode: desiredMode,
        desiredCodexModeUpdatedAt: desiredModeUpdatedAt,
      }
      : {}),
    runtime: {
      state: "ready",
      leaseId: lease.id,
      sessionName,
      paneId,
      windowName,
      workspace,
      repoPath: lease.repoPath,
      branchName: lease.branchName,
      worktreePath: lease.worktreePath,
      startedAt: lease.startedAt,
    },
    executor: { ...(thread.executor || {}), sessionName, tmuxTarget: paneId },
  }, env);
  await appendEvent({ type: "runtime_woken", threadId: thread.id, leaseId: lease.id, sessionName, paneId, windowName, reason: lease.reason }, env);
  return { thread: updatedThread, lease, reused: false, status: await runtimeStatus(thread.id, env), dataHome: paths.home };
}

export async function sleepThread(threadId, options = {}, env = process.env) {
  const thread = await getThread(threadId, env);
  if (!thread) {
    const error = new Error("thread_not_found");
    error.statusCode = 404;
    throw error;
  }
  const leases = await listRuntimeLeases(env);
  const now = nowIso();
  const active = leases.filter((lease) => lease.threadId === thread.id && !lease.endedAt);
  for (const lease of active) {
    if (options.kill !== false) {
      await execFileAsync("tmux", ["kill-session", "-t", lease.sessionName]).catch(() => {});
    }
  }
  await saveRuntimeLeases(leases.map((lease) => active.some((item) => item.id === lease.id)
    ? { ...lease, endedAt: now, endReason: options.reason || "sleep" }
    : lease), env);
  const reason = options.reason || "sleep";
  const updated = await updateThread(thread.id, {
    state: "sleeping",
    activeRuntimeLeaseId: null,
    runtime: { state: "sleeping", endedAt: now, reason },
  }, env);
  await appendEvent({ type: "runtime_slept", threadId: thread.id, reason, killed: options.kill !== false }, env);
  const notice = options.kill !== false && active.length
    ? await appendRuntimeInterruptionNotice(updated, { reason, sourceMessage: options.sourceMessage || null }, env).catch(() => null)
    : null;
  return { thread: updated, slept: active.length, notice };
}

async function appendRuntimeInterruptionNotice(thread, options = {}, env = process.env) {
  const messages = await listThreadMessages(thread.id, env).catch(() => []);
  const explicitParent = options.sourceMessage && whatsappOrigin(options.sourceMessage) ? options.sourceMessage : null;
  const whatsappParent = explicitParent || latestWhatsAppInput(messages);
  const reason = String(options.reason || "interrupt").trim() || "interrupt";
  const notice = await appendThreadMessage(thread.id, {
    role: "assistant",
    source: "orkestr_runtime",
    phase: "runtime_interrupted",
    text: runtimeInterruptionNoticeText(reason),
    state: "completed",
    parentMessageId: whatsappParent?.id || null,
    connector: whatsappParent ? "whatsapp" : "",
    chatId: whatsappParent?.chatId || "",
    accountId: whatsappParent?.accountId || "",
  }, env);
  markConnectorDeliverySignal(notice);
  await appendEvent({
    type: "thread_runtime_interruption_notice",
    threadId: thread.id,
    messageId: notice.id,
    parentMessageId: whatsappParent?.id || null,
    chatId: whatsappParent?.chatId || null,
    reason,
  }, env).catch(() => {});
  return notice;
}

export async function resetThreadRuntime(threadId, options = {}, env = process.env) {
  const reason = options.reason || "reset";
  const slept = await sleepThread(threadId, { reason, kill: options.kill !== false }, env);
  const woken = await wakeThread(threadId, { reason: options.wakeReason || reason }, env);
  await appendEvent({
    type: "thread_runtime_reset",
    threadId: woken.thread?.id || threadId,
    reason,
    slept: slept.slept,
    leaseId: woken.lease?.id || null,
  }, env).catch(() => {});
  return {
    ok: true,
    reset: true,
    slept: slept.slept,
    thread: woken.thread,
    lease: woken.lease || null,
    status: woken.status || null,
  };
}

function compactReadyTimeoutMs(env = process.env) {
  const parsed = Number(env.ORKESTR_COMPACT_READY_TIMEOUT_MS ?? 60_000);
  return Number.isFinite(parsed) ? Math.max(1_000, parsed) : 60_000;
}

function checkpointMessageText(message) {
  const role = String(message?.role || "unknown").trim();
  const phase = String(message?.phase || "").trim();
  const stamp = String(message?.timestamp || message?.createdAt || "").trim();
  const text = String(message?.text || "").trim();
  const header = [role, phase, stamp].filter(Boolean).join(" ");
  return [`### ${header || "message"}`, "", text || "(empty)"].join("\n");
}

async function writeManualContextCheckpoint(threadId, context = {}, env = process.env) {
  const thread = await getThread(threadId, env);
  if (!thread) {
    const error = new Error("thread_not_found");
    error.statusCode = 404;
    throw error;
  }
  const paths = await ensureDataDirs(env);
  const messages = await listThreadMessages(thread.id, env).catch(() => []);
  const status = context.status || await runtimeStatus(thread.id, env).catch(() => null);
  const now = nowIso();
  const safeStamp = now.replace(/[:.]/g, "-");
  const dir = path.join(paths.home, "context-checkpoints", thread.id);
  const checkpointPath = path.join(dir, `${safeStamp}-hard-reset.md`);
  const recentMessages = messages.slice(-40);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const content = [
    `# Manual Context Checkpoint: ${thread.name || thread.id}`,
    "",
    `Created: ${now}`,
    `Thread: ${thread.id}`,
    `Codex thread: ${thread.codexThreadId || thread.executor?.metadata?.codexThreadId || ""}`,
    `Reason: ${context.reason || "hard_reset"}`,
    `Runtime state: ${status?.state || "unknown"}`,
    `Prompt ready: ${status?.promptReady === true}`,
    `Working: ${status?.working === true || status?.foregroundWorking === true}`,
    "",
    "## Recent Messages",
    "",
    ...recentMessages.map(checkpointMessageText),
    "",
  ].join("\n");
  await fs.writeFile(checkpointPath, content, { mode: 0o600 });
  await appendEvent({
    type: "thread_manual_context_checkpoint",
    threadId: thread.id,
    path: checkpointPath,
    messageCount: recentMessages.length,
    reason: context.reason || "hard_reset",
  }, env).catch(() => {});
  return {
    method: "manual_checkpoint",
    path: checkpointPath,
    messageCount: recentMessages.length,
  };
}

async function compactCodexRuntimeContext(threadId, env = process.env) {
  const status = await runtimeStatus(threadId, env).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
  if (!status?.paneId) {
    return {
      method: "codex_compact",
      attempted: false,
      compacted: false,
      reason: status?.error || "runtime_unavailable",
      status,
    };
  }
  if (!status.promptReady || status.working || status.foregroundWorking) {
    return {
      method: "codex_compact",
      attempted: false,
      compacted: false,
      reason: "runtime_not_ready",
      status,
    };
  }
  await pasteTmuxText(status.paneId, "/compact", env);
  await execFileAsync("tmux", ["send-keys", "-t", status.paneId, "C-m"]);
  const compactedAt = nowIso();
  const readyStatus = await waitForRuntimeReady(threadId, {
    ...env,
    ORKESTR_WAKE_READY_TIMEOUT_MS: String(compactReadyTimeoutMs(env)),
  }).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
  const paneText = await capturePane(status.paneId, 80).catch(() => "");
  if (paneRejectedSlashCommand(paneText, "/compact")) {
    return {
      method: "codex_compact",
      attempted: true,
      compacted: false,
      reason: "compact_command_rejected",
      paneId: status.paneId,
      status: readyStatus,
    };
  }
  if (readyStatus?.error) {
    return {
      method: "codex_compact",
      attempted: true,
      compacted: false,
      reason: readyStatus.error,
      paneId: status.paneId,
      status: readyStatus,
    };
  }
  await appendEvent({
    type: "thread_context_compacted",
    threadId,
    paneId: status.paneId,
    method: "codex_compact",
    compactedAt,
  }, env).catch(() => {});
  return {
    method: "codex_compact",
    attempted: true,
    compacted: true,
    paneId: status.paneId,
    compactedAt,
    status: readyStatus,
  };
}

export async function hardResetThreadRuntime(threadId, options = {}, env = process.env) {
  const reason = options.reason || "hard_reset";
  const compaction = await compactCodexRuntimeContext(threadId, env).catch((error) => ({
    method: "codex_compact",
    attempted: true,
    compacted: false,
    reason: error instanceof Error ? error.message : String(error),
  }));
  const manualCheckpoint = compaction.compacted
    ? null
    : await writeManualContextCheckpoint(threadId, { reason, status: compaction.status || null }, env);
  const reset = await resetThreadRuntime(threadId, { reason, wakeReason: options.wakeReason || reason, kill: true }, env);
  await appendEvent({
    type: "thread_runtime_hard_reset",
    threadId: reset.thread?.id || threadId,
    reason,
    compacted: compaction.compacted === true,
    compactionMethod: compaction.compacted ? compaction.method : manualCheckpoint?.method || compaction.method,
    manualCheckpointPath: manualCheckpoint?.path || null,
    slept: reset.slept,
    leaseId: reset.lease?.id || null,
  }, env).catch(() => {});
  return {
    ok: true,
    hardReset: true,
    reset: true,
    compaction,
    manualCheckpoint,
    slept: reset.slept,
    thread: reset.thread,
    lease: reset.lease || null,
    status: reset.status || null,
  };
}

async function completeStopCommand(thread, message, env = process.env) {
  const stopped = await sleepThread(thread.id, { reason: whatsappOrigin(message) ? "whatsapp_stop_command" : "stop_command", kill: true }, env);
  const updated = await updateThreadMessage(thread.id, message.id, {
    state: "completed",
    deliveryState: "delivered",
    observedVia: "orkestr_stop_command",
    deliveredAt: nowIso(),
    error: null,
  }, env);
  await appendEvent({
    type: "thread_stop_command",
    threadId: thread.id,
    messageId: message.id,
    source: message.source || null,
    slept: stopped.slept,
  }, env).catch(() => {});
  return updated.id;
}

async function completeResetCommand(thread, message, hard = false, env = process.env) {
  const result = hard
    ? await hardResetThreadRuntime(thread.id, { reason: whatsappOrigin(message) ? "whatsapp_hard_reset_command" : "hard_reset_command" }, env)
    : await resetThreadRuntime(thread.id, { reason: whatsappOrigin(message) ? "whatsapp_reset_command" : "reset_command" }, env);
  const updated = await updateThreadMessage(thread.id, message.id, {
    state: "completed",
    deliveryState: "delivered",
    observedVia: hard ? "orkestr_hard_reset_command" : "orkestr_reset_command",
    deliveredAt: nowIso(),
    error: null,
    resetSlept: result.slept,
    compactionMethod: result.compaction?.compacted
      ? result.compaction?.method
      : result.manualCheckpoint?.method || result.compaction?.method || null,
    manualCheckpointPath: result.manualCheckpoint?.path || null,
  }, env);
  await appendEvent({
    type: hard ? "thread_hard_reset_command" : "thread_reset_command",
    threadId: thread.id,
    messageId: message.id,
    source: message.source || null,
    slept: result.slept,
    compacted: hard ? result.compaction?.compacted === true : null,
    manualCheckpointPath: result.manualCheckpoint?.path || null,
  }, env).catch(() => {});
  return updated.id;
}

async function completeCodexModeCommand(thread, message, mode, env = process.env) {
  const result = await applyRuntimeCodexMode(thread.id, mode, env);
  const applied = result.applied === true;
  if (applied) {
    await updateThread(thread.id, codexModePersistencePatch(mode, "orkestr-command", result), env).catch(() => {});
  }
  const updated = await updateThreadMessage(thread.id, message.id, {
    state: applied ? "completed" : "failed",
    deliveryState: applied ? "delivered" : "failed",
    observedVia: applied ? "orkestr_codex_mode_command" : "orkestr_codex_mode_not_applied",
    deliveredAt: applied ? nowIso() : "",
    error: applied ? null : result.reason || "Codex mode could not be applied.",
  }, env);
  await appendEvent({
    type: "thread_codex_mode_command",
    threadId: thread.id,
    messageId: message.id,
    source: message.source || null,
    mode,
    applied,
    reason: result.reason || null,
  }, env).catch(() => {});
  return updated.id;
}

async function reapplyDesiredCodexMode(thread, status, env = process.env) {
  const desired = codexModeSetting(thread?.desiredCodexMode);
  if (!desired || !status?.paneId) return null;
  if (!status.promptReady || status.working || status.foregroundWorking || status.backgroundWork || status.typingActive) return null;
  if (status.planImplementationMenuVisible || status.needsResumeDirectoryConfirmation || status.needsCodexUpdatePromptSkip) return null;
  const liveMode = codexModeSetting(status.codexMode);
  if (!liveMode) return null;
  if (liveMode === desired) {
    await updateThread(thread.id, codexModePersistencePatch(desired, "orkestr-wake-restore", { changed: false }), env).catch(() => {});
    await appendEvent({
      type: "thread_codex_mode_restored",
      threadId: thread.id,
      mode: desired,
      changed: false,
      observedVia: "runtime_mode_already_matched",
    }, env).catch(() => {});
    return { applied: true, changed: false, mode: desired, previousMode: liveMode };
  }
  const result = await applyRuntimeCodexMode(thread.id, desired, env, { requirePromptReady: true }).catch((error) => ({
    applied: false,
    changed: false,
    mode: desired,
    previousMode: liveMode,
    reason: error instanceof Error ? error.message : String(error),
  }));
  if (result.applied) {
    await updateThread(thread.id, codexModePersistencePatch(desired, "orkestr-wake-restore", result), env).catch(() => {});
  }
  await appendEvent({
    type: "thread_codex_mode_restore_attempt",
    threadId: thread.id,
    mode: desired,
    previousMode: liveMode,
    applied: Boolean(result.applied),
    changed: Boolean(result.changed),
    reason: result.reason || null,
  }, env).catch(() => {});
  return result;
}

function immediateThreadCommand(message) {
  if (!message || message.role !== "user") return null;
  if (!["queued", "pending_delivery"].includes(String(message.state || ""))) return null;
  const parsed = parseThreadInputCommand({ text: message.text });
  if (parsed.command === "stop" || parsed.command === "reset" || parsed.command === "hard_reset") return parsed;
  if ((parsed.command === "plan" || parsed.command === "code") && !parsed.text) return parsed;
  return null;
}

async function completeImmediateThreadCommand(thread, message, parsed, env = process.env) {
  if (parsed.command === "stop") return completeStopCommand(thread, message, env);
  if (parsed.command === "reset") return completeResetCommand(thread, message, false, env);
  if (parsed.command === "hard_reset") return completeResetCommand(thread, message, true, env);
  if (parsed.command === "plan" || parsed.command === "code") {
    return completeCodexModeCommand(thread, message, parsed.command, env);
  }
  return null;
}

async function supersedeAwaitingAcksForControlCommand(thread, messages, controlMessage, parsed, env = process.env) {
  if (!["stop", "reset", "hard_reset"].includes(parsed?.command)) return;
  const controlCursor = messageCursor(controlMessage);
  const controlMs = messageTimeMs(controlMessage);
  const commandLabel = parsed.rawCommand ? `/${parsed.rawCommand}` : `/${parsed.command}`;
  const errorText = `Superseded by ${commandLabel}.`;
  for (const message of messages) {
    if (message?.id === controlMessage.id || message?.role !== "user" || message?.state !== "awaiting_ack") continue;
    const candidateCursor = messageCursor(message);
    if (controlCursor && candidateCursor && candidateCursor > controlCursor) continue;
    const candidateMs = messageTimeMs(message);
    if (!controlCursor && controlMs && candidateMs && candidateMs > controlMs) continue;
    await updateThreadMessage(thread.id, message.id, {
      state: "failed",
      deliveryState: "superseded",
      deliveryFailedAt: nowIso(),
      observedVia: "thread_control_command_superseded_ack",
      error: errorText,
    }, env);
    await appendEvent({
      type: "thread_input_superseded_by_control_command",
      threadId: thread.id,
      messageId: message.id,
      controlMessageId: controlMessage.id,
      command: parsed.command,
      rawCommand: parsed.rawCommand || parsed.command,
    }, env).catch(() => {});
  }
}

function latestMessageActivityMs(messages = []) {
  return messages.reduce((latest, message) => Math.max(
    latest,
    timestampMs(message?.createdAt),
    timestampMs(message?.timestamp),
    timestampMs(message?.deliveredAt),
  ), 0);
}

function hasPendingNeedInput(messages = []) {
  let latestNeedInputMs = 0;
  let latestUserMs = 0;
  for (const message of messages) {
    const messageMs = Math.max(timestampMs(message?.createdAt), timestampMs(message?.timestamp));
    if (String(message?.role || "").toLowerCase() === "user") {
      latestUserMs = Math.max(latestUserMs, messageMs);
      continue;
    }
    const phase = String(message?.phase || "").trim().toLowerCase();
    if (String(message?.role || "").toLowerCase() === "assistant" && needInputPhases.has(phase) && String(message?.text || "").trim()) {
      latestNeedInputMs = Math.max(latestNeedInputMs, messageMs);
    }
  }
  return latestNeedInputMs > latestUserMs;
}

function isNeedInputMessage(message) {
  const role = String(message?.role || "").trim().toLowerCase();
  const phase = String(message?.phase || "").trim().toLowerCase();
  return role === "assistant" && needInputPhases.has(phase) && String(message?.text || "").trim();
}

function latestNeedInputBeforeMessage(messages = [], messageId = "") {
  const index = messages.findIndex((message) => message.id === messageId);
  if (index <= 0) return null;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const message = messages[cursor];
    if (isNeedInputMessage(message)) return message;
    if (String(message?.role || "").trim().toLowerCase() === "user") return null;
  }
  return null;
}

function runtimeActivityMs(lease, messages = []) {
  return Math.max(
    latestMessageActivityMs(messages),
    timestampMs(lease?.startedAt),
  );
}

function adoptedRuntimeLease(lease = {}) {
  return String(lease.id || "").startsWith("adopt-") || String(lease.reason || "").includes("adopt_existing");
}

function idleSleepDecision({ lease, messages = [], status }, env = process.env) {
  const idleSleepMs = runtimeIdleSleepMs(env);
  if (!idleSleepMs || !lease || !status) return null;
  if (adoptedRuntimeLease(lease)) return null;
  if (status.state !== "ready" || status.promptReady !== true || status.promptReadyStable !== true) return null;
  if (status.working || status.foregroundWorking || status.backgroundWork || status.typingActive) return null;
  if (Number(status.pendingCount || 0) > 0 || Number(status.runningCount || 0) > 0 || Number(status.awaitingAckCount || 0) > 0) return null;
  if (status.nextDeliveryAttemptAt) return null;
  if (hasPendingNeedInput(messages)) return null;

  const lastActivityMs = runtimeActivityMs(lease, messages);
  if (!lastActivityMs) return null;
  const idleMs = Date.now() - lastActivityMs;
  if (idleMs < idleSleepMs) return null;
  return {
    reason: "idle_auto_sleep",
    idleMs,
    idleSleepMs,
    lastActivityAt: new Date(lastActivityMs).toISOString(),
  };
}

async function waitForRuntimeReady(threadId, env = process.env) {
  const timeoutMs = Number(env.ORKESTR_WAKE_READY_TIMEOUT_MS || 60_000);
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await runtimeStatus(threadId, env);
    if (last.needsResumeDirectoryConfirmation && last.paneId) {
      await execFileAsync("tmux", ["send-keys", "-t", last.paneId, "2", "C-m"]).catch(() => {});
      await sleep(1000);
      continue;
    }
    if (last.needsCodexUpdatePromptSkip && last.paneId) {
      await execFileAsync("tmux", ["send-keys", "-t", last.paneId, last.codexUpdatePromptChoice || "2", "C-m"]).catch(() => {});
      await sleep(1000);
      continue;
    }
    if (last.promptReady && !last.working && last.paneId) return last;
    await sleep(500);
  }
  const error = new Error("runtime_not_ready");
  error.statusCode = 504;
  error.status = last;
  throw error;
}

function codexStatusLineFromPaneText(text) {
  const lines = String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-12);
  return [...lines].reverse().find((line) => (
    /\bgpt-[a-z0-9_.-]+/i.test(line) &&
    /\b(?:low|medium|high|xhigh)\b/i.test(line)
  )) || "";
}

function codexModeFromPaneText(text) {
  const statusLine = codexStatusLineFromPaneText(text);
  if (!statusLine) return null;
  if (/\bPlan mode\b/i.test(statusLine)) return "plan";
  if (/\bgpt-[a-z0-9_.-]+/i.test(statusLine)) return "code";
  return null;
}

function planImplementationDismissWaitMs(env = process.env) {
  const parsed = Number(env.ORKESTR_PLAN_IMPLEMENTATION_DISMISS_WAIT_MS ?? 250);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 250;
}

function planImplementationDismissReadyTimeoutMs(env = process.env) {
  const parsed = Number(env.ORKESTR_PLAN_IMPLEMENTATION_DISMISS_READY_TIMEOUT_MS ?? 2500);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 2500;
}

function planImplementationDismissMaxEscapes(env = process.env) {
  const parsed = Number(env.ORKESTR_PLAN_IMPLEMENTATION_DISMISS_MAX_ESCAPES ?? 2);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(5, Math.floor(parsed))) : 2;
}

async function dismissPlanImplementationMenu(threadId, status, env = process.env, context = {}) {
  if (!status?.paneId) return status;
  let latest = status;
  let escapes = 0;
  const maxEscapes = planImplementationDismissMaxEscapes(env);
  const waitMs = planImplementationDismissWaitMs(env);
  for (; escapes < maxEscapes && latest?.planImplementationMenuVisible; escapes += 1) {
    await execFileAsync("tmux", ["send-keys", "-t", latest.paneId, "Escape"]);
    await appendEvent({
      type: "thread_plan_implementation_prompt_dismissed",
      threadId,
      messageId: context.messageId || null,
      paneId: latest.paneId,
      escapeCount: escapes + 1,
      observedVia: context.observedVia || "codex_plan_implementation_escape",
      mode: context.mode || null,
    }, env).catch(() => {});
    if (waitMs > 0) await sleep(waitMs);
    latest = await runtimeStatus(threadId, env).catch(() => latest);
  }
  if (!latest?.planImplementationMenuVisible) {
    const readyTimeoutMs = planImplementationDismissReadyTimeoutMs(env);
    if (readyTimeoutMs > 0) {
      latest = await waitForRuntimeReady(threadId, {
        ...env,
        ORKESTR_WAKE_READY_TIMEOUT_MS: String(readyTimeoutMs),
      }).catch(() => latest);
    }
  }
  return { ...latest, planImplementationEscapes: escapes };
}

async function sendPlanImplementationChoice(status, choice) {
  if (!status?.paneId) return false;
  const requested = String(choice || "").trim();
  if (!["1", "2", "3"].includes(requested)) return false;
  const paneText = await capturePane(status.paneId, 80).catch(() => "");
  if (!panePlanImplementationMenuVisible(paneText)) return false;
  const selected = panePlanImplementationSelectedChoice(paneText) || status.planImplementationSelectedChoice || "1";
  const from = Math.max(1, Number(selected) || 1);
  const to = Math.max(1, Number(requested) || 1);
  const direction = to >= from ? "Down" : "Up";
  for (let index = 0; index < Math.abs(to - from); index += 1) {
    await execFileAsync("tmux", ["send-keys", "-t", status.paneId, direction]);
    await sleep(50);
  }
  await execFileAsync("tmux", ["send-keys", "-t", status.paneId, "C-m"]);
  return true;
}

export async function applyRuntimeCodexMode(threadId, mode, env = process.env, options = {}) {
  const desired = String(mode || "").trim().toLowerCase();
  if (desired !== "code" && desired !== "plan") {
    const error = new Error("invalid_codex_mode");
    error.statusCode = 400;
    throw error;
  }
  const status = await runtimeStatus(threadId, env).catch(() => null);
  if (!status?.paneId) return { applied: false, changed: false, mode: desired, reason: "runtime_unavailable" };
  const beforeText = await capturePane(status.paneId, 80).catch(() => "");
  const beforeMode = codexModeFromPaneText(beforeText);
  if (status.planImplementationMenuVisible && !status.working) {
    const dismissed = await dismissPlanImplementationMenu(threadId, status, env, {
      observedVia: "orkestr_codex_mode_command",
      mode: desired,
    });
    const afterText = dismissed?.paneId ? await capturePane(dismissed.paneId, 80).catch(() => "") : "";
    const afterMode = codexModeFromPaneText(afterText) || dismissed?.codexMode || beforeMode || "plan";
    const needsToggle = afterMode !== desired;
    if (needsToggle) {
      if (options.requirePromptReady !== false && (!dismissed?.promptReady || dismissed?.working || dismissed?.planImplementationMenuVisible)) {
        return {
          applied: false,
          changed: false,
          mode: desired,
          previousMode: beforeMode || null,
          paneId: dismissed?.paneId || status.paneId,
          state: dismissed?.state,
          promptReady: Boolean(dismissed?.promptReady),
          working: Boolean(dismissed?.working),
          reason: "runtime_not_ready",
        };
      }
      await execFileAsync("tmux", ["send-keys", "-t", dismissed.paneId || status.paneId, "BTab"]);
    }
    return {
      applied: true,
      changed: needsToggle,
      mode: desired,
      previousMode: beforeMode || null,
      paneId: dismissed?.paneId || status.paneId,
      reason: "closed_plan_implementation_prompt",
    };
  }
  if (beforeMode === desired) {
    return { applied: true, changed: false, mode: desired, previousMode: beforeMode, paneId: status.paneId };
  }
  if (options.requirePromptReady !== false && (!status.promptReady || status.working)) {
    return {
      applied: false,
      changed: false,
      mode: desired,
      previousMode: beforeMode || null,
      paneId: status.paneId,
      state: status.state,
      promptReady: Boolean(status.promptReady),
      working: Boolean(status.working),
      reason: "runtime_not_ready",
    };
  }
  if (!beforeMode) {
    return { applied: false, changed: false, mode: desired, previousMode: null, paneId: status.paneId, reason: "runtime_mode_unknown" };
  }
  await execFileAsync("tmux", ["send-keys", "-t", status.paneId, "BTab"]);
  return { applied: true, changed: true, mode: desired, previousMode: beforeMode, paneId: status.paneId };
}

export async function implementRuntimePlan(threadId, env = process.env) {
  const status = await runtimeStatus(threadId, env);
  if (!status?.paneId) {
    return { implemented: false, reason: "runtime_unavailable", status };
  }
  if (!status.planImplementationMenuVisible) {
    return {
      implemented: false,
      reason: "implementation_prompt_not_visible",
      paneId: status.paneId,
      status,
    };
  }
  if (!await sendPlanImplementationChoice(status, "1")) {
    return {
      implemented: false,
      reason: "implementation_prompt_not_visible",
      paneId: status.paneId,
      status,
    };
  }
  await updateThread(threadId, { state: "working", lastError: null }, env).catch(() => {});
  await appendEvent({
    type: "thread_plan_implementation_started",
    threadId,
    paneId: status.paneId,
    observedVia: "codex_plan_implementation_confirmed",
  }, env).catch(() => {});
  return {
    implemented: true,
    reason: "confirmed",
    paneId: status.paneId,
    status,
    observedVia: "codex_plan_implementation_confirmed",
  };
}

async function completePlanImplementationInput(thread, message, env = process.env) {
  const result = await implementRuntimePlan(thread.id, env);
  const implemented = Boolean(result.implemented);
  const errorText = implemented ? "" : "No active Codex implementation prompt is visible.";
  const updated = await updateThreadMessage(thread.id, message.id, {
    state: implemented ? "completed" : "failed",
    deliveryState: implemented ? "delivered" : "failed",
    observedVia: implemented ? "codex_plan_implementation_confirmed" : "codex_plan_implementation_not_ready",
    runtimeLeaseId: result.status?.lease?.id || null,
    deliveryPaneId: result.paneId || null,
    deliveredAt: implemented ? nowIso() : "",
    error: errorText,
  }, env);
  if (!implemented) {
    await updateThread(thread.id, { state: "failed", lastError: errorText }, env).catch(() => {});
  }
  return updated.id;
}

async function completePlanImplementationChoiceInput(thread, message, status, choice, env = process.env) {
  const selectedChoice = String(choice || "").trim();
  const deliveredAt = nowIso();
  if (!status?.paneId || !status.planImplementationMenuVisible || !await sendPlanImplementationChoice(status, selectedChoice)) {
    const errorText = "No active Codex implementation prompt is visible.";
    const failed = await updateThreadMessage(thread.id, message.id, {
      state: "failed",
      deliveryState: "failed",
      observedVia: "codex_plan_implementation_not_ready",
      runtimeLeaseId: status?.lease?.id || null,
      deliveryPaneId: status?.paneId || null,
      error: errorText,
    }, env);
    await updateThread(thread.id, { state: "failed", lastError: errorText }, env).catch(() => {});
    return failed.id;
  }
  const observedVia = planImplementationChoiceObservedVia(selectedChoice);
  const updated = await updateThreadMessage(thread.id, message.id, {
    state: "completed",
    deliveryState: "delivered",
    observedVia,
    runtimeLeaseId: status.lease?.id || null,
    deliveryPaneId: status.paneId,
    deliveredAt,
    error: null,
  }, env);
  await updateThread(thread.id, {
    state: selectedChoice === "3" ? "ready" : "working",
    lastError: null,
  }, env).catch(() => {});
  await appendEvent({
    type: "thread_plan_implementation_choice",
    threadId: thread.id,
    messageId: message.id,
    paneId: status.paneId,
    choice: selectedChoice,
    observedVia,
  }, env);
  return updated.id;
}

function shouldDeferRuntimeDelivery(error) {
  if (!error || String(error.message || error) !== "runtime_not_ready") return false;
  const status = error.status || {};
  return Boolean(
    status.working ||
    status.state === "working" ||
    status.state === "waking" ||
    status.promptReady === false ||
    status.planImplementationMenuVisible ||
    status.pendingCount > 0,
  );
}

async function deferThreadInputDelivery(thread, message, error, env = process.env) {
  const status = error?.status || {};
  const deliveryState = status.state === "waking" ? "waiting_runtime_start" : "waiting_runtime_ready";
  await updateThreadMessage(thread.id, message.id, {
    state: "queued",
    deliveryState,
    error: null,
  }, env).catch(() => {});
  await updateThread(thread.id, {
    state: status.state || "working",
    lastError: null,
  }, env).catch(() => {});
  await appendEvent({
    type: "thread_input_delivery_deferred",
    threadId: thread.id,
    messageId: message.id,
    reason: deliveryState,
    runtimeState: status.state || null,
  }, env);
}

async function pasteTmuxText(paneId, text, env = process.env) {
  const paths = await ensureDataDirs(env);
  const bufferName = `orkestr-${crypto.randomBytes(8).toString("hex")}`;
  const pastePath = path.join(paths.home, `${bufferName}.txt`);
  await fs.writeFile(pastePath, String(text || ""), "utf8");
  try {
    await execFileAsync("tmux", ["load-buffer", "-b", bufferName, pastePath]);
    await execFileAsync("tmux", ["paste-buffer", "-b", bufferName, "-t", paneId]);
  } finally {
    await execFileAsync("tmux", ["delete-buffer", "-b", bufferName]).catch(() => {});
    await fs.unlink(pastePath).catch(() => {});
  }
}

function submitKeys(env = process.env) {
  return String(env.ORKESTR_RUNTIME_SUBMIT_KEYS || "C-m")
    .split(",")
    .map((key) => key.trim())
    .filter(Boolean);
}

function submitDelayMs(env = process.env) {
  return Math.max(0, Number(env.ORKESTR_RUNTIME_SUBMIT_DELAY_MS || 250) || 0);
}

function fileSubmitDelayMs(env = process.env) {
  const parsed = Number(env.ORKESTR_TMUX_FILE_SUBMIT_DELAY_MS ?? 750);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 750;
}

function tmuxInlineCharLimit(env = process.env) {
  const parsed = Number(env.ORKESTR_TMUX_INLINE_CHAR_LIMIT || 800);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 800;
}

function inputTextForMessage(message) {
  const text = String(message.text || "").trim();
  let body = text;
  if (message.promptFile) {
    body = text ? `${text}\n\nPrompt file: ${message.promptFile}` : `Run the prompt file: ${message.promptFile}`;
  }
  if (whatsappOrigin(message)) {
    const source = String(message.from || message.chatId || "WhatsApp").trim();
    return `[WhatsApp: ${source}]\n\n${body}`;
  }
  return body;
}

function runtimeInterruptionReason(reason) {
  const key = String(reason || "interrupt").trim();
  const labels = {
    stale_delivery_ack: "Orkestr could not confirm that the previous input reached Codex",
    stop_command: "a stop command was requested",
    whatsapp_stop_command: "a WhatsApp stop command was requested",
    reset_command: "a reset was requested",
    whatsapp_reset_command: "a WhatsApp reset was requested",
    hard_reset_command: "a hard reset was requested",
    whatsapp_hard_reset_command: "a WhatsApp hard reset was requested",
    ui_stop: "the pane was stopped from the UI",
    manual_sleep: "the pane was put to sleep",
    hibernate: "the thread was hibernated",
    interrupt: "an interrupt was requested",
  };
  return labels[key] || key.replace(/_/g, " ");
}

function runtimeInterruptionNoticeText(reason) {
  return [
    "Codex pane interrupted",
    "",
    `${runtimeInterruptionReason(reason)}. Any in-progress Codex turn may have been stopped.`,
    "If this came from WhatsApp, wait for the pane to be ready before sending the next instruction.",
  ].join("\n");
}

function deliveryPayloadHash(message) {
  return crypto.createHash("sha256").update(inputTextForMessage(message)).digest("hex");
}

async function writeLongDeliveryInputFile(thread, message, inputText, env = process.env) {
  const paths = await ensureDataDirs(env);
  const threadDir = path.join(paths.home, "tmp", "thread-inputs", safeName(thread.id));
  await fs.mkdir(threadDir, { recursive: true, mode: 0o700 });
  const filePath = path.join(threadDir, `${safeName(message.id)}.txt`);
  await fs.writeFile(filePath, inputText, { encoding: "utf8", mode: 0o600 });
  return filePath;
}

async function deliveryInputForMessage(thread, message, inputText, env = process.env) {
  const bytes = Buffer.byteLength(inputText, "utf8");
  if (inputText.length <= tmuxInlineCharLimit(env)) {
    return {
      text: inputText,
      mode: "inline",
      filePath: "",
      bytes,
      observedVia: "tmux_send",
    };
  }
  const filePath = await writeLongDeliveryInputFile(thread, message, inputText, env);
  const checksum = crypto.createHash("sha256").update(inputText).digest("hex");
  return {
    text: [
      "A full user message was written to a local temp file because it is too long for safe tmux inline delivery.",
      `Read the full message from this local UTF-8 file: ${filePath}`,
      `Bytes: ${bytes}`,
      `SHA-256: ${checksum}`,
      "",
      "Treat the file contents as the user's message and answer it directly. Do not summarize this wrapper message.",
    ].join("\n"),
    mode: "file",
    filePath,
    bytes,
    observedVia: "tmux_send_file",
  };
}

function deliveryAttempt(message) {
  return Math.max(0, Number(message?.deliveryAttempt || 0) || 0);
}

function deliveryAckWaitMs(env = process.env) {
  return Math.max(0, Number(env.ORKESTR_DELIVERY_ACK_WAIT_MS ?? 2500) || 0);
}

function stuckPromptFailAfterMs(env = process.env) {
  const parsed = Number(env.ORKESTR_STUCK_PROMPT_FAIL_AFTER_MS ?? 30_000);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 30_000;
}

function unsentPromptStableMs(env = process.env) {
  const parsed = Number(env.ORKESTR_UNSENT_PROMPT_STABLE_MS ?? 3000);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 3000;
}

function deliveryFirstAttemptMs(message) {
  return timestampMs(message?.deliveryFirstAttemptAt) ||
    timestampMs(message?.deliveryLastAttemptAt) ||
    messageTimeMs(message);
}

function stuckPromptFailDueInMs(message, env = process.env) {
  const failAfterMs = stuckPromptFailAfterMs(env);
  if (failAfterMs <= 0) return 0;
  const firstAttemptMs = deliveryFirstAttemptMs(message);
  if (!firstAttemptMs) return failAfterMs;
  return Math.max(0, firstAttemptMs + failAfterMs - Date.now());
}

function deliveryRetryBackoffMs(attempt, env = process.env) {
  const configured = String(env.ORKESTR_DELIVERY_ACK_BACKOFF_MS || "")
    .split(",")
    .map((value) => positiveNumber(value.trim()))
    .filter(Boolean);
  const schedule = configured.length ? configured : deliveryRetryDefaultsMs;
  return schedule[Math.min(Math.max(0, Number(attempt || 1) - 1), schedule.length - 1)];
}

function deliveryDueInMs(message) {
  const dueMs = Date.parse(message?.deliveryNextAttemptAt || "");
  if (!Number.isFinite(dueMs) || dueMs <= 0) return 0;
  return Math.max(0, dueMs - Date.now());
}

function staleAckRecoveryAttempts(env = process.env) {
  const parsed = Number(env.ORKESTR_DELIVERY_STALE_ACK_RECOVERY_ATTEMPTS ?? 5);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 5;
}

function staleAckRecoveryMax(env = process.env) {
  const parsed = Number(env.ORKESTR_DELIVERY_STALE_ACK_RECOVERY_MAX ?? 1);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 1;
}

function staleAckRecoveryCount(message) {
  return Math.max(0, Number(message?.deliveryStaleRecoveryCount || 0) || 0);
}

function deliveryAckCheckCount(message) {
  return Math.max(0, Number(message?.deliveryAckCheckCount || 0) || 0);
}

function staleAckRecoveryProgress(message) {
  return Math.max(deliveryAttempt(message), deliveryAckCheckCount(message));
}

function compactDeliveryText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function leadingSlashCommand(message) {
  const match = inputTextForMessage(message).trimStart().match(/^(\/\S+)/);
  return match ? match[1].toLowerCase() : "";
}

function panePromptBodyText(paneText) {
  const lines = String(paneText || "").split("\n");
  let promptStart = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (panePromptLine(lines[index].trim())) {
      promptStart = index;
      break;
    }
  }
  return promptStart >= 0
    ? lines
      .slice(promptStart)
      .map((line, index) => {
        if (index === 0) return line.replace(/^\s*(?:›|>)\s?/, "");
        return line;
      })
      .filter((line) => !/^\s*gpt-[^\n]*\s+·\s+/i.test(line.trim()))
      .join(" ")
    : lines
      .map((line) => line.trim())
      .filter((line) => /^›(?:\s|$)/.test(line))
      .join(" ");
}

function paneContainsDeliveryText(paneText, messageText) {
  const expected = compactDeliveryText(messageText);
  if (!expected) return false;
  const sample = expected.length > 160 ? expected.slice(0, 160) : expected;
  const promptText = panePromptBodyText(paneText);
  return compactDeliveryText(promptText).includes(sample);
}

function fileDeliveryPromptTextForMessage(message) {
  const filePath = String(message?.deliveryInputFile || "").trim();
  const bytes = Number(message?.deliveryInputBytes || 0) || 0;
  const hash = String(message?.deliveryPayloadHash || "").trim();
  if (!filePath || !bytes || !hash) return "";
  return [
    "A full user message was written to a local temp file because it is too long for safe tmux inline delivery.",
    `Read the full message from this local UTF-8 file: ${filePath}`,
    `Bytes: ${bytes}`,
    `SHA-256: ${hash}`,
    "",
    "Treat the file contents as the user's message and answer it directly. Do not summarize this wrapper message.",
  ].join("\n");
}

function deliveryPromptTextForMessage(message) {
  if (String(message?.deliveryInputMode || "") === "file") {
    return fileDeliveryPromptTextForMessage(message) || inputTextForMessage(message);
  }
  return inputTextForMessage(message);
}

function paneMatchesDeliveryTextExactly(paneText, messageText) {
  const expected = compactDeliveryText(messageText);
  if (!expected) return false;
  return compactDeliveryText(panePromptBodyText(paneText)) === expected;
}

function paneMatchesMessageDeliveryPromptExactly(paneText, message) {
  const expected = deliveryPromptTextForMessage(message);
  return paneMatchesDeliveryTextExactly(paneText, expected);
}

function paneContainsMessageDeliveryPrompt(paneText, message) {
  if (paneContainsDeliveryText(paneText, inputTextForMessage(message))) return true;
  if (String(message?.deliveryInputMode || "") !== "file") return false;
  const hash = String(message?.deliveryPayloadHash || "").trim();
  const bytes = Number(message?.deliveryInputBytes || 0) || 0;
  if (!hash || !bytes) return false;
  const compact = compactDeliveryText(paneText);
  return compact.includes(`Bytes: ${bytes}`) && compact.includes(`SHA-256: ${hash}`);
}

function paneRejectedSlashCommand(paneText, command) {
  if (!command) return false;
  const pattern = new RegExp(`Unrecognized command ['"]${escapeRegex(command)}['"]`, "i");
  return pattern.test(String(paneText || ""));
}

async function rolloutSnapshotForDelivery(thread, lease, env = process.env) {
  const rolloutPath = String(
    lease?.rolloutPath ||
    thread?.codexRolloutPath ||
    thread?.executor?.metadata?.codexRolloutPath ||
    "",
  ).trim();
  if (!rolloutPath) return { deliveryRolloutPath: "", deliveryRolloutOffset: 0 };
  const stats = await fs.stat(rolloutPath).catch(() => null);
  return {
    deliveryRolloutPath: rolloutPath,
    deliveryRolloutOffset: Number(stats?.size || lease?.rolloutOffset || 0) || 0,
  };
}

async function deliveryAckEvidence(thread, message, status, env = process.env) {
  if (message?.state !== "awaiting_ack") return null;
  const messages = await listThreadMessages(thread.id, env).catch(() => []);
  const inputCursor = messageCursor(message);
  const inputMs = messageTimeMs(message);
  const assistantAfterInput = messages.find((candidate) => {
    if (candidate?.id === message.id) return false;
    if (String(candidate?.role || "").trim().toLowerCase() !== "assistant") return false;
    if (!String(candidate?.text || "").trim()) return false;
    if (String(candidate?.source || "").trim() === "orkestr_runtime" || String(candidate?.phase || "").trim() === "runtime_interrupted") return false;
    const state = String(candidate?.state || "completed").trim().toLowerCase();
    if (state === "failed" || pendingInputStates.has(state)) return false;
    const candidateCursor = messageCursor(candidate);
    if (inputCursor && candidateCursor && candidateCursor <= inputCursor) return false;
    const candidateMs = messageTimeMs(candidate);
    if (inputMs && candidateMs && candidateMs <= inputMs) return false;
    return true;
  });
  if (assistantAfterInput) {
    return { observedVia: "assistant_after_input", observedMessageId: assistantAfterInput.id };
  }
  if (status?.working || status?.state === "working") return { observedVia: "runtime_working" };

  const rolloutPath = String(
    message.deliveryRolloutPath ||
    status?.lease?.rolloutPath ||
    thread?.codexRolloutPath ||
    thread?.executor?.metadata?.codexRolloutPath ||
    "",
  ).trim();
  if (rolloutPath) {
    const stats = await fs.stat(rolloutPath).catch(() => null);
    const sentOffset = Number(message.deliveryRolloutOffset || 0) || 0;
    if (Number(stats?.size || 0) > sentOffset) return { observedVia: "codex_rollout_growth" };
  }
  return null;
}

async function rejectedCommandDeliveryEvidence(message, status) {
  if (message?.state !== "awaiting_ack" || !status?.paneId) return null;
  const command = leadingSlashCommand(message);
  if (!command) return null;
  const paneText = await capturePane(status.paneId, 80).catch(() => "");
  if (!paneRejectedSlashCommand(paneText, command)) return null;
  return {
    observedVia: "codex_unrecognized_command",
    error: `Codex rejected ${command}: Unrecognized command '${command}'.`,
  };
}

async function failThreadInputDelivery(thread, message, evidence, status, env = process.env) {
  if (!evidence) return null;
  const errorText = evidence.error || "Thread input delivery failed.";
  await updateThreadMessage(thread.id, message.id, {
    state: "failed",
    deliveryState: "failed",
    deliveryFailedAt: nowIso(),
    observedVia: evidence.observedVia || "delivery_failed",
    error: errorText,
  }, env);
  markConnectorDeliverySignal(message);
  await updateThread(thread.id, {
    state: status?.state || "ready",
    lastError: errorText,
  }, env).catch(() => {});
  await appendEvent({
    type: "thread_input_delivery_failed",
    threadId: thread.id,
    messageId: message.id,
    paneId: status?.paneId || message.deliveryPaneId || null,
    observedVia: evidence.observedVia || "delivery_failed",
    error: errorText,
  }, env);
  notifyThreadInputDeliveryFailure({
    thread,
    message,
    reason: errorText,
    observedVia: evidence.observedVia || "delivery_failed",
    env,
  });
  return message.id;
}

async function failRejectedThreadInputDelivery(thread, message, status, env = process.env) {
  return failThreadInputDelivery(thread, message, await rejectedCommandDeliveryEvidence(message, status), status, env);
}

async function stuckPromptDeliveryEvidence(message, status, env = process.env) {
  if (message?.state !== "awaiting_ack" || !status?.paneId) return null;
  const paneText = await capturePane(status.paneId, 80).catch(() => "");
  if (!paneContainsMessageDeliveryPrompt(paneText, message)) return null;
  const dueInMs = stuckPromptFailDueInMs(message, env);
  if (dueInMs > 0) {
    return {
      deferred: true,
      dueInMs,
      observedVia: "input_stuck_at_prompt_pending",
    };
  }
  return {
    observedVia: "input_stuck_at_prompt",
    error: "Message was pasted into Codex but was not accepted/submitted. Orkestr stopped retrying to avoid duplicate input.",
  };
}

async function failStuckPromptThreadInputDelivery(thread, message, status, env = process.env) {
  const evidence = await stuckPromptDeliveryEvidence(message, status, env);
  if (!evidence) return null;
  if (evidence.deferred) {
    const nextAttemptAt = isoAfter(evidence.dueInMs);
    await updateThreadMessage(thread.id, message.id, {
      deliveryState: "awaiting_prompt_submission",
      deliveryNextAttemptAt: nextAttemptAt,
      error: null,
    }, env).catch(() => {});
    await appendEvent({
      type: "thread_input_stuck_prompt_deferred",
      threadId: thread.id,
      messageId: message.id,
      paneId: status?.paneId || message.deliveryPaneId || null,
      dueInMs: evidence.dueInMs,
      nextAttemptAt,
    }, env).catch(() => {});
    scheduleThreadInputDelivery(thread.id, env, evidence.dueInMs);
    return message.id;
  }
  return failThreadInputDelivery(thread, message, evidence, status, env);
}

async function submitStableUnsentPromptDelivery(thread, message, status, env = process.env) {
  if (message?.state !== "awaiting_ack" || !status?.paneId) return null;
  const beforeText = await capturePane(status.paneId, 80).catch(() => "");
  if (!paneMatchesMessageDeliveryPromptExactly(beforeText, message)) return null;
  const beforePromptBody = compactDeliveryText(panePromptBodyText(beforeText));
  const stableMs = unsentPromptStableMs(env);
  if (stableMs > 0) await sleep(stableMs);
  const afterText = await capturePane(status.paneId, 80).catch(() => "");
  if (compactDeliveryText(panePromptBodyText(afterText)) !== beforePromptBody) return null;
  if (!paneMatchesMessageDeliveryPromptExactly(afterText, message)) return null;

  const attempt = deliveryAttempt(message) + 1;
  const sentAt = nowIso();
  const nextAttemptAt = isoAfter(deliveryRetryBackoffMs(attempt, env));
  const rollout = await rolloutSnapshotForDelivery(thread, status.lease, env);
  await updateThreadMessage(thread.id, message.id, {
    state: "pending_delivery",
    deliveryState: "submitting_unsent_prompt",
    deliveryAttempt: attempt,
    deliveryAckCheckCount: 0,
    deliveryLastAttemptAt: sentAt,
    deliveryNextAttemptAt: nextAttemptAt,
    deliveryPaneId: status.paneId,
    runtimeLeaseId: status.lease?.id || null,
    ...rollout,
    error: null,
  }, env);
  for (const key of submitKeys(env)) {
    await execFileAsync("tmux", ["send-keys", "-t", status.paneId, key]);
  }
  await updateThreadMessage(thread.id, message.id, {
    state: "awaiting_ack",
    deliveryState: "awaiting_ack",
    deliveryAttempt: attempt,
    deliveryAckCheckCount: 0,
    deliveryLastAttemptAt: sentAt,
    deliveryNextAttemptAt: nextAttemptAt,
    observedVia: "tmux_submit_stable_unsent_prompt_pending_ack",
    deliveryPaneId: status.paneId,
    runtimeLeaseId: status.lease?.id || null,
    ...rollout,
    error: null,
  }, env);
  await appendEvent({
    type: "thread_input_delivery_attempted",
    threadId: thread.id,
    messageId: message.id,
    attempt,
    paneId: status.paneId,
    nextAttemptAt,
    observedVia: "tmux_submit_stable_unsent_prompt",
    deliveryInputMode: message.deliveryInputMode || "inline",
    deliveryInputFile: message.deliveryInputFile || null,
  }, env);
  return message.id;
}

async function recoverStaleThreadInputAck(thread, message, status, env = process.env) {
  const threshold = staleAckRecoveryAttempts(env);
  const recoveryProgress = staleAckRecoveryProgress(message);
  if (!threshold || recoveryProgress < threshold) return false;
  if (!status?.paneId || !status.promptReady || status.working) return false;
  const paneText = await capturePane(status.paneId, 40).catch(() => "");
  if (paneContainsDeliveryText(paneText, inputTextForMessage(message))) return false;
  const rolloutPath = String(
    message.deliveryRolloutPath ||
    status?.lease?.rolloutPath ||
    thread?.codexRolloutPath ||
    thread?.executor?.metadata?.codexRolloutPath ||
    "",
  ).trim();
  if (rolloutPath) {
    const stats = await fs.stat(rolloutPath).catch(() => null);
    const sentOffset = Number(message.deliveryRolloutOffset || 0) || 0;
    if (Number(stats?.size || 0) > sentOffset) return false;
  }
  const recoveryCount = staleAckRecoveryCount(message);
  const maxRecoveries = staleAckRecoveryMax(env);
  if (recoveryCount >= maxRecoveries || recoveryProgress > threshold + maxRecoveries) {
    const errorText = "Thread input was not observed after stale-ack recovery; failing it to unblock later input.";
    await updateThreadMessage(thread.id, message.id, {
      state: "failed",
      deliveryState: "failed",
      deliveryFailedAt: nowIso(),
      observedVia: "stale_ack_recovery_exhausted",
      error: errorText,
    }, env);
    markConnectorDeliverySignal(message);
    await appendEvent({
      type: "thread_input_stale_ack_recovery_exhausted",
      threadId: thread.id,
      messageId: message.id,
      paneId: status.paneId,
      attempt: recoveryProgress,
      recoveryCount,
      maxRecoveries,
    }, env).catch(() => {});
    notifyThreadInputDeliveryFailure({
      thread,
      message,
      reason: errorText,
      observedVia: "stale_ack_recovery_exhausted",
      env,
    });
    return true;
  }
  await updateThreadMessage(thread.id, message.id, {
    state: "queued",
    deliveryState: "recovering_stale_ack",
    deliveryStaleRecoveryCount: recoveryCount + 1,
    deliveryNextAttemptAt: null,
    error: null,
  }, env);
  await appendEvent({
    type: "thread_input_stale_ack_recovery",
    threadId: thread.id,
    messageId: message.id,
    paneId: status.paneId,
    attempt: recoveryProgress,
  }, env);
  await sleepThread(thread.id, { reason: "stale_delivery_ack", kill: true, sourceMessage: message }, env).catch(() => {});
  return true;
}

async function acknowledgeThreadInputDelivery(thread, message, status, env = process.env) {
  const evidence = await deliveryAckEvidence(thread, message, status, env);
  if (!evidence) return null;
  const deliveredAt = nowIso();
  await updateThreadMessage(thread.id, message.id, {
    state: "completed",
    deliveryState: "delivered",
    deliveredAt,
    observedVia: evidence.observedVia,
    error: null,
  }, env);
  await updateThread(thread.id, {
    state: status?.state || "working",
    lastError: null,
  }, env).catch(() => {});
  await appendEvent({
    type: "thread_input_delivered",
    threadId: thread.id,
    messageId: message.id,
    paneId: status?.paneId || message.deliveryPaneId || null,
    observedVia: evidence.observedVia,
  }, env);
  return message.id;
}

async function waitForThreadInputAck(thread, messageId, env = process.env) {
  const waitMs = deliveryAckWaitMs(env);
  const deadline = Date.now() + waitMs;
  do {
    const messages = await listThreadMessages(thread.id, env);
    const message = messages.find((item) => item.id === messageId);
    if (!message || message.state !== "awaiting_ack") return message?.state === "completed" ? message.id : null;
    const status = await runtimeStatus(thread.id, env).catch(() => null);
    const acknowledged = await acknowledgeThreadInputDelivery(thread, message, status, env);
    if (acknowledged) return acknowledged;
    if (await failRejectedThreadInputDelivery(thread, message, status, env)) return null;
    if (Date.now() >= deadline) break;
    await sleep(Math.min(250, Math.max(25, deadline - Date.now())));
  } while (Date.now() < deadline);
  return null;
}

function normalizeNeedInputChoice(value) {
  return String(value || "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function parseNeedInputQuestions(text) {
  const questions = [];
  let current = null;
  for (const rawLine of String(text || "").split("\n")) {
    const line = rawLine.trim();
    if (!line || /^Codex needs input/i.test(line) || /^Reply with/i.test(line)) continue;
    const optionMatch = line.match(/^([A-Z])\.\s+(.+?)(?::\s*(.*))?$/);
    if (optionMatch && current) {
      current.options.push({
        letter: optionMatch[1],
        label: optionMatch[2].trim(),
        description: String(optionMatch[3] || "").trim(),
      });
      continue;
    }
    const questionMatch = line.match(/^(?:\d+[.)]\s*)?([^:]{1,80}):\s+(.+)$/);
    if (!questionMatch) continue;
    current = {
      header: questionMatch[1].trim(),
      question: questionMatch[2].trim(),
      options: [],
    };
    questions.push(current);
  }
  return questions.filter((question) => question.options.length);
}

function explicitAnswerForQuestion(answerText, question) {
  const headerPattern = escapeRegex(question.header).replace(/\s+/g, "\\s+");
  const match = String(answerText || "").match(new RegExp(`(?:^|[,;\\n])\\s*${headerPattern}\\s*:\\s*([^,;\\n]+)`, "i"));
  return match ? match[1].trim() : "";
}

function explicitNumberedAnswerForQuestion(answerText, questionIndex) {
  const number = Number(questionIndex) + 1;
  if (!Number.isFinite(number) || number < 1) return "";
  const pattern = new RegExp(`(?:^|[\\s,;])${number}\\s*[-:.)]\\s*(.+?)(?=(?:\\s+\\d+\\s*[-:.)])|[,;\\n]|$)`, "i");
  const match = String(answerText || "").match(pattern);
  return match ? String(match[1] || "").trim() : "";
}

function optionIndexForQuestionAnswer(question, answerText, questionCount, questionIndex = null) {
  const explicit = explicitAnswerForQuestion(answerText, question) || explicitNumberedAnswerForQuestion(answerText, questionIndex);
  const fallback = questionCount === 1 ? answerText : "";
  const answer = normalizeNeedInputChoice(explicit || fallback);
  if (!answer) return null;
  const letter = answer.length === 1 ? answer.toUpperCase() : "";
  for (const [index, option] of question.options.entries()) {
    if (letter && option.letter === letter) return index;
    const label = normalizeNeedInputChoice(option.label);
    const description = normalizeNeedInputChoice(option.description);
    if (label && (label === answer || label.startsWith(answer) || answer.startsWith(label))) return index;
    if (description && description.includes(answer)) return index;
  }
  return null;
}

async function sendNeedInputAnswerToPane(thread, message, pendingQuestion, status, env = process.env) {
  if (!status?.paneId || !pendingQuestion?.text) return null;
  const questions = parseNeedInputQuestions(pendingQuestion.text);
  if (!questions.length) return null;
  const selections = questions.map((question, index) => optionIndexForQuestionAnswer(question, message.text, questions.length, index));
  if (selections.some((selection) => selection === null)) return null;
  const deliveredAt = nowIso();
  await updateThreadMessage(thread.id, message.id, {
    state: "pending_delivery",
    deliveryState: "answering_need_input",
    deliveryAttempt: deliveryAttempt(message) + 1,
    deliveryPaneId: status.paneId,
    runtimeLeaseId: status.lease?.id || null,
    answeredInputMessageId: pendingQuestion.id || null,
    answeredInputEventId: pendingQuestion.eventId || null,
    error: null,
  }, env);
  for (const selection of selections) {
    for (let step = 0; step < selection; step += 1) {
      await execFileAsync("tmux", ["send-keys", "-t", status.paneId, "Down"]);
      await sleep(50);
    }
    await execFileAsync("tmux", ["send-keys", "-t", status.paneId, "C-m"]);
    await sleep(150);
  }
  await updateThreadMessage(thread.id, message.id, {
    state: "completed",
    deliveryState: "delivered",
    deliveredAt,
    observedVia: "codex_request_user_input",
    deliveryPaneId: status.paneId,
    runtimeLeaseId: status.lease?.id || null,
    answeredInputMessageId: pendingQuestion.id || null,
    answeredInputEventId: pendingQuestion.eventId || null,
    error: null,
  }, env);
  await updateThread(thread.id, { state: "working", lastError: null }, env).catch(() => {});
  await appendEvent({
    type: "thread_input_delivered",
    threadId: thread.id,
    messageId: message.id,
    paneId: status.paneId,
    observedVia: "codex_request_user_input",
    answeredInputMessageId: pendingQuestion.id || null,
    answeredInputEventId: pendingQuestion.eventId || null,
  }, env);
  return message.id;
}

function needInputCancelWaitMs(env = process.env) {
  const parsed = Number(env.ORKESTR_NEED_INPUT_CANCEL_WAIT_MS ?? 500);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 500;
}

function needInputCancelReadyTimeoutMs(env = process.env) {
  const parsed = Number(env.ORKESTR_NEED_INPUT_CANCEL_READY_TIMEOUT_MS ?? 2000);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 2000;
}

async function cancelNeedInputForRawDelivery(thread, message, pendingQuestion, status, env = process.env) {
  if (!status?.paneId) return null;
  await updateThreadMessage(thread.id, message.id, {
    state: "pending_delivery",
    deliveryState: "canceling_need_input",
    deliveryPaneId: status.paneId,
    runtimeLeaseId: status.lease?.id || null,
    canceledInputMessageId: pendingQuestion?.id || null,
    canceledInputEventId: pendingQuestion?.eventId || null,
    error: null,
  }, env);
  await execFileAsync("tmux", ["send-keys", "-t", status.paneId, "Escape"]);
  await appendEvent({
    type: "thread_input_need_input_cancelled",
    threadId: thread.id,
    messageId: message.id,
    paneId: status.paneId,
    canceledInputMessageId: pendingQuestion?.id || null,
    canceledInputEventId: pendingQuestion?.eventId || null,
  }, env);
  const waitMs = needInputCancelWaitMs(env);
  if (waitMs > 0) await sleep(waitMs);
  const latest = await runtimeStatus(thread.id, env).catch(() => status);
  if (latest?.promptReady && !latest.working && !latest.planImplementationMenuVisible) return latest;
  const readyTimeoutMs = needInputCancelReadyTimeoutMs(env);
  if (readyTimeoutMs <= 0) return latest || status;
  return await waitForRuntimeReady(thread.id, {
    ...env,
    ORKESTR_WAKE_READY_TIMEOUT_MS: String(readyTimeoutMs),
  }).catch(() => latest || status);
}

async function sendThreadInputToPane(thread, message, status, env = process.env) {
  if (!status?.paneId || status.working || !status.promptReady || status.planImplementationMenuVisible) {
    const error = new Error("runtime_not_ready");
    error.statusCode = 504;
    error.status = status;
    throw error;
  }
  const attempt = deliveryAttempt(message) + 1;
  const inputText = inputTextForMessage(message);
  const deliveryInput = await deliveryInputForMessage(thread, message, inputText, env);
  const sentAt = nowIso();
  const nextAttemptAt = isoAfter(deliveryRetryBackoffMs(attempt, env));
  const rollout = await rolloutSnapshotForDelivery(thread, status.lease, env);
  await updateThreadMessage(thread.id, message.id, {
    state: "pending_delivery",
    deliveryState: attempt > 1 ? "retrying_delivery" : "delivering",
    deliveryAttempt: attempt,
    deliveryAckCheckCount: 0,
    deliveryPayloadHash: deliveryPayloadHash(message),
    deliveryFirstAttemptAt: message.deliveryFirstAttemptAt || sentAt,
    deliveryLastAttemptAt: sentAt,
    deliveryNextAttemptAt: nextAttemptAt,
    deliveryPaneId: status.paneId,
    runtimeLeaseId: status.lease?.id || null,
    deliveryInputMode: deliveryInput.mode,
    deliveryInputFile: deliveryInput.filePath,
    deliveryInputBytes: deliveryInput.bytes,
    ...rollout,
    error: null,
  }, env);

  let submittedExistingPaste = false;
  if (attempt > 1 && status.paneId) {
    const paneText = await capturePane(status.paneId, 40).catch(() => "");
    submittedExistingPaste = paneContainsDeliveryText(paneText, deliveryInput.text);
  }
  if (!submittedExistingPaste) await pasteTmuxText(status.paneId, deliveryInput.text, env);

  const delayMs = deliveryInput.mode === "file" ? Math.max(submitDelayMs(env), fileSubmitDelayMs(env)) : submitDelayMs(env);
  if (delayMs > 0) await sleep(delayMs);
  for (const key of submitKeys(env)) {
    await execFileAsync("tmux", ["send-keys", "-t", status.paneId, key]);
  }

  await updateThreadMessage(thread.id, message.id, {
    state: "awaiting_ack",
    deliveryState: "awaiting_ack",
    deliveryAttempt: attempt,
    deliveryAckCheckCount: 0,
    deliveryLastAttemptAt: sentAt,
    deliveryNextAttemptAt: nextAttemptAt,
    observedVia: submittedExistingPaste ? `tmux_submit_existing_${deliveryInput.mode}_pending_ack` : `${deliveryInput.observedVia}_pending_ack`,
    deliveryPaneId: status.paneId,
    runtimeLeaseId: status.lease?.id || null,
    deliveryInputMode: deliveryInput.mode,
    deliveryInputFile: deliveryInput.filePath,
    deliveryInputBytes: deliveryInput.bytes,
    ...rollout,
    error: null,
  }, env);
  await appendEvent({
    type: "thread_input_delivery_attempted",
    threadId: thread.id,
    messageId: message.id,
    attempt,
    paneId: status.paneId,
    nextAttemptAt,
    observedVia: submittedExistingPaste ? `tmux_submit_existing_${deliveryInput.mode}` : deliveryInput.observedVia,
    deliveryInputMode: deliveryInput.mode,
    deliveryInputFile: deliveryInput.filePath || null,
  }, env);
  return { messageId: message.id, nextAttemptAt };
}

function scheduleThreadInputDelivery(threadId, env = process.env, delayMs = 0) {
  const id = String(threadId || "").trim();
  if (!id) return;
  const current = deliveryTimers.get(id);
  if (current) clearTimeout(current);
  const timer = setTimeout(() => {
    deliveryTimers.delete(id);
    void deliverPendingThreadInputs(id, env);
  }, Math.max(0, Number(delayMs) || 0));
  if (typeof timer.unref === "function") timer.unref();
  deliveryTimers.set(id, timer);
}

export async function deliverPendingThreadInputs(threadId, env = process.env) {
  const thread = await getThread(threadId, env);
  if (!thread) return [];
  if (deliveryLocks.has(thread.id)) return [];
  deliveryLocks.add(thread.id);
  const delivered = [];
  try {
    for (;;) {
      const messages = await listThreadMessages(thread.id, env);
      const immediate = messages
        .map((message) => ({ message, parsed: immediateThreadCommand(message) }))
        .find((item) => item.parsed);
      if (immediate) {
        await supersedeAwaitingAcksForControlCommand(thread, messages, immediate.message, immediate.parsed, env);
        const completed = await completeImmediateThreadCommand(thread, immediate.message, immediate.parsed, env);
        if (completed) delivered.push(completed);
        continue;
      }
      const awaitingAck = messages.find((message) => message.role === "user" && message.state === "awaiting_ack");
      if (awaitingAck) {
        const status = await runtimeStatus(thread.id, env).catch(() => null);
        const acknowledged = await acknowledgeThreadInputDelivery(thread, awaitingAck, status, env);
        if (acknowledged) {
          delivered.push(acknowledged);
          continue;
        }
        if (await failRejectedThreadInputDelivery(thread, awaitingAck, status, env)) continue;
        const dueInMs = deliveryDueInMs(awaitingAck);
        if (dueInMs > 0) {
          scheduleThreadInputDelivery(thread.id, env, dueInMs);
          break;
        }
        if (await submitStableUnsentPromptDelivery(thread, awaitingAck, status, env)) continue;
        if (await failStuckPromptThreadInputDelivery(thread, awaitingAck, status, env)) continue;
        if (!status?.paneId || status.state === "sleeping") {
          await updateThreadMessage(thread.id, awaitingAck.id, {
            state: "queued",
            deliveryState: "waiting_runtime_start",
            error: null,
          }, env).catch(() => {});
          continue;
        }
        if (!status.promptReady || status.working) {
          const attempt = Math.max(1, deliveryAttempt(awaitingAck));
          const nextAttemptAt = isoAfter(deliveryRetryBackoffMs(attempt, env));
          await updateThreadMessage(thread.id, awaitingAck.id, {
            deliveryState: status.working ? "awaiting_runtime_completion" : "waiting_runtime_ready",
            deliveryNextAttemptAt: nextAttemptAt,
          }, env).catch(() => {});
          scheduleThreadInputDelivery(thread.id, env, deliveryDueInMs({ deliveryNextAttemptAt: nextAttemptAt }));
          break;
        }
        if (await recoverStaleThreadInputAck(thread, awaitingAck, status, env)) continue;
        const ackCheckCount = staleAckRecoveryProgress(awaitingAck) + 1;
        const nextAttemptAt = isoAfter(deliveryRetryBackoffMs(ackCheckCount, env));
        await updateThreadMessage(thread.id, awaitingAck.id, {
          deliveryState: "awaiting_ack_unobserved",
          deliveryAckCheckCount: ackCheckCount,
          deliveryNextAttemptAt: nextAttemptAt,
        }, env).catch(() => {});
        await appendEvent({
          type: "thread_input_ack_unobserved",
          threadId: thread.id,
          messageId: awaitingAck.id,
          paneId: status.paneId,
          ackCheckCount,
          nextAttemptAt,
        }, env).catch(() => {});
        scheduleThreadInputDelivery(thread.id, env, deliveryDueInMs({ deliveryNextAttemptAt: nextAttemptAt }));
        break;
      }

      const next = messages.find((message) => message.role === "user" && ["queued", "pending_delivery", "awaiting_ack"].includes(message.state));
      if (!next) break;
      const parsedCommand = parseThreadInputCommand({ text: next.text });
      if (parsedCommand.command === "stop") {
        delivered.push(await completeStopCommand(thread, next, env));
        continue;
      }
      if (parsedCommand.command === "reset") {
        delivered.push(await completeResetCommand(thread, next, false, env));
        continue;
      }
      if (parsedCommand.command === "hard_reset") {
        delivered.push(await completeResetCommand(thread, next, true, env));
        continue;
      }
      if ((parsedCommand.command === "plan" || parsedCommand.command === "code") && !parsedCommand.text) {
        delivered.push(await completeCodexModeCommand(thread, next, parsedCommand.command, env));
        continue;
      }
      await updateThreadMessage(thread.id, next.id, { state: "pending_delivery", deliveryState: "waking" }, env);
      await updateThread(thread.id, { state: "waking" }, env);
      try {
        await wakeThread(thread.id, { reason: next.source || "message" }, env);
        const currentMessages = await listThreadMessages(thread.id, env);
        const currentNext = currentMessages.find((item) => item.id === next.id) || next;
        let status = await runtimeStatus(thread.id, env).catch(() => null);
        if (status?.planImplementationMenuVisible) {
          const choice = parsedCommand.command === "implement" ? "1" : planImplementationChoiceForInput(currentNext.text);
          if (choice) {
            delivered.push(await completePlanImplementationChoiceInput(thread, currentNext, status, choice, env));
            continue;
          }
          status = await dismissPlanImplementationMenu(thread.id, status, env, {
            messageId: currentNext.id,
            observedVia: "thread_input_delivery",
          });
        }
        if (parsedCommand.command === "implement") {
          const attempted = await completePlanImplementationInput(thread, currentNext, env);
          delivered.push(attempted);
          continue;
        }
        const pendingNeedInput = latestNeedInputBeforeMessage(currentMessages, currentNext.id);
        if (pendingNeedInput) {
          const needInputStatus = await runtimeStatus(thread.id, env, currentMessages).catch(() => null);
          const answered = await sendNeedInputAnswerToPane(thread, currentNext, pendingNeedInput, needInputStatus, env);
          if (answered) {
            delivered.push(answered);
            continue;
          }
          status = await cancelNeedInputForRawDelivery(thread, currentNext, pendingNeedInput, needInputStatus, env);
        }
        if (!status) status = await waitForRuntimeReady(thread.id, env);
        const attempt = await sendThreadInputToPane(thread, currentNext, status, env);
        const acknowledged = await waitForThreadInputAck(thread, currentNext.id, env);
        if (acknowledged) {
          delivered.push(acknowledged);
          continue;
        }
        const current = (await listThreadMessages(thread.id, env)).find((item) => item.id === currentNext.id) || currentNext;
        if (await failRejectedThreadInputDelivery(thread, current, status, env)) continue;
        await updateThread(thread.id, { state: "working", lastError: null }, env);
        scheduleThreadInputDelivery(thread.id, env, deliveryDueInMs({ deliveryNextAttemptAt: attempt.nextAttemptAt }));
        break;
      } catch (error) {
        const errorText = error instanceof Error ? error.message : String(error);
        if (shouldDeferRuntimeDelivery(error)) {
          await deferThreadInputDelivery(thread, next, error, env);
          break;
        }
        await updateThreadMessage(thread.id, next.id, { state: "failed", deliveryState: "failed", error: errorText }, env).catch(() => {});
        markConnectorDeliverySignal(next);
        await updateThread(thread.id, { state: "failed", lastError: errorText }, env).catch(() => {});
        await appendEvent({ type: "thread_input_delivery_failed", threadId: thread.id, messageId: next.id, error: errorText }, env);
        break;
      }
    }
  } finally {
    deliveryLocks.delete(thread.id);
  }
  return delivered;
}

export function requestThreadInputDelivery(threadId, env = process.env, delayMs = 0) {
  scheduleThreadInputDelivery(threadId, env, delayMs);
}

export function requestThreadWake(threadId, options = {}, env = process.env) {
  setImmediate(() => {
    void wakeThread(threadId, options, env).catch(async (error) => {
      const errorText = error instanceof Error ? error.message : String(error);
      await updateThread(threadId, { state: "sleeping", lastError: errorText }, env).catch(() => {});
      await appendEvent({
        type: "runtime_wake_failed",
        threadId,
        reason: options.reason || "wake",
        error: errorText,
      }, env).catch(() => {});
    });
  });
}

function collectMessageText(content = []) {
  return (Array.isArray(content) ? content : [])
    .map((part) => typeof part?.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function optionLabel(index) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  return alphabet[index] || String(index + 1);
}

function parseJsonObject(value) {
  if (!value || typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function formatRequestUserInput(argumentsText) {
  const args = parseJsonObject(argumentsText);
  const questions = Array.isArray(args?.questions) ? args.questions : [];
  const sections = [];
  for (const [questionIndex, rawQuestion] of questions.entries()) {
    if (!rawQuestion || typeof rawQuestion !== "object") continue;
    const header = String(rawQuestion.header || rawQuestion.id || `Question ${questionIndex + 1}`).trim();
    const question = String(rawQuestion.question || "").trim();
    if (!question) continue;
    const lines = [`${questionIndex + 1}. ${header}: ${question}`];
    const options = Array.isArray(rawQuestion.options) ? rawQuestion.options : [];
    for (const [optionIndex, rawOption] of options.entries()) {
      if (!rawOption || typeof rawOption !== "object") continue;
      const label = String(rawOption.label || "").trim();
      const description = String(rawOption.description || "").trim();
      if (!label && !description) continue;
      const optionText = description ? `${label}: ${description}` : label;
      lines.push(`   ${optionLabel(optionIndex)}. ${optionText}`);
    }
    sections.push(lines.join("\n"));
  }
  if (!sections.length) return "";
  return [
    "Codex needs input to continue:",
    "",
    sections.join("\n\n"),
    "",
    "Reply with your choices or a short free-form answer.",
  ].join("\n").trim();
}

function parseAssistantRolloutMessages(body, threadId, baseOffset = 0) {
  const messages = [];
  const keyIndexes = new Map();
  let offset = baseOffset;
  for (const line of String(body || "").split("\n")) {
    const cursor = offset;
    offset += Buffer.byteLength(line) + 1;
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    let text = "";
    let phase = null;
    if (parsed?.type === "response_item" && parsed.payload?.type === "message" && parsed.payload?.role === "assistant") {
      text = collectMessageText(parsed.payload.content);
      phase = parsed.payload.phase || "final_answer";
    } else if (parsed?.type === "event_msg" && parsed.payload?.type === "agent_message") {
      text = String(parsed.payload.message || "").trim();
      phase = parsed.payload.phase || "final_answer";
    } else if (parsed?.type === "event_msg" && parsed.payload?.type === "item_completed" && parsed.payload?.item?.type === "Plan") {
      text = String(parsed.payload.item.text || "").trim();
      phase = "plan";
    } else if (parsed?.type === "response_item" && parsed.payload?.type === "function_call" && parsed.payload?.name === "request_user_input") {
      text = formatRequestUserInput(parsed.payload.arguments);
      phase = "need_input";
    }
    if (!text) continue;
    if (phase !== "plan" && hasProposedPlanEnvelope(text)) phase = "plan";
    const timestamp = parsed.timestamp || nowIso();
    const message = {
      cursor,
      role: "assistant",
      source: "codex-rollout",
      timestamp,
      phase,
      text,
      eventId: eventId({ threadId, timestamp, role: "assistant", phase, text }),
      sourceFormat: parsed?.type === "response_item" ? "response_item" : "event_msg",
    };
    const key = ["assistant", String(phase || ""), normalizedTextKey(text)].join("\n");
    const existingIndex = keyIndexes.get(key);
    if (existingIndex === undefined) {
      keyIndexes.set(key, messages.length);
      messages.push(message);
    } else if (messages[existingIndex]?.sourceFormat !== "response_item" && message.sourceFormat === "response_item") {
      messages[existingIndex] = message;
    }
  }
  return messages.map(({ sourceFormat, ...message }) => message);
}

function latestWhatsAppInput(messages = [], beforeTimestamp = null) {
  const beforeMs = beforeTimestamp ? timestampMs(beforeTimestamp) : 0;
  return [...messages].reverse().find((message) =>
    message?.role === "user" &&
    whatsappOrigin(message) &&
    String(message.chatId || "").trim() &&
    (!beforeMs || timestampMs(message.timestamp || message.createdAt) <= beforeMs + 1000),
  ) || null;
}

async function syncLeaseRollout(lease, env = process.env) {
  const thread = await getThread(lease.threadId, env);
  const codexMetadata = await resolveCodexThreadMetadata(thread, env).catch(() => ({}));
  if (Object.keys(codexMetadata).length) {
    await updateThread(lease.threadId, {
      ...codexMetadata,
      executor: {
        ...(thread?.executor || {}),
        codexThreadId: codexMetadata.codexThreadId || thread?.executor?.codexThreadId || "",
        metadata: { ...(thread?.executor?.metadata || {}), ...codexMetadata },
      },
    }, env).catch(() => {});
  }
  let rolloutPath = lease.rolloutPath;
  if (!rolloutPath) {
    rolloutPath = await resolveCodexRolloutPath(codexThreadId(thread));
    if (!rolloutPath) {
      const discovered = await resolveCodexThreadByWorkspace(lease.workspace, lease.startedAt, env);
      if (discovered?.codexThreadId && discovered.rolloutPath) {
        rolloutPath = discovered.rolloutPath;
        await updateThread(lease.threadId, {
          executor: { ...(thread?.executor || {}), codexThreadId: discovered.codexThreadId },
        }, env).catch(() => {});
      }
    }
    if (!rolloutPath) return { lease, appended: 0 };
  }
  const stats = await fs.stat(rolloutPath).catch(() => null);
  if (!stats) {
    return { lease: { ...lease, rolloutPath }, appended: 0 };
  }
  const size = Number(stats.size || 0) || 0;
  const savedOffset = Math.max(0, Number(lease.rolloutOffset || 0));
  const lookbackBytes = rolloutSyncLookbackBytes(env);
  const scannedLookbackBytes = Number(lease.rolloutOffsetLookbackBytes || 0) || 0;
  const needsLookbackScan =
    lookbackBytes > 0 &&
    !lease.rolloutOffsetLookbackApplied &&
    (!lease.rolloutLookbackScannedAt || scannedLookbackBytes < lookbackBytes);
  if (size <= savedOffset && !needsLookbackScan) {
    return { lease: { ...lease, rolloutPath }, appended: 0 };
  }
  const start = needsLookbackScan
    ? Math.max(0, Math.min(savedOffset, size) - lookbackBytes)
    : Math.min(savedOffset, size);
  const handle = await fs.open(rolloutPath, "r");
  let body = "";
  try {
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    body = buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close().catch(() => {});
  }
  const parsed = parseAssistantRolloutMessages(body, lease.threadId, start);
  const existing = await listThreadMessages(lease.threadId, env);
  const existingEventKeys = new Set(existing.map(rolloutMessageEventKey));
  const existingTextKeys = new Set(
    existing
      .filter((message) => message.source === "codex-rollout" && message.role === "assistant")
      .map(rolloutMessageNearTextKey),
  );
  let appended = 0;
  for (const message of parsed) {
    const eventKey = rolloutMessageEventKey(message);
    const textKey = rolloutMessageNearTextKey(message);
    if (existingEventKeys.has(eventKey) || existingTextKeys.has(textKey)) continue;
    const whatsappParent = latestWhatsAppInput(existing, message.timestamp);
    await appendThreadMessage(lease.threadId, {
      role: "assistant",
      source: message.source,
      text: message.text,
      state: "completed",
      cursor: null,
      timestamp: message.timestamp,
      phase: message.phase,
      eventId: message.eventId,
      parentMessageId: whatsappParent?.id || null,
      connector: whatsappParent ? "whatsapp" : "",
      chatId: whatsappParent?.chatId || "",
      accountId: whatsappParent?.accountId || "",
    }, env);
    existingEventKeys.add(eventKey);
    existingTextKeys.add(textKey);
    appended += 1;
  }
  return {
    lease: {
      ...lease,
      rolloutPath,
      rolloutOffset: Math.max(savedOffset, size),
      heartbeatAt: nowIso(),
      ...(needsLookbackScan
        ? {
          rolloutLookbackScannedAt: nowIso(),
          rolloutLookbackScannedFrom: start,
          rolloutOffsetLookbackBytes: lookbackBytes,
        }
        : {}),
    },
    appended,
  };
}

async function syncRuntimeLeasesOnce(env = process.env) {
  const leases = await listRuntimeLeases(env);
  let changed = false;
  let appended = 0;
  const next = [];
  for (const lease of leases) {
    if (lease.endedAt) {
      next.push(lease);
      continue;
    }
    if (!(await tmuxHasSession(lease.sessionName))) {
      next.push({ ...lease, endedAt: nowIso(), endReason: "tmux_session_missing" });
      await updateThread(lease.threadId, { state: "sleeping", activeRuntimeLeaseId: null }, env).catch(() => {});
      changed = true;
      continue;
    }
    const synced = await syncLeaseRollout(lease, env).catch(() => ({ lease, appended: 0 }));
    let leaseForStorage = synced.lease;
    appended += synced.appended || 0;
    const thread = await getThread(lease.threadId, env).catch(() => null);
    const messages = thread ? await listThreadMessages(thread.id, env).catch(() => []) : [];
    let status = await runtimeStatus(lease.threadId, env, messages).catch(() => null);
    if (status) {
      leaseForStorage = {
        ...synced.lease,
        paneId: status.lease?.paneId ?? synced.lease.paneId,
        windowName: status.lease?.windowName ?? synced.lease.windowName,
      };
      if (thread) {
        const awaitingAck = messages.find((message) => message.role === "user" && message.state === "awaiting_ack");
        if (awaitingAck) {
          const acknowledged = await acknowledgeThreadInputDelivery(thread, awaitingAck, status, env).catch(() => null);
          if (acknowledged) scheduleThreadInputDelivery(thread.id, env, 0);
          else await failRejectedThreadInputDelivery(thread, awaitingAck, status, env).catch(() => null);
        }
      }
      if (status.needsResumeDirectoryConfirmation && status.paneId) {
        await execFileAsync("tmux", ["send-keys", "-t", status.paneId, "2", "C-m"]).catch(() => {});
        await updateThread(lease.threadId, {
          state: "waking",
          runtime: { ...leaseForStorage, state: "waking", progress: status.progress || null },
        }, env).catch(() => {});
        next.push(leaseForStorage);
        changed = true;
        continue;
      }
      if (status.needsCodexUpdatePromptSkip && status.paneId) {
        await execFileAsync("tmux", ["send-keys", "-t", status.paneId, status.codexUpdatePromptChoice || "2", "C-m"]).catch(() => {});
        await updateThread(lease.threadId, {
          state: "waking",
          runtime: { ...leaseForStorage, state: "waking", progress: status.progress || null },
        }, env).catch(() => {});
        next.push(leaseForStorage);
        changed = true;
        continue;
      }
      const restoredMode = thread ? await reapplyDesiredCodexMode(thread, status, env) : null;
      if (restoredMode?.applied) {
        status = await runtimeStatus(lease.threadId, env, messages).catch(() => status);
        changed = true;
      }
      const idleSleep = idleSleepDecision({ lease: leaseForStorage, messages, status }, env);
      if (thread && idleSleep) {
        const endedAt = nowIso();
        const endedLease = {
          ...leaseForStorage,
          endedAt,
          endReason: idleSleep.reason,
          idleMs: idleSleep.idleMs,
          lastActivityAt: idleSleep.lastActivityAt,
        };
        await execFileAsync("tmux", ["kill-session", "-t", endedLease.sessionName]).catch(() => {});
        await updateThread(lease.threadId, {
          state: "sleeping",
          activeRuntimeLeaseId: null,
          runtime: {
            state: "sleeping",
            endedAt,
            reason: idleSleep.reason,
            idleMs: idleSleep.idleMs,
            lastActivityAt: idleSleep.lastActivityAt,
          },
        }, env).catch(() => {});
        await appendEvent({
          type: "runtime_slept",
          threadId: lease.threadId,
          reason: idleSleep.reason,
          killed: true,
          auto: true,
          idleMs: idleSleep.idleMs,
          idleSleepMs: idleSleep.idleSleepMs,
          lastActivityAt: idleSleep.lastActivityAt,
        }, env).catch(() => {});
        next.push(endedLease);
        changed = true;
        continue;
      }
      await updateThread(lease.threadId, {
        state: status.state,
        runtime: { ...leaseForStorage, state: status.state, progress: status.progress || null },
      }, env).catch(() => {});
    }
    next.push(leaseForStorage);
    changed = changed || JSON.stringify(leaseForStorage) !== JSON.stringify(lease);
  }
  if (changed) await saveRuntimeLeases(next, env);
  return { leases: next, appended };
}

export async function syncPaneProgressForActiveLeases(env = process.env) {
  const leases = await listRuntimeLeases(env);
  let sampled = 0;
  let changed = 0;
  for (const lease of leases) {
    if (lease.endedAt) continue;
    if (!(await tmuxHasSession(lease.sessionName).catch(() => false))) continue;
    const paneId = await resolveLivePaneId(lease, env).catch(() => lease.paneId || null);
    if (!paneId) continue;
    const progress = publicPaneProgress(await samplePaneProgress({
      threadId: lease.threadId,
      leaseId: lease.id,
      sessionName: lease.sessionName,
      paneId,
    }, env).catch(() => null));
    if (!progress) continue;
    sampled += 1;
    const thread = await getThread(lease.threadId, env).catch(() => null);
    if (!thread) continue;
    const previous = thread.runtime?.progress;
    const changedProgress = !previous ||
      previous.tailHash !== progress.tailHash ||
      previous.summary !== progress.summary ||
      previous.stateHint !== progress.stateHint;
    if (!changedProgress) continue;
    changed += 1;
    await updateThread(lease.threadId, {
      runtime: {
        ...(thread.runtime || {}),
        ...lease,
        paneId,
        progress,
      },
    }, env).catch(() => {});
  }
  return { sampled, changed };
}

export async function syncRuntimeLeases(env = process.env) {
  if (runtimeSyncInFlight) return runtimeSyncInFlight;
  runtimeSyncInFlight = syncRuntimeLeasesOnce(env).finally(() => {
    runtimeSyncInFlight = null;
  });
  return runtimeSyncInFlight;
}

export async function drainAllPendingThreadInputs(env = process.env) {
  const threads = await listThreads(env);
  const results = [];
  for (const thread of threads) {
    const messages = await listThreadMessages(thread.id, env);
    if (messages.some((message) => message.role === "user" && pendingInputStates.has(message.state))) {
      results.push({ threadId: thread.id, delivered: await deliverPendingThreadInputs(thread.id, env) });
    }
  }
  return results;
}
