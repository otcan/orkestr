import crypto from "node:crypto";
import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const progressCache = new Map();
const defaultCaptureLines = 80;
const defaultTailLines = 20;
const defaultWorkingAfterPromptMs = 30 * 60 * 1000;
const defaultFrozenAfterMs = 60 * 1000;

function positiveNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function durationMs(value, fallback) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (["0", "off", "false", "disabled"].includes(raw)) return 0;
  return positiveNumber(raw) ?? fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizedLines(text) {
  return String(text || "")
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""))
    .filter((line) => line.trim());
}

function recentPaneText(text, lines = 16) {
  return String(text || "")
    .split("\n")
    .slice(-Math.max(1, lines))
    .join("\n");
}

function tailHash(lines) {
  return crypto.createHash("sha256").update(lines.join("\n")).digest("hex");
}

export function paneWorkingLine(line) {
  return (
    /^[•◦]\s*(?:Working|Thinking|Running|Processing)\b/i.test(line) ||
    /^Codex is still preparing (?:a )?response\b/i.test(line) ||
    /^(?:Waiting for background terminal|Working|Thinking|Running|Processing)\b.*\b(?:esc|ctrl-c) to interrupt\b/i.test(line)
  );
}

function paneWorkingLineDurationMs(line) {
  const match = String(line || "").match(/\(([^)]*)\)/);
  if (!match) return null;
  let total = 0;
  for (const unitMatch of match[1].matchAll(/(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)\b/gi)) {
    const value = Number(unitMatch[1]);
    if (!Number.isFinite(value)) continue;
    const unit = unitMatch[2].toLowerCase();
    if (unit.startsWith("h")) total += value * 60 * 60 * 1000;
    else if (unit.startsWith("m")) total += value * 60 * 1000;
    else total += value * 1000;
  }
  return total > 0 ? total : null;
}

function paneWorkingLineStillActiveAfterPrompt(line, distanceFromTail) {
  const duration = paneWorkingLineDurationMs(line);
  return duration !== null && duration <= defaultWorkingAfterPromptMs && distanceFromTail <= 6;
}

export function paneBackgroundTerminalLine(line) {
  return /^[•◦]?\s*Waiting for background terminal\b/i.test(String(line || "").trim());
}

export function panePromptLine(line) {
  return /^(?:›|>)(?:\s|$)/.test(line) && !/^(?:›|>)\s*\d+[.)]/.test(line);
}

function paneConversationInterruptedLine(line) {
  const text = String(line || "").trim();
  return /Conversation interrupted\s*[-–—]\s*tell the model what to do differently/i.test(text) ||
    /^<turn_aborted>$/i.test(text);
}

export function paneConversationInterrupted(text) {
  return normalizedLines(text).map((line) => line.trim()).slice(-20).some(paneConversationInterruptedLine);
}

function paneConversationInterruptionLine(text) {
  return normalizedLines(text)
    .map((line) => line.trim())
    .slice(-20)
    .findLast(paneConversationInterruptedLine) || "";
}

function paneConversationInterruptionHash(text) {
  const lines = normalizedLines(text).map((line) => line.trim()).slice(-20);
  const index = lines.findLastIndex(paneConversationInterruptedLine);
  if (index < 0) return "";
  return tailHash(lines.slice(index, Math.min(lines.length, index + 4)));
}

export function paneNeedInputMenuVisible(text) {
  const body = String(text || "");
  return /^Question\s+\d+\/\d+\s+\(\d+\s+unanswered\)/im.test(body) &&
    /^\s*(?:›\s*)?\d+\.\s+\S+/im.test(body) &&
    /\benter to submit answer\b/i.test(body);
}

export function panePlanImplementationMenuVisible(text) {
  return /Implement this plan\?/i.test(recentPaneText(text));
}

export function panePlanImplementationReady(text) {
  const body = recentPaneText(text);
  return panePlanImplementationMenuVisible(body) && /^\s*›\s*1\.\s*Yes,\s*implement this plan\b/im.test(body);
}

export function paneResumeDirectoryPrompt(text) {
  const body = String(text || "");
  return /Choose working directory to resume this session/i.test(body) && /Press enter to continue/i.test(body);
}

export function paneCodexUpdatePromptChoice(text) {
  const lines = normalizedLines(text).map((line) => line.trim()).slice(-12);
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

export function codexModeFromPaneText(text) {
  const statusLine = normalizedLines(text)
    .map((line) => line.trim())
    .slice(-12)
    .reverse()
    .find((line) => /\bgpt-[a-z0-9_.-]+/i.test(line) && /\b(?:low|medium|high|xhigh)\b/i.test(line)) || "";
  if (!statusLine) return null;
  if (/\bPlan mode\b/i.test(statusLine)) return "plan";
  if (/\bgpt-[a-z0-9_.-]+/i.test(statusLine)) return "code";
  return null;
}

export function paneWorking(text) {
  const lines = normalizedLines(text).map((line) => line.trim()).slice(-20);
  if (paneNeedInputMenuVisible(text)) return true;
  const lastWorkingIndex = lines.findLastIndex(paneWorkingLine);
  if (lastWorkingIndex < 0) return false;
  const lastPromptIndex = lines.findLastIndex(panePromptLine);
  if (lastWorkingIndex > lastPromptIndex) return true;
  return paneWorkingLineStillActiveAfterPrompt(lines[lastWorkingIndex], lines.length - lastWorkingIndex);
}

export function paneStaleWorkingPrompt(text) {
  const lines = normalizedLines(text).map((line) => line.trim()).slice(-20);
  const lastWorkingIndex = lines.findLastIndex(paneWorkingLine);
  if (lastWorkingIndex < 0) return false;
  const lastPromptIndex = lines.findLastIndex(panePromptLine);
  return lastPromptIndex > lastWorkingIndex &&
    paneWorkingLineStillActiveAfterPrompt(lines[lastWorkingIndex], lines.length - lastWorkingIndex);
}

export function paneBackgroundWork(text) {
  const lines = normalizedLines(text).map((line) => line.trim()).slice(-20);
  const lastBackgroundIndex = lines.findLastIndex(paneBackgroundTerminalLine);
  if (lastBackgroundIndex < 0) return false;
  const lastPromptIndex = lines.findLastIndex(panePromptLine);
  return lastBackgroundIndex > lastPromptIndex || lastBackgroundIndex >= Math.max(0, lines.length - 6);
}

export function panePromptReady(text) {
  const lines = normalizedLines(text).map((line) => line.trim()).slice(-8);
  return lines.some(panePromptLine);
}

function paneHasRecentError(lines) {
  return lines.slice(-8).some((line) => (
    /\b(?:delivery failed|not delivered|unrecognized command|can't find pane|command failed|failed to deliver)\b/i.test(line) &&
    !/failed tests?/i.test(line)
  ));
}

function codexAuthInvalidReason(text) {
  const body = String(text || "");
  if (/\btoken_invalidated\b/i.test(body)) return "codex_token_invalidated";
  if (/authentication token has been invalidated/i.test(body)) return "codex_token_invalidated";
  if (/MCP client for [`'"]?codex_apps[`'"]?\s+failed to start/i.test(body) && /\b(?:401|auth|token|sign in)\b/i.test(body)) {
    return "codex_apps_auth_invalid";
  }
  if (/MCP startup incomplete\s*\(failed:\s*codex_apps\)/i.test(body) && /\b(?:401|auth|token|sign in)\b/i.test(body)) {
    return "codex_apps_auth_invalid";
  }
  return "";
}

function summaryForProgress({ stateHint, codexMode, planImplementationReady, planImplementationMenuVisible, codexAuthInvalid }) {
  if (codexAuthInvalid) return "Codex sign-in expired";
  if (planImplementationReady || planImplementationMenuVisible) return "Implement plan?";
  if (stateHint === "error") return "Error";
  if (stateHint === "frozen") return "Frozen";
  if (stateHint === "awaiting_input") return "Waiting for input";
  if (stateHint === "planning" || codexMode === "plan") return "Planning";
  if (stateHint === "working") return "Working";
  if (stateHint === "ready") return "Ready";
  return "Starting";
}

export function paneProgressFromText(text, options = {}) {
  const tailLineCount = Math.max(1, Math.floor(positiveNumber(options.tailLines) || defaultTailLines));
  const lines = normalizedLines(text);
  const tailLines = lines.slice(-tailLineCount);
  const codexMode = codexModeFromPaneText(text);
  const planImplementationReady = panePlanImplementationReady(text);
  const planImplementationMenuVisible = panePlanImplementationMenuVisible(text);
  const needsResumeDirectoryConfirmation = paneResumeDirectoryPrompt(text);
  const codexUpdatePromptChoice = paneCodexUpdatePromptChoice(text);
  const needsCodexUpdatePromptSkip = Boolean(codexUpdatePromptChoice);
  const conversationInterrupted = paneConversationInterrupted(text);
  const codexAuthInvalid = codexAuthInvalidReason(text);
  const backgroundWork = paneBackgroundWork(text);
  const working = paneWorking(text) || backgroundWork;
  const staleWorkingPrompt = paneStaleWorkingPrompt(text);
  const promptReady = !working && panePromptReady(text);
  let stateHint = "unknown";
  if (codexAuthInvalid || paneHasRecentError(tailLines)) stateHint = "error";
  else if (planImplementationReady || planImplementationMenuVisible || codexMode === "plan") stateHint = "planning";
  else if (needsResumeDirectoryConfirmation || needsCodexUpdatePromptSkip || paneNeedInputMenuVisible(text)) stateHint = "awaiting_input";
  else if (working) stateHint = "working";
  else if (promptReady) stateHint = "ready";
  const summary = summaryForProgress({
    stateHint,
    codexMode,
    planImplementationReady,
    planImplementationMenuVisible,
    codexAuthInvalid: Boolean(codexAuthInvalid),
  });
  return {
    capturedAt: nowIso(),
    stateHint,
    summary,
    tailLines,
    tailHash: tailHash(tailLines),
    promptReady,
    working,
    backgroundWork,
    staleWorkingPrompt,
    conversationInterrupted,
    conversationInterruptedLine: conversationInterrupted ? paneConversationInterruptionLine(text) : "",
    conversationInterruptedHash: conversationInterrupted ? paneConversationInterruptionHash(text) : "",
    codexAuthInvalid: Boolean(codexAuthInvalid),
    codexAuthInvalidReason: codexAuthInvalid,
    codexAuthInvalidMessage: codexAuthInvalid ? "Codex reported an invalidated auth token. Reconnect Codex before starting coding agents." : "",
    codexMode,
    planImplementationReady,
    planImplementationMenuVisible,
    needsResumeDirectoryConfirmation,
    needsCodexUpdatePromptSkip,
    codexUpdatePromptChoice,
  };
}

export function publicPaneProgress(progress) {
  if (!progress || typeof progress !== "object") return null;
  const { paneText, cacheKey, sampledAtMs, cached, observedStateHint, observedSummary, ...safe } = progress;
  return safe;
}

function progressCacheTtlMs(progress, env = process.env) {
  const active = durationMs(env.ORKESTR_PANE_PROGRESS_ACTIVE_MS, 1000);
  const idle = durationMs(env.ORKESTR_PANE_PROGRESS_IDLE_MS, 5000);
  const state = String(progress?.stateHint || "").toLowerCase();
  if (state === "working" || state === "planning" || state === "awaiting_input" || state === "frozen") return active;
  return idle;
}

async function testCaptureFingerprint(env = process.env) {
  const captureText = env.TMUX_CAPTURE_TEXT ?? process.env.TMUX_CAPTURE_TEXT;
  if (captureText != null) return `text:${String(captureText)}`;
  const captureFile = env.TMUX_CAPTURE_FILE ?? process.env.TMUX_CAPTURE_FILE;
  if (!captureFile) return "";
  const stats = await fs.stat(String(captureFile)).catch(() => null);
  if (!stats?.isFile()) return `file:${captureFile}:missing`;
  return `file:${captureFile}:${stats.size}:${stats.mtimeMs}`;
}

function cacheIdentity(input = {}, env = process.env, fingerprint = "") {
  const key = String(input.threadId || input.leaseId || input.paneId || "").trim();
  return [
    key || "pane",
    String(input.paneId || ""),
    String(input.sessionName || ""),
    String(input.lines || env.ORKESTR_PANE_PROGRESS_CAPTURE_LINES || ""),
    String(input.tailLines || env.ORKESTR_PANE_PROGRESS_TAIL_LINES || ""),
    fingerprint,
  ].join("|");
}

async function capturePane(paneId, lines = defaultCaptureLines, env = process.env) {
  if (!paneId) return "";
  const captureLines = Math.max(20, Math.floor(positiveNumber(lines) || defaultCaptureLines));
  const { stdout } = await execFileAsync(
    "tmux",
    ["capture-pane", "-t", paneId, "-p", "-J", "-S", `-${captureLines}`],
    { env: { ...process.env, ...env } },
  );
  return String(stdout || "");
}

export async function samplePaneProgress(input = {}, env = process.env) {
  const paneId = String(input.paneId || "").trim();
  const fingerprint = await testCaptureFingerprint(env);
  const cacheKey = cacheIdentity(input, env, fingerprint);
  const cached = progressCache.get(cacheKey);
  if (cached && !input.force) {
    const ttl = progressCacheTtlMs(cached, env);
    if (ttl > 0 && cached.sampledAtMs + ttl > Date.now()) {
      return { ...cached, cached: true };
    }
  }
  const captureLines = Math.floor(positiveNumber(input.lines) || positiveNumber(env.ORKESTR_PANE_PROGRESS_CAPTURE_LINES) || defaultCaptureLines);
  const tailLines = Math.floor(positiveNumber(input.tailLines) || positiveNumber(env.ORKESTR_PANE_PROGRESS_TAIL_LINES) || defaultTailLines);
  const paneText = await capturePane(paneId, captureLines, env);
  const previous = cached || null;
  const sampledAtMs = Date.now();
  const progress = {
    ...paneProgressFromText(paneText, { tailLines }),
    threadId: input.threadId || null,
    leaseId: input.leaseId || null,
    paneId,
    sessionName: input.sessionName || null,
    pendingCount: Number(input.pendingCount || 0),
    runningCount: Number(input.runningCount || 0),
    awaitingAckCount: Number(input.awaitingAckCount || 0),
    paneText,
    cacheKey,
    sampledAtMs,
  };
  const observedStateHint = progress.stateHint;
  const observedSummary = progress.summary;
  const sameProgress = Boolean(previous) &&
    previous.tailHash === progress.tailHash &&
    (previous.observedSummary || previous.summary) === observedSummary &&
    (previous.observedStateHint || previous.stateHint) === observedStateHint;
  progress.observedStateHint = observedStateHint;
  progress.observedSummary = observedSummary;
  progress.changed = !sameProgress;
  progress.stableSinceMs = sameProgress
    ? Number(previous.stableSinceMs || previous.sampledAtMs || sampledAtMs)
    : sampledAtMs;
  progress.stableForMs = Math.max(0, sampledAtMs - progress.stableSinceMs);
  const frozenAfterMs = durationMs(env.ORKESTR_PANE_FROZEN_AFTER_MS, defaultFrozenAfterMs);
  if (
    frozenAfterMs > 0 &&
    progress.stateHint === "working" &&
    progress.staleWorkingPrompt &&
    progress.stableForMs >= frozenAfterMs
  ) {
    progress.stateHint = "frozen";
    progress.summary = "Frozen";
    progress.working = false;
    progress.frozen = true;
  } else {
    progress.frozen = false;
  }
  progressCache.set(cacheKey, progress);
  return { ...progress, cached: false };
}

export function cachedPaneProgress(input = {}, env = process.env) {
  const keyPrefix = `${String(input.threadId || input.leaseId || input.paneId || "").trim() || "pane"}|`;
  for (const progress of progressCache.values()) {
    if (!String(progress.cacheKey || "").startsWith(keyPrefix)) continue;
    const ttl = progressCacheTtlMs(progress, env);
    if (ttl > 0 && progress.sampledAtMs + ttl > Date.now()) return { ...progress, cached: true };
  }
  return null;
}

export function clearPaneProgressCache() {
  progressCache.clear();
}
