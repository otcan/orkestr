import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listEvents } from "../packages/storage/src/store.js";
import { createLlmAccountProfile, updateLlmAccountProfileState } from "../packages/core/src/llm-account-profiles.js";
import {
  claudeCodeBurstNote,
  claudeCodeInputDebounceDelayMs,
} from "../packages/core/src/claude-code-interrupt-resume.js";
import {
  deliverClaudeCodePendingInputs,
  hasActiveClaudeCodeSupervisor,
  resetClaudeCodeRuntimeForTest,
  setClaudeCodeDeliveryScheduler,
  startClaudeCodeThread,
} from "../packages/core/src/runtime-claude-code-adapter.js";
import { createThread, enqueueThreadInput, listThreadMessages } from "../packages/core/src/threads.js";

// A WhatsApp group burst (text + photos sent one by one within seconds) must
// produce one turn and one answer, not one turn and one reply per message.

async function fixture(t, name, extraEnv = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), `orkestr-claude-burst-${name}-`));
  const priorHome = process.env.ORKESTR_HOME;
  process.env.ORKESTR_HOME = home;
  const fake = path.join(home, "fake-claude.mjs");
  const calls = path.join(home, "calls.jsonl");
  await fs.writeFile(fake, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
const record = (entry) => fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(entry) + "\\n");
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
if (args[0] === "auth") {
  emit({ authenticated: true, status: "logged_in" });
  process.exit(0);
}
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { prompt += chunk; });
process.stdin.on("end", () => {
  record({ turn: true, prompt: prompt.trim() });
  emit({ type: "system", subtype: "init", session_id: "claude_session_burst" });
  const finish = () => {
    emit({ type: "result", session_id: "claude_session_burst", is_error: false, result: "Reply: " + prompt.trim() });
    process.exit(0);
  };
  if (prompt.includes("long task")) {
    record({ started: true });
    setTimeout(finish, 1200);
    return;
  }
  finish();
});
`, { mode: 0o755 });
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_CLAUDE_CODE_ENABLED: "1",
    ORKESTR_CLAUDE_CODE_BIN: fake,
    ORKESTR_CLAUDE_GRACE_PERIOD_MS: "200",
    ORKESTR_THREAD_INPUT_DEBOUNCE_MS: "0",
    ...extraEnv,
  };
  let releaseScheduler = () => {};
  t.after(async () => {
    releaseScheduler();
    resetClaudeCodeRuntimeForTest();
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const profile = await createLlmAccountProfile("owner", { provider: "claude-code", label: "Burst", authMode: "subscription" }, env);
  await updateLlmAccountProfileState("owner", profile.id, "ready", { verified: true }, env);
  env.ORKESTR_ADMIN_USER_ID = "owner";
  const created = await createThread({
    id: `claude-burst-${name}`,
    name: `Claude burst ${name}`,
    ownerUserId: "owner",
    executorId: "claude-code",
    runtimeKind: "claude-code",
    executor: { type: "claude-code", accountProfileId: profile.id, metadata: { accountProfileId: profile.id, runtimeKind: "claude-code" } },
  }, env);
  const thread = (await startClaudeCodeThread(created, env)).thread;
  // Mirrors the production scheduler: one pending timer per thread, re-armed
  // by every request.
  const useScheduler = () => {
    const timers = new Map();
    const handler = (threadId, schedulerEnv, delayMs) => {
      clearTimeout(timers.get(threadId));
      timers.set(threadId, setTimeout(() => { void deliverClaudeCodePendingInputs(thread, schedulerEnv).catch(() => {}); }, delayMs));
    };
    const release = setClaudeCodeDeliveryScheduler(handler);
    releaseScheduler = () => {
      release();
      for (const timer of timers.values()) clearTimeout(timer);
    };
    return handler;
  };
  return { env, calls, thread, useScheduler };
}

async function turnsOf(calls) {
  const raw = await fs.readFile(calls, "utf8").catch(() => "");
  return (raw.trim() ? raw.trim().split("\n").map((line) => JSON.parse(line)) : []).filter((entry) => entry.turn);
}

async function waitFor(predicate, timeoutMs = 10000) {
  const started = Date.now();
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function settled(thread, env) {
  return waitFor(async () => {
    if (hasActiveClaudeCodeSupervisor(thread.id)) return false;
    const open = (await listThreadMessages(thread.id, env)).filter((message) => message.role === "user" && !["completed", "failed", "cancelled"].includes(message.state));
    return open.length === 0;
  });
}

const group = (text) => ({ text, source: "whatsapp_group_relay" });

test("debounce holds a fresh chat input until the burst goes quiet, capped by the max wait", () => {
  const env = { ORKESTR_THREAD_INPUT_DEBOUNCE_MS: "3000", ORKESTR_THREAD_INPUT_DEBOUNCE_MAX_MS: "10000" };
  const at = (seconds) => new Date(Date.UTC(2026, 9, 22, 10, 20, 0) + seconds * 1000).toISOString();
  const input = (id, seconds, extra = {}) => ({ id, role: "user", state: "queued", source: "whatsapp_group_relay", createdAt: at(seconds), ...extra });
  const now = (seconds) => Date.UTC(2026, 9, 22, 10, 20, 0) + seconds * 1000;
  const burst = [input("a", 0), input("b", 0.7), input("c", 1.5)];

  assert.equal(claudeCodeInputDebounceDelayMs(burst, burst[0], env, now(1.6)), 2900, "waits for quiet after the newest input");
  assert.equal(claudeCodeInputDebounceDelayMs(burst, burst[0], env, now(4.5)), 0, "starts once the burst is quiet");
  const stream = Array.from({ length: 12 }, (_, index) => input(`s${index}`, index));
  assert.equal(claudeCodeInputDebounceDelayMs(stream, stream[0], env, now(9.5)), 500, "a continuous stream cannot hold the first input past the max wait");
  assert.equal(claudeCodeInputDebounceDelayMs(stream, stream[0], env, now(10)), 0);

  assert.equal(claudeCodeInputDebounceDelayMs(burst, burst[0], { ORKESTR_THREAD_INPUT_DEBOUNCE_MS: "0" }, now(0.1)), 0, "kill switch");
  const timer = input("t", 0, { source: "timer_due" });
  assert.equal(claudeCodeInputDebounceDelayMs([timer], timer, env, now(0.1)), 0, "machine inputs never wait");
  const bridge = input("m", 0, { source: "thread_bridge_message" });
  assert.equal(claudeCodeInputDebounceDelayMs([bridge], bridge, env, now(0.1)), 0, "MCP requests never wait");
  const steer = input("n", 0, { steerActiveTurn: true, codexDeliveryMode: "instant_steer" });
  assert.equal(claudeCodeInputDebounceDelayMs([steer], steer, env, now(0.1)), 0, "interrupt inputs never wait");
  const command = input("c1", 0, { text: "/stop" });
  assert.equal(claudeCodeInputDebounceDelayMs([command], command, env, now(0.1)), 0, "commands never wait");
  // A newer input from another source does not extend the window.
  const mixed = [input("a", 0), input("x", 1.5, { source: "timer_due" })];
  assert.equal(claudeCodeInputDebounceDelayMs(mixed, mixed[0], env, now(1)), 2000);
});

test("pending chat inputs are coalesced into one turn with one answer and a burst note", async (t) => {
  const { env, calls, thread } = await fixture(t, "idle");
  const inputs = [];
  for (const text of ["merhaba, bi eksik fark ettim", "en önemlisi bu bizim için", "eski versiyonunda bu şekilde"]) {
    inputs.push(await enqueueThreadInput(thread.id, group(text), env));
  }
  const delivered = await deliverClaudeCodePendingInputs(thread, env);
  assert.deepEqual(delivered, inputs.map((input) => input.id));

  const turns = await turnsOf(calls);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].prompt, [claudeCodeBurstNote(3), "merhaba, bi eksik fark ettim", "en önemlisi bu bizim için", "eski versiyonunda bu şekilde"].join("\n\n"));

  const messages = await listThreadMessages(thread.id, env);
  const users = messages.filter((message) => inputs.some((input) => input.id === message.id));
  assert.ok(users.every((message) => message.state === "completed"));
  assert.equal(new Set(users.map((message) => message.executorTurnId)).size, 1, "all inputs settle under one turn");
  const finals = messages.filter((message) => message.role === "assistant" && message.phase === "final_answer");
  assert.equal(finals.length, 1, "one answer for the whole burst");
  assert.equal(finals[0].parentMessageId, inputs[0].id);
  assert.equal((await listEvents(env, 500)).filter((event) => event.type === "claude_code_inputs_coalesced").length, 1);
});

test("inputs arriving while a turn runs become one follow-up turn", async (t) => {
  const { env, calls, thread } = await fixture(t, "running");
  const first = await enqueueThreadInput(thread.id, group("long task first"), env);
  const owner = deliverClaudeCodePendingInputs(thread, env);
  await waitFor(async () => (await turnsOf(calls)).length === 1);
  const second = await enqueueThreadInput(thread.id, group("second"), env);
  const third = await enqueueThreadInput(thread.id, group("third"), env);
  const fourth = await enqueueThreadInput(thread.id, group("fourth"), env);
  assert.deepEqual(await deliverClaudeCodePendingInputs(thread, env), [], "a running turn owns the queue");
  assert.deepEqual(await owner, [first.id, second.id, third.id, fourth.id]);

  const turns = await turnsOf(calls);
  assert.deepEqual(turns.map((turn) => turn.prompt), ["long task first", [claudeCodeBurstNote(3), "second", "third", "fourth"].join("\n\n")]);
  const finals = (await listThreadMessages(thread.id, env)).filter((message) => message.role === "assistant" && message.phase === "final_answer");
  assert.equal(finals.length, 2);
});

test("a burst kicked per message with the default debounce starts exactly one turn", async (t) => {
  const { env, calls, thread, useScheduler } = await fixture(t, "debounce", { ORKESTR_THREAD_INPUT_DEBOUNCE_MS: "400" });
  const schedule = useScheduler();
  const inputs = [];
  for (const text of ["one", "two", "three"]) {
    inputs.push(await enqueueThreadInput(thread.id, group(text), env));
    // Every inbound message requests delivery right away, as WhatsApp does.
    schedule(thread.id, env, 0);
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  await settled(thread, env);
  const turns = await turnsOf(calls);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].prompt, [claudeCodeBurstNote(3), "one", "two", "three"].join("\n\n"));
  assert.ok((await listEvents(env, 500)).some((event) => event.type === "claude_code_input_debounced" && event.messageId === inputs[0].id));
});

test("chat bursts never absorb machine, MCP or differently-routed inputs", async (t) => {
  const { env, calls, thread } = await fixture(t, "boundaries");
  await enqueueThreadInput(thread.id, group("chat a"), env);
  await enqueueThreadInput(thread.id, { text: "timer report", source: "timer_due" }, env);
  await enqueueThreadInput(thread.id, group("chat b"), env);
  await enqueueThreadInput(thread.id, { text: "dm reply", source: "whatsapp_inbound", connector: "whatsapp", chatId: "synthetic-dm", accountId: "synthetic-account" }, env);
  await deliverClaudeCodePendingInputs(thread, env);
  await settled(thread, env);
  assert.deepEqual((await turnsOf(calls)).map((turn) => turn.prompt), ["chat a", "timer report", "chat b", "dm reply"]);
});

test("ORKESTR_CLAUDE_CODE_COALESCE_QUEUED_INPUTS=0 restores one turn per queued input", async (t) => {
  const { env, calls, thread } = await fixture(t, "disabled", { ORKESTR_CLAUDE_CODE_COALESCE_QUEUED_INPUTS: "0" });
  await enqueueThreadInput(thread.id, group("one"), env);
  await enqueueThreadInput(thread.id, group("two"), env);
  await deliverClaudeCodePendingInputs(thread, env);
  assert.deepEqual((await turnsOf(calls)).map((turn) => turn.prompt), ["one", "two"]);
});
