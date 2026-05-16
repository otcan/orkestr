import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import {
  appendThreadMessage,
  getThread,
  listThreadMessages,
  listThreads,
  updateThread,
  updateThreadMessage,
} from "./threads.js";

const execFileAsync = promisify(execFile);
const deliveryLocks = new Set();

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeName(value) {
  return String(value || "default").replace(/[^a-zA-Z0-9_.-]/g, "_") || "default";
}

function codexThreadId(thread) {
  return String(thread?.executor?.codexThreadId || thread?.codexThreadId || "").trim();
}

function threadName(thread) {
  return String(thread?.bindingName || thread?.binding?.displayName || thread?.name || thread?.id || "").trim();
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
  const { stdout } = await execFileAsync("tmux", ["list-panes", "-t", sessionName, "-F", "#{pane_id}"]);
  return String(stdout || "").trim().split("\n").filter(Boolean)[0] || null;
}

async function capturePane(paneId, lines = 80) {
  if (!paneId) return "";
  const { stdout } = await execFileAsync("tmux", ["capture-pane", "-t", paneId, "-p", "-S", `-${Math.max(20, lines)}`]);
  return String(stdout || "");
}

function paneWorking(text) {
  const lines = String(text || "").split("\n").map((line) => line.trim()).filter(Boolean).slice(-12);
  return lines.some((line) => /(?:•\s*Working\s*\(|esc to interrupt)/i.test(line));
}

function panePromptReady(text) {
  const lines = String(text || "").split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.some((line) => /^›(?:\s|$)/.test(line) && !/^›\s*\d+[.)]/.test(line));
}

function paneResumeDirectoryPrompt(text) {
  const body = String(text || "");
  return /Choose working directory to resume this session/i.test(body) && /Press enter to continue/i.test(body);
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

export async function runtimeStatus(threadId, env = process.env) {
  const thread = await getThread(threadId, env);
  if (!thread) {
    const error = new Error("thread_not_found");
    error.statusCode = 404;
    throw error;
  }
  const messages = await listThreadMessages(thread.id, env);
  const pendingCount = messages.filter((message) => ["queued", "pending_delivery"].includes(message.state)).length;
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
      runningCount,
      wakePolicy: thread.wakePolicy || "wake-on-message",
      hibernated: state === "sleeping",
    };
  }

  const paneId = lease.paneId || await tmuxPaneId(lease.sessionName).catch(() => null);
  const paneText = await capturePane(paneId).catch(() => "");
  const needsResumeDirectoryConfirmation = paneResumeDirectoryPrompt(paneText);
  const promptReadyCandidate = panePromptReady(paneText);
  const working = !promptReadyCandidate && (paneWorking(paneText) || runningCount > 0);
  const promptReady = promptReadyCandidate && !working && !needsResumeDirectoryConfirmation;
  const recentlyStarted = Date.now() - (Date.parse(lease.startedAt || "") || Date.now()) < 20_000;
  const state = working ? "working" : promptReady ? "ready" : recentlyStarted || pendingCount > 0 ? "waking" : "ready";
  return {
    state,
    status: state,
    runtimeState: "live",
    lease: { ...lease, paneId },
    sessionName: lease.sessionName,
    paneId,
    promptReady,
    promptReadyStable: promptReady,
    needsResumeDirectoryConfirmation,
    working,
    foregroundWorking: working,
    typingActive: working,
    backgroundWork: false,
    pendingCount,
    runningCount,
    wakePolicy: thread.wakePolicy || "wake-on-message",
    hibernated: false,
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

async function rolloutOffsetForThread(thread) {
  const rolloutPath = await resolveCodexRolloutPath(codexThreadId(thread));
  if (!rolloutPath) return { rolloutPath: null, rolloutOffset: 0 };
  const stats = await fs.stat(rolloutPath).catch(() => null);
  return { rolloutPath, rolloutOffset: stats?.size || 0 };
}

function runtimeWorkspace(thread, env) {
  const paths = dataPaths(env);
  const explicit = thread.cwd || thread.workspace || thread.executor?.metadata?.cwd || "";
  return path.resolve(explicit || path.join(env.ORKESTR_RUNTIME_WORKSPACE_ROOT || paths.workspaces, safeName(thread.id)));
}

function runtimeCommand(thread, env = process.env) {
  const base = String(env.ORKESTR_RUNTIME_CODEX_COMMAND || "codex --dangerously-bypass-approvals-and-sandbox").trim();
  const threadId = codexThreadId(thread);
  return threadId ? `${base} resume ${shellQuote(threadId)}` : base;
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
    return { thread, lease: existing, reused: true, status: await runtimeStatus(thread.id, env) };
  }

  const paths = await ensureDataDirs(env);
  const sessionName = `orkestr-${safeName(thread.id).slice(0, 48)}`;
  const workspace = runtimeWorkspace(thread, env);
  await fs.mkdir(workspace, { recursive: true });
  await ensureCodexWorkspaceTrusted(workspace, env);
  await updateThread(thread.id, {
    state: "waking",
    wakePolicy: thread.wakePolicy || "wake-on-message",
    runtime: { state: "waking", sessionName, workspace, reason: options.reason || "wake" },
  }, env);

  const command = runtimeCommand(thread, env);
  if (!(await tmuxHasSession(sessionName))) {
    await execFileAsync("tmux", ["new-session", "-d", "-s", sessionName, "-c", workspace, command], {
      env: {
        ...process.env,
        ...env,
        HOME: runtimeHome(env),
        CODEX_HOME: env.CODEX_HOME || process.env.CODEX_HOME || defaultCodexHome(env),
      },
    });
  }
  const paneId = await tmuxPaneId(sessionName).catch(() => null);
  const { rolloutPath, rolloutOffset } = await rolloutOffsetForThread(thread);
  const lease = {
    id: crypto.randomUUID(),
    threadId: thread.id,
    threadName: threadName(thread),
    sessionName,
    paneId,
    workspace,
    command,
    resourceClass: "light",
    reason: String(options.reason || "wake"),
    startedAt: nowIso(),
    heartbeatAt: nowIso(),
    rolloutPath,
    rolloutOffset,
  };
  const leases = await listRuntimeLeases(env);
  leases.push(lease);
  await saveRuntimeLeases(leases, env);
  const updatedThread = await updateThread(thread.id, {
    state: "ready",
    wakePolicy: thread.wakePolicy || "wake-on-message",
    activeRuntimeLeaseId: lease.id,
    runtime: { state: "ready", leaseId: lease.id, sessionName, paneId, workspace, startedAt: lease.startedAt },
    executor: { ...(thread.executor || {}), sessionName, tmuxTarget: paneId },
  }, env);
  await appendEvent({ type: "runtime_woken", threadId: thread.id, leaseId: lease.id, sessionName, paneId, reason: lease.reason }, env);
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
  const updated = await updateThread(thread.id, {
    state: "sleeping",
    activeRuntimeLeaseId: null,
    runtime: { state: "sleeping", endedAt: now, reason: options.reason || "sleep" },
  }, env);
  await appendEvent({ type: "runtime_slept", threadId: thread.id, reason: options.reason || "sleep", killed: options.kill !== false }, env);
  return { thread: updated, slept: active.length };
}

async function waitForRuntimeReady(threadId, env = process.env) {
  const timeoutMs = Number(env.ORKESTR_WAKE_READY_TIMEOUT_MS || 60_000);
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await runtimeStatus(threadId, env);
    if (last.needsResumeDirectoryConfirmation && last.paneId) {
      await execFileAsync("tmux", ["send-keys", "-t", last.paneId, "C-m"]).catch(() => {});
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

function shouldDeferRuntimeDelivery(error) {
  if (!error || String(error.message || error) !== "runtime_not_ready") return false;
  const status = error.status || {};
  return Boolean(
    status.working ||
    status.state === "working" ||
    status.state === "waking" ||
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

function inputTextForMessage(message) {
  const text = String(message.text || "").trim();
  if (message.promptFile) {
    return text ? `${text}\n\nPrompt file: ${message.promptFile}` : `Run the prompt file: ${message.promptFile}`;
  }
  return text;
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
      const next = messages.find((message) => message.role === "user" && ["queued", "pending_delivery"].includes(message.state));
      if (!next) break;
      await updateThreadMessage(thread.id, next.id, { state: "pending_delivery", deliveryState: "waking" }, env);
      await updateThread(thread.id, { state: "waking" }, env);
      try {
        await wakeThread(thread.id, { reason: next.source || "message" }, env);
        const status = await waitForRuntimeReady(thread.id, env);
        await updateThreadMessage(thread.id, next.id, { deliveryState: "delivering" }, env);
        await pasteTmuxText(status.paneId, inputTextForMessage(next), env);
        const delayMs = submitDelayMs(env);
        if (delayMs > 0) await sleep(delayMs);
        for (const key of submitKeys(env)) {
          await execFileAsync("tmux", ["send-keys", "-t", status.paneId, key]);
        }
        const deliveredAt = nowIso();
        await updateThreadMessage(thread.id, next.id, {
          state: "completed",
          deliveryState: "delivered",
          deliveredAt,
          observedVia: "tmux_send",
          runtimeLeaseId: status.lease?.id || null,
        }, env);
        await updateThread(thread.id, { state: "working", lastError: null }, env);
        await appendEvent({ type: "thread_input_delivered", threadId: thread.id, messageId: next.id, paneId: status.paneId }, env);
        delivered.push(next.id);
      } catch (error) {
        const errorText = error instanceof Error ? error.message : String(error);
        if (shouldDeferRuntimeDelivery(error)) {
          await deferThreadInputDelivery(thread, next, error, env);
          break;
        }
        await updateThreadMessage(thread.id, next.id, { state: "failed", deliveryState: "failed", error: errorText }, env).catch(() => {});
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

export function requestThreadInputDelivery(threadId, env = process.env) {
  setImmediate(() => {
    void deliverPendingThreadInputs(threadId, env);
  });
}

function collectMessageText(content = []) {
  return (Array.isArray(content) ? content : [])
    .map((part) => typeof part?.text === "string" ? part.text : "")
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function parseAssistantRolloutMessages(body, threadId, baseOffset = 0) {
  const messages = [];
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
    }
    if (!text) continue;
    const timestamp = parsed.timestamp || nowIso();
    messages.push({
      cursor,
      role: "assistant",
      source: "codex-rollout",
      timestamp,
      phase,
      text,
      eventId: eventId({ threadId, timestamp, role: "assistant", phase, text }),
    });
  }
  return messages;
}

async function syncLeaseRollout(lease, env = process.env) {
  let rolloutPath = lease.rolloutPath;
  if (!rolloutPath) {
    const thread = await getThread(lease.threadId, env);
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
  if (!stats || Number(stats.size || 0) <= Number(lease.rolloutOffset || 0)) {
    return { lease: { ...lease, rolloutPath }, appended: 0 };
  }
  const start = Math.max(0, Number(lease.rolloutOffset || 0));
  const handle = await fs.open(rolloutPath, "r");
  let body = "";
  try {
    const buffer = Buffer.alloc(Number(stats.size) - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    body = buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close().catch(() => {});
  }
  const parsed = parseAssistantRolloutMessages(body, lease.threadId, start);
  const existing = await listThreadMessages(lease.threadId, env);
  const existingKeys = new Set(existing.map((message) => [
    message.eventId || "",
    message.role,
    String(message.phase || ""),
    String(message.text || "").replace(/\s+/g, " ").trim(),
  ].join("\n")));
  let appended = 0;
  for (const message of parsed) {
    const key = [message.eventId || "", message.role, String(message.phase || ""), message.text.replace(/\s+/g, " ").trim()].join("\n");
    if (existingKeys.has(key)) continue;
    await appendThreadMessage(lease.threadId, {
      role: "assistant",
      source: message.source,
      text: message.text,
      state: "completed",
      cursor: null,
      phase: message.phase,
      eventId: message.eventId,
    }, env);
    existingKeys.add(key);
    appended += 1;
  }
  return { lease: { ...lease, rolloutPath, rolloutOffset: Number(stats.size || 0), heartbeatAt: nowIso() }, appended };
}

export async function syncRuntimeLeases(env = process.env) {
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
    appended += synced.appended || 0;
    const status = await runtimeStatus(lease.threadId, env).catch(() => null);
    if (status) {
      await updateThread(lease.threadId, {
        state: status.state,
        runtime: { ...(status.lease || synced.lease), state: status.state },
      }, env).catch(() => {});
    }
    next.push(synced.lease);
    changed = changed || JSON.stringify(synced.lease) !== JSON.stringify(lease);
  }
  if (changed) await saveRuntimeLeases(next, env);
  return { leases: next, appended };
}

export async function drainAllPendingThreadInputs(env = process.env) {
  const threads = await listThreads(env);
  const results = [];
  for (const thread of threads) {
    const messages = await listThreadMessages(thread.id, env);
    if (messages.some((message) => message.role === "user" && ["queued", "pending_delivery"].includes(message.state))) {
      results.push({ threadId: thread.id, delivered: await deliverPendingThreadInputs(thread.id, env) });
    }
  }
  return results;
}
