// A Claude Code turn holds the thread reservation (profile checks, batching,
// spawn) before its process supervisor is registered. Status queries in that
// window must report the turn as working, never as interrupted.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claudeCodeStatusPayload } from "../packages/core/src/claude-code-status.js";
import { createLlmAccountProfile, updateLlmAccountProfileState } from "../packages/core/src/llm-account-profiles.js";
import { claudeCodeThreadStatus, interruptClaudeCodeThread, resetClaudeCodeRuntimeForTest, sendClaudeCodeInput, startClaudeCodeThread } from "../packages/core/src/runtime-claude-code-adapter.js";
import { createThread, enqueueThreadInput, getThread } from "../packages/core/src/threads.js";

test("a reserved turn without a supervisor yet is reported as working", () => {
  const thread = { state: "working", runtime: { state: "working", activeTurnId: "claude_turn_synthetic" } };
  const starting = claudeCodeStatusPayload({ thread, supervisor: null, starting: true });
  assert.equal(starting.state, "working");
  assert.equal(starting.working, true);
  assert.equal(starting.typingActive, true);
  assert.equal(starting.staleWorking, false);
  assert.equal(starting.activeTurnId, "claude_turn_synthetic");
  assert.notEqual(starting.error, "claude_code_runtime_interrupted");
  // Without a reservation the persisted working state is still an interruption.
  const orphan = claudeCodeStatusPayload({ thread, supervisor: null });
  assert.equal(orphan.state, "interrupted");
  assert.equal(orphan.working, false);
});

test("status sampled continuously across a real turn start never reports interrupted", { timeout: 15_000 }, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-status-starting-"));
  const priorHome = process.env.ORKESTR_HOME;
  process.env.ORKESTR_HOME = home;
  const script = path.join(home, "fake-claude.mjs");
  await fs.writeFile(script, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }) + "\\n");
setTimeout(() => {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", session_id: "s1", result: "done", is_error: false }) + "\\n");
  process.exit(0);
}, 1500);
`, { mode: 0o755 });
  const env = {
    ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "owner", ORKESTR_CLAUDE_CODE_ENABLED: "1", ORKESTR_CLAUDE_CODE_BIN: script,
    ORKESTR_CLAUDE_CODE_LOGIN_TRANSPORT: "pipe", ORKESTR_CLAUDE_GRACE_PERIOD_MS: "300",
  };
  let running = null;
  let thread = null;
  t.after(async () => {
    if (running) { await interruptClaudeCodeThread(thread, env).catch(() => {}); await running.catch(() => {}); }
    resetClaudeCodeRuntimeForTest();
    if (priorHome === undefined) delete process.env.ORKESTR_HOME; else process.env.ORKESTR_HOME = priorHome;
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const profile = await createLlmAccountProfile("owner", { provider: "claude-code", label: "Starting", authMode: "subscription" }, env);
  await updateLlmAccountProfileState("owner", profile.id, "ready", { verified: true }, env);
  const created = await createThread({ id: "status-starting", ownerUserId: "owner", executorId: "claude-code", runtimeKind: "claude-code",
    executor: { type: "claude-code", accountProfileId: profile.id, metadata: { accountProfileId: profile.id, runtimeKind: "claude-code" } } }, env);
  thread = (await startClaudeCodeThread(created, env)).thread;
  const message = await enqueueThreadInput(thread.id, { text: "start", source: "test" }, env);

  running = sendClaudeCodeInput(thread, message, env);
  const samples = [];
  for (const started = Date.now(); Date.now() - started < 1200;) {
    const current = await getThread(thread.id, env);
    const status = await claudeCodeThreadStatus(current, env);
    samples.push({ persisted: current.runtime?.state, state: status.state, working: status.working });
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(samples.some((sample) => sample.state === "working"), "the turn was observed working");
  const wrong = samples.filter((sample) => sample.persisted === "working" && (sample.state !== "working" || !sample.working));
  assert.deepEqual(wrong, [], "a persisted working turn is never reported interrupted or idle while it starts or runs");
  await running;
  running = null;
});
