import crypto from "node:crypto";
import {
  claudeCodeEnabled,
} from "./claude-code-client.js";
import { appendEvent } from "../../storage/src/store.js";
import { updateLlmAccountProfileState } from "./llm-account-profiles.js";
import { deferClaudeCodeRateLimitedInput, recoverClaudeCodeThreadState, resolveClaudeCodeRuntimeProfile } from "./claude-code-rate-limit.js";
import {
  getThread,
  getThreadMessage,
  listThreadMessageCandidates,
  updateThread,
  updateThreadMessage,
} from "./threads.js";
import { appendTurnLifecycleEvent } from "./turn-lifecycle.js";
import { parseThreadInputCommand } from "./thread-commands.js";
import { getClaudeCodeSession, setClaudeCodeSession } from "./claude-code-sessions.js";
import { codexInputText } from "./codex-app-server-common.js";
import {
  claudeCodeOutputEventId,
  appendClaudeCodeFinal,
  existingClaudeCodeOutput,
  recordClaudeCodeRouterTrace,
} from "./claude-code-router-trace.js";
import {
  assertClaudeCodeHostOwner,
  publicClaudeCodeFailure,
  threadUsesClaudeCode,
} from "./claude-code-runtime-policy.js";
import { createClaudeCodeProgressReporter } from "./claude-code-progress.js";
import { completeInterruptedClaudeCodeTurn } from "./claude-code-turn-state.js";
import {
  recoverOrphanedAttempt,
} from "./claude-code-supervised-process.js";
import { runClaudeCodeProcess, supervisionIdentityPath } from "./claude-code-process-runner.js";

export { assertClaudeCodeHostOwner, threadUsesClaudeCode } from "./claude-code-runtime-policy.js";

const activeTurns = new Map();
const turnReservations = new Set();
const pendingStates = new Set(["queued", "pending_delivery"]);
let deliveryScheduler = null;

function clean(value = "") {
  return String(value || "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function claudeCodeTelemetryPatch(telemetry = {}) {
  return {
    ...(telemetry?.model ? { claudeModelResolved: telemetry.model } : {}),
    ...(telemetry?.tokenUsage ? { claudeTokenUsage: telemetry.tokenUsage } : {}),
    ...(telemetry?.rateLimits ? { claudeRateLimits: telemetry.rateLimits } : {}),
    ...(telemetry?.contextWindow ? { claudeContextWindow: telemetry.contextWindow } : {}),
  };
}

function accountProfileId(thread = {}) {
  return clean(thread?.executor?.accountProfileId || thread?.executor?.metadata?.accountProfileId);
}

async function profileForThread(thread, env, requireReady = true) {
  assertClaudeCodeHostOwner(thread, env);
  if (requireReady && !claudeCodeEnabled(env)) {
    const error = new Error("claude_code_disabled");
    error.code = "claude_code_disabled";
    error.statusCode = 409;
    throw error;
  }
  return resolveClaudeCodeRuntimeProfile(thread, env, requireReady);
}

export async function startClaudeCodeThread(thread, env = process.env) {
  if (!claudeCodeEnabled(env)) {
    const error = new Error("claude_code_disabled");
    error.statusCode = 409;
    throw error;
  }
  const profile = await profileForThread(thread, env, true);
  const updated = await updateThread(thread.id, {
    state: "ready",
    runtimeKind: "claude-code",
    executorId: "claude-code",
    executor: {
      ...(thread.executor || {}),
      id: "claude-code",
      type: "claude-code",
      transport: "stream-json",
      accountProfileId: profile.id,
      metadata: {
        ...(thread.executor?.metadata || {}),
        runtimeKind: "claude-code",
        transport: "stream-json",
        accountProfileId: profile.id,
      },
    },
    runtime: { ...(thread.runtime || {}), runtimeKind: "claude-code", state: "ready", activeTurnId: null },
  }, env);
  await appendEvent({ type: "claude_code_thread_started", threadId: thread.id, ownerUserId: thread.ownerUserId, profileId: profile.id }, env);
  return { thread: updated, started: true };
}

async function sendClaudeCodeInputReserved(thread, message, env = process.env) {
  if (activeTurns.has(thread.id)) {
    const error = new Error("claude_code_turn_active");
    error.statusCode = 409;
    throw error;
  }
  const profile = await profileForThread(thread, env, true);
  const freshMessage = await getThreadMessage(thread.id, message.id, env);
  if (!freshMessage || !pendingStates.has(clean(freshMessage.state))) return { skipped: true, message: freshMessage || message };
  const attemptId = `claude_turn_${crypto.randomBytes(12).toString("base64url")}`;

  // Terminate any orphaned process group left by a previous crashed attempt
  // before writing the new attempt identity file.
  const identityFilePath = supervisionIdentityPath(thread.id, env);
  const orphan = await recoverOrphanedAttempt(identityFilePath).catch(() => ({ recovered: false }));
  if (orphan.blocked) {
    const error = new Error("claude_code_orphan_identity_unverified");
    error.code = "claude_code_orphan_identity_unverified";
    throw error;
  }
  if (orphan.recovered) {
    await appendEvent({
      type: "claude_code_orphan_recovered",
      threadId: thread.id,
      orphanPgid: orphan.pgid,
      orphanAttemptId: orphan.attemptId,
    }, env).catch(() => {});
  }

  const deliveryAttempt = Math.max(0, Number(freshMessage.deliveryAttempt || 0) || 0) + 1;
  const sessionId = await getClaudeCodeSession(thread, env);
  const priorTurnFailed = clean(thread.runtime?.lastTurnStatus) === "failed";
  const runningMessage = await updateThreadMessage(thread.id, message.id, {
    state: "running",
    deliveryState: "delivering",
    deliveryAttempt,
    observedVia: "claude_code_stream_json",
    executorKind: "claude-code",
    executorTurnId: attemptId,
  }, env);
  await recordClaudeCodeRouterTrace(runningMessage || freshMessage, "delivery_started", {
    threadId: thread.id,
    attempt: deliveryAttempt,
    ownerProcess: attemptId,
  }, env);
  thread = await updateThread(thread.id, {
    state: "working",
    lastError: null,
    runtime: { ...(thread.runtime || {}), runtimeKind: "claude-code", state: "working", activeTurnId: attemptId },
  }, env);
  await appendTurnLifecycleEvent("started", { threadId: thread.id, runtimeKind: "claude-code", turnId: attemptId, state: "working", source: "claude-code" }, env).catch(() => {});
  await appendEvent({ type: "claude_code_turn_started", threadId: thread.id, profileId: profile.id, turnId: attemptId }, env);
  const progress = createClaudeCodeProgressReporter({
    thread,
    parentMessage: freshMessage,
    attemptId,
    onPersisted: () => deliveryScheduler?.(thread.id, env, 0),
  }, env);
  await progress.start();

  try {
    let result;
    try {
      result = await runClaudeCodeProcess({
        thread,
        profile,
        prompt: codexInputText(freshMessage),
        sessionId,
        priorTurnFailed,
        attemptId,
        onPromptSubmitted: () => recordClaudeCodeRouterTrace(runningMessage || freshMessage, "delivered_to_runtime", {
          threadId: thread.id,
          attempt: deliveryAttempt,
          ownerProcess: attemptId,
        }, env),
        onEvent: (event) => progress.observe(event),
        // Forward supervisor heartbeats to the progress reporter.
        // heartbeat() is rate-limited inside the reporter; redaction is handled there.
        onHeartbeat: ({ toolElapsedMs }) => progress.heartbeat(toolElapsedMs),
        assertProfileReady: () => profileForThread(thread, env, true),
        activeTurns,
        env,
      });
    } finally {
      await progress.flush();
    }
    if (result.interrupted) {
      const updated = await completeInterruptedClaudeCodeTurn(thread, freshMessage, attemptId, env);
      return { interrupted: true, message: await getThreadMessage(thread.id, message.id, env), thread: updated };
    }
    await profileForThread(thread, env, true);
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
      assistant = await appendClaudeCodeFinal(thread, freshMessage, attemptId, result.text, env);
    }
    const completedMessage = await updateThreadMessage(thread.id, freshMessage.id, {
      state: "completed",
      deliveryState: "delivered",
      deliveredAt: nowIso(),
      observedVia: "claude_code_stream_json",
      executorTurnId: attemptId,
      error: null,
    }, env);
    const updated = await updateThread(thread.id, {
      state: "ready",
      ...claudeCodeTelemetryPatch(result.telemetry),
      runtime: {
        ...(thread.runtime || {}),
        runtimeKind: "claude-code",
        state: "ready",
        activeTurnId: null,
        lastTurnId: attemptId,
        lastTurnStatus: "completed",
      },
    }, env);
    await appendTurnLifecycleEvent("completed", { threadId: thread.id, runtimeKind: "claude-code", turnId: attemptId, state: "completed", source: "claude-code" }, env).catch(() => {});
    await appendEvent({ type: "claude_code_turn_completed", threadId: thread.id, profileId: profile.id, turnId: attemptId }, env);
    deliveryScheduler?.(thread.id, env, 0);
    return { message: completedMessage, assistant, thread: updated };
  } catch (error) {
    const failureCode = publicClaudeCodeFailure(error);
    const failureTelemetry = error?.telemetry || null;
    await updateThreadMessage(thread.id, freshMessage.id, { state: "failed", deliveryState: "failed", error: failureCode }, env).catch(() => {});
    const updated = await updateThread(thread.id, {
      state: "failed",
      lastError: failureCode,
      ...(failureTelemetry?.model ? { claudeModelResolved: failureTelemetry.model } : {}),
      ...(failureTelemetry?.tokenUsage ? { claudeTokenUsage: failureTelemetry.tokenUsage } : {}),
      ...(failureTelemetry?.rateLimits ? { claudeRateLimits: failureTelemetry.rateLimits } : {}),
      ...(failureTelemetry?.contextWindow ? { claudeContextWindow: failureTelemetry.contextWindow } : {}),
      runtime: { ...(thread.runtime || {}), runtimeKind: "claude-code", state: "failed", activeTurnId: null, lastTurnId: attemptId, lastTurnStatus: "failed", lastTurnError: failureCode },
    }, env).catch(() => thread);
    if (failureCode === "claude_code_rate_limited") {
      await updateLlmAccountProfileState(thread.ownerUserId, profile.id, "rate_limited", { failureCode, credentialRevision: profile.credentialRevision || 0 }, env).catch(() => {});
    } else if (failureCode === "claude_code_auth_required") {
      await updateLlmAccountProfileState(thread.ownerUserId, profile.id, "login_required", { failureCode, credentialRevision: profile.credentialRevision || 0 }, env).catch(() => {});
    }
    await appendTurnLifecycleEvent("failed", { threadId: thread.id, runtimeKind: "claude-code", turnId: attemptId, state: "failed", source: "claude-code", error: failureCode }, env).catch(() => {});
    await appendEvent({ type: "claude_code_turn_failed", threadId: thread.id, profileId: profile.id, turnId: attemptId, failureCode }, env);
    deliveryScheduler?.(thread.id, env, 0);
    const publicError = new Error(failureCode);
    publicError.code = failureCode;
    publicError.thread = updated;
    throw publicError;
  }
}

export async function sendClaudeCodeInput(thread, message, env = process.env) {
  if (turnReservations.has(thread.id) || activeTurns.has(thread.id)) {
    const error = new Error("claude_code_turn_active");
    error.statusCode = 409;
    throw error;
  }
  turnReservations.add(thread.id);
  try {
    return await sendClaudeCodeInputReserved(thread, message, env);
  } finally {
    turnReservations.delete(thread.id);
  }
}

export async function deliverClaudeCodePendingInputs(thread, env = process.env) {
  const delivered = [];
  for (;;) {
    const candidates = (await listThreadMessageCandidates(thread.id, { states: [...pendingStates] }, env))
      .filter((message) => message.role === "user");
    const control = candidates.find((message) => {
      const command = parseThreadInputCommand(message);
      return command.command === "stop" || command.command === "interrupt";
    });
    if (control) {
      const interrupted = await interruptClaudeCodeThread(thread, env).catch(() => ({ interrupted: false }));
      await updateThreadMessage(thread.id, control.id, {
        state: "completed",
        deliveryState: "delivered",
        deliveredAt: nowIso(),
        observedVia: "claude_code_control_command",
        interruptSent: Boolean(interrupted.interrupted),
        error: null,
      }, env);
      delivered.push(control.id);
      if (activeTurns.has(thread.id)) break;
      continue;
    }
    if (turnReservations.has(thread.id) || activeTurns.has(thread.id)) break;
    const next = candidates[0];
    if (!next) break;
    const current = await getThread(thread.id, env) || thread;
    let result;
    try {
      result = await sendClaudeCodeInput(current, next, env);
    } catch (error) {
      if (error?.rateLimitPreflight !== true) throw error;
      await deferClaudeCodeRateLimitedInput(current, next, error, deliveryScheduler, env);
      break;
    }
    if (result.skipped) break;
    delivered.push(next.id);
  }
  return delivered;
}

export async function interruptClaudeCodeThread(thread, env = process.env) {
  const supervisor = activeTurns.get(thread.id);
  if (!supervisor) return { interrupted: false, reason: "no_active_turn" };
  // interrupt() marks the flag and sends SIGTERM/-PGID, killing the whole
  // process group including any grandchild app-server or readline handles.
  supervisor.interrupt();
  await appendEvent({ type: "claude_code_turn_interrupt_requested", threadId: thread.id, turnId: supervisor.attemptId }, env);
  return { interrupted: true, turnId: supervisor.attemptId };
}

export async function claudeCodeThreadStatus(thread, env = process.env, counts = {}) {
  const supervisor = activeTurns.get(thread.id);
  let profileState = "unknown";
  try { profileState = (await profileForThread(thread, env, false)).state; } catch {}
  if (!supervisor) {
    const recovery = await recoverClaudeCodeThreadState(thread, profileState, env);
    thread = recovery.thread;
    if (recovery.recovered) deliveryScheduler?.(thread.id, env, 0);
  }
  const persistedState = clean(thread.runtime?.state || thread.state || "ready").toLowerCase();
  const state = supervisor ? "working" : persistedState === "working" ? "interrupted" : persistedState;

  // Semantic liveness: staleWorking is true when the process is alive but has not
  // produced meaningful output for longer than ORKESTR_CLAUDE_STALE_WORKING_MS.
  const staleWorking = supervisor ? supervisor.tickStaleWorking() : false;
  const staleWorkingSince = supervisor ? (supervisor.staleWorkingSince || null) : null;
  const staleWorkingReason = staleWorking ? "semantic_inactivity" : null;

  return {
    state,
    status: state,
    runtimeState: state,
    runtimeKind: "claude-code",
    provider: "anthropic",
    promptReady: state === "ready" && profileState === "ready",
    promptReadyStable: state === "ready" && profileState === "ready",
    working: Boolean(supervisor),
    foregroundWorking: Boolean(supervisor),
    // typingActive is false when the process is stale (transport alive, semantics silent).
    typingActive: Boolean(supervisor) && !staleWorking,
    backgroundWork: false,
    staleWorking,
    staleWorkingSince,
    staleWorkingReason,
    pendingCount: Number(counts.pendingCount || 0),
    runningCount: Number(counts.runningCount || 0),
    accountProfileId: accountProfileId(thread) || null,
    accountState: profileState,
    activeTurnId: supervisor?.attemptId || null,
    error: state === "interrupted" ? "claude_code_runtime_interrupted" : thread.lastError || null,
    model: thread.claudeModel || thread.executor?.metadata?.claudeModel || thread.claudeModelResolved || null,
    effort: thread.claudeEffort || thread.executor?.metadata?.claudeEffort || null,
    permissionMode: thread.claudePermissionMode || thread.executor?.metadata?.claudePermissionMode || "acceptEdits",
    tokenUsage: thread.claudeTokenUsage || null,
    rateLimits: thread.claudeRateLimits || null,
  };
}

export async function resumeClaudeCodeThread(thread, env = process.env) {
  if (!threadUsesClaudeCode(thread)) return null;
  await profileForThread(thread, env, true);
  if (activeTurns.has(thread.id)) return { thread, resumed: false, reason: "turn_active" };
  const updated = await updateThread(thread.id, {
    state: "ready",
    lastError: null,
    runtime: { ...(thread.runtime || {}), runtimeKind: "claude-code", state: "ready", activeTurnId: null },
  }, env);
  return { thread: updated, resumed: true };
}

export function resetClaudeCodeRuntimeForTest() {
  for (const supervisor of activeTurns.values()) supervisor.terminate("test_reset");
  activeTurns.clear();
  turnReservations.clear();
}

export function setClaudeCodeDeliveryScheduler(handler) {
  deliveryScheduler = typeof handler === "function" ? handler : null;
  return () => {
    if (deliveryScheduler === handler) deliveryScheduler = null;
  };
}
