import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { auditCodexQuestions, reportCodexQuestions } from "../packages/core/src/codex-question-audit.js";
import { createThread, appendThreadMessage, updateThread, listThreadMessages, getThread } from "../packages/core/src/threads.js";
import { listEvents } from "../packages/storage/src/store.js";
import { readConnectorOutbox } from "../packages/connectors/src/connector-outbox.js";
import { runQuestionAudit } from "../scripts/codex-question-audit.mjs";

const thread = { id: "thread-a", ownerUserId: "owner-a", executor: { transport: "app-server" },
  runtime: { codexThreadId: "generation-a" } };
const scope = { ownerUserId: "owner-a", runtimeGeneration: "generation-a" };
const question = { id: "question-a", ownerUserId: "owner-a", threadId: "thread-a", role: "assistant",
  source: "codex-rollout", phase: "need_input", codexThreadId: "generation-a", codexTurnId: "turn-a",
  text: "Sensitive question content", state: "completed" };

test("question audit separates unbound legacy, pending native and unresolved identities without content", () => {
  const report = auditCodexQuestions(thread, [question], scope);
  assert.equal(report.counts.legacy_unbound, 1);
  assert.equal(report.automaticMutation, false);
  assert.equal(JSON.stringify(report).includes(question.text), false);
  const pendingRequest = { requestId: 42, method: "item/tool/requestUserInput", codexThreadId: "generation-a",
    params: { turnId: "turn-a" } };
  const nativeThread = { ...thread, runtime: { ...thread.runtime, pendingRequest } };
  const native = { ...question, source: "codex-app-server", codexRequestId: "42" };
  assert.equal(auditCodexQuestions(nativeThread, [native], scope).counts.pending_native, 1);
  assert.equal(auditCodexQuestions(nativeThread, [question], scope).counts.manual_review, 1);
  assert.equal(auditCodexQuestions(thread, [native], scope).counts.manual_review, 1);
  assert.equal(auditCodexQuestions(nativeThread, [{ ...native, executorRequestId: "other" }], scope).counts.manual_review, 1);
  for (const patch of [{ codexThreadId: "old" }, { executorThreadId: "conflict" }]) {
    assert.equal(auditCodexQuestions(thread, [{ ...question, ...patch }], scope).counts.manual_review, 1);
  }
  assert.equal(auditCodexQuestions(thread, [question, question], scope).counts.manual_review, 2);
  assert.deepEqual(auditCodexQuestions(thread, [{ ...question, ownerUserId: "other" }], scope).rows, []);
  assert.throws(() => auditCodexQuestions(thread, [question], { ...scope, maxMessages: 0 }), /bounds/);
  assert.throws(() => auditCodexQuestions(thread, [question], { ...scope, runtimeGeneration: "old" }), /scope/);
  assert.throws(() => auditCodexQuestions({ ...thread, executor: { transport: "tmux" } }, [question], scope), /scope/);
});

test("completed answers require exact owner/generation binding", () => {
  const answer = { id: "answer", role: "user", ownerUserId: "owner-a", codexThreadId: "generation-a",
    answeredInputMessageId: question.id, state: "completed" };
  assert.equal(auditCodexQuestions(thread, [question, answer], scope).counts.resolved, 1);
  for (const patch of [{ state: "failed" }, { ownerUserId: "other" }, { codexThreadId: "old" }]) {
    assert.equal(auditCodexQuestions(thread, [question, { ...answer, ...patch }], scope).counts.legacy_unbound, 1);
  }
});

test("conflicting or duplicate resolution evidence stays under manual review", () => {
  const answer = { id: "answer", role: "user", ownerUserId: scope.ownerUserId,
    codexThreadId: scope.runtimeGeneration, answeredInputMessageId: question.id, state: "completed" };
  for (const patch of [{ executorThreadId: "other-generation" },
    { codexTurnId: "turn-a", executorTurnId: "other-turn" },
    { codexRequestId: "request-a", executorRequestId: "other-request" }]) {
    assert.equal(auditCodexQuestions(thread, [question, { ...answer, ...patch }], scope).counts.manual_review, 1);
  }
  assert.equal(auditCodexQuestions(thread, [question, answer, answer], scope).counts.manual_review, 1);
});

test("pending native requests cannot qualify with conflicting generation aliases", () => {
  const native = { ...question, source: "codex-app-server", codexRequestId: "42" };
  const pendingRequest = { requestId: 42, method: "item/tool/requestUserInput",
    codexThreadId: scope.runtimeGeneration, params: { threadId: "other-generation", turnId: "turn-a" } };
  assert.equal(auditCodexQuestions({ ...thread, runtime: { ...thread.runtime, pendingRequest } },
    [native], scope).counts.manual_review, 1);
});

test("repository question report leaves runtime, messages, events and outbox unchanged", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ork-question-audit-"));
  t.after(() => fs.rm(home, { recursive: true, force: true, maxRetries: 5 }));
  const env = { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "owner-a" };
  const stored = await createThread({ id: thread.id, ownerUserId: thread.ownerUserId, name: "Synthetic question audit" }, env);
  await updateThread(stored.id, { runtime: thread.runtime, executor: thread.executor }, env);
  await appendThreadMessage(stored.id, question, env);
  const before = { thread: await getThread(stored.id, env), messages: await listThreadMessages(stored.id, env),
    events: await listEvents(env, 1000), outbox: await readConnectorOutbox(env) };
  let transportCalls = 0;
  t.mock.method(globalThis, "fetch", async () => { transportCalls++; throw new Error("unexpected_transport"); });
  const result = await reportCodexQuestions({ threadId: stored.id, ...scope }, env);
  assert.equal(result.counts.legacy_unbound, 1);
  assert.equal((await reportCodexQuestions({ threadId: stored.id, ...scope }, env)).snapshotDigest, result.snapshotDigest);
  assert.deepEqual(await getThread(stored.id, env), before.thread);
  assert.deepEqual(await listThreadMessages(stored.id, env), before.messages);
  assert.deepEqual(await listEvents(env, 1000), before.events);
  assert.deepEqual(await readConnectorOutbox(env), before.outbox);
  await assert.rejects(reportCodexQuestions({ threadId: stored.id, ...scope, ownerUserId: "other" }, env), /scope/);
  const reportPath = path.join(home, "private", "questions.json");
  const args = ["--thread", stored.id, "--owner", scope.ownerUserId, "--generation", scope.runtimeGeneration, "--report", reportPath];
  assert.equal((await runQuestionAudit(args, env)).snapshotDigest, result.snapshotDigest);
  assert.equal((await fs.stat(reportPath)).mode & 0o777, 0o600);
  await assert.rejects(runQuestionAudit([...args, "--apply", "yes"], env), /invalid_arguments/);
  assert.equal(transportCalls, 0);
});
