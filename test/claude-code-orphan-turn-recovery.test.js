import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  recoverOrphanedClaudeCodeTurn,
  recoverOrphanedClaudeCodeTurns,
} from "../packages/core/src/claude-code-orphan-turn-recovery.js";
import { claudeCodeOutputEventId } from "../packages/core/src/claude-code-router-trace.js";
import {
  hasActiveClaudeCodeSupervisor,
  registerActiveClaudeCodeSupervisorForTest,
  resetClaudeCodeRuntimeForTest,
} from "../packages/core/src/runtime-claude-code-adapter.js";
import {
  appendThreadMessage,
  createThread,
  enqueueThreadInput,
  getThread,
  getThreadMessage,
} from "../packages/core/src/threads.js";

async function fixture(t, name = "orphan-recovery") {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), `orkestr-claude-${name}-`));
  const priorHome = process.env.ORKESTR_HOME;
  process.env.ORKESTR_HOME = home;
  const env = { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "owner" };
  t.after(async () => {
    resetClaudeCodeRuntimeForTest();
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { home, env };
}

async function claudeThreadWithStuckTurn(env, id, { withFinal = false } = {}) {
  const thread = await createThread({
    id,
    name: `Orphan fixture ${id}`,
    ownerUserId: "owner",
    runtimeKind: "claude-code",
    executor: { type: "claude-code", metadata: { runtimeKind: "claude-code" } },
    runtime: { runtimeKind: "claude-code", state: "working", activeTurnId: "claude_turn_stuck" },
  }, env);
  const message = await enqueueThreadInput(thread.id, { text: "stuck request", source: "test" }, env);
  const running = await getThreadMessage(thread.id, message.id, env);
  const { updateThreadMessage } = await import("../packages/core/src/threads.js");
  await updateThreadMessage(thread.id, running.id, { state: "running", executorKind: "claude-code", executorTurnId: "claude_turn_stuck" }, env);
  if (withFinal) {
    await appendThreadMessage(thread.id, {
      role: "assistant", source: "claude-code", phase: "final_answer", state: "completed",
      text: "Completed before the crash.",
      parentMessageId: running.id,
      eventId: claudeCodeOutputEventId(thread.id, "claude_turn_stuck"),
      executorKind: "claude-code", executorTurnId: "claude_turn_stuck",
    }, env);
  }
  return { thread: await getThread(thread.id, env), messageId: running.id };
}

test("orphaned Claude turn with a completed final output is marked completed, not replayed", async (t) => {
  const { env } = await fixture(t, "completed");
  const { thread, messageId } = await claudeThreadWithStuckTurn(env, "orphan-completed", { withFinal: true });

  const result = await recoverOrphanedClaudeCodeTurn(thread, env);
  assert.equal(result.recovered, true);
  assert.equal(result.outcome, "completed");

  const message = await getThreadMessage(thread.id, messageId, env);
  assert.equal(message.state, "completed");
  assert.equal(message.error, null);
  const updatedThread = await getThread(thread.id, env);
  assert.equal(updatedThread.runtime.activeTurnId, null);
  assert.equal(updatedThread.runtime.lastTurnStatus, "completed");
});

test("orphaned Claude turn with no final output is marked failed/interrupted and runtime state is cleared", async (t) => {
  const { env } = await fixture(t, "failed");
  const { thread, messageId } = await claudeThreadWithStuckTurn(env, "orphan-failed", { withFinal: false });

  const result = await recoverOrphanedClaudeCodeTurn(thread, env);
  assert.equal(result.recovered, true);
  assert.equal(result.outcome, "failed");

  const message = await getThreadMessage(thread.id, messageId, env);
  assert.equal(message.state, "failed");
  assert.equal(message.error, "claude_code_turn_interrupted");
  const updatedThread = await getThread(thread.id, env);
  assert.equal(updatedThread.runtime.activeTurnId, null);
  assert.equal(updatedThread.runtime.lastTurnStatus, "failed");
});

test("recovery leaves a mismatched executorTurnId untouched", async (t) => {
  const { env } = await fixture(t, "mismatch");
  const { thread, messageId } = await claudeThreadWithStuckTurn(env, "orphan-mismatch", { withFinal: false });
  const { updateThreadMessage } = await import("../packages/core/src/threads.js");
  // Simulate a message that belongs to a different turn than the one the
  // runtime currently claims is active.
  await updateThreadMessage(thread.id, messageId, { executorTurnId: "claude_turn_other" }, env);

  const result = await recoverOrphanedClaudeCodeTurn(await getThread(thread.id, env), env);
  assert.equal(result.recovered, false);
  assert.equal(result.reason, "no_correlated_message");

  const message = await getThreadMessage(thread.id, messageId, env);
  assert.equal(message.state, "running");
  const untouchedThread = await getThread(thread.id, env);
  assert.equal(untouchedThread.runtime.activeTurnId, "claude_turn_stuck");
});

test("SQLite recovery correlates the active turn instead of selecting a newer unrelated user message", async (t) => {
  const { env: baseEnv } = await fixture(t, "sqlite-correlation");
  const env = { ...baseEnv, ORKESTR_THREAD_MESSAGE_STORE: "sqlite" };
  const { thread, messageId } = await claudeThreadWithStuckTurn(env, "orphan-sqlite-correlation", { withFinal: false });
  const unrelated = await enqueueThreadInput(thread.id, { text: "newer unrelated request", source: "test" }, env);
  const { updateThreadMessage } = await import("../packages/core/src/threads.js");
  await updateThreadMessage(thread.id, unrelated.id, {
    state: "running",
    executorKind: "claude-code",
    executorTurnId: "claude_turn_other",
  }, env);

  const result = await recoverOrphanedClaudeCodeTurn(await getThread(thread.id, env), env);
  assert.equal(result.recovered, true);
  assert.equal(result.messageId, messageId);
  assert.equal((await getThreadMessage(thread.id, messageId, env)).state, "failed");
  assert.equal((await getThreadMessage(thread.id, unrelated.id, env)).state, "running");
});

test("recovery leaves a live turn untouched", async (t) => {
  const { env } = await fixture(t, "live");
  const { thread, messageId } = await claudeThreadWithStuckTurn(env, "orphan-live", { withFinal: false });

  // A live supervisor for this thread means the turn is not actually
  // orphaned -- some other request is legitimately still running it.
  const unregister = registerActiveClaudeCodeSupervisorForTest(thread.id);
  t.after(unregister);
  assert.equal(hasActiveClaudeCodeSupervisor(thread.id), true);

  const result = await recoverOrphanedClaudeCodeTurn(thread, env);
  assert.equal(result.recovered, false);
  assert.equal(result.reason, "turn_live");

  const message = await getThreadMessage(thread.id, messageId, env);
  assert.equal(message.state, "running");
  const untouchedThread = await getThread(thread.id, env);
  assert.equal(untouchedThread.runtime.activeTurnId, "claude_turn_stuck");
});

test("recovery is idempotent: a second pass over an already-recovered thread is a no-op", async (t) => {
  const { env } = await fixture(t, "idempotent");
  const { thread } = await claudeThreadWithStuckTurn(env, "orphan-idempotent", { withFinal: false });

  const first = await recoverOrphanedClaudeCodeTurn(thread, env);
  assert.equal(first.recovered, true);

  const second = await recoverOrphanedClaudeCodeTurn(await getThread(thread.id, env), env);
  assert.equal(second.recovered, false);
  assert.equal(second.reason, "no_active_turn");
});

test("recoverOrphanedClaudeCodeTurns sweeps every stuck claude-code thread and skips others", async (t) => {
  const { env } = await fixture(t, "sweep");
  await claudeThreadWithStuckTurn(env, "sweep-completed", { withFinal: true });
  await claudeThreadWithStuckTurn(env, "sweep-failed", { withFinal: false });
  await createThread({ id: "sweep-idle", name: "Idle", ownerUserId: "owner" }, env);

  const summary = await recoverOrphanedClaudeCodeTurns(env);
  assert.equal(summary.recovered, 2);
  const byThread = Object.fromEntries(summary.results.map((result) => [result.threadId, result]));
  assert.equal(byThread["sweep-completed"].outcome, "completed");
  assert.equal(byThread["sweep-failed"].outcome, "failed");
  assert.equal(byThread["sweep-idle"], undefined);
});
