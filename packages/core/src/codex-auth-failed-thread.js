// Thread-level handling for Codex auth faults. An auth fault is not a runtime
// fault: the thread is parked in `failed_auth`, its Codex session is kept, and
// queued inputs stay pending until Codex auth is repaired.
import path from "node:path";
import { appendEvent } from "../../storage/src/store.js";
import { activeCodexRuntimeAuthInvalid, markCodexAuthHealthRepaired } from "./codex-auth-health.js";
import { redactCodexSecrets } from "./codex-auth-failure.js";
import { claimCodexAuthProbe, codexHomeForThread } from "./codex-auth-probe.js";
import { clean, nowIso } from "./codex-app-server-common.js";
import { getThread, getThreadMessage, listThreads, updateThread, updateThreadMessage } from "./threads.js";

export const failedAuthState = "failed_auth";
export const failedAuthDeliveryState = "awaiting_codex_auth";

export function threadInFailedAuth(thread = {}) {
  return clean(thread?.state) === failedAuthState ||
    clean(thread?.runtime?.state) === failedAuthState ||
    clean(thread?.runtime?.authFailure?.state) === "broken";
}

export function failedAuthRuntimeFields({ reason = "", turnId = "", error = "", previous = null } = {}) {
  const lastProbeAt = clean(previous?.lastProbeAt) || null;
  return {
    state: failedAuthState,
    authFailure: {
      state: "broken",
      reason: clean(reason) || "codex_runtime_auth_invalid",
      turnId: clean(turnId) || null,
      summary: redactCodexSecrets(clean(error)) || null,
      detectedAt: nowIso(),
      ...(lastProbeAt ? { lastProbeAt } : {}),
    },
  };
}

export function codexAuthHoldRetryMs(env = process.env) {
  const parsed = Number(env.ORKESTR_CODEX_AUTH_HOLD_RETRY_MS ?? 60_000);
  return Number.isFinite(parsed) ? Math.max(1000, parsed) : 60_000;
}

function codexAuthPathForThread(thread, env) {
  return path.join(codexHomeForThread(thread, env), "auth.json");
}

// Active (unrepaired) Codex auth-health fault for the thread's Codex home.
export async function activeCodexAuthFaultForThread(thread = {}, env = process.env) {
  return await activeCodexRuntimeAuthInvalid({ env, codexAuthPath: codexAuthPathForThread(thread, env) }).catch(() => null);
}

async function releaseFailedAuthThread(thread, env, resolution = "repaired") {
  const releasedAt = nowIso();
  const updated = await updateThread(thread.id, {
    state: "ready",
    lastError: null,
    runtime: {
      ...(thread.runtime || {}),
      state: "ready",
      authFailure: { ...(thread.runtime?.authFailure || {}), state: resolution, repairedAt: releasedAt, probeMessageId: null },
      updatedAt: releasedAt,
    },
  }, env).catch(() => thread);
  await appendEvent({
    type: "codex_auth_failed_thread_released",
    threadId: thread.id,
    reason: clean(thread.runtime?.authFailure?.reason) || null,
    resolution,
  }, env).catch(() => {});
  return updated || thread;
}

// Returns `{ held: true }` when the input must wait for Codex auth repair, or
// `{ held: false, thread }` when delivery may proceed (releasing a repaired
// failed_auth thread back to ready without resetting its Codex session).
export async function holdInputWhileCodexAuthFailed(thread = {}, message = {}, env = process.env) {
  if (!threadInFailedAuth(thread)) return { held: false, thread };
  const health = await activeCodexAuthFaultForThread(thread, env);
  if (!health) return { held: false, thread: await releaseFailedAuthThread(thread, env), released: true };
  const reason = clean(thread.runtime?.authFailure?.reason || health.reason) || "codex_runtime_auth_invalid";
  const probe = await claimCodexAuthProbe(thread, message, env).catch(() => null);
  if (probe) {
    // Let exactly this input through as the auth probe; the thread stays parked
    // until the probe turn succeeds (see resolveCodexAuthAfterSuccessfulTurn).
    const probed = await updateThread(thread.id, {
      runtime: {
        ...(thread.runtime || {}),
        authFailure: { ...(thread.runtime?.authFailure || {}), state: "broken", lastProbeAt: probe.probeAt, probeMessageId: message.id },
        updatedAt: nowIso(),
      },
    }, env).catch(() => thread) || thread;
    return { held: false, thread: probed, probe: true };
  }
  const busy = ["working", "awaiting_approval"].includes(clean(thread.runtime?.state || thread.state));
  if (!busy && (clean(thread.state) !== failedAuthState || clean(thread.runtime?.state) !== failedAuthState)) {
    // Enqueueing new input may have moved the visible state; keep it parked.
    thread = await updateThread(thread.id, {
      state: failedAuthState,
      runtime: { ...(thread.runtime || {}), state: failedAuthState, updatedAt: nowIso() },
    }, env).catch(() => thread) || thread;
  }
  let held = message;
  if (message?.id) {
    held = await updateThreadMessage(thread.id, message.id, {
      state: "queued",
      deliveryState: failedAuthDeliveryState,
      deliveryClaimId: null,
      deliveryAuthHoldReason: reason,
      deliveryAuthHeldAt: nowIso(),
      error: "Codex authentication was rejected. Input is held until Codex auth is repaired.",
    }, env).catch(() => message);
  }
  await appendEvent({
    type: "codex_app_server_input_held_for_auth",
    threadId: thread.id,
    messageId: message?.id || null,
    reason,
  }, env).catch(() => {});
  return { held: true, thread, message: held, reason };
}

// Requeues the probe input when its turn was rejected for auth again, so the
// input is retried after repair instead of being consumed by the failed probe.
export async function requeueFailedAuthProbeInput(thread = {}, previousAuthFailure = null, turnId = "", env = process.env) {
  const messageId = clean(previousAuthFailure?.probeMessageId);
  if (!messageId) return null;
  return requeueAuthRejectedInput(thread, messageId, turnId, env);
}

async function requeueAuthRejectedInput(thread, messageId, turnId, env) {
  const requeued = await updateThreadMessage(thread.id, messageId, {
    state: "queued",
    deliveryState: failedAuthDeliveryState,
    deliveryClaimId: null,
    deliveredAt: null,
    deliveryAuthProbeFailedTurnId: clean(turnId) || null,
    deliveryAuthHeldAt: nowIso(),
    error: "Codex authentication probe was rejected. Input is held until Codex auth is repaired.",
  }, env).catch(() => null);
  await appendEvent({ type: "codex_auth_probe_rejected", threadId: thread.id, messageId, turnId: clean(turnId) || null }, env).catch(() => {});
  return requeued;
}

// The probe turn's failure notification can race with delivery bookkeeping
// and the turn/started handler, which may overwrite the input as delivered or
// the thread as working. Once delivery finishes, re-apply the requeue and the
// failed_auth park for an input whose probe turn was rejected for auth.
export async function reconcileRejectedAuthProbeAfterDelivery(threadId, messageId, env = process.env) {
  const message = await getThreadMessage(threadId, messageId, env).catch(() => null);
  const failedTurnId = clean(message?.deliveryAuthProbeFailedTurnId);
  if (!message || !failedTurnId || clean(message.codexTurnId) !== failedTurnId) return false;
  const thread = await getThread(threadId, env).catch(() => null);
  if (!thread) return false;
  if (clean(message.state) !== "queued") await requeueAuthRejectedInput(thread, messageId, failedTurnId, env);
  const authFailure = thread.runtime?.authFailure || {};
  const parked = clean(thread.state) === failedAuthState && clean(authFailure.state) === "broken" && clean(authFailure.turnId) === failedTurnId;
  if (!parked) {
    await updateThread(threadId, {
      state: failedAuthState,
      runtime: {
        ...(thread.runtime || {}),
        state: failedAuthState,
        activeTurnId: null,
        authFailure: { ...authFailure, state: "broken", turnId: failedTurnId, detectedAt: nowIso(), probeMessageId: null },
        updatedAt: nowIso(),
      },
    }, env).catch(() => {});
  }
  return true;
}

// A successful turn proves Codex auth works for this Codex home: mark health
// repaired and release every failed_auth thread on the same home back to ready
// on its existing Codex session (no reset).
export async function resolveCodexAuthAfterSuccessfulTurn(thread = {}, env = process.env) {
  const fault = await activeCodexAuthFaultForThread(thread, env);
  if (!fault && !threadInFailedAuth(thread)) return { released: [] };
  if (fault) await markCodexAuthHealthRepaired({ threadId: thread.id }, env).catch(() => {});
  const codexHome = codexHomeForThread(thread, env);
  const threads = await listThreads(env).catch(() => []);
  const released = [];
  for (const candidate of threads) {
    if (!threadInFailedAuth(candidate)) continue;
    if (candidate.id !== thread.id && codexHomeForThread(candidate, env) !== codexHome) continue;
    await releaseFailedAuthThread(candidate, env, "repaired");
    released.push(candidate.id);
  }
  return { released };
}

// Operator wake: clear failed_auth for one thread and allow an immediate
// delivery attempt, without touching the Codex session.
export async function clearFailedAuthForOperatorWake(thread = {}, env = process.env) {
  if (!threadInFailedAuth(thread)) return thread;
  return releaseFailedAuthThread(thread, env, "operator_cleared");
}
