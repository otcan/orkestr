// Thread-level handling for Codex auth faults. An auth fault is not a runtime
// fault: the thread is parked in `failed_auth`, its Codex session is kept, and
// queued inputs stay pending until Codex auth is repaired.
import path from "node:path";
import { appendEvent } from "../../storage/src/store.js";
import { activeCodexRuntimeAuthInvalid } from "./codex-auth-health.js";
import { redactCodexSecrets } from "./codex-auth-failure.js";
import { clean, codexRuntimeEnvForThread, nowIso, runtimeHome } from "./codex-app-server-common.js";
import { updateThread, updateThreadMessage } from "./threads.js";

export const failedAuthState = "failed_auth";
export const failedAuthDeliveryState = "awaiting_codex_auth";

export function threadInFailedAuth(thread = {}) {
  return clean(thread?.state) === failedAuthState ||
    clean(thread?.runtime?.state) === failedAuthState ||
    clean(thread?.runtime?.authFailure?.state) === "broken";
}

export function failedAuthRuntimeFields({ reason = "", turnId = "", error = "" } = {}) {
  return {
    state: failedAuthState,
    authFailure: {
      state: "broken",
      reason: clean(reason) || "codex_runtime_auth_invalid",
      turnId: clean(turnId) || null,
      summary: redactCodexSecrets(clean(error)) || null,
      detectedAt: nowIso(),
    },
  };
}

export function codexAuthHoldRetryMs(env = process.env) {
  const parsed = Number(env.ORKESTR_CODEX_AUTH_HOLD_RETRY_MS ?? 60_000);
  return Number.isFinite(parsed) ? Math.max(1000, parsed) : 60_000;
}

function codexAuthPathForThread(thread, env) {
  // Same resolution as the Codex connector's defaultCodexHome, kept local so
  // core does not take a new connector import.
  const runtimeEnv = codexRuntimeEnvForThread(thread, env);
  const codexHome = path.resolve(clean(runtimeEnv.CODEX_HOME) || path.join(runtimeHome(runtimeEnv), ".codex"));
  return path.join(codexHome, "auth.json");
}

// Active (unrepaired) Codex auth-health fault for the thread's Codex home.
export async function activeCodexAuthFaultForThread(thread = {}, env = process.env) {
  return await activeCodexRuntimeAuthInvalid({ env, codexAuthPath: codexAuthPathForThread(thread, env) }).catch(() => null);
}

async function releaseFailedAuthThread(thread, env) {
  const releasedAt = nowIso();
  const updated = await updateThread(thread.id, {
    state: "ready",
    lastError: null,
    runtime: {
      ...(thread.runtime || {}),
      state: "ready",
      authFailure: { ...(thread.runtime?.authFailure || {}), state: "repaired", repairedAt: releasedAt },
      updatedAt: releasedAt,
    },
  }, env).catch(() => thread);
  await appendEvent({
    type: "codex_auth_failed_thread_released",
    threadId: thread.id,
    reason: clean(thread.runtime?.authFailure?.reason) || null,
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
  if (clean(thread.state) !== failedAuthState || clean(thread.runtime?.state) !== failedAuthState) {
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
