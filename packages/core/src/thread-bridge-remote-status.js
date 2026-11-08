import { remoteWhatsAppRuntimeBinding } from "./thread-remote-runtime-binding.js";

const MAX_AGE_MS = 5000;
const phases = new Set(["queued", "starting", "running", "cancel_requested", "cancelled", "awaiting_acceptance", "completed", "failed", "blocked"]);

async function read(thread, suffix, env, fetchImpl) {
  const remote = remoteWhatsAppRuntimeBinding(thread, env);
  if (!remote) return null;
  const { backendForBinding, remoteJson } = await import("../../connectors/src/whatsapp-remote-runtime.js");
  const backend = backendForBinding(remote.binding, env);
  return remoteJson(backend, `threads/${encodeURIComponent(remote.remoteThreadId)}/${suffix}`, fetchImpl);
}

function fresh(stamp, now) {
  return Number.isSafeInteger(stamp) && stamp <= now && now - stamp <= MAX_AGE_MS;
}

export async function remoteBridgeStatus(thread, env, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
  if (!remoteWhatsAppRuntimeBinding(thread, env)) return null;
  const unknown = { state: "unknown", source: "core", runtime: "rust-v2", model: null, queuedMessages: null,
    observedAtMs: null, taskOutcome: "unknown", lastError: "core_status_unavailable" };
  try {
    const value = await read(thread, "status", env, fetchImpl);
    const time = now();
    if (value?.source !== "core" || value.version !== 1 || value.publicThreadId !== thread.id ||
        !fresh(value.observedAtMs, time) || !Array.isArray(value.queuedInputs) || !value.roles ||
        !Object.hasOwn(value.roles, "deep") || !Object.hasOwn(value.roles, "fast")) return unknown;
    const roles = Object.values(value.roles).filter(Boolean);
    if (roles.some((role) => !phases.has(role.phase) || !fresh(role.observedAtMs, time))) return unknown;
    const deep = value.roles.deep;
    const active = roles.some((role) => ["starting", "running", "cancel_requested"].includes(role.phase));
    const queued = value.queuedInputs.length;
    const state = active ? "working" : queued || (deep?.phase === "queued" && deep.runId) ? "queued" : deep?.phase === "blocked" ? "blocked" :
      deep?.phase === "failed" ? "last_turn_failed" : deep?.phase === "awaiting_acceptance" ? "awaiting_acceptance" : "idle";
    return { state, source: "core", runtime: "rust-v2", model: null, observedAtMs: value.observedAtMs,
      queuedMessages: queued, queuedInputs: value.queuedInputs, roles: value.roles,
      taskOutcome: "unknown", lastError: deep?.failure || null };
  } catch {
    return unknown;
  }
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
