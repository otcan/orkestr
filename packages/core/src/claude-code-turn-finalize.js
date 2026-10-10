// Terminal bookkeeping for one Claude Code turn: persists the final answer,
// message/thread state, lifecycle events, and account-profile state. Shared by
// the in-process turn path and the detached-turn reattach path so a turn that
// outlived a server restart finishes exactly like one that did not.
import { appendClaudeCodeKillNotice, claudeCodeTerminationReason } from "./claude-code-kill-notice.js";
import { claudeCodeEnabled } from "./claude-code-client.js";
import { appendEvent } from "../../storage/src/store.js";
import { updateLlmAccountProfileState } from "./llm-account-profiles.js";
import { resolveClaudeCodeRuntimeProfile } from "./claude-code-rate-limit.js";
import { getThreadMessage, updateThread, updateThreadMessage } from "./threads.js";
import { turnOutcomeFields } from "./runtime-input-result.js";
import { classifyClaudeCodeFailureCode } from "./runtime-turn-error-class.js";
import { appendTurnLifecycleEvent } from "./turn-lifecycle.js";
import { setClaudeCodeSession } from "./claude-code-sessions.js";
import { claudeCodeOutputEventId, appendClaudeCodeFinal, existingClaudeCodeOutput } from "./claude-code-router-trace.js";
import { assertClaudeCodeHostOwner, publicClaudeCodeFailure } from "./claude-code-runtime-policy.js";
import { completeInterruptedClaudeCodeTurn } from "./claude-code-turn-state.js";
import { claudeCodeTelemetryPatch } from "./claude-code-telemetry.js";
import { persistInterruptedClaudeCodeSession, settleClaudeCodeCoalescedInputs } from "./claude-code-interrupt-resume.js";
import { scheduleClaudeCodeDelivery } from "./claude-code-active-turns.js";
import { listDetachedTurnRecords, archiveDetachedTurn } from "./claude-code-detached-turn.js";
import { runtimeTurnGeneration, updateThreadRuntime } from "./runtime-record-update.js";

function clean(value = "") {
  return String(value || "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

export async function claudeCodeProfileForThread(thread, env, requireReady = true) {
  assertClaudeCodeHostOwner(thread, env);
  if (requireReady && !claudeCodeEnabled(env)) {
    const error = new Error("claude_code_disabled");
    error.code = "claude_code_disabled";
    error.statusCode = 409;
    throw error;
  }
  return resolveClaudeCodeRuntimeProfile(thread, env, requireReady);
}

// Once a turn's outcome is persisted its detached event log is no longer
// needed. Only one turn runs per thread, so every record for the thread
// (including discarded background-task retry attempts) can be swept.
export async function cleanupDetachedClaudeCodeTurns(threadId, env = process.env) {
  if (["1", "true", "yes", "on"].includes(clean(env.ORKESTR_CLAUDE_DETACHED_KEEP_LOGS).toLowerCase())) return;
  for (const record of await listDetachedTurnRecords(threadId, env).catch(() => [])) {
    await archiveDetachedTurn(record, env);
  }
}

// `turnGeneration` defaults to the generation of the snapshot taken when the
// turn started; a newer turn that began since then is never overwritten.
export async function finalizeClaudeCodeTurnResult({ thread, message, coalesced = [], attemptId, profile, result, turnGeneration = runtimeTurnGeneration(thread), env = process.env }) {
  if (result.interrupted) {
    await persistInterruptedClaudeCodeSession(thread, result.sessionId, env);
    const updated = await completeInterruptedClaudeCodeTurn(thread, message, attemptId, env, { turnGeneration });
    await settleClaudeCodeCoalescedInputs(thread, message, coalesced, "interrupted", attemptId, env);
    await cleanupDetachedClaudeCodeTurns(thread.id, env);
    scheduleClaudeCodeDelivery(thread.id, env, 0);
    return { interrupted: true, message: await getThreadMessage(thread.id, message.id, env), thread: updated, coalescedMessageIds: coalesced.map((item) => item.id) };
  }
  await claudeCodeProfileForThread(thread, env, true);
  const nextSessionId = clean(result.sessionId);
  await setClaudeCodeSession(thread, nextSessionId, env);
  const eventId = claudeCodeOutputEventId(thread.id, attemptId);
  let assistant = await existingClaudeCodeOutput(thread.id, eventId, env);
  if (!assistant) {
    // Appending the final raises the connector-delivery signal immediately.
    // Persist its telemetry first so WhatsApp formats the final from the same
    // completed Claude turn instead of the previous quota snapshot.
    const telemetryPatch = claudeCodeTelemetryPatch(result.telemetry);
    if (Object.keys(telemetryPatch).length) await updateThread(thread.id, telemetryPatch, env);
    assistant = await appendClaudeCodeFinal(thread, message, attemptId, result.text, env);
  }
  const completedMessage = await updateThreadMessage(thread.id, message.id, {
    state: "completed",
    deliveryState: "delivered",
    deliveredAt: nowIso(),
    observedVia: "claude_code_stream_json",
    executorTurnId: attemptId,
    error: null,
    ...turnOutcomeFields({ turnId: attemptId, status: "completed" }),
  }, env);
  await settleClaudeCodeCoalescedInputs(thread, message, coalesced, "completed", attemptId, env);
  const updated = await updateThreadRuntime(thread.id, {
    state: "ready",
    ...claudeCodeTelemetryPatch(result.telemetry),
    runtime: {
      runtimeKind: "claude-code",
      state: "ready",
      activeTurnId: null,
      lastTurnId: attemptId,
      lastTurnStatus: "completed",
      lastTurnError: null,
      lastTurnErrorClass: null,
    },
  }, env, { turnGeneration });
  await appendTurnLifecycleEvent("completed", { threadId: thread.id, runtimeKind: "claude-code", turnId: attemptId, state: "completed", source: "claude-code" }, env).catch(() => {});
  await appendEvent({ type: "claude_code_turn_completed", threadId: thread.id, profileId: profile?.id, turnId: attemptId }, env);
  await cleanupDetachedClaudeCodeTurns(thread.id, env);
  scheduleClaudeCodeDelivery(thread.id, env, 0);
  return { message: completedMessage, assistant, thread: updated, coalescedMessageIds: coalesced.map((item) => item.id) };
}

// Persists a failed turn and returns the public error the caller should throw.
export async function finalizeClaudeCodeTurnFailure({ thread, message, coalesced = [], attemptId, profile, error, workspace = null, turnGeneration = runtimeTurnGeneration(thread), env = process.env }) {
  const failureCode = publicClaudeCodeFailure(error);
  const errorClass = classifyClaudeCodeFailureCode(failureCode);
  const failureTelemetry = error?.telemetry || null;
  await updateThreadMessage(thread.id, message.id, {
    state: "failed",
    deliveryState: "failed",
    error: failureCode,
    executorTurnId: attemptId,
    ...turnOutcomeFields({ turnId: attemptId, status: "failed", error: errorClass }),
  }, env).catch(() => {});
  await settleClaudeCodeCoalescedInputs(thread, message, coalesced, "failed", attemptId, env, failureCode);
  const updated = await updateThreadRuntime(thread.id, {
    state: "failed",
    lastError: failureCode,
    ...(failureTelemetry?.model ? { claudeModelResolved: failureTelemetry.model } : {}),
    ...(failureTelemetry?.tokenUsage ? { claudeTokenUsage: failureTelemetry.tokenUsage } : {}),
    ...(failureTelemetry?.rateLimits ? { claudeRateLimits: failureTelemetry.rateLimits, claudeRateLimitsObservedAt: nowIso() } : {}),
    ...(failureTelemetry?.contextWindow ? { claudeContextWindow: failureTelemetry.contextWindow } : {}),
    runtime: { runtimeKind: "claude-code", state: "failed", activeTurnId: null, lastTurnId: attemptId, lastTurnStatus: "failed", lastTurnError: failureCode, lastTurnErrorClass: errorClass, lastTurnTermination: claudeCodeTerminationReason(error) || null },
  }, env, { turnGeneration }).catch(() => thread);
  if (profile?.id && failureCode === "claude_code_rate_limited") {
    await updateLlmAccountProfileState(thread.ownerUserId, profile.id, "rate_limited", { failureCode, credentialRevision: profile.credentialRevision || 0 }, env).catch(() => {});
  } else if (profile?.id && failureCode === "claude_code_auth_required") {
    await updateLlmAccountProfileState(thread.ownerUserId, profile.id, "login_required", { failureCode, credentialRevision: profile.credentialRevision || 0 }, env).catch(() => {});
  }
  await appendTurnLifecycleEvent("failed", { threadId: thread.id, runtimeKind: "claude-code", turnId: attemptId, state: "failed", source: "claude-code", error: failureCode, errorClass: errorClass.class, errorCode: errorClass.code, retryable: errorClass.retryable }, env).catch(() => {});
  await appendEvent({ type: "claude_code_turn_failed", threadId: thread.id, profileId: profile?.id, turnId: attemptId, failureCode }, env);
  await appendClaudeCodeKillNotice({ thread, parent: message, attemptId, error, workspace, env });
  await cleanupDetachedClaudeCodeTurns(thread.id, env);
  scheduleClaudeCodeDelivery(thread.id, env, 0);
  const publicError = new Error(failureCode);
  publicError.code = failureCode;
  publicError.errorClass = errorClass;
  publicError.thread = updated;
  return publicError;
}
