import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createLlmAccountProfile, updateLlmAccountProfileState } from "../packages/core/src/llm-account-profiles.js";
import { createThread, enqueueThreadInput, getThread, getThreadMessage, updateThread } from "../packages/core/src/threads.js";
import { setThreadQueueHold, threadQueueSnapshot } from "../packages/core/src/thread-queue-control.js";
import {
  deliverClaudeCodePendingInputs, interruptClaudeCodeThreadForInput,
  resetClaudeCodeRuntimeForTest, sendClaudeCodeInput, startClaudeCodeThread,
} from "../packages/core/src/runtime-claude-code-adapter.js";

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "claude-queue-hold-"));
  const before = process.env.ORKESTR_HOME;
  process.env.ORKESTR_HOME = home;
  const calls = path.join(home, "calls.jsonl");
  const release = path.join(home, "release");
  const fake = path.join(home, "claude.mjs");
  const pending = [];
  await fs.writeFile(fake, `#!/usr/bin/env node
import fs from "node:fs";
const emit = event => process.stdout.write(JSON.stringify(event) + "\\n");
const record = event => fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(event) + "\\n");
if (process.argv[2] === "auth") { emit({authenticated:true,status:"logged_in"}); process.exit(0); }
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { prompt += chunk; });
process.stdin.on("end", () => {
  record({turn:true,prompt});
  emit({type:"system",subtype:"init",session_id:"claude_session_queue"});
  const finish = () => { emit({type:"result",session_id:"claude_session_queue",is_error:false,result:"Complete"}); process.exit(0); };
  if (!prompt.includes("long task")) { finish(); return; }
  record({started:true});
  process.on("SIGTERM", () => { record({interrupted:true}); process.exit(130); });
  setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) finish(); }, 20);
});
`, { mode: 0o755 });
  const env = { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "owner", ORKESTR_CLAUDE_CODE_ENABLED: "1",
    ORKESTR_CLAUDE_CODE_BIN: fake, ORKESTR_THREAD_INPUT_DEBOUNCE_MS: "0", ORKESTR_AUTO_RUN_THREAD_INPUT: "0",
    ORKESTR_CLAUDE_DETACHED_TURNS: "0", ORKESTR_CLAUDE_GRACE_PERIOD_MS: "100" };
  t.after(async () => {
    await fs.writeFile(release, "release");
    await Promise.allSettled(pending);
    resetClaudeCodeRuntimeForTest();
    if (before === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = before;
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const profile = await createLlmAccountProfile("owner", { provider: "claude-code", label: "Synthetic", authMode: "subscription" }, env);
  await updateLlmAccountProfileState("owner", profile.id, "ready", { verified: true }, env);
  const created = await createThread({ id: "claude-queue", ownerUserId: "owner", runtimeKind: "claude-code", executorId: "claude-code",
    executor: { type: "claude-code", accountProfileId: profile.id, metadata: { runtimeKind: "claude-code", accountProfileId: profile.id } } }, env);
  const thread = (await startClaudeCodeThread(created, env)).thread;
  const readCalls = async () => (await fs.readFile(calls, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  return { env, thread, pending, release, readCalls };
}

async function waitFor(condition) {
  const deadline = Date.now() + 5000;
  while (!await condition()) {
    assert.ok(Date.now() < deadline, "synthetic turn did not reach the expected phase");
    await delay(20);
  }
}

test("Claude hold fences stale direct callers and pending dispatch without claiming inputs", async t => {
  const f = await fixture(t);
  const row = await enqueueThreadInput(f.thread.id, { text: "next task", source: "cli" }, f.env);
  const held = await setThreadQueueHold(f.thread.id, { paused: true, reason: "migration" }, f.env);
  assert.equal(held.paused, true);
  assert.equal(held.pendingCount, 1);
  assert.equal(held.activeTurnId, null);
  assert.deepEqual(await deliverClaudeCodePendingInputs(f.thread, f.env), []);
  assert.equal((await sendClaudeCodeInput(f.thread, row, f.env)).skipped, true);
  assert.equal((await f.readCalls()).length, 0);
  const unchanged = await getThreadMessage(f.thread.id, row.id, f.env);
  assert.equal(unchanged.state, "queued");
  assert.equal(unchanged.deliveryAttempt, undefined);
  assert.equal(unchanged.executorTurnId, undefined);
  await setThreadQueueHold(f.thread.id, { paused: false, reason: "complete" }, f.env);
  assert.deepEqual(await deliverClaudeCodePendingInputs(f.thread, f.env), [row.id]);
  assert.equal((await f.readCalls()).filter(c => c.turn).length, 1);
});

test("Claude hold returns during a live turn, reports its id, and preserves its next input", async t => {
  const f = await fixture(t);
  const first = await enqueueThreadInput(f.thread.id, { text: "long task", source: "cli" }, f.env);
  const running = sendClaudeCodeInput(f.thread, first, f.env);
  f.pending.push(running);
  await waitFor(async () => (await f.readCalls()).some(c => c.started));
  const second = await enqueueThreadInput(f.thread.id, { text: "next task", source: "cli" }, f.env);
  let timer;
  const hold = await Promise.race([
    setThreadQueueHold(f.thread.id, { paused: true, reason: "migration" }, f.env),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("hold waited for inference")), 1500); }),
  ]).finally(() => clearTimeout(timer));
  assert.equal(hold.activeTurnId, (await getThread(f.thread.id, f.env)).runtime.activeTurnId);
  assert.ok(hold.activeTurnId.startsWith("claude_turn_"));
  assert.equal(hold.pendingCount, 1);
  assert.deepEqual(await interruptClaudeCodeThreadForInput(f.thread, f.env), { interrupted: false, reason: "queue_held" });
  assert.deepEqual(await deliverClaudeCodePendingInputs(f.thread, f.env), []);
  assert.equal((await f.readCalls()).some(c => c.interrupted), false);
  await fs.writeFile(f.release, "complete");
  await running;
  const settled = await threadQueueSnapshot(f.thread.id, f.env);
  assert.equal(settled.paused, true);
  assert.equal(settled.activeTurnId, null);
  assert.equal(settled.pendingCount, 1);
  assert.equal((await getThreadMessage(f.thread.id, second.id, f.env)).state, "queued");
  await setThreadQueueHold(f.thread.id, { paused: false, reason: "complete" }, f.env);
  assert.deepEqual(await deliverClaudeCodePendingInputs(f.thread, f.env), [second.id]);
  assert.equal((await f.readCalls()).filter(c => c.turn).length, 2);
});

test("releasing a migrated Claude hold never starts its preserved inputs locally", async t => {
  const f = await fixture(t);
  const row = await enqueueThreadInput(f.thread.id, { text: "preserved", source: "cli" }, f.env);
  await setThreadQueueHold(f.thread.id, { paused: true, reason: "migration" }, f.env);
  await updateThread(f.thread.id, { binding: { remoteBackend: "example", remoteThreadId: "remote-example", remoteRuntimeEnabled: true } }, f.env);
  await setThreadQueueHold(f.thread.id, { paused: false, reason: "remote enabled" }, f.env);
  assert.deepEqual(await deliverClaudeCodePendingInputs(f.thread, f.env), []);
  assert.equal((await sendClaudeCodeInput(f.thread, row, f.env)).skipped, true);
  assert.equal((await f.readCalls()).length, 0);
  assert.equal((await getThreadMessage(f.thread.id, row.id, f.env)).state, "queued");
});
