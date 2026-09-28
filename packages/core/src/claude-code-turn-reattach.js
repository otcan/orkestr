// Reattach to detached Claude Code turns after a server restart.
//
// A detached turn (see claude-code-detached-turn.js) keeps running while the
// Orkestr server restarts. When the new server finds a Claude thread whose
// runtime.activeTurnId still names such a turn, it tails the turn's durable
// event log again: a still-running process is followed to completion, and a
// process that exited while the server was down is replayed so its final
// answer is delivered through the normal turn-completion path, exactly once.
import { appendEvent } from "../../storage/src/store.js";
import { claudeCodeEventBackgroundToolUse } from "./claude-code-client.js";
import { activeTurns, scheduleClaudeCodeDelivery, turnReservations } from "./claude-code-active-turns.js";
import { attachClaudeCodeProcess } from "./claude-code-process-runner.js";
import {
  detachedTurnHasSuccessfulResult,
  detachedTurnState,
  listDetachedTurnRecords,
} from "./claude-code-detached-turn.js";
import {
  claudeCodeProfileForThread,
  finalizeClaudeCodeTurnFailure,
  finalizeClaudeCodeTurnResult,
} from "./claude-code-turn-finalize.js";
import { createClaudeCodeProgressReporter } from "./claude-code-progress.js";
import { applyPendingExecutorSwitchAfterTurn } from "./executor-switch-hooks.js";
import { findThreadMessage, getThread, listThreadMessages, listThreads } from "./threads.js";

function clean(value = "") {
  return String(value || "").trim();
}

function isClaudeCodeThread(thread = {}) {
  return clean(thread?.runtimeKind || thread?.runtime?.runtimeKind || thread?.executor?.metadata?.runtimeKind) === "claude-code";
}

// The newest persisted attempt for the thread's active turn. A background-task
// retry runs under a fresh attempt id while runtime.activeTurnId keeps the
// first one, so records carry that root id as well.
export async function findDetachedClaudeCodeTurn(thread, env = process.env) {
  const activeTurnId = clean(thread?.runtime?.activeTurnId);
  if (!activeTurnId) return null;
  const records = (await listDetachedTurnRecords(thread.id, env).catch(() => []))
    .filter((record) => clean(record.rootTurnId) === activeTurnId || clean(record.attemptId) === activeTurnId)
    .sort((a, b) => (Date.parse(b.startedAt || "") || 0) - (Date.parse(a.startedAt || "") || 0));
  const record = records[0];
  if (!record) return null;
  const state = await detachedTurnState(record);
  // A process that vanished without an exit record (e.g. SIGKILL or reboot)
  // is only worth replaying when it already produced its final answer.
  const reattachable = state !== "gone" || await detachedTurnHasSuccessfulResult(record);
  return { record, state, reattachable, activeTurnId };
}

async function coalescedRunningInputs(thread, primary, turnId, env) {
  const messages = await listThreadMessages(thread.id, env).catch(() => []);
  return messages.filter((message) => message.id !== primary.id &&
    clean(message.role).toLowerCase() === "user" &&
    clean(message.state) === "running" &&
    clean(message.executorTurnId || message.codexTurnId) === turnId);
}

export async function reattachDetachedClaudeCodeTurn(threadOrId, env = process.env) {
  const initial = typeof threadOrId === "string" ? await getThread(threadOrId, env) : threadOrId;
  if (!initial?.id) return { reattached: false, reason: "thread_not_found" };
  if (!clean(initial.runtime?.activeTurnId)) return { reattached: false, reason: "no_active_turn" };
  if (activeTurns.has(initial.id) || turnReservations.has(initial.id)) return { reattached: false, reason: "turn_live" };
  turnReservations.add(initial.id);
  let handedOff = false;
  try {
    const thread = await getThread(initial.id, env) || initial;
    const found = await findDetachedClaudeCodeTurn(thread, env);
    if (!found) return { reattached: false, reason: "no_detached_turn" };
    if (!found.reattachable) return { reattached: false, reason: "process_gone", attemptId: found.record.attemptId };
    const { record, state, activeTurnId } = found;
    const message = await findThreadMessage(thread.id, { codexTurnId: activeTurnId, role: "user", state: "running" }, env).catch(() => null);
    if (!message || clean(message.state) !== "running") return { reattached: false, reason: "no_correlated_message" };
    const coalesced = await coalescedRunningInputs(thread, message, activeTurnId, env);
    const profile = await claudeCodeProfileForThread(thread, env, false).catch(() => ({ id: clean(record.profileId) }));
    const progress = createClaudeCodeProgressReporter({
      thread,
      parentMessage: message,
      attemptId: record.attemptId,
      // A fresh reporter must not reuse the pre-restart progress event ids.
      eventKeyPrefix: `r${Date.now().toString(36)}-`,
      onPersisted: () => scheduleClaudeCodeDelivery(thread.id, env, 0),
    }, env);
    const { promise } = attachClaudeCodeProcess({
      thread,
      record,
      onEvent: (event) => {
        if (!claudeCodeEventBackgroundToolUse(event)) progress.observe(event);
      },
      onHeartbeat: ({ toolElapsedMs }) => progress.heartbeat(toolElapsedMs),
      activeTurns,
      env,
    });
    handedOff = true;
    turnReservations.delete(thread.id);
    await appendEvent({
      type: "claude_code_turn_reattached",
      threadId: thread.id,
      turnId: activeTurnId,
      attemptId: record.attemptId,
      processState: state,
      forwardedOffset: Number(record.forwardedOffset) || 0,
    }, env).catch(() => {});
    const attemptId = clean(record.attemptId);
    const done = promise
      .then(async (result) => {
        await progress.flush();
        const current = await getThread(thread.id, env) || thread;
        return await finalizeClaudeCodeTurnResult({ thread: current, message, coalesced, attemptId, profile, result, env });
      }, async (error) => {
        await progress.flush();
        const current = await getThread(thread.id, env) || thread;
        const publicError = await finalizeClaudeCodeTurnFailure({ thread: current, message, coalesced, attemptId, profile, error, env });
        return { failed: true, error: publicError.code, thread: publicError.thread };
      })
      .catch((error) => ({ failed: true, error: error?.message || String(error) }))
      .finally(() => applyPendingExecutorSwitchAfterTurn(thread.id, env).catch(() => {}));
    return { reattached: true, turnId: activeTurnId, attemptId, processState: state, done };
  } finally {
    if (!handedOff) turnReservations.delete(initial.id);
  }
}

export async function reattachDetachedClaudeCodeTurns(env = process.env) {
  const threads = (await listThreads(env)).filter((thread) => isClaudeCodeThread(thread) && clean(thread?.runtime?.activeTurnId));
  const results = [];
  for (const thread of threads) {
    const result = await reattachDetachedClaudeCodeTurn(thread, env).catch((error) => ({
      reattached: false,
      reason: "reattach_error",
      error: error?.message || String(error),
    }));
    results.push({ threadId: thread.id, ...result });
  }
  return { reattached: results.filter((result) => result.reattached).length, results };
}
