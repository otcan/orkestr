import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  attachDetachedClaudeTurn,
  claudeCodeDetachedTransport,
  detachedTurnProcessAlive,
  detachedTurnState,
  listDetachedTurnRecords,
  readDetachedTurnRecord,
  spawnDetachedClaudeTurn,
} from "../packages/core/src/claude-code-detached-turn.js";
import { recoverOrphanedClaudeCodeTurns } from "../packages/core/src/claude-code-orphan-turn-recovery.js";
import { createLlmAccountProfile, updateLlmAccountProfileState } from "../packages/core/src/llm-account-profiles.js";
import { resetClaudeCodeRuntimeForTest, startClaudeCodeThread } from "../packages/core/src/runtime-claude-code-adapter.js";
import { createThread, getThread, listThreadMessages } from "../packages/core/src/threads.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function tempHome(t, name) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), `ork-dt-${name}-`));
  t.after(async () => {
    resetClaudeCodeRuntimeForTest();
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return home;
}

function collect(facade) {
  const lines = [];
  facade.onLine((line, meta) => lines.push({ line, replay: meta.replay }));
  const closed = new Promise((resolve, reject) => {
    facade.on("close", (code, signal) => resolve({ code, signal }));
    facade.on("error", reject);
  });
  return { lines, closed };
}

async function waitFor(predicate, timeoutMs = 5_000, stepMs = 20) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

// A stand-in for the Claude CLI: echoes the prompt read from stdin as a
// stream-json turn, pausing between events so a test can interrupt it.
const LINE_SCRIPT = [
  "read -r prompt",
  "echo '{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"s1\"}'",
  "sleep \"${PAUSE:-0}\"",
  "printf '{\"type\":\"result\",\"is_error\":false,\"result\":\"%s\"}\\n' \"$prompt\"",
].join("\n");

test("detached turns stream file-backed output and record the exit code", async (t) => {
  const home = await tempHome(t, "spawn");
  const env = { ORKESTR_HOME: home, ORKESTR_CLAUDE_DETACHED_POLL_MS: "10" };
  const facade = spawnDetachedClaudeTurn({
    command: "/bin/sh", args: ["-c", LINE_SCRIPT], cwd: home, childEnv: { PATH: process.env.PATH },
    prompt: "hello", threadId: "t1", attemptId: "a1", env,
  });
  assert.equal(facade.detached, true);
  const { lines, closed } = collect(facade);
  assert.deepEqual(await closed, { code: 0, signal: null });
  assert.deepEqual(lines.map((item) => JSON.parse(item.line).type), ["system", "result"]);
  assert.equal(JSON.parse(lines[1].line).result, "hello");
  assert.equal(lines.every((item) => item.replay === false), true);
  const record = await readDetachedTurnRecord("t1", "a1", env);
  assert.equal(record.transport, "detached");
  assert.ok(record.forwardedOffset > 0);
  assert.equal(await detachedTurnState(record), "exited");
});

test("reattaching replays only lines forwarded before the restart", async (t) => {
  const home = await tempHome(t, "attach");
  const env = { ORKESTR_HOME: home, ORKESTR_CLAUDE_DETACHED_POLL_MS: "10" };
  const first = spawnDetachedClaudeTurn({
    command: "/bin/sh", args: ["-c", LINE_SCRIPT], cwd: home, childEnv: { PATH: process.env.PATH, PAUSE: "0" },
    prompt: "done", threadId: "t2", attemptId: "a2", env,
  });
  await collect(first).closed;
  const record = await readDetachedTurnRecord("t2", "a2", env);
  const events = await fs.readFile(record.paths.events, "utf8");
  // Pretend the old server had forwarded only the first line.
  const partial = { ...record, forwardedOffset: events.indexOf("\n") + 1 };
  const { lines, closed } = collect(attachDetachedClaudeTurn(partial, env));
  assert.deepEqual(await closed, { code: 0, signal: null });
  assert.deepEqual(lines.map((item) => item.replay), [true, false]);
});

test("a recycled pid is never mistaken for the turn process", async (t) => {
  const home = await tempHome(t, "pid");
  const env = { ORKESTR_HOME: home, ORKESTR_CLAUDE_DETACHED_POLL_MS: "10" };
  const facade = spawnDetachedClaudeTurn({
    command: "/bin/sh", args: ["-c", "read -r p; sleep 5"], cwd: home, childEnv: { PATH: process.env.PATH },
    prompt: "x", threadId: "t3", attemptId: "a3", env,
  });
  const { closed } = collect(facade);
  const record = await readDetachedTurnRecord("t3", "a3", env);
  assert.equal(detachedTurnProcessAlive(record), true);
  if (process.platform === "linux") {
    assert.equal(detachedTurnProcessAlive({ ...record, procStartTime: "1" }), false);
    assert.equal(await detachedTurnState({ ...record, procStartTime: "1" }), "gone");
  }
  process.kill(-record.pgid, "SIGTERM");
  const status = await closed;
  assert.equal(status.signal, "SIGTERM");
  assert.equal(await detachedTurnState(record), "exited");
  // The wrapper records the signal so an unexpected turn end can be traced.
  assert.match(await fs.readFile(`${record.paths.exit}.signals`, "utf8"), /^TERM \d+$/m);
});

test("detached turns run in their own systemd scope and keep the wrapper pid", async (t) => {
  const home = await tempHome(t, "scope");
  const log = path.join(home, "systemd-run.log");
  const fakeSystemdRun = path.join(home, "systemd-run");
  // Like `systemd-run --scope`: register (here: log) and exec the command.
  await fs.writeFile(fakeSystemdRun, `#!/bin/sh
echo "$@" >> ${JSON.stringify(log)}
while [ $# -gt 0 ]; do case "$1" in --*) shift;; *) break;; esac; done
exec "$@"
`, { mode: 0o755 });
  const env = { ORKESTR_HOME: home, ORKESTR_CLAUDE_DETACHED_POLL_MS: "10", ORKESTR_CLAUDE_DETACHED_SCOPE: "1", ORKESTR_SYSTEMD_RUN_BIN: fakeSystemdRun };
  assert.equal(claudeCodeDetachedTransport(env), "detached");
  assert.equal(claudeCodeDetachedTransport({ ...env, ORKESTR_CLAUDE_DETACHED_SCOPE: "0" }), "detached-unscoped");
  assert.equal(claudeCodeDetachedTransport({ ...env, ORKESTR_CLAUDE_DETACHED_TURNS: "0" }), "pipe");
  const facade = spawnDetachedClaudeTurn({
    command: "/bin/sh", args: ["-c", LINE_SCRIPT], cwd: home, childEnv: { PATH: process.env.PATH, PAUSE: "1" },
    prompt: "scoped", threadId: "t5", attemptId: "a5_x", env,
  });
  const { lines, closed } = collect(facade);
  const record = await readDetachedTurnRecord("t5", "a5_x", env);
  assert.match(record.scopeUnit, /^orkestr-claude-a5-x-\d+\.scope$/);
  await waitFor(async () => (await fs.readFile(log, "utf8").catch(() => "")).includes("--scope"));
  assert.equal(detachedTurnProcessAlive(record), true, "the exec'd wrapper keeps the recorded pid");
  assert.deepEqual(await closed, { code: 0, signal: null });
  assert.equal(JSON.parse(lines.at(-1).line).result, "scoped");
  const args = await fs.readFile(log, "utf8");
  assert.match(args, /--scope --quiet --collect --unit=orkestr-claude-a5-x-\d+\.scope/);
});

async function claudeFixture(t, name, pauseSec) {
  const home = await tempHome(t, name);
  const fake = path.join(home, "fake-claude.sh");
  await fs.writeFile(fake, `#!/bin/sh
case "$1" in auth) echo '{"authenticated":true,"status":"logged_in"}'; exit 0;; esac
read -r prompt
echo '{"type":"system","subtype":"init","session_id":"detached-session"}'
sleep ${pauseSec}
printf '{"type":"result","session_id":"detached-session","is_error":false,"result":"Reply: %s"}\\n' "$prompt"
`, { mode: 0o755 });
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_ADMIN_USER_ID: "owner",
    ORKESTR_CLAUDE_CODE_ENABLED: "1",
    ORKESTR_CLAUDE_CODE_BIN: fake,
    ORKESTR_CLAUDE_CODE_LOGIN_TRANSPORT: "pipe",
    ORKESTR_CLAUDE_DETACHED_POLL_MS: "10",
  };
  const profile = await createLlmAccountProfile("owner", { provider: "claude-code", label: "Detached", authMode: "subscription" }, env);
  await updateLlmAccountProfileState("owner", profile.id, "ready", { verified: true }, env);
  const created = await createThread({
    id: `claude-${name}`,
    name: `Claude ${name}`,
    ownerUserId: "owner",
    executorId: "claude-code",
    runtimeKind: "claude-code",
    executor: { type: "claude-code", accountProfileId: profile.id, metadata: { accountProfileId: profile.id, runtimeKind: "claude-code" } },
  }, env);
  const thread = (await startClaudeCodeThread(created, env)).thread;
  return { env, thread };
}

// Runs a turn in a separate Node process (the "old server") and SIGKILLs that
// process once the detached Claude turn has started, like a service restart.
async function startTurnThenKillServer(env, threadId, text) {
  const script = `
    import { enqueueThreadInput, getThread } from ${JSON.stringify(path.join(repoRoot, "packages/core/src/threads.js"))};
    import { sendClaudeCodeInput } from ${JSON.stringify(path.join(repoRoot, "packages/core/src/runtime-claude-code-adapter.js"))};
    const env = JSON.parse(process.env.FIXTURE_ENV);
    const thread = await getThread(${JSON.stringify(threadId)}, env);
    const input = await enqueueThreadInput(thread.id, { text: ${JSON.stringify(text)}, source: "test" }, env);
    sendClaudeCodeInput(thread, input, env).catch(() => {});
    setInterval(() => {}, 1000);
  `;
  const server = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, FIXTURE_ENV: JSON.stringify(env) },
    stdio: "ignore",
  });
  const record = await waitFor(async () => (await listDetachedTurnRecords(threadId, env))[0], 15_000);
  const events = record.paths.events;
  await waitFor(async () => (await fs.readFile(events, "utf8").catch(() => "")).includes("\"init\""), 15_000);
  // Let the old server forward (and persist the offset of) the init line.
  await waitFor(async () => Number((await readDetachedTurnRecord(threadId, record.attemptId, env))?.forwardedOffset) > 0, 15_000);
  server.kill("SIGKILL");
  await new Promise((resolve) => server.once("exit", resolve));
  return record;
}

async function assertDeliveredOnce(env, threadId, text) {
  const messages = await listThreadMessages(threadId, env);
  const finals = messages.filter((message) => message.role === "assistant" && message.phase === "final_answer");
  assert.equal(finals.length, 1, JSON.stringify(messages.map((m) => [m.role, m.phase, m.state])));
  assert.equal(finals[0].text, `Reply: ${text}`);
  const input = messages.find((message) => message.role === "user");
  assert.equal(input.state, "completed");
  const thread = await getThread(threadId, env);
  assert.equal(thread.runtime.activeTurnId, null);
  assert.equal(thread.runtime.lastTurnStatus, "completed");
}

test("a detached turn still running after a server restart is reattached and delivers once", async (t) => {
  const { env, thread } = await claudeFixture(t, "restart-running", 2);
  const record = await startTurnThenKillServer(env, thread.id, "survive restart");
  assert.equal(await detachedTurnState(record), "running");
  // Unscoped here: tests do not run as root under systemd.
  assert.equal((await getThread(thread.id, env)).runtime.claudeTransport, claudeCodeDetachedTransport(env));

  const recovery = await recoverOrphanedClaudeCodeTurns(env);
  assert.equal(recovery.reattached, 1);
  assert.equal(recovery.recovered, 0);
  await recovery.results.find((result) => result.reattached).done;
  await assertDeliveredOnce(env, thread.id, "survive restart");
  // A second recovery pass is a no-op.
  const again = await recoverOrphanedClaudeCodeTurns(env);
  assert.equal(again.reattached, 0);
  assert.equal(again.recovered, 0);
  await assertDeliveredOnce(env, thread.id, "survive restart");
});

test("a detached turn that finished while the server was down is replayed and delivered once", async (t) => {
  const { env, thread } = await claudeFixture(t, "restart-exited", 1);
  const record = await startTurnThenKillServer(env, thread.id, "finished offline");
  await waitFor(async () => (await detachedTurnState(record)) === "exited", 15_000);

  const recovery = await recoverOrphanedClaudeCodeTurns(env);
  assert.equal(recovery.reattached, 1);
  await recovery.results.find((result) => result.reattached).done;
  await assertDeliveredOnce(env, thread.id, "finished offline");
});
