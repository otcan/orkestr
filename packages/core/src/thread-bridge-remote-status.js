// Native (V2 Core) execution status for threads delegated to a remote runtime.
// Read through the same scoped, authenticated adapter transport V1 already
// uses for the thread (remote-runtime-http.js); never another endpoint or
// credential. The adapter answers only for the binding of the requested
// remote thread and echoes this thread's public id, which is checked here.
//
// Core's execution phase is not task success: `completed` is a native run
// that ended and was accepted by Core, `awaiting_acceptance` one that ended
// and waits for that acceptance. Neither says whether the request succeeded,
// so `taskOutcome` stays "unknown". An unreadable observation is reported
// as unknown with a closed reason, never as idle.
//
// Pending input: Core gives the age of the oldest eligible inbox input
// (queued or claimed, not held; reserved steering is consumed, deferred
// steering stays queued) with every current Deep read, even when the latest
// run decides the phase. It is presence and age, not a count, so a pending
// inbox leaves `queuedMessages` null (count not observed) rather than a
// guessed number.
import { QUEUED_INPUT_STATES } from "./thread-queue-control.js";
import { backendForBinding, remoteJson } from "./remote-runtime-http.js";
import { remoteWhatsAppRuntimeBinding } from "./thread-remote-runtime-binding.js";

const MAX_AGE_MS = 5000;
// A status read is a quick look, not a wait: bounded well below the
// transport's general timeout.
const STATUS_TIMEOUT_MS = 3000;
const phases = new Set(["queued", "starting", "running", "cancel_requested", "cancelled", "awaiting_acceptance", "completed", "failed", "blocked"]);
const activePhases = new Set(["starting", "running", "cancel_requested"]);
const providers = new Set(["codex", "claude"]);
const failureClasses = new Set(["policy", "authentication", "quota", "billing", "provider", "unknown"]);

async function read(thread, suffix, env, fetchImpl, signal) {
  const remote = remoteWhatsAppRuntimeBinding(thread, env);
  if (!remote) return null;
  const backend = backendForBinding(remote.binding, env);
  return remoteJson(backend, `threads/${encodeURIComponent(remote.remoteThreadId)}/${suffix}`, fetchImpl, signal ? { signal } : {});
}

function fresh(stamp, now) {
  return Number.isSafeInteger(stamp) && stamp <= now && now - stamp <= MAX_AGE_MS;
}

function stamp(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function runId(value) {
  return typeof value === "string" && /^[A-Za-z0-9-]{1,64}$/.test(value) ? value : null;
}

// Model names only (as Core validates them); nothing path-like.
function modelName(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(value) &&
    !value.includes("..") && !value.includes("//") ? value : null;
}

// The closed reason a native observation is missing; never raw remote text.
function unavailableReason(error) {
  const name = String(error?.name || "");
  if (name === "TimeoutError" || name === "AbortError") return "native_status_timeout";
  if (String(error?.message || "").startsWith("whatsapp_remote_backend_not_configured")) return "native_backend_not_configured";
  const status = Number(error?.statusCode || 0);
  if (status === 401 || status === 403) return "native_auth_rejected";
  if (status === 404) return "native_binding_not_found";
  if (status === 410) return "native_binding_revoked";
  return "native_status_unavailable";
}

function role(value, time) {
  if (value === null) return null;
  if (!value || typeof value !== "object" || !phases.has(value.phase)) throw Object.assign(new Error("native_status_invalid"), { reason: "native_status_invalid" });
  if (!fresh(value.observedAtMs, time)) throw Object.assign(new Error("native_status_stale"), { reason: "native_status_stale" });
  return {
    phase: value.phase,
    runId: runId(value.runId),
    observedAtMs: value.observedAtMs,
    lastProgressAtMs: stamp(value.lastProgressAtMs),
    failure: failureClasses.has(value.failure) ? value.failure : null,
    provider: providers.has(value.provider) ? value.provider : null,
    model: modelName(value.model),
    // Unobserved unless the adapter says Core answered the field with null
    // (nothing eligible) or an age; anything else is no evidence either way.
    queueObserved: value.queueObserved === true && (value.queueAgeMs === null || age(value.queueAgeMs)),
    queueAgeMs: value.queueObserved === true && age(value.queueAgeMs) ? value.queueAgeMs : null,
  };
}

function age(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

// Core's eligible pending inbox for this conversation. No Deep status at all
// (204) means no run and nothing eligible queued; a Deep status without the
// field (an older adapter or Core) leaves it unobserved.
function pendingInbox(deep) {
  if (deep === null) return { observed: true, pending: false, oldestAgeMs: null };
  if (!deep.queueObserved) return { observed: false, pending: null, oldestAgeMs: null };
  return deep.queueAgeMs === null ? { observed: true, pending: false, oldestAgeMs: null } : { observed: true, pending: true, oldestAgeMs: deep.queueAgeMs };
}

// The adapter's projection, checked and reduced to what a status needs.
// Throws with a closed `reason` when it cannot stand as evidence.
function nativeObservation(value, thread, time) {
  const invalid = (reason) => { throw Object.assign(new Error(reason), { reason }); };
  if (value?.source !== "core" || value.version !== 1 || !value.roles || typeof value.roles !== "object" ||
      !Object.hasOwn(value.roles, "deep") || !Object.hasOwn(value.roles, "fast") || !Array.isArray(value.queuedInputs)) invalid("native_status_invalid");
  if (value.publicThreadId !== thread.id) invalid("native_scope_mismatch");
  if (!fresh(value.observedAtMs, time)) invalid("native_status_stale");
  return {
    observedAtMs: value.observedAtMs,
    deep: role(value.roles.deep, time),
    fast: role(value.roles.fast, time),
    queued: value.queuedInputs.length,
  };
}

// V1-side inputs for a remote thread that the adapter has not acknowledged
// yet (no remote message id): queued work native Core cannot know about.
function pendingForward(inputs = []) {
  return inputs.filter((message) => message?.role === "user" && QUEUED_INPUT_STATES.includes(message.state) &&
    !String(message.remoteMessageId || "").trim()).length;
}

// The latest V1 input was refused or dropped on its way to native Core
// (whatsapp-remote-local-input.js, remote-runtime-held-inputs.js), so Core
// never ran it. Only those closed forwarding codes are reported.
function forwardFailure(inputs = []) {
  const last = inputs.filter((message) => message?.role === "user").at(-1);
  if (!last || last.state !== "failed" || String(last.remoteMessageId || "").trim() ||
      !String(last.observedVia || "").startsWith("remote_runtime_")) return null;
  const code = String(last.error || "");
  return /^[a-z0-9_:-]{1,120}$/i.test(code) ? code : "remote_forward_failed";
}

function topState(native, inbox, waiting, failedForward) {
  const deep = native.deep;
  if ([native.deep, native.fast].some((entry) => entry && activePhases.has(entry.phase))) return ["working", null];
  if (native.queued || deep?.phase === "queued" || inbox.pending || waiting) return ["queued", null];
  if (failedForward) return ["last_turn_failed", failedForward];
  switch (deep?.phase) {
    case "awaiting_acceptance": return ["awaiting_acceptance", null];
    case "failed": return ["last_turn_failed", deep.failure || "native_run_failed"];
    case "blocked": return ["blocked", deep.failure || "native_run_blocked"];
    case "cancelled": return ["last_turn_cancelled", deep.failure];
    // Idle claims that nothing is pending; without Core's inbox field that
    // is not observed.
    default: return inbox.observed ? ["idle", null] : ["unknown", "native_queue_unobserved"];
  }
}

function present(entry) {
  if (!entry) return null;
  return { phase: entry.phase, runId: entry.runId, observedAtMs: entry.observedAtMs, lastProgressAtMs: entry.lastProgressAtMs,
    failure: entry.failure, provider: entry.provider, model: entry.model };
}

// No native evidence: unknown with a closed reason, never idle.
export function remoteStatusUnavailable(reason, pendingForwardMessages = null) {
  return { state: "unknown", source: "core", runtime: "rust-v2", provider: null, model: null, observedAtMs: null,
    queuedMessages: null, pendingForwardMessages, taskOutcome: "unknown", lastError: reason,
    execution: { available: false, reason } };
}

// Whether `current` is still delegated to exactly the remote thread and
// backend `before` was read through (enabled, same ids).
export function sameRemoteBinding(before, current, env) {
  const a = remoteWhatsAppRuntimeBinding(before, env);
  const b = remoteWhatsAppRuntimeBinding(current, env);
  return Boolean(a && b) && a.backendId === b.backendId && a.remoteThreadId === b.remoteThreadId;
}

// Status fields for a delegated thread, or null for a local one (which then
// keeps its V1 status). `inputs` are the thread's V1 input candidates.
export async function remoteBridgeStatus(thread, env, { fetchImpl = globalThis.fetch, now = Date.now, inputs = [], timeoutMs = STATUS_TIMEOUT_MS } = {}) {
  if (!remoteWhatsAppRuntimeBinding(thread, env)) return null;
  const waiting = pendingForward(inputs);
  let native;
  try {
    const value = await read(thread, "status", env, fetchImpl, AbortSignal.timeout(Math.max(1, Math.min(STATUS_TIMEOUT_MS, Number(timeoutMs) || STATUS_TIMEOUT_MS))));
    native = nativeObservation(value, thread, now());
  } catch (error) {
    return remoteStatusUnavailable(error?.reason || unavailableReason(error), waiting);
  }
  const inbox = pendingInbox(native.deep);
  const [state, lastError] = topState(native, inbox, waiting, forwardFailure(inputs));
  const activeRole = ["deep", "fast"].find((name) => native[name] && activePhases.has(native[name].phase)) || null;
  const reporting = native[activeRole || "deep"] || native.fast;
  return {
    state,
    source: "core",
    runtime: "rust-v2",
    provider: reporting?.provider || null,
    model: reporting?.model || null,
    observedAtMs: native.observedAtMs,
    // An exact count only when every part of it was counted: Core's inbox
    // gives presence and age only, so pending or unobserved inbox input
    // leaves the total unobserved (null), never a guessed number.
    queuedMessages: inbox.observed && !inbox.pending && native.deep?.phase !== "queued" ? native.queued + waiting : null,
    pendingForwardMessages: waiting,
    taskOutcome: "unknown",
    lastError,
    execution: {
      available: true,
      phase: native.deep?.phase || "none",
      activeRole,
      queuedInputs: native.queued,
      pendingInput: inbox,
      roles: { deep: present(native.deep), fast: present(native.fast) },
    },
  };
}

export async function remoteInputActivity(thread, input, env, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (!remoteWhatsAppRuntimeBinding(thread, env)) return null;
  try {
    const value = await read(thread, `activity?publicMessageId=${encodeURIComponent(input.id)}`, env, fetchImpl);
    if (value?.publicThreadId !== thread.id || value.publicMessageId !== input.id || !fresh(value.observedAtMs, now())) return { state: "unknown" };
    return { state: value.active ? "working" : value.finalReady ? "awaiting_delivery" : "waiting_for_reply", observedAtMs: value.observedAtMs };
  } catch {
    return { state: "unknown" };
  }
}
