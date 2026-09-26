// Claude Code turns run as a fire-and-forget child process per turn, tracked
// only in this process's in-memory activeTurns map. A server restart (or a
// crash) drops that map without ever clearing thread.runtime.activeTurnId or
// the correlated message's "running" state, so without this sweep a thread
// can be stuck claiming an active turn forever. Recovery only ever acts on a
// turn it can positively correlate; anything it cannot confidently identify
// is left untouched for a human or a later, better-informed pass.
import { appendEvent } from "../../storage/src/store.js";
import {
  findThreadMessage,
  getThread,
  listThreads,
  updateThread,
  updateThreadMessage,
} from "./threads.js";
import { appendTurnLifecycleEvent } from "./turn-lifecycle.js";
import { claudeCodeOutputEventId, existingClaudeCodeOutput } from "./claude-code-router-trace.js";
import { hasActiveClaudeCodeSupervisor } from "./runtime-claude-code-adapter.js";

function clean(value = "") {
  return String(value || "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function isClaudeCodeThread(thread = {}) {
  return clean(thread?.runtimeKind || thread?.runtime?.runtimeKind || thread?.executor?.metadata?.runtimeKind) === "claude-code";
}

// Fences on thread.runtime.activeTurnId === message.executorTurnId so a turn
// that merely looks stuck (e.g. a different, unrelated running message) is
// never touched. Only a user message still in "running" state counts: once a
// turn has already reached a terminal state, there is nothing left to repair.
async function correlatedRunningMessage(thread, activeTurnId, env) {
  // A completed turn's final assistant message shares the same executorTurnId
  // and can be newer than the user message, so the role must be part of the
  // lookup itself rather than filtered afterward -- otherwise a reverse scan
  // would match the assistant final instead of the still-"running" user turn.
  // findThreadMessage's canonical lookup key is codexTurnId; both the JSON and
  // SQLite repositories map that key to executorTurnId for non-Codex runtimes.
  // Passing executorTurnId directly only worked in the legacy JSON fallback
  // and silently dropped the correlation predicate in SQLite.
  const candidate = await findThreadMessage(thread.id, {
    codexTurnId: activeTurnId,
    role: "user",
    state: "running",
  }, env).catch(() => null);
  if (!candidate) return null;
  if (clean(candidate.state) !== "running") return null;
  return candidate;
}

export async function recoverOrphanedClaudeCodeTurn(threadOrId, env = process.env) {
  const thread = typeof threadOrId === "string" ? await getThread(threadOrId, env) : threadOrId;
  if (!thread) return { recovered: false, reason: "thread_not_found" };
  const activeTurnId = clean(thread?.runtime?.activeTurnId);
  if (!activeTurnId) return { recovered: false, reason: "no_active_turn" };
  if (hasActiveClaudeCodeSupervisor(thread.id)) return { recovered: false, reason: "turn_live" };

  const message = await correlatedRunningMessage(thread, activeTurnId, env);
  if (!message) return { recovered: false, reason: "no_correlated_message" };

  const finalEventId = claudeCodeOutputEventId(thread.id, activeTurnId);
  const finalOutput = await existingClaudeCodeOutput(thread.id, finalEventId, env).catch(() => null);

  if (finalOutput) {
    await updateThreadMessage(thread.id, message.id, {
      state: "completed",
      deliveryState: message.deliveryState === "delivered" ? message.deliveryState : "delivered",
      deliveredAt: message.deliveredAt || nowIso(),
      observedVia: "claude_code_orphan_turn_recovery",
      error: null,
    }, env);
    const updated = await updateThread(thread.id, {
      state: "ready",
      runtime: {
        ...(thread.runtime || {}),
        state: "ready",
        activeTurnId: null,
        lastTurnId: activeTurnId,
        lastTurnStatus: "completed",
        lastTurnError: null,
      },
    }, env);
    await appendTurnLifecycleEvent("completed", {
      threadId: thread.id, runtimeKind: "claude-code", turnId: activeTurnId, state: "completed", source: "claude_code_orphan_recovery",
    }, env).catch(() => {});
    await appendEvent({ type: "claude_code_turn_recovered", threadId: thread.id, turnId: activeTurnId, outcome: "completed" }, env).catch(() => {});
    return { recovered: true, outcome: "completed", thread: updated, messageId: message.id };
  }

  await updateThreadMessage(thread.id, message.id, {
    state: "failed",
    deliveryState: "failed",
    error: "claude_code_turn_interrupted",
  }, env);
  const updated = await updateThread(thread.id, {
    state: "failed",
    lastError: "claude_code_turn_interrupted",
    runtime: {
      ...(thread.runtime || {}),
      state: "failed",
      activeTurnId: null,
      lastTurnId: activeTurnId,
      lastTurnStatus: "failed",
      lastTurnError: "claude_code_turn_interrupted",
    },
  }, env);
  await appendTurnLifecycleEvent("failed", {
    threadId: thread.id, runtimeKind: "claude-code", turnId: activeTurnId, state: "failed", source: "claude_code_orphan_recovery", error: "claude_code_turn_interrupted",
  }, env).catch(() => {});
  await appendEvent({ type: "claude_code_turn_recovered", threadId: thread.id, turnId: activeTurnId, outcome: "failed" }, env).catch(() => {});
  return { recovered: true, outcome: "failed", thread: updated, messageId: message.id };
}

export async function recoverOrphanedClaudeCodeTurns(env = process.env) {
  const threads = (await listThreads(env)).filter((thread) => isClaudeCodeThread(thread) && clean(thread?.runtime?.activeTurnId));
  const results = [];
  for (const thread of threads) {
    const result = await recoverOrphanedClaudeCodeTurn(thread, env).catch((error) => ({
      recovered: false,
      reason: "recovery_error",
      error: error?.message || String(error),
    }));
    results.push({ threadId: thread.id, ...result });
  }
  const recovered = results.filter((result) => result.recovered).length;
  return { recovered, results };
}
