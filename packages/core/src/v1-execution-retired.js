// V1 "execution retired" guard.
//
// Orkestr V2 runs owner threads; V1 stays the WhatsApp transport, relay,
// mailbox and desktop-lease service. When this guard is on, V1 refuses to
// start a model turn on a thread unless the thread is delegated to the remote
// (V2) runtime, which forwards instead of running, or is on an explicit
// allowlist. It is checked at every runtime admission point (see
// runtime-leases.js deliverPendingThreadInputs, codex-app-server.js,
// runtime-claude-code-adapter.js and tenant-api-agent.js), so owner messages,
// timers, API input, mailbox routes and job signals are all covered.
//
// A refusal never touches intake: the input stays recorded and queued (like a
// queue hold), so delegating or allowlisting the thread later still delivers
// it. Each refused input gets one `thread_turn_refused_v1_retired` audit event
// and a marker on the message; the operator alert hook is rate limited per
// thread.
//
// Configuration (default OFF):
// - ORKESTR_V1_EXECUTION_RETIRED: "1"/"true" forces the guard on, "0"/"false"
//   forces it off (kill switch). Unset: the flag file decides.
// - Flag file: $ORKESTR_HOME/v1-execution-retired.json (or
//   ORKESTR_V1_EXECUTION_RETIRED_FILE): {"enabled": true, "allowlist": [...]}.
//   Read on use (cached briefly), so the lead can flip it without a restart.
// - ORKESTR_V1_EXECUTION_ALLOWLIST: thread ids or names, comma or space
//   separated; merged with the file allowlist.
// - ORKESTR_V1_EXECUTION_RETIRED_ALERT_INTERVAL_MS: per-thread operator alert
//   interval (default 15 minutes).
// - ORKESTR_V1_EXECUTION_RETIRED_ALERT_COMMAND: optional absolute path of an
//   executable (for example orkestr-notify) that receives the alert as JSON on
//   stdin. No shell is used.
// - ORKESTR_V1_EXECUTION_RETIRED_MAX_INPUT_AGE_MS: a refused input older than
//   this (default 24 hours) is cancelled instead of being run later, so turning
//   the guard off never replays a stale backlog.
//
// A flag file that exists but cannot be read or parsed keeps the last good
// file setting; with none, the guard fails closed (on). Delivery, relay and
// forwarding are unaffected either way, and ORKESTR_V1_EXECUTION_RETIRED=0
// still overrides.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { appHome } from "../../storage/src/paths.js";
import { appendEvent } from "../../storage/src/store.js";
import { remoteWhatsAppRuntimeBinding } from "./thread-remote-runtime-binding.js";
import { listThreadMessageCandidates, updateThreadMessage } from "./threads.js";

export const v1ExecutionRetiredEvent = "thread_turn_refused_v1_retired";
export const v1ExecutionRetiredDeliveryState = "refused_v1_execution_retired";
export const v1ExecutionExpiredDeliveryState = "expired_v1_execution_retired";
export const v1ExecutionExpiredEvent = "thread_input_expired_v1_retired";
const pendingStates = ["queued", "pending_delivery"];
// Delivery states that carry no in-flight provenance; only these are replaced
// by the refusal marker. Others (for example codex_acceptance_uncertain) are
// kept so recovery still sees them after the guard is turned off.
const neutralDeliveryStates = new Set(["", "queued"]);
const fileCacheMs = 2_000;
const defaultAlertIntervalMs = 15 * 60_000;
const defaultMaxInputAgeMs = 24 * 60 * 60_000;

let fileCache = { path: "", readAt: 0, value: null };
let lastGoodFile = { path: "", value: null };
let lastConfigError = "";
const lastAlertAt = new Map();
// Threads whose refused inputs were already settled after the guard allowed
// them, so the allowed path scans each thread at most once per refusal.
const settledThreads = new Set();
let alertHook = null;

function clean(value) {
  return String(value || "").trim();
}

function flagValue(value) {
  const text = clean(value).toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return null;
}

function listValue(value) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  return clean(value).split(/[\s,]+/).map(clean).filter(Boolean);
}

export function v1ExecutionRetiredFile(env = process.env) {
  return path.resolve(clean(env.ORKESTR_V1_EXECUTION_RETIRED_FILE) || path.join(appHome(env), "v1-execution-retired.json"));
}

async function readFlagFile(env = process.env) {
  const filePath = v1ExecutionRetiredFile(env);
  const now = Date.now();
  if (fileCache.path === filePath && now - fileCache.readAt < fileCacheMs) return fileCache.value;
  let value = null;
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("v1_execution_retired_config_not_object");
    value = parsed;
    lastGoodFile = { path: filePath, value };
    lastConfigError = "";
  } catch (error) {
    // A missing file means "not configured". A file that exists but cannot be
    // read or parsed (for example mid-write) keeps the last good setting, and
    // with none it fails closed: refusing turns is the safe side here, since
    // relay, delivery and V2 forwarding never depend on this guard.
    if (error?.code !== "ENOENT") {
      value = lastGoodFile.path === filePath && lastGoodFile.value
        ? lastGoodFile.value
        : { enabled: true, allowlist: [], invalid: true };
      const message = clean(error?.message).slice(0, 200);
      if (message !== lastConfigError) {
        lastConfigError = message;
        await appendEvent({ type: "v1_execution_retired_config_invalid", error: message, failClosed: value.invalid === true }, env).catch(() => {});
      }
    } else {
      lastGoodFile = { path: "", value: null };
      lastConfigError = "";
    }
  }
  fileCache = { path: filePath, readAt: now, value };
  return value;
}

export async function v1ExecutionRetiredConfig(env = process.env) {
  const file = await readFlagFile(env);
  const envFlag = flagValue(env.ORKESTR_V1_EXECUTION_RETIRED);
  const enabled = envFlag !== null ? envFlag : flagValue(file?.enabled) === true;
  const allowlist = new Set([...listValue(env.ORKESTR_V1_EXECUTION_ALLOWLIST), ...listValue(file?.allowlist)]);
  return { enabled, allowlist, source: envFlag !== null ? "env" : file ? "file" : "default" };
}

function allowlisted(thread = {}, allowlist = new Set()) {
  return [thread.id, thread.name, thread.slug].map(clean).some((key) => key && allowlist.has(key));
}

// Decides whether V1 may start a model turn on this thread. Pure apart from
// reading the flag; it never writes.
export async function v1ExecutionDecision(thread = null, env = process.env) {
  const config = await v1ExecutionRetiredConfig(env);
  if (!config.enabled) return { allowed: true, reason: "guard_off", config };
  if (remoteWhatsAppRuntimeBinding(thread, env)) return { allowed: false, delegated: true, reason: "delegated_to_remote_runtime", config };
  if (allowlisted(thread || {}, config.allowlist)) return { allowed: true, reason: "allowlisted", config };
  return { allowed: false, delegated: false, reason: "v1_execution_retired", config };
}

function alertIntervalMs(env = process.env) {
  const parsed = Number(env.ORKESTR_V1_EXECUTION_RETIRED_ALERT_INTERVAL_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : defaultAlertIntervalMs;
}

function runAlertCommand(command, payload) {
  return new Promise((resolve) => {
    const child = execFile(command, [], { timeout: 10_000, windowsHide: true }, (error) => resolve(!error));
    child.stdin?.on("error", () => {});
    child.stdin?.end(`${JSON.stringify(payload)}\n`);
  });
}

async function defaultAlert(payload, env = process.env) {
  const { recordWatcherAlert } = await import("./watcher-alerts.js");
  await recordWatcherAlert({
    severity: "warning",
    source: "v1_execution_retired",
    code: v1ExecutionRetiredEvent,
    message: `V1 refused to start a model turn on a thread that is neither delegated to V2 nor allowlisted (${payload.refusedCount} input(s) held).`,
    threadId: payload.threadId,
    details: { entryPoint: payload.entryPoint, refusedCount: payload.refusedCount, threadName: payload.threadName },
  }, env).catch(() => {});
  const command = clean(env.ORKESTR_V1_EXECUTION_RETIRED_ALERT_COMMAND);
  if (command && path.isAbsolute(command)) await runAlertCommand(command, payload).catch(() => false);
}

// Test and wiring seam: replaces the operator alert (watcher alert + optional
// command). Pass null to restore the default.
export function setV1ExecutionRetiredAlertHook(hook) {
  alertHook = typeof hook === "function" ? hook : null;
}

export function resetV1ExecutionRetiredForTest() {
  fileCache = { path: "", readAt: 0, value: null };
  lastGoodFile = { path: "", value: null };
  lastConfigError = "";
  lastAlertAt.clear();
  settledThreads.clear();
  alertHook = null;
}

// Test seam: forces the next read of the flag file (keeps the last good value).
export function expireV1ExecutionRetiredFileCacheForTest() {
  fileCache = { path: "", readAt: 0, value: null };
}

function maxInputAgeMs(env = process.env) {
  const parsed = Number(env.ORKESTR_V1_EXECUTION_RETIRED_MAX_INPUT_AGE_MS);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : defaultMaxInputAgeMs;
}

function inputAgeMs(message = {}, now = Date.now()) {
  const at = Date.parse(message.createdAt || message.timestamp || message.v1ExecutionRefusedAt || "");
  return Number.isFinite(at) ? now - at : 0;
}

async function pendingUserInputs(threadId, env) {
  return (await listThreadMessageCandidates(threadId, { states: pendingStates }, env).catch(() => []))
    .filter((message) => message.role === "user" && pendingStates.includes(clean(message.state)));
}

// Cancels refused inputs older than the max age (never replay stale input) and,
// when the guard now allows the thread, clears the marker from the rest so they
// run normally and a later refusal audits them again.
async function settleRefusedInputs(thread, pending, env, { clearFresh, entryPoint }) {
  const now = Date.now();
  const limit = maxInputAgeMs(env);
  const expired = [];
  for (const message of pending.filter((entry) => clean(entry.v1ExecutionRefusedAt))) {
    if (inputAgeMs(message, now) > limit) {
      const updated = await updateThreadMessage(thread.id, message.id, {
        state: "cancelled",
        deliveryState: v1ExecutionExpiredDeliveryState,
        error: "v1_execution_retired_input_expired",
      }, env, { expectedFields: { state: message.state } }).catch(() => null);
      if (updated) expired.push(message);
    } else if (clearFresh) {
      await updateThreadMessage(thread.id, message.id, {
        v1ExecutionRefusedAt: null,
        ...(clean(message.deliveryState) === v1ExecutionRetiredDeliveryState ? { deliveryState: "queued" } : {}),
      }, env, { expectedFields: { state: message.state } }).catch(() => null);
    }
  }
  for (const message of expired) {
    await appendEvent({
      type: v1ExecutionExpiredEvent,
      threadId: thread.id,
      messageId: message.id,
      source: clean(message.source) || null,
      timerId: clean(message.timerId) || null,
      entryPoint,
      maxInputAgeMs: limit,
    }, env).catch(() => {});
  }
  return expired.map((message) => message.id);
}

async function maybeAlert(payload, env = process.env) {
  const now = Date.now();
  const last = lastAlertAt.get(payload.threadId) || 0;
  if (last && now - last < alertIntervalMs(env)) {
    return false;
  }
  lastAlertAt.set(payload.threadId, now);
  await (alertHook || defaultAlert)(payload, env);
  await appendEvent({ type: "v1_execution_retired_alert_sent", threadId: payload.threadId, entryPoint: payload.entryPoint }, env).catch(() => {});
  return true;
}

// Called at each runtime admission point before a model turn could start.
// Returns null when the turn may start (guard off, or allowlisted). Otherwise
// returns a refusal and the caller must return without starting a turn. A
// delegated thread is not a refusal: the caller's forwarding path handles it,
// so nothing is logged for it here.
export async function refuseV1ExecutionIfRetired(thread = null, env = process.env, context = {}) {
  if (!thread?.id) return null;
  const decision = await v1ExecutionDecision(thread, env);
  const entryPoint = clean(context.entryPoint) || "unknown";
  if (decision.allowed) {
    // Settle any held backlog once per thread per process (and again after each
    // refusal), so turning the guard off never bursts stale inputs.
    if (!settledThreads.has(thread.id)) {
      settledThreads.add(thread.id);
      await settleRefusedInputs(thread, await pendingUserInputs(thread.id, env), env, { clearFresh: true, entryPoint });
    }
    return null;
  }
  if (decision.delegated) return { refused: true, delegated: true, reason: decision.reason };
  settledThreads.delete(thread.id);
  const pending = await pendingUserInputs(thread.id, env);
  const expiredIds = new Set(await settleRefusedInputs(thread, pending, env, { clearFresh: false, entryPoint }));
  const fresh = pending.filter((message) => !expiredIds.has(message.id) && !clean(message.v1ExecutionRefusedAt));
  const refusedAt = new Date().toISOString();
  const marked = [];
  for (const message of fresh) {
    // The input stays queued, so the refusal is visible and audited once per
    // input. In-flight delivery provenance is never overwritten.
    const neutral = clean(message.state) === "queued" && neutralDeliveryStates.has(clean(message.deliveryState).toLowerCase());
    const updated = await updateThreadMessage(thread.id, message.id, {
      ...(neutral ? { deliveryState: v1ExecutionRetiredDeliveryState } : {}),
      v1ExecutionRefusedAt: refusedAt,
    }, env, { expectedFields: { state: message.state } }).catch(() => null);
    if (updated) marked.push(message);
  }
  if (marked.length) {
    for (const message of marked) {
      await appendEvent({
        type: v1ExecutionRetiredEvent,
        threadId: thread.id,
        messageId: message.id,
        source: clean(message.source) || null,
        timerId: clean(message.timerId) || null,
        entryPoint,
        runtimeKind: clean(thread.runtimeKind || thread.runtime?.runtimeKind) || null,
        reason: decision.reason,
        configSource: decision.config.source,
      }, env).catch(() => {});
    }
    await maybeAlert({
      type: v1ExecutionRetiredEvent,
      threadId: thread.id,
      threadName: clean(thread.name) || null,
      entryPoint,
      refusedCount: marked.length,
      messageIds: marked.map((message) => message.id),
      refusedAt,
    }, env).catch(() => false);
  }
  return { refused: true, delegated: false, reason: decision.reason, refusedMessageIds: marked.map((message) => message.id) };
}
