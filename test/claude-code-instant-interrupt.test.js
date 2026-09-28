import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listEvents } from "../packages/storage/src/store.js";
import { createLlmAccountProfile, updateLlmAccountProfileState } from "../packages/core/src/llm-account-profiles.js";
import { getClaudeCodeSession } from "../packages/core/src/claude-code-sessions.js";
import { CLAUDE_CODE_INTERRUPT_RESUME_NOTE } from "../packages/core/src/claude-code-interrupt-resume.js";
import {
  deliverClaudeCodePendingInputs,
  hasActiveClaudeCodeSupervisor,
  interruptClaudeCodeThreadForInput,
  resetClaudeCodeRuntimeForTest,
  startClaudeCodeThread,
} from "../packages/core/src/runtime-claude-code-adapter.js";
import { recoverOrphanedClaudeCodeTurn } from "../packages/core/src/claude-code-orphan-turn-recovery.js";
import { createThread, enqueueThreadInput, getThread, getThreadMessage, listThreadMessages, updateThreadMessage } from "../packages/core/src/threads.js";

const steer = { steerActiveTurn: true, codexDeliveryMode: "instant_steer" };

async function fixture(t, name, extraEnv = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), `orkestr-claude-interrupt-${name}-`));
  const priorHome = process.env.ORKESTR_HOME;
  process.env.ORKESTR_HOME = home;
  const fake = path.join(home, "fake-claude.mjs");
  const calls = path.join(home, "calls.jsonl");
  await fs.writeFile(fake, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const record = (entry) => fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ pid: process.pid, ...entry }) + "\\n");
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
if (args[0] === "auth") {
  emit({ authenticated: true, status: "logged_in" });
  process.exit(0);
}
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { prompt += chunk; });
process.stdin.on("end", () => {
  const resumeAt = args.indexOf("--resume");
  const resumed = resumeAt >= 0 ? args[resumeAt + 1] : "";
  const session = resumed || "claude_session_fresh";
  record({ turn: true, resumed, prompt: prompt.trim() });
  emit({ type: "system", subtype: "init", session_id: session });
  const result = () => emit({ type: "result", session_id: session, is_error: false, result: "Reply: " + prompt.trim() });
  if (prompt.includes("long task")) {
    process.on("SIGINT", () => {
      record({ signal: "SIGINT" });
      setTimeout(() => process.exit(130), 100);
    });
    emit({ type: "assistant", session_id: session, message: { content: [{ type: "text", text: "partial work" }] } });
    record({ started: true });
    setTimeout(() => { result(); process.exit(0); }, 1500);
    return;
  }
  if (prompt.includes("ignore sigint")) {
    process.on("SIGINT", () => record({ signal: "SIGINT" }));
    record({ started: true });
    setTimeout(() => process.exit(0), 20000);
    return;
  }
  if (prompt.includes("answer on sigint")) {
    process.on("SIGINT", () => {
      record({ signal: "SIGINT" });
      result();
      setTimeout(() => process.exit(130), 20);
    });
    record({ started: true });
    setTimeout(() => process.exit(0), 20000);
    return;
  }
  if (prompt.includes("linger")) {
    process.on("SIGINT", () => record({ signal: "SIGINT" }));
    result();
    record({ resultWritten: true });
    setTimeout(() => process.exit(0), 500);
    return;
  }
  result();
});
`, { mode: 0o755 });
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_CLAUDE_CODE_ENABLED: "1",
    ORKESTR_CLAUDE_CODE_BIN: fake,
    ORKESTR_CLAUDE_CODE_INTERRUPT_GRACE_MS: "2000",
    ORKESTR_CLAUDE_GRACE_PERIOD_MS: "200",
    ...extraEnv,
  };
  t.after(async () => {
    resetClaudeCodeRuntimeForTest();
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const profile = await createLlmAccountProfile("owner", { provider: "claude-code", label: "Interrupt", authMode: "subscription" }, env);
  await updateLlmAccountProfileState("owner", profile.id, "ready", { verified: true }, env);
  env.ORKESTR_ADMIN_USER_ID = "owner";
  const created = await createThread({
    id: `claude-${name}`,
    name: `Claude interrupt ${name}`,
    ownerUserId: "owner",
    executorId: "claude-code",
    runtimeKind: "claude-code",
    executor: { type: "claude-code", accountProfileId: profile.id, metadata: { accountProfileId: profile.id, runtimeKind: "claude-code" } },
  }, env);
  const thread = (await startClaudeCodeThread(created, env)).thread;
  return { env, calls, thread };
}

async function readCalls(calls) {
  const raw = await fs.readFile(calls, "utf8").catch(() => "");
  return raw.trim() ? raw.trim().split("\n").map((line) => JSON.parse(line)) : [];
}

async function waitFor(predicate, timeoutMs = 8000) {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForStarted(calls, threadId, count = 1) {
  await waitFor(async () => hasActiveClaudeCodeSupervisor(threadId) && (await readCalls(calls)).filter((entry) => entry.started || entry.resultWritten).length >= count);
}

async function interruptEvents(env, threadId) {
  return (await listEvents(env, 500)).filter((event) => event.type === "claude_code_turn_interrupt_requested" && event.threadId === threadId);
}

test("steer input gracefully interrupts, persists the session, and coalesces follow-ups into one resume turn", async (t) => {
  const { env, calls, thread } = await fixture(t, "coalesce");
  const first = await enqueueThreadInput(thread.id, { text: "long task please", source: "test" }, env);
  const owner = deliverClaudeCodePendingInputs(thread, env);
  await waitForStarted(calls, thread.id);

  const second = await enqueueThreadInput(thread.id, { text: "first follow-up", source: "whatsapp_inbound", ...steer }, env);
  const third = await enqueueThreadInput(thread.id, { text: "second follow-up", source: "ui", ...steer }, env);
  assert.deepEqual(await deliverClaudeCodePendingInputs(thread, env), []);
  // Arrives during the SIGINT grace window: joins the same resume turn.
  const fourth = await enqueueThreadInput(thread.id, { text: "/now third follow-up", source: "whatsapp_inbound" }, env);

  const delivered = await owner;
  assert.deepEqual(delivered, [first.id, second.id, third.id, fourth.id]);

  const recorded = await readCalls(calls);
  const turns = recorded.filter((entry) => entry.turn);
  assert.equal(turns.length, 2);
  assert.equal(recorded.filter((entry) => entry.signal === "SIGINT").length, 1);
  assert.equal(turns[0].resumed, "");
  assert.equal(turns[1].resumed, "claude_session_fresh");
  assert.equal(turns[1].prompt, [CLAUDE_CODE_INTERRUPT_RESUME_NOTE, "first follow-up", "second follow-up", "third follow-up"].join("\n\n"));

  const current = await getThread(thread.id, env);
  assert.equal(await getClaudeCodeSession(current, env), "claude_session_fresh");
  const messages = await listThreadMessages(thread.id, env);
  const byId = Object.fromEntries(messages.map((message) => [message.id, message]));
  assert.equal(byId[first.id].observedVia, "claude_code_interrupted");
  const resumeTurnId = byId[second.id].executorTurnId;
  assert.ok(resumeTurnId);
  for (const id of [second.id, third.id, fourth.id]) {
    assert.equal(byId[id].state, "completed");
    assert.equal(byId[id].deliveryState, "delivered");
    assert.equal(byId[id].executorTurnId, resumeTurnId);
  }
  assert.equal(byId[third.id].coalescedIntoMessageId, second.id);
  assert.equal(byId[fourth.id].coalescedIntoMessageId, second.id);
  assert.equal(byId[fourth.id].text, "third follow-up");
  assert.deepEqual(byId[second.id].coalescedMessageIds, [third.id, fourth.id]);
  const assistant = messages.filter((message) => message.role === "assistant" && message.phase === "final_answer");
  assert.equal(assistant.length, 1);
  assert.equal(assistant[0].parentMessageId, second.id);
  const events = await interruptEvents(env, thread.id);
  assert.equal(events.length, 1);
  assert.equal(events[0].mode, "graceful");
});

test("an ignored SIGINT falls back to the supervisor terminate path after the grace period", async (t) => {
  const { env, calls, thread } = await fixture(t, "fallback", { ORKESTR_CLAUDE_CODE_INTERRUPT_GRACE_MS: "300" });
  const first = await enqueueThreadInput(thread.id, { text: "ignore sigint and keep going", source: "test" }, env);
  const owner = deliverClaudeCodePendingInputs(thread, env);
  await waitForStarted(calls, thread.id);
  const second = await enqueueThreadInput(thread.id, { text: "change of plan", source: "ui", ...steer }, env);
  const startedAt = Date.now();
  const interrupted = await interruptClaudeCodeThreadForInput(thread, env);
  assert.equal(interrupted.interrupted, true);
  assert.deepEqual(await owner, [first.id, second.id]);
  assert.ok(Date.now() - startedAt >= 250, "SIGTERM fallback must wait for the SIGINT grace period");
  const recorded = await readCalls(calls);
  assert.equal(recorded.filter((entry) => entry.signal === "SIGINT").length, 1);
  const turns = recorded.filter((entry) => entry.turn);
  assert.equal(turns.length, 2);
  assert.equal(turns[1].prompt, `${CLAUDE_CODE_INTERRUPT_RESUME_NOTE}\n\nchange of plan`);
  const messages = await listThreadMessages(thread.id, env);
  assert.equal(messages.find((message) => message.id === first.id).observedVia, "claude_code_interrupted");
});

test("a duplicate interrupt for the same turn is ignored", async (t) => {
  const { env, calls, thread } = await fixture(t, "duplicate");
  await enqueueThreadInput(thread.id, { text: "long task duplicate", source: "test" }, env);
  const owner = deliverClaudeCodePendingInputs(thread, env);
  await waitForStarted(calls, thread.id);
  await enqueueThreadInput(thread.id, { text: "only once", source: "ui", ...steer }, env);
  const firstRequest = await interruptClaudeCodeThreadForInput(thread, env);
  const secondRequest = await interruptClaudeCodeThreadForInput(thread, env);
  await deliverClaudeCodePendingInputs(thread, env);
  assert.equal(firstRequest.interrupted, true);
  assert.equal(firstRequest.duplicate, undefined);
  assert.equal(secondRequest.duplicate, true);
  await owner;
  const recorded = await readCalls(calls);
  assert.equal(recorded.filter((entry) => entry.signal === "SIGINT").length, 1);
  assert.equal((await interruptEvents(env, thread.id)).length, 1);
  assert.equal(recorded.filter((entry) => entry.turn && entry.prompt.includes("only once")).length, 1);
});

test("a turn that already emitted its result completes normally instead of being interrupted", async (t) => {
  const { env, calls, thread } = await fixture(t, "natural");
  const first = await enqueueThreadInput(thread.id, { text: "linger after answering", source: "test" }, env);
  const owner = deliverClaudeCodePendingInputs(thread, env);
  await waitForStarted(calls, thread.id);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const second = await enqueueThreadInput(thread.id, { text: "next question", source: "ui", ...steer }, env);
  const request = await interruptClaudeCodeThreadForInput(thread, env);
  assert.equal(request.interrupted, false);
  assert.equal(request.reason, "turn_completing");
  assert.deepEqual(await owner, [first.id, second.id]);
  const recorded = await readCalls(calls);
  assert.equal(recorded.some((entry) => entry.signal), false);
  assert.equal(recorded.filter((entry) => entry.turn)[1].prompt, "next question");
  const messages = await listThreadMessages(thread.id, env);
  assert.equal(messages.find((message) => message.id === first.id).observedVia, "claude_code_stream_json");
  assert.deepEqual(
    messages.filter((message) => message.role === "assistant").map((message) => message.text),
    ["Reply: linger after answering", "Reply: next question"],
  );
});

test("a result emitted during the SIGINT grace window is kept as a natural completion", async (t) => {
  const { env, calls, thread } = await fixture(t, "grace-result");
  const first = await enqueueThreadInput(thread.id, { text: "answer on sigint", source: "test" }, env);
  const owner = deliverClaudeCodePendingInputs(thread, env);
  await waitForStarted(calls, thread.id);
  const second = await enqueueThreadInput(thread.id, { text: "follow-up after answer", source: "ui", ...steer }, env);
  assert.equal((await interruptClaudeCodeThreadForInput(thread, env)).interrupted, true);
  assert.deepEqual(await owner, [first.id, second.id]);
  const messages = await listThreadMessages(thread.id, env);
  assert.equal(messages.find((message) => message.id === first.id).observedVia, "claude_code_stream_json");
  assert.deepEqual(
    messages.filter((message) => message.role === "assistant").map((message) => message.text),
    ["Reply: answer on sigint", "Reply: follow-up after answer"],
  );
  const turns = (await readCalls(calls)).filter((entry) => entry.turn);
  assert.equal(turns[1].prompt, "follow-up after answer");
  assert.equal((await getThread(thread.id, env)).runtime.lastTurnStatus, "completed");
});

test("the kill switch restores plain queueing for steer input while /now still interrupts", async (t) => {
  const { env, calls, thread } = await fixture(t, "kill-switch", { ORKESTR_CLAUDE_CODE_INSTANT_INTERRUPT: "0" });
  const first = await enqueueThreadInput(thread.id, { text: "long task queued", source: "test" }, env);
  const owner = deliverClaudeCodePendingInputs(thread, env);
  await waitForStarted(calls, thread.id);
  const second = await enqueueThreadInput(thread.id, { text: "queued one", source: "ui", ...steer }, env);
  const third = await enqueueThreadInput(thread.id, { text: "queued two", source: "ui", ...steer }, env);
  assert.deepEqual(await deliverClaudeCodePendingInputs(thread, env), []);
  assert.deepEqual(await owner, [first.id, second.id, third.id]);
  const recorded = await readCalls(calls);
  assert.equal(recorded.some((entry) => entry.signal), false);
  assert.deepEqual(recorded.filter((entry) => entry.turn).map((entry) => entry.prompt), ["long task queued", "queued one", "queued two"]);

  const fourth = await enqueueThreadInput(thread.id, { text: "long task again", source: "test" }, env);
  const nextOwner = deliverClaudeCodePendingInputs(thread, env);
  await waitForStarted(calls, thread.id, 2);
  const fifth = await enqueueThreadInput(thread.id, { text: "/now explicit interrupt", source: "whatsapp_inbound" }, env);
  await deliverClaudeCodePendingInputs(thread, env);
  assert.deepEqual(await nextOwner, [fourth.id, fifth.id]);
  const turns = (await readCalls(calls)).filter((entry) => entry.turn);
  assert.equal(turns.at(-1).prompt, `${CLAUDE_CODE_INTERRUPT_RESUME_NOTE}\n\nexplicit interrupt`);
});

test("passive inputs are never coalesced and keep their queue position", async (t) => {
  const { env, calls, thread } = await fixture(t, "passive");
  await enqueueThreadInput(thread.id, { text: "long task first", source: "test" }, env);
  const owner = deliverClaudeCodePendingInputs(thread, env);
  await waitForStarted(calls, thread.id);
  await enqueueThreadInput(thread.id, { text: "steer one", source: "ui", ...steer }, env);
  await enqueueThreadInput(thread.id, { text: "timer prompt", source: "timer", steerActiveTurn: false, codexDeliveryMode: "passive" }, env);
  await enqueueThreadInput(thread.id, { text: "steer two", source: "ui", ...steer }, env);
  await deliverClaudeCodePendingInputs(thread, env);
  await owner;
  const prompts = (await readCalls(calls)).filter((entry) => entry.turn).map((entry) => entry.prompt);
  assert.deepEqual(prompts, [
    "long task first",
    `${CLAUDE_CODE_INTERRUPT_RESUME_NOTE}\n\nsteer one`,
    "timer prompt",
    "steer two",
  ]);
});

test("orphan recovery settles every input coalesced into a crashed resume turn", async (t) => {
  const { env, thread } = await fixture(t, "orphan");
  const ids = [];
  for (const text of ["first steer", "second steer", "third steer"]) {
    const message = await enqueueThreadInput(thread.id, { text, source: "ui", ...steer }, env);
    await updateThreadMessage(thread.id, message.id, { state: "running", executorKind: "claude-code", executorTurnId: "claude_turn_crashed" }, env);
    ids.push(message.id);
  }
  const { updateThread } = await import("../packages/core/src/threads.js");
  await updateThread(thread.id, { state: "working", runtime: { ...(thread.runtime || {}), state: "working", activeTurnId: "claude_turn_crashed" } }, env);
  const result = await recoverOrphanedClaudeCodeTurn(thread.id, env);
  assert.equal(result.recovered, true);
  for (const id of ids) {
    const message = await getThreadMessage(thread.id, id, env);
    assert.equal(message.state, "failed");
    assert.equal(message.error, "claude_code_turn_interrupted");
  }
});
