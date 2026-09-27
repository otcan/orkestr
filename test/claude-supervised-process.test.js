// Hermetic regression tests for the Claude supervised-process abstraction.
//
// Rules:
// - No real Claude or Codex provider binaries are invoked.
// - Every test has an explicit timeout.
// - Production/provider env vars are stripped; ORKESTR_HOME is an isolated tmpdir.
// - All spawned processes are awaited; leaked handles would fail the test.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import {
  recoverOrphanedAttempt,
  spawnSupervised,
  supervisedProcessDefaults,
} from "../packages/core/src/claude-code-supervised-process.js";
import {
  claudeCodeThreadStatus,
  deliverClaudeCodePendingInputs,
  interruptClaudeCodeThread,
  resetClaudeCodeRuntimeForTest,
  sendClaudeCodeInput,
  startClaudeCodeThread,
} from "../packages/core/src/runtime-claude-code-adapter.js";
import { createClaudeCodeProgressReporter } from "../packages/core/src/claude-code-progress.js";
import {
  createLlmAccountProfile,
  updateLlmAccountProfileState,
} from "../packages/core/src/llm-account-profiles.js";
import {
  createThread,
  enqueueThreadInput,
  getThread,
  listThreadMessages,
} from "../packages/core/src/threads.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function mktemp(prefix = "orkestr-sup-") {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeFakeScript(dir, name, body) {
  const p = path.join(dir, name);
  await fs.writeFile(p, `#!/usr/bin/env node\n${body}`, { mode: 0o755 });
  return p;
}

// Drain supervisor's stdout/stderr so Node.js can close the streams and fire
// the "close" event. Required for tests that don't go through the adapter's
// readline consumer.
function drainSupervisor(supervisor) {
  supervisor.proc.stdout.resume();
  supervisor.proc.stderr.resume();
}

function fakeChildEnv() {
  return {
    PATH: process.env.PATH || "/usr/bin:/bin",
    LANG: process.env.LANG || "C.UTF-8",
  };
}

// Wait for a supervised process to exit (uses "exit" event which fires before
// stdio streams close, avoiding ordering issues in drain-less tests).
function waitForExit(supervisor) {
  return new Promise((resolve) => {
    if (supervisor.proc.exitCode !== null || supervisor.proc.signalCode !== null) {
      resolve();
    } else {
      supervisor.proc.once("exit", resolve);
    }
  });
}

async function readyProfile(ownerUserId, label, env) {
  const created = await createLlmAccountProfile(ownerUserId, { provider: "claude-code", label, authMode: "subscription" }, env);
  await updateLlmAccountProfileState(ownerUserId, created.id, "ready", { verified: true }, env);
  return created;
}

async function claudeThread(ownerUserId, profileId, env, id = "sup-thread") {
  env.ORKESTR_ADMIN_USER_ID = ownerUserId;
  const thread = await createThread({
    id,
    name: `Supervised test ${id}`,
    ownerUserId,
    executorId: "claude-code",
    runtimeKind: "claude-code",
    executor: { type: "claude-code", accountProfileId: profileId, metadata: { accountProfileId: profileId, runtimeKind: "claude-code" } },
  }, env);
  return (await startClaudeCodeThread(thread, env)).thread;
}

// ---------------------------------------------------------------------------
// 1. supervisedProcessDefaults reads env vars with safe fallbacks
// ---------------------------------------------------------------------------
test("supervisedProcessDefaults reads env vars with safe fallbacks", { timeout: 2_000 }, () => {
  const defaults = supervisedProcessDefaults({});
  assert.equal(defaults.gracePeriodMs, 5_000);
  assert.equal(defaults.semanticInactivityMs, 10 * 60_000);
  assert.equal(defaults.staleWorkingMs, 2 * 60_000);
  assert.equal(defaults.toolDeadlineMs, 10 * 60_000);

  const custom = supervisedProcessDefaults({
    ORKESTR_CLAUDE_GRACE_PERIOD_MS: "200",
    ORKESTR_CLAUDE_SEMANTIC_INACTIVITY_MS: "3000",
    ORKESTR_CLAUDE_STALE_WORKING_MS: "1000",
    ORKESTR_CLAUDE_TOOL_DEADLINE_MS: "4000",
  });
  assert.equal(custom.gracePeriodMs, 200);
  assert.equal(custom.semanticInactivityMs, 3_000);
  assert.equal(custom.staleWorkingMs, 1_000);
  assert.equal(custom.toolDeadlineMs, 4_000);
});

// ---------------------------------------------------------------------------
// 2. recoverOrphanedAttempt returns no_identity when file is absent
// ---------------------------------------------------------------------------
test("recoverOrphanedAttempt returns no_identity when file absent", { timeout: 2_000 }, async () => {
  const dir = await mktemp("sup-recover-");
  try {
    const result = await recoverOrphanedAttempt(path.join(dir, "nonexistent.json"));
    assert.equal(result.recovered, false);
    assert.equal(result.reason, "no_identity");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 3. recoverOrphanedAttempt skips an already-dead PGID
// ---------------------------------------------------------------------------
test("recoverOrphanedAttempt skips already-dead PGID", { timeout: 2_000 }, async () => {
  const dir = await mktemp("sup-dead-");
  const filePath = path.join(dir, "identity.json");
  try {
    // PID 99999999 almost certainly does not exist.
    await fs.writeFile(filePath, JSON.stringify({ attemptId: "old", pid: 99999999, pgid: 99999999 }), "utf8");
    const result = await recoverOrphanedAttempt(filePath);
    // On Linux POSIX, `kill(-99999999, 0)` → ESRCH → "already_dead".
    assert.ok(
      result.reason === "already_dead" || result.reason === "not_posix" || result.recovered === true,
      `unexpected reason: ${result.reason}`,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 4. spawnSupervised: observeEvent tracks semantic evidence and stale state
// ---------------------------------------------------------------------------
test("spawnSupervised tracks semantic evidence and stale state", { timeout: 5_000 }, async (t) => {
  const dir = await mktemp("sup-semantic-");
  try {
    // A minimal script that waits for stdin before exiting (so we control timing).
    const script = await writeFakeScript(dir, "fake.mjs", `
process.stdin.setEncoding("utf8");
process.stdin.once("data", () => process.exit(0));
`);
    const supervisor = spawnSupervised({
      command: "node",
      args: [script],
      cwd: dir,
      env: fakeChildEnv(),
      attemptId: "test-semantic",
      gracePeriodMs: 500,
      semanticInactivityMs: 2_000,
      staleWorkingMs: 100,
      toolDeadlineMs: 30_000,
    });
    drainSupervisor(supervisor);
    t.after(() => { if (!supervisor.settled) { supervisor.proc.stdin.end("x"); supervisor.markSettled(); } });

    // Initially not stale (just started).
    assert.equal(supervisor.staleWorking, false);

    // Transport-only init event does NOT count as semantic evidence.
    const tBefore = supervisor.lastSemanticEvidenceAt;
    supervisor.observeEvent({ type: "system", subtype: "init", session_id: "s1" });
    assert.equal(supervisor.lastSemanticEvidenceAt, tBefore, "init does not advance semantic clock");

    // A real assistant event IS semantic.
    await new Promise((r) => setTimeout(r, 10));
    supervisor.observeEvent({ type: "assistant", session_id: "s1", message: { content: [{ type: "text", text: "hi" }] } });
    assert.ok(supervisor.lastSemanticEvidenceAt > tBefore, "semantic evidence timestamp advances");

    // After staleWorkingMs (100 ms) with no new events → staleWorking = true.
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(supervisor.staleWorking, true, "staleWorking true after silence");
    supervisor.tickStaleWorking();
    assert.ok(supervisor.staleWorkingSince !== null, "staleWorkingSince set after tick");

    // A new semantic event clears stale state.
    supervisor.observeEvent({ type: "result", subtype: "success" });
    assert.equal(supervisor.staleWorking, false, "staleWorking cleared by new event");
    supervisor.tickStaleWorking();
    assert.equal(supervisor.staleWorkingSince, null, "staleWorkingSince cleared after tick");

    supervisor.proc.stdin.end("done\n");
    await waitForExit(supervisor);
    supervisor.markSettled();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. spawnSupervised kills process group including grandchild descendants
// ---------------------------------------------------------------------------
test("PGID kill terminates grandchild readline handle", { timeout: 5_000 }, async (t) => {
  const dir = await mktemp("sup-pgid-");
  const childPidFile = path.join(dir, "child.pid");
  try {
    // Fake Claude spawns a grandchild with an open readline handle, then exits.
    // Without PGID kill the grandchild would keep running.
    const script = await writeFakeScript(dir, "fake-claude.mjs", `
import { spawn } from "node:child_process";
import fs from "node:fs";
const child = spawn(process.execPath, ["-e",
  "const rl = require('readline').createInterface({input:process.stdin}); setInterval(()=>{},1000);"
], { detached: false, stdio: "pipe" });
fs.writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid));
process.exit(0);
`);

    const supervisor = spawnSupervised({
      command: "node",
      args: [script],
      cwd: dir,
      env: fakeChildEnv(),
      attemptId: "pgid-test",
      gracePeriodMs: 500,
      semanticInactivityMs: 30_000,
      staleWorkingMs: 30_000,
      toolDeadlineMs: 30_000,
    });
    drainSupervisor(supervisor);
    t.after(() => { if (!supervisor.settled) supervisor.terminate("test_cleanup"); });

    // Register exit listener BEFORE waiting for the PID file (race-free).
    const exitedPromise = waitForExit(supervisor);

    // Wait for the grandchild PID file.
    for (let i = 0; i < 60; i++) {
      try { await fs.access(childPidFile); break; } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 50));
    }
    const childPidRaw = await fs.readFile(childPidFile, "utf8").catch(() => "0");
    const childPid = Number(childPidRaw.trim());
    assert.ok(childPid > 0, "grandchild PID recorded");

    // Verify grandchild is alive before the kill.
    let aliveBeforeKill = false;
    try { process.kill(childPid, 0); aliveBeforeKill = true; } catch { /* dead */ }
    assert.equal(aliveBeforeKill, true, "grandchild alive before PGID kill");

    // Kill via process group — should take out both Claude and the grandchild.
    supervisor.terminate("test");
    // Wait for Claude to exit (it may have already exited on its own).
    await Promise.race([exitedPromise, new Promise((r) => setTimeout(r, 2_000))]);
    supervisor.markSettled();

    // Give the kill signal time to propagate to the grandchild.
    await new Promise((r) => setTimeout(r, 300));

    let deadAfterKill = false;
    try { process.kill(childPid, 0); } catch { deadAfterKill = true; }
    assert.equal(deadAfterKill, true, "grandchild killed via PGID");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. SIGTERM → SIGKILL escalation fires within grace period
// ---------------------------------------------------------------------------
test("SIGTERM-to-SIGKILL escalation fires within grace period", { timeout: 5_000 }, async (t) => {
  const dir = await mktemp("sup-term-kill-");
  try {
    // A fake Claude that traps and ignores SIGTERM.
    const script = await writeFakeScript(dir, "fake-stubborn.mjs", `
process.on("SIGTERM", () => { /* ignore */ });
setInterval(() => {}, 10_000); // keep alive
`);
    const start = Date.now();
    const supervisor = spawnSupervised({
      command: "node",
      args: [script],
      cwd: dir,
      env: fakeChildEnv(),
      attemptId: "term-kill-test",
      gracePeriodMs: 300,
      semanticInactivityMs: 30_000,
      staleWorkingMs: 30_000,
      toolDeadlineMs: 30_000,
    });
    drainSupervisor(supervisor);
    t.after(() => { if (!supervisor.settled) supervisor.terminate("test_cleanup"); });

    await new Promise((r) => setTimeout(r, 50)); // let the process start
    supervisor.terminate("test");
    await waitForExit(supervisor);
    supervisor.markSettled();

    const elapsed = Date.now() - start;
    assert.ok(elapsed < 2_000, `process died within 2 s (actual ${elapsed} ms)`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 7. Semantic stall triggers termination via semanticInactivityMs timer
// ---------------------------------------------------------------------------
test("semantic stall terminates process after inactivity deadline", { timeout: 5_000 }, async (t) => {
  const dir = await mktemp("sup-stall-");
  try {
    // Fake Claude emits init and then stalls.
    const script = await writeFakeScript(dir, "fake-stall.mjs", `
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }) + "\\n");
setInterval(() => {}, 10_000);
`);
    let stallCalled = false;
    const supervisor = spawnSupervised({
      command: "node",
      args: [script],
      cwd: dir,
      env: fakeChildEnv(),
      attemptId: "stall-test",
      gracePeriodMs: 300,
      semanticInactivityMs: 300,
      staleWorkingMs: 100,
      toolDeadlineMs: 30_000,
      onSemanticStall() { stallCalled = true; },
    });
    drainSupervisor(supervisor);
    t.after(() => { if (!supervisor.settled) supervisor.terminate("test_cleanup"); });

    await waitForExit(supervisor);
    supervisor.markSettled();

    assert.equal(stallCalled, true, "onSemanticStall callback fired");
    assert.equal(supervisor.failureCode, "claude_code_semantic_stall");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 8. Per-tool deadline terminates a stuck tool call
// ---------------------------------------------------------------------------
test("per-tool deadline terminates a stuck tool call", { timeout: 5_000 }, async (t) => {
  const dir = await mktemp("sup-tool-deadline-");
  try {
    // Fake Claude emits a tool_use but never emits tool_result.
    const script = await writeFakeScript(dir, "fake-tool-stuck.mjs", `
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "assistant", session_id: "s1", message: { content: [
  { type: "tool_use", name: "Bash", input: { command: "sleep 9999" } }
] } }) + "\\n");
setInterval(() => {}, 10_000);
`);
    let timeoutCalled = false;
    let timeoutToolName = null;
    const supervisor = spawnSupervised({
      command: "node",
      args: [script],
      cwd: dir,
      env: fakeChildEnv(),
      attemptId: "tool-deadline-test",
      gracePeriodMs: 300,
      semanticInactivityMs: 30_000,
      staleWorkingMs: 30_000,
      toolDeadlineMs: 300,
      onToolTimeout({ toolName }) {
        timeoutCalled = true;
        timeoutToolName = toolName;
      },
    });
    const lines = readline.createInterface({ input: supervisor.proc.stdout });
    lines.on("line", (line) => {
      try { supervisor.observeEvent(JSON.parse(line)); } catch { /* ignore malformed fake output */ }
    });
    supervisor.proc.stderr.resume();
    t.after(() => { if (!supervisor.settled) supervisor.terminate("test_cleanup"); });

    await waitForExit(supervisor);
    supervisor.markSettled();

    assert.equal(timeoutCalled, true, "onToolTimeout callback fired");
    assert.equal(timeoutToolName, "Bash");
    assert.equal(supervisor.failureCode, "claude_code_tool_timeout");
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("nested tool_result clears the matching tool deadline", { timeout: 5_000 }, async (t) => {
  const dir = await mktemp("sup-tool-result-");
  try {
    const script = await writeFakeScript(dir, "fake-tool-result.mjs", `
process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [
  { type: "tool_use", id: "tool-1", name: "Bash", input: {} }
] } }) + "\\n");
setTimeout(() => process.stdout.write(JSON.stringify({ type: "user", message: { content: [
  { type: "tool_result", tool_use_id: "tool-1", content: "ok" }
] } }) + "\\n"), 75);
setTimeout(() => process.exit(0), 500);
`);
    let timeoutCalled = false;
    const supervisor = spawnSupervised({
      command: "node", args: [script], cwd: dir, env: fakeChildEnv(),
      attemptId: "tool-result-test", gracePeriodMs: 200,
      semanticInactivityMs: 30_000, staleWorkingMs: 30_000, toolDeadlineMs: 200,
      onToolTimeout() { timeoutCalled = true; },
    });
    const lines = readline.createInterface({ input: supervisor.proc.stdout });
    lines.on("line", (line) => {
      try { supervisor.observeEvent(JSON.parse(line)); } catch { /* ignore malformed fake output */ }
    });
    supervisor.proc.stderr.resume();
    t.after(() => { if (!supervisor.settled) supervisor.terminate("test_cleanup"); });
    await waitForExit(supervisor);
    supervisor.markSettled();
    assert.equal(timeoutCalled, false, "completed tool does not time out");
    assert.equal(supervisor.failureCode, null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 9. Attempt-identity fencing: stale cleanup cannot kill a newer attempt's PGID
// ---------------------------------------------------------------------------
test("attempt fencing prevents stale cleanup from killing a newer attempt", { timeout: 5_000 }, async (t) => {
  const dir = await mktemp("sup-fence-");
  const identityFile = path.join(dir, "identity.json");
  try {
    // Attempt A: waits for stdin.
    const scriptA = await writeFakeScript(dir, "fake-a.mjs", `
process.stdin.setEncoding("utf8");
process.stdin.once("data", () => process.exit(0));
`);
    const supervisorA = spawnSupervised({
      command: "node", args: [scriptA], cwd: dir, env: fakeChildEnv(),
      attemptId: "attempt-A", identityFilePath: identityFile,
      gracePeriodMs: 500, semanticInactivityMs: 30_000, staleWorkingMs: 30_000, toolDeadlineMs: 30_000,
    });
    drainSupervisor(supervisorA);
    t.after(() => { if (!supervisorA.settled) { supervisorA.proc.stdin.end("x"); supervisorA.markSettled(); } });
    await supervisorA.identityWritten;

    // Attempt B: overwrites the identity file (simulates restart).
    const scriptB = await writeFakeScript(dir, "fake-b.mjs", `setInterval(()=>{},10_000);`);
    const supervisorB = spawnSupervised({
      command: "node", args: [scriptB], cwd: dir, env: fakeChildEnv(),
      attemptId: "attempt-B", identityFilePath: identityFile,
      gracePeriodMs: 500, semanticInactivityMs: 30_000, staleWorkingMs: 30_000, toolDeadlineMs: 30_000,
    });
    drainSupervisor(supervisorB);
    t.after(() => { if (!supervisorB.settled) supervisorB.terminate("test_cleanup"); });
    await supervisorB.identityWritten;

    // verifyCurrentAttempt for attempt A should now be fenced.
    const checkA = await supervisorA.verifyCurrentAttempt();
    assert.equal(checkA.ok, false, "attempt A fenced by newer attempt B");
    assert.equal(checkA.reason, "superseded_by_newer_attempt");

    // verifyCurrentAttempt for attempt B should pass.
    const checkB = await supervisorB.verifyCurrentAttempt();
    assert.equal(checkB.ok, true, "attempt B not fenced");

    // Clean up A by sending stdin.
    supervisorA.proc.stdin.end("done\n");
    await waitForExit(supervisorA);
    supervisorA.markSettled();

    // Clean up B.
    supervisorB.terminate("test_cleanup");
    await waitForExit(supervisorB);
    supervisorB.markSettled();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 10. recoverOrphanedAttempt kills a live PGID from an identity file
// ---------------------------------------------------------------------------
test("recoverOrphanedAttempt kills live orphaned process group", { timeout: 5_000 }, async (t) => {
  const dir = await mktemp("sup-orphan-");
  const identityFile = path.join(dir, "identity.json");
  try {
    const orphanScript = await writeFakeScript(dir, "orphan.mjs", `setInterval(()=>{},10_000);`);
    const orphan = spawnSupervised({
      command: "node", args: [orphanScript], cwd: dir, env: fakeChildEnv(),
      attemptId: "orphan-attempt", identityFilePath: identityFile,
      gracePeriodMs: 500, semanticInactivityMs: 30_000, staleWorkingMs: 30_000, toolDeadlineMs: 30_000,
    });
    drainSupervisor(orphan);
    t.after(() => { if (!orphan.settled) orphan.terminate("test_cleanup"); });
    await orphan.identityWritten;

    const orphanPgid = orphan.pgid;
    assert.ok(orphanPgid > 0, "orphan has PGID");

    // Verify alive before recovery.
    let aliveBeforeRecover = false;
    try { process.kill(-orphanPgid, 0); aliveBeforeRecover = true; } catch { /* dead */ }
    assert.equal(aliveBeforeRecover, true, "orphan alive before recovery");

    // Recovery kills the orphan.
    const result = await recoverOrphanedAttempt(identityFile);
    assert.equal(result.recovered, true, "recovery succeeded");
    assert.equal(result.attemptId, "orphan-attempt");

    // Give the SIGKILL time to land.
    await new Promise((r) => setTimeout(r, 300));
    let deadAfterRecover = false;
    try { process.kill(-orphanPgid, 0); } catch { deadAfterRecover = true; }
    assert.equal(deadAfterRecover, true, "orphan dead after recovery");

    await waitForExit(orphan);
    orphan.markSettled();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("recoverOrphanedAttempt refuses an unverified reused process group", { timeout: 5_000 }, async (t) => {
  if (process.platform !== "linux") return t.skip("Linux /proc verification only");
  const dir = await mktemp("sup-unverified-");
  const identityFile = path.join(dir, "identity.json");
  const script = await writeFakeScript(dir, "unmarked.mjs", `setInterval(()=>{},10_000);`);
  const child = spawn("node", [script], { cwd: dir, env: fakeChildEnv(), detached: true, stdio: "ignore" });
  t.after(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } });
  try {
    await fs.writeFile(identityFile, JSON.stringify({ attemptId: "forged-attempt", pid: child.pid, pgid: child.pid }), "utf8");
    const result = await recoverOrphanedAttempt(identityFile);
    assert.equal(result.recovered, false);
    assert.equal(result.blocked, true);
    assert.equal(result.reason, "identity_unverified");
    assert.doesNotThrow(() => process.kill(child.pid, 0), "unverified process remains alive");
  } finally {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 11. Exact-once interruption via the adapter
// ---------------------------------------------------------------------------
test("interruption leaves message state interrupted, no duplicate final answer", { timeout: 8_000 }, async (t) => {
  const home = await mktemp("orkestr-sup-int-");
  const priorHome = process.env.ORKESTR_HOME;
  process.env.ORKESTR_HOME = home;
  t.after(async () => {
    resetClaudeCodeRuntimeForTest();
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  try {
    // Fake Claude: waits 2 s before finishing (interrupted well before that).
    const delayScript = await writeFakeScript(home, "fake-delay.mjs", `
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }) + "\\n");
setTimeout(() => {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", session_id: "s1", result: "delayed", is_error: false }) + "\\n");
  process.exit(0);
}, 2_000);
`);
    const env = {
      ORKESTR_HOME: home,
      ORKESTR_ADMIN_USER_ID: "owner",
      ORKESTR_CLAUDE_CODE_ENABLED: "1",
      ORKESTR_CLAUDE_CODE_BIN: delayScript,
      ORKESTR_CLAUDE_CODE_LOGIN_TRANSPORT: "pipe",
      ANTHROPIC_API_KEY: "must-not-reach",
      ORKESTR_CLAUDE_GRACE_PERIOD_MS: "300",
      ORKESTR_CLAUDE_SEMANTIC_INACTIVITY_MS: "30000",
      ORKESTR_CLAUDE_STALE_WORKING_MS: "30000",
      ORKESTR_CLAUDE_TOOL_DEADLINE_MS: "30000",
    };

    const profile = await readyProfile("owner", "Interrupt", env);
    const thread = await claudeThread("owner", profile.id, env, "sup-interrupt");
    const message = await enqueueThreadInput(thread.id, { text: "long task", source: "test" }, env);

    const running = sendClaudeCodeInput(thread, message, env);
    // Wait for the process to start and emit init.
    await new Promise((r) => setTimeout(r, 300));

    // Interrupt exactly once.
    const ir = await interruptClaudeCodeThread(thread, env);
    assert.equal(ir.interrupted, true);
    const result = await running;
    assert.equal(result.interrupted, true);

    // Allow async cleanup to settle.
    await new Promise((r) => setTimeout(r, 500));

    const messages = await listThreadMessages(thread.id, env);
    const user = messages.find((m) => m.id === message.id);
    assert.equal(user.observedVia, "claude_code_interrupted", "message marked interrupted");
    const finalAnswers = messages.filter((m) => m.role === "assistant" && m.phase === "final_answer");
    assert.equal(finalAnswers.length, 0, "no duplicate final answer after interruption");
  } catch (err) {
    throw err;
  }
});

// ---------------------------------------------------------------------------
// 12. No duplicate delivery/replay after interruption
// ---------------------------------------------------------------------------
test("interrupted message is not re-delivered by deliverClaudeCodePendingInputs", { timeout: 8_000 }, async (t) => {
  const home = await mktemp("orkestr-sup-replay-");
  const priorHome = process.env.ORKESTR_HOME;
  process.env.ORKESTR_HOME = home;
  t.after(async () => {
    resetClaudeCodeRuntimeForTest();
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  try {
    const script = await writeFakeScript(home, "fake-replay.mjs", `
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }) + "\\n");
setTimeout(() => {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", session_id: "s1", result: "late", is_error: false }) + "\\n");
  process.exit(0);
}, 2_000);
`);
    const env = {
      ORKESTR_HOME: home,
      ORKESTR_ADMIN_USER_ID: "owner",
      ORKESTR_CLAUDE_CODE_ENABLED: "1",
      ORKESTR_CLAUDE_CODE_BIN: script,
      ORKESTR_CLAUDE_CODE_LOGIN_TRANSPORT: "pipe",
      ANTHROPIC_API_KEY: "must-not-reach",
      ORKESTR_CLAUDE_GRACE_PERIOD_MS: "300",
      ORKESTR_CLAUDE_SEMANTIC_INACTIVITY_MS: "30000",
      ORKESTR_CLAUDE_STALE_WORKING_MS: "30000",
      ORKESTR_CLAUDE_TOOL_DEADLINE_MS: "30000",
    };

    const profile = await readyProfile("owner", "Replay", env);
    let thread = await claudeThread("owner", profile.id, env, "sup-replay");
    const msg = await enqueueThreadInput(thread.id, { text: "replay test", source: "test" }, env);

    const running = sendClaudeCodeInput(thread, msg, env);
    await new Promise((r) => setTimeout(r, 300));
    await interruptClaudeCodeThread(thread, env);
    await running;
    await new Promise((r) => setTimeout(r, 500));

    // deliverClaudeCodePendingInputs must NOT replay the interrupted message.
    thread = await getThread(thread.id, env);
    const delivered = await deliverClaudeCodePendingInputs(thread, env);
    assert.equal(delivered.length, 0, "no messages re-delivered after interruption");

    const messages = await listThreadMessages(thread.id, env);
    const finals = messages.filter((m) => m.role === "assistant" && m.phase === "final_answer");
    assert.equal(finals.length, 0, "no final answer produced");
  } catch (err) {
    throw err;
  }
});

// ---------------------------------------------------------------------------
// 13. staleWorking surfaces in claudeCodeThreadStatus
// ---------------------------------------------------------------------------
test("claudeCodeThreadStatus reflects staleWorking from semantic inactivity", { timeout: 8_000 }, async (t) => {
  const home = await mktemp("orkestr-sup-stale-");
  const priorHome = process.env.ORKESTR_HOME;
  process.env.ORKESTR_HOME = home;
  t.after(async () => {
    resetClaudeCodeRuntimeForTest();
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  try {
    // Fake Claude emits init then stalls for 5 s (well past staleWorkingMs=200 ms).
    const script = await writeFakeScript(home, "fake-stall-status.mjs", `
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }) + "\\n");
setTimeout(() => {
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", session_id: "s1", result: "late", is_error: false }) + "\\n");
  process.exit(0);
}, 5_000);
`);
    const env = {
      ORKESTR_HOME: home,
      ORKESTR_ADMIN_USER_ID: "owner",
      ORKESTR_CLAUDE_CODE_ENABLED: "1",
      ORKESTR_CLAUDE_CODE_BIN: script,
      ORKESTR_CLAUDE_CODE_LOGIN_TRANSPORT: "pipe",
      ANTHROPIC_API_KEY: "must-not-reach",
      ORKESTR_CLAUDE_GRACE_PERIOD_MS: "300",
      ORKESTR_CLAUDE_SEMANTIC_INACTIVITY_MS: "30000", // don't auto-terminate
      ORKESTR_CLAUDE_STALE_WORKING_MS: "200",         // flag stale quickly
      ORKESTR_CLAUDE_TOOL_DEADLINE_MS: "30000",
    };

    const profile = await readyProfile("owner", "Stale", env);
    let thread = await claudeThread("owner", profile.id, env, "sup-stale-status");
    const msg = await enqueueThreadInput(thread.id, { text: "stall now", source: "test" }, env);

    const running = sendClaudeCodeInput(thread, msg, env);
    // Wait for the process to emit init (transport-only — semantic timer ticking).
    await new Promise((r) => setTimeout(r, 100));

    // Just after start: working is true.
    thread = await getThread(thread.id, env);
    const statusFresh = await claudeCodeThreadStatus(thread, env);
    assert.equal(statusFresh.working, true, "working while process is running");

    // Wait past staleWorkingMs.
    await new Promise((r) => setTimeout(r, 350));
    thread = await getThread(thread.id, env);
    const statusStale = await claudeCodeThreadStatus(thread, env);
    assert.equal(statusStale.staleWorking, true, "staleWorking true after semantic silence");
    assert.equal(statusStale.staleWorkingReason, "semantic_inactivity");
    assert.equal(statusStale.typingActive, false, "typingActive false when stale");

    // Interrupt and clean up.
    await interruptClaudeCodeThread(thread, env);
    await running.catch(() => {});
    await new Promise((r) => setTimeout(r, 500));
  } catch (err) {
    throw err;
  }
});

// ---------------------------------------------------------------------------
// 14. Heartbeat text is safe, redacted, contains only elapsed duration
// ---------------------------------------------------------------------------
test("progress heartbeat is safe and contains only elapsed duration", { timeout: 5_000 }, async (t) => {
  const home = await mktemp("orkestr-sup-hb-");
  const priorHome = process.env.ORKESTR_HOME;
  process.env.ORKESTR_HOME = home;
  t.after(async () => {
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  try {
    const env = {
      ORKESTR_HOME: home,
      ORKESTR_ADMIN_USER_ID: "owner",
      ORKESTR_CLAUDE_CODE_ENABLED: "1",
      ORKESTR_CLAUDE_CODE_LOGIN_TRANSPORT: "pipe",
      ANTHROPIC_API_KEY: "must-not-reach",
      ORKESTR_CLAUDE_PROGRESS_MIN_INTERVAL_MS: "0", // disable rate limit for test
    };

    const profile = await readyProfile("owner", "Heartbeat", env);
    const thread = await claudeThread("owner", profile.id, env, "sup-heartbeat");
    // WhatsApp-sourced parent message enables the progress reporter.
    const parentMsg = { source: "whatsapp_inbound", connector: "whatsapp", id: "hb-parent" };
    const heartbeatMessages = [];
    const progress = createClaudeCodeProgressReporter({
      thread,
      parentMessage: parentMsg,
      attemptId: "hb-attempt",
      onPersisted: (msg) => heartbeatMessages.push(msg),
    }, env);

    // Emit a heartbeat with 3m 15s elapsed.
    await progress.heartbeat(3 * 60_000 + 15_000);
    await progress.flush();

    assert.ok(heartbeatMessages.length > 0, "heartbeat message persisted");
    const text = heartbeatMessages[0]?.text || "";
    assert.match(text, /still working/i, "text contains 'still working'");
    assert.match(text, /3m 15s/, "text contains elapsed '3m 15s'");

    // Must NOT leak secrets, paths, command contents, or provider env vars.
    assert.doesNotMatch(text, /must-not-reach|ANTHROPIC|token|secret|api.?key/i, "no secrets");
    assert.doesNotMatch(text, /\/home\/|\/root\/|\/etc\//i, "no paths");
    assert.doesNotMatch(text, /command|input|Bash|Read/i, "no tool details");
  } catch (err) {
    throw err;
  }
});

// ---------------------------------------------------------------------------
// 15. Identity file is removed on successful turn completion
// ---------------------------------------------------------------------------
test("identity file is removed on successful turn completion", { timeout: 8_000 }, async (t) => {
  const home = await mktemp("orkestr-sup-cleanup-");
  const priorHome = process.env.ORKESTR_HOME;
  process.env.ORKESTR_HOME = home;
  t.after(async () => {
    resetClaudeCodeRuntimeForTest();
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  try {
    const script = await writeFakeScript(home, "fake-ok.mjs", `
process.stdin.resume();
process.stdin.on("data", () => {});
process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "s1" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", session_id: "s1", result: "done", is_error: false }) + "\\n");
setTimeout(() => process.exit(0), 50);
`);
    const env = {
      ORKESTR_HOME: home,
      ORKESTR_ADMIN_USER_ID: "owner",
      ORKESTR_CLAUDE_CODE_ENABLED: "1",
      ORKESTR_CLAUDE_CODE_BIN: script,
      ORKESTR_CLAUDE_CODE_LOGIN_TRANSPORT: "pipe",
      ANTHROPIC_API_KEY: "must-not-reach",
      ORKESTR_CLAUDE_GRACE_PERIOD_MS: "300",
      ORKESTR_CLAUDE_SEMANTIC_INACTIVITY_MS: "30000",
      ORKESTR_CLAUDE_STALE_WORKING_MS: "30000",
      ORKESTR_CLAUDE_TOOL_DEADLINE_MS: "30000",
    };

    const profile = await readyProfile("owner", "Cleanup", env);
    const thread = await claudeThread("owner", profile.id, env, "sup-cleanup");
    const msg = await enqueueThreadInput(thread.id, { text: "run and finish", source: "test" }, env);
    await sendClaudeCodeInput(thread, msg, env);

    // Allow async identity file removal to complete.
    await new Promise((r) => setTimeout(r, 200));

    const identityDir = path.join(home, "runtimes", "claude-code", "supervision");
    let remaining = [];
    try {
      remaining = (await fs.readdir(identityDir)).filter((f) => f.endsWith(".json"));
    } catch {
      // dir may not exist if nothing was written — also fine.
    }
    assert.equal(remaining.length, 0, "no identity files left after clean exit");
  } catch (err) {
    throw err;
  }
});
