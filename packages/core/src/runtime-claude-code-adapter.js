import crypto from "node:crypto";
import {
  claudeCodeEnabled,
  claudeCodeEventBackgroundToolUse,
  claudeCodeMaxBackgroundTaskRetries,
} from "./claude-code-client.js";
import { appendEvent } from "../../storage/src/store.js";
import { deferClaudeCodeRateLimitedInput, recoverClaudeCodeThreadState } from "./claude-code-rate-limit.js";
import {
  getThread,
  getThreadMessage,
  listThreadMessageCandidates,
  updateThreadMessage,
} from "./threads.js";
import { appendTurnLifecycleEvent } from "./turn-lifecycle.js";
import { delegatedAssistantInput, parseThreadInputCommand } from "./thread-commands.js";
import { getClaudeCodeSession } from "./claude-code-sessions.js";
import { recordClaudeCodeRouterTrace } from "./claude-code-router-trace.js";
import { publicClaudeCodeFailure, threadUsesClaudeCode } from "./claude-code-runtime-policy.js";
import { createClaudeCodeProgressReporter } from "./claude-code-progress.js";
import { recoverOrphanedAttempt } from "./claude-code-supervised-process.js";
import { runClaudeCodeProcess, supervisionIdentityPath } from "./claude-code-process-runner.js";
import { createClaudeCodeWorkspaceTracker } from "./claude-code-partial-work.js";
import { resolveStandingMissionAppendText } from "./claude-standing-mission.js";
import { claudeCodeStatusPayload } from "./claude-code-status.js";
import { claimExecutorHandoffForMessage } from "./executor-handoff-delivery.js";
import { applyPendingExecutorSwitchAfterTurn } from "./executor-switch-hooks.js";
import {
  activeTurns,
  scheduleClaudeCodeDelivery,
  turnReservations,
} from "./claude-code-active-turns.js";
import {
  claudeCodeProfileForThread as profileForThread,
  finalizeClaudeCodeTurnFailure,
  finalizeClaudeCodeTurnResult,
} from "./claude-code-turn-finalize.js";
import { claudeCodeDetachedTransport } from "./claude-code-detached-turn.js";
import { reattachDetachedClaudeCodeTurn } from "./claude-code-turn-reattach.js";
import {
  claudeCodeInputRequestsInterrupt,
  claudeCodeResumePrompt,
  claudeCodeInputDeferredByAuthority,
  collectClaudeCodeResumeBatch,
  consumeClaudeCodeInterruptResume,
  normalizeClaudeCodeNowInputs,
  requestClaudeCodeInstantInterrupt,
  resetClaudeCodeInterruptResumeForTest,
  settleClaudeCodeCoalescedInputs,
} from "./claude-code-interrupt-resume.js";
import { updateThreadRuntime } from "./runtime-record-update.js";

export { assertClaudeCodeHostOwner, threadUsesClaudeCode } from "./claude-code-runtime-policy.js";
export { setClaudeCodeDeliveryScheduler } from "./claude-code-active-turns.js";

const pendingStates = new Set(["queued", "pending_delivery"]);

function clean(value = "") {
  return String(value || "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function accountProfileId(thread = {}) {
  return clean(thread?.executor?.accountProfileId || thread?.executor?.metadata?.accountProfileId);
}

export async function startClaudeCodeThread(thread, env = process.env) {
  if (!claudeCodeEnabled(env)) {
    const error = new Error("claude_code_disabled");
    error.statusCode = 409;
    throw error;
  }
  const profile = await profileForThread(thread, env, true);
  const updated = await updateThreadRuntime(thread.id, {
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
    runtime: { runtimeKind: "claude-code", state: "ready", activeTurnId: null },
  }, env);
  await appendEvent({ type: "claude_code_thread_started", threadId: thread.id, ownerUserId: thread.ownerUserId, profileId: profile.id }, env);
  return { thread: updated, started: true };
}

async function sendClaudeCodeInputReserved(thread, message, env = process.env, options = {}) {
  if (activeTurns.has(thread.id)) {
    const error = new Error("claude_code_turn_active");
    error.statusCode = 409;
    throw error;
  }
  const profile = await profileForThread(thread, env, true);
  let freshMessage = await getThreadMessage(thread.id, message.id, env);
  if (!freshMessage || !pendingStates.has(clean(freshMessage.state))) return { skipped: true, message: freshMessage || message };
  freshMessage = await claimExecutorHandoffForMessage(thread, freshMessage, "claude-code", env);
  const coalesced = options.coalesce ? await collectClaudeCodeResumeBatch(thread, freshMessage, env) : [];
  const resumeAfterInterrupt = claudeCodeInputRequestsInterrupt(freshMessage, env) && consumeClaudeCodeInterruptResume(thread);
  const prompt = claudeCodeResumePrompt(freshMessage, coalesced, { interrupted: resumeAfterInterrupt });
  // Reassigned across an automatic background-task retry (below) so every
  // downstream success/failure code path reports the attempt that actually
  // produced the outcome.
  let attemptId = `claude_turn_${crypto.randomBytes(12).toString("base64url")}`;
  const rootTurnId = attemptId;

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
  let sessionId = await getClaudeCodeSession(thread, env);
  let priorTurnFailed = clean(thread.runtime?.lastTurnStatus) === "failed";
  const runningMessage = await updateThreadMessage(thread.id, message.id, {
    state: "running",
    deliveryState: "delivering",
    deliveryAttempt,
    observedVia: "claude_code_stream_json",
    executorKind: "claude-code",
    executorTurnId: attemptId,
  }, env);
  await settleClaudeCodeCoalescedInputs(thread, freshMessage, coalesced, "running", attemptId, env);
  await recordClaudeCodeRouterTrace(runningMessage || freshMessage, "delivery_started", {
    threadId: thread.id,
    attempt: deliveryAttempt,
    ownerProcess: attemptId,
  }, env);
  thread = await updateThreadRuntime(thread.id, {
    state: "working",
    lastError: null,
    runtime: {
      runtimeKind: "claude-code",
      state: "working",
      activeTurnId: attemptId,
      // Read by the deploy active-work guard: only a "detached" turn (in its
      // own systemd scope) survives a UI service restart.
      claudeTransport: claudeCodeDetachedTransport(env),
    },
  }, env);
  await appendTurnLifecycleEvent("started", { threadId: thread.id, runtimeKind: "claude-code", turnId: attemptId, state: "working", source: "claude-code" }, env).catch(() => {});
  await appendEvent({ type: "claude_code_turn_started", threadId: thread.id, profileId: profile.id, turnId: attemptId }, env);
  const progress = createClaudeCodeProgressReporter({
    thread,
    parentMessage: freshMessage,
    attemptId,
    onPersisted: () => scheduleClaudeCodeDelivery(thread.id, env, 0),
    onProgress: typeof options.onProgress === "function" ? options.onProgress : null,
  }, env);
  await progress.start();
  const workspace = createClaudeCodeWorkspaceTracker();

  const maxBackgroundTaskRetries = claudeCodeMaxBackgroundTaskRetries(env);
  let backgroundTaskRetries = 0;
  let backgroundTaskRetryNotice = false;

  try {
    let result;
    try {
      // A detected run_in_background attempt gets a small, hard-bounded number
      // of *immediate* foreground retries of this same input/session under a
      // fresh attemptId and a stronger notice. Exceeding the bound re-throws
      // into one durable failure; discarded attempts emit no visible output.
      for (;;) {
        try {
          result = await runClaudeCodeProcess({
            thread,
            profile,
            prompt,
            sessionId,
            priorTurnFailed,
            backgroundTaskRetry: backgroundTaskRetryNotice,
            standingMission: resolveStandingMissionAppendText(thread, env),
            attemptId,
            messageId: freshMessage.id,
            rootTurnId,
            onPromptSubmitted: () => recordClaudeCodeRouterTrace(runningMessage || freshMessage, "delivered_to_runtime", {
              threadId: thread.id,
              attempt: deliveryAttempt,
              ownerProcess: attemptId,
            }, env),
            // An event carrying the violating tool_use is never forwarded to
            // progress commentary: the assistant's own text in that same
            // event is exactly the false "I'll keep working/report back"
            // narration CLAUDE_CODE_HEADLESS_RUNTIME_NOTICE warns against,
            // and detection only concludes at process close -- forwarding it
            // first would leak that false claim to WhatsApp before the
            // rejection below ever happens.
            onEvent: (event) => {
              workspace.observe(event);
              if (!claudeCodeEventBackgroundToolUse(event)) progress.observe(event);
            },
            // Forward supervisor heartbeats to the progress reporter.
            // heartbeat() is rate-limited inside the reporter; redaction is handled there.
            onHeartbeat: ({ toolElapsedMs }) => progress.heartbeat(toolElapsedMs),
            assertProfileReady: () => profileForThread(thread, env, true),
            activeTurns,
            env,
          });
          break;
        } catch (error) {
          const retryFailureCode = publicClaudeCodeFailure(error);
          if (retryFailureCode !== "claude_code_background_task_attempted" || backgroundTaskRetries >= maxBackgroundTaskRetries) {
            throw error;
          }
          backgroundTaskRetries += 1;
          backgroundTaskRetryNotice = true;
          priorTurnFailed = true;
          // Resume the exact session the offending turn was running under
          // (captured from its own init event) rather than starting fresh.
          sessionId = clean(error.sessionId) || sessionId;
          const nextAttemptId = `claude_turn_${crypto.randomBytes(12).toString("base64url")}`;
          await appendEvent({
            type: "claude_code_background_task_retry",
            threadId: thread.id,
            profileId: profile.id,
            previousTurnId: attemptId,
            turnId: nextAttemptId,
            retryCount: backgroundTaskRetries,
            maxRetries: maxBackgroundTaskRetries,
          }, env).catch(() => {});
          attemptId = nextAttemptId;
        }
      }
    } finally {
      await progress.flush();
    }
    return await finalizeClaudeCodeTurnResult({ thread, message: freshMessage, coalesced, attemptId, profile, result, env });
  } catch (error) {
    throw await finalizeClaudeCodeTurnFailure({ thread, message: freshMessage, coalesced, attemptId, profile, error, workspace, env });
  }
}

export async function sendClaudeCodeInput(thread, message, env = process.env, options = {}) {
  // A detached turn left by a previous server process owns this thread until
  // it is reattached and finished; never start (or orphan-kill) over it.
  if (!turnReservations.has(thread.id) && !activeTurns.has(thread.id)) {
    await reattachDetachedClaudeCodeTurn(thread, env).catch(() => null);
  }
  if (turnReservations.has(thread.id) || activeTurns.has(thread.id)) {
    const error = new Error("claude_code_turn_active");
    error.statusCode = 409;
    throw error;
  }
  turnReservations.add(thread.id);
  try {
    return await sendClaudeCodeInputReserved(thread, message, env, options);
  } finally {
    turnReservations.delete(thread.id);
    await applyPendingExecutorSwitchAfterTurn(thread.id, env);
  }
}

export async function deliverClaudeCodePendingInputs(thread, env = process.env) {
  const delivered = [];
  for (;;) {
    const candidates = await normalizeClaudeCodeNowInputs(thread, (await listThreadMessageCandidates(thread.id, { states: [...pendingStates] }, env))
      .filter((message) => message.role === "user"), env);
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
    if (turnReservations.has(thread.id) || activeTurns.has(thread.id)) {
      if (candidates.some((message) => claudeCodeInputRequestsInterrupt(message, env))) await steerActiveClaudeCodeTurn(thread, env);
      break;
    }
    const next = candidates[0];
    if (!next) break;
    if (parseThreadInputCommand(next).command === "executor") {
      const { processQueuedExecutorCommands } = await import("./thread-executor-commands.js");
      const handled = await processQueuedExecutorCommands(thread, env);
      delivered.push(...handled);
      if (handled.length) continue;
      break;
    }
    const current = await getThread(thread.id, env) || thread;
    if (!threadUsesClaudeCode(current)) {
      // An executor switch was applied at turn completion; the remaining
      // queue belongs to the new executor.
      scheduleClaudeCodeDelivery(thread.id, env, 0);
      break;
    }
    let result;
    try {
      result = await sendClaudeCodeInput(current, next, env, { coalesce: true });
    } catch (error) {
      // Another delivery pass won the turn reservation; it owns these inputs.
      if (error?.message === "claude_code_turn_active") break;
      if (error?.rateLimitPreflight !== true) throw error;
      await deferClaudeCodeRateLimitedInput(current, next, error, scheduleClaudeCodeDelivery, env);
      break;
    }
    if (result.skipped) break;
    delivered.push(next.id, ...(result.coalescedMessageIds || []));
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

// A turn marks its whole input batch running before its process is spawned, so
// inputs still pending once the supervisor exists arrived after that batch.
async function steerActiveClaudeCodeTurn(thread, env = process.env) {
  const supervisor = activeTurns.get(thread.id);
  if (!supervisor) {
    if (!turnReservations.has(thread.id)) return { interrupted: false, reason: "no_active_turn" };
    // Reserved but not yet spawned (or finishing): retry once it can be signalled.
    scheduleClaudeCodeDelivery(thread.id, env, 250);
    return { interrupted: false, reason: "turn_starting" };
  }
  // Inputs held back from the running turn's batch because their reply
  // authority differs queue behind it rather than interrupting it.
  const pending = (await listThreadMessageCandidates(thread.id, { states: [...pendingStates] }, env))
    .filter((message) => message.role === "user" && !claudeCodeInputDeferredByAuthority(thread.id, message.id));
  if (!pending.some((message) => claudeCodeInputRequestsInterrupt(message, env))) return { interrupted: false, reason: "no_interrupt_input" };
  if (activeTurns.get(thread.id) !== supervisor) {
    scheduleClaudeCodeDelivery(thread.id, env, 0);
    return { interrupted: false, reason: "turn_changed" };
  }
  // A turn answering a delegated (MCP) message is not interrupted by a steer
  // input: the interrupted input would be settled without its own answer and
  // the resumed turn would continue that request under the steer input's
  // reply route. The steer input runs next instead.
  const running = await listThreadMessageCandidates(thread.id, { states: ["running"] }, env);
  if (running.some((message) => message.executorTurnId === supervisor.attemptId && delegatedAssistantInput(message))) {
    return { interrupted: false, reason: "delegated_turn" };
  }
  return requestClaudeCodeInstantInterrupt({ thread, supervisor, env });
}

// Interrupt-and-resume entry point for pending inputs that must take effect now
// (WhatsApp/WebUI steer, `/now`, "Send now"). Sends SIGINT first and falls back
// to the supervisor's SIGTERM/SIGKILL path; the resumed turn is started by the
// delivery pass that owned the interrupted turn or by the delivery scheduler.
export async function interruptClaudeCodeThreadForInput(thread, env = process.env) {
  return steerActiveClaudeCodeTurn(thread, env);
}

export async function claudeCodeThreadStatus(thread, env = process.env, counts = {}) {
  const supervisor = activeTurns.get(thread.id);
  let profileState = "unknown";
  try { profileState = (await profileForThread(thread, env, false)).state; } catch {}
  // A reserved (starting) turn owns the thread state; never reset it here.
  if (!supervisor && !turnReservations.has(thread.id)) {
    const recovery = await recoverClaudeCodeThreadState(thread, profileState, env);
    thread = recovery.thread;
    if (recovery.recovered) scheduleClaudeCodeDelivery(thread.id, env, 0);
  }
  return claudeCodeStatusPayload({ thread, supervisor, starting: !supervisor && turnReservations.has(thread.id), profileState, counts, accountProfileId: accountProfileId(thread) });
}

export async function resumeClaudeCodeThread(thread, env = process.env) {
  if (!threadUsesClaudeCode(thread)) return null;
  await profileForThread(thread, env, true);
  if (activeTurns.has(thread.id)) return { thread, resumed: false, reason: "turn_active" };
  const updated = await updateThreadRuntime(thread.id, {
    state: "ready",
    lastError: null,
    runtime: { runtimeKind: "claude-code", state: "ready", activeTurnId: null },
  }, env);
  return { thread: updated, resumed: true };
}

// A stale runtime.activeTurnId with no live supervisor in this process's
// activeTurns map is the fence orphan-turn recovery uses to decide a turn is
// truly dead rather than merely running in another concurrent request.
export function hasActiveClaudeCodeSupervisor(threadId) {
  return activeTurns.has(threadId);
}

// Test-only: lets orphan-recovery tests simulate a genuinely live turn
// without spawning a real Claude Code process.
export function registerActiveClaudeCodeSupervisorForTest(threadId, supervisor = { attemptId: "test", interrupt() {}, terminate() {}, tickStaleWorking: () => false }) {
  activeTurns.set(threadId, supervisor);
  return () => activeTurns.delete(threadId);
}

export function resetClaudeCodeRuntimeForTest() {
  for (const supervisor of activeTurns.values()) supervisor.terminate("test_reset");
  activeTurns.clear();
  turnReservations.clear();
  resetClaudeCodeInterruptResumeForTest();
}
