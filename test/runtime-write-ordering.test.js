import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createKeyedSerialQueue } from "../packages/core/src/keyed-serial-queue.js";
import { runtimeTurnGeneration, updateThreadRuntime } from "../packages/core/src/runtime-record-update.js";
import { CodexAppServerClient } from "../packages/core/src/codex-app-server-client.js";
import {
  deliverCodexAppServerPendingInputs,
  startCodexAppServerThread,
  stopCodexAppServerClients,
} from "../packages/core/src/codex-app-server.js";
import { completeInterruptedClaudeCodeTurn } from "../packages/core/src/claude-code-turn-state.js";
import { recordRuntimeLiveness, recordRuntimeLivenessProbeFailure } from "../packages/core/src/runtime-liveness.js";
import { appendThreadMessage, createThread, enqueueThreadInput, getThread, listThreadMessages } from "../packages/core/src/threads.js";
import { claudeCodeConformance } from "./conformance/claude-code-harness.js";

// Regression coverage for concurrent thread.runtime writers: per-thread
// in-order Codex notification handling, field-owned runtime merges, the
// monotonic turn-generation guard, and liveness writes under the store lock.

const fakeCodexPath = fileURLToPath(new URL("./conformance/fakes/fake-codex-app-server.mjs", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(probe, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await sleep(10);
  }
  throw new Error("timed out waiting for runtime state");
}

async function tempEnv(t, prefix) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return { home, env: { ORKESTR_HOME: path.join(home, "orkestr"), HOME: path.join(home, "runtime-home"), ORKESTR_ADMIN_USER_ID: "order-owner" } };
}

async function codexThread(env, home, { id = "order-thread", generation = "codex-gen-order", runtime = {} } = {}) {
  return createThread({
    id,
    name: "Ordering thread",
    ownerUserId: "order-owner",
    cwd: home,
    executorId: "codex",
    runtimeKind: "codex-app-server",
    codexThreadId: generation,
    codexSessionId: generation,
    executor: { type: "codex", transport: "app-server", codexThreadId: generation, codexSessionId: generation },
    runtime: { runtimeKind: "codex-app-server", runtimeGeneration: generation, codexThreadId: generation, state: "ready", ...runtime },
  }, env);
}

test("keyed serial queue keeps per-key order, runs other keys concurrently, survives failures", async () => {
  const queue = createKeyedSerialQueue();
  const log = [];
  const task = (label, ms, fail = false) => async () => {
    log.push(`start:${label}`);
    await sleep(ms);
    log.push(`end:${label}`);
    if (fail) throw new Error(label);
  };
  const results = await Promise.allSettled([
    queue.run("a", task("a1", 40, true)),
    queue.run("a", task("a2", 1)),
    queue.run("b", task("b1", 1)),
  ]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "fulfilled");
  assert.ok(log.indexOf("end:a1") < log.indexOf("start:a2"), log.join(","));
  assert.ok(log.indexOf("end:b1") < log.indexOf("end:a1"), "a different key must not wait");
  assert.equal(queue.size(), 0);
});

test("updateThreadRuntime merges owned fields and fences writers of an older turn", async (t) => {
  const { home, env } = await tempEnv(t, "orkestr-runtime-merge-");
  await codexThread(env, home, { runtime: { liveness: { phase: "executing" } } });
  const started = await updateThreadRuntime("order-thread", { state: "working", runtime: { activeTurnId: "turn-a", state: "working" } }, env);
  assert.equal(runtimeTurnGeneration(started), 1);
  assert.deepEqual(started.runtime.liveness, { phase: "executing" });
  const generationA = runtimeTurnGeneration(started);
  const same = await updateThreadRuntime("order-thread", { runtime: { activeTurnId: "turn-a", codexStatus: { type: "active" } } }, env);
  assert.equal(runtimeTurnGeneration(same), 1, "re-asserting the same turn does not bump the generation");
  await updateThreadRuntime("order-thread", { runtime: { activeTurnId: "turn-b", state: "working" } }, env);
  const stale = await updateThreadRuntime("order-thread", { state: "ready", runtime: { activeTurnId: null, lastTurnId: "turn-a", state: "ready" } }, env, { turnGeneration: generationA, withSkipped: true });
  assert.equal(stale.skipped, true);
  assert.equal(stale.thread.runtime.activeTurnId, "turn-b");
  assert.equal(stale.thread.runtime.state, "working");
  assert.equal(runtimeTurnGeneration(stale.thread), 2);
});

test("Codex notifications for one thread are applied in arrival order", async (t) => {
  const { home, env } = await tempEnv(t, "orkestr-codex-order-");
  await codexThread(env, home, { runtime: { state: "working", activeTurnId: "turn-1" } });
  const client = new CodexAppServerClient({ env, home: env.HOME });
  client.request = async () => ({});
  // The completion of a turn this client never saw start (no remembered
  // generation, e.g. after a restart) followed immediately by the next turn:
  // the completion handler is slower, so only in-order handling keeps the
  // later turn/started from being overwritten.
  client.handleLine(JSON.stringify({ method: "turn/completed", params: { turn: { id: "turn-1", threadId: "codex-gen-order", status: "failed", error: { message: "invalid_request_error: malformed" } } } }));
  client.handleLine(JSON.stringify({ method: "turn/started", params: { turn: { id: "turn-2", threadId: "codex-gen-order", status: "inProgress" } } }));
  await client.drainNotifications();
  const thread = await getThread("order-thread", env);
  assert.equal(thread.state, "working");
  assert.equal(thread.runtime.state, "working");
  assert.equal(thread.runtime.activeTurnId, "turn-2");
});

test("a Codex completion for an older turn does not overwrite a newer turn", async (t) => {
  const { home, env } = await tempEnv(t, "orkestr-codex-generation-");
  await codexThread(env, home);
  const client = new CodexAppServerClient({ env, home: env.HOME });
  client.request = async () => ({});
  await client.handleNotification({ method: "turn/started", params: { turn: { id: "turn-old", threadId: "codex-gen-order" } } });
  // A newer turn is installed by the turn/start RPC path before the old
  // turn's completion is processed.
  await updateThreadRuntime("order-thread", { state: "working", runtime: { activeTurnId: "turn-new", state: "working" } }, env);
  await client.handleNotification({ method: "turn/completed", params: { turn: { id: "turn-old", threadId: "codex-gen-order", status: "failed", error: { message: "invalid_request_error: malformed" } } } });
  const thread = await getThread("order-thread", env);
  assert.equal(thread.state, "working");
  assert.equal(thread.runtime.activeTurnId, "turn-new");
  assert.notEqual(thread.runtime.lastTurnId, "turn-old");
  // The completion of the current turn still lands.
  client.rememberTurnGeneration("codex-gen-order", "turn-new", thread);
  await client.handleNotification({ method: "turn/completed", params: { turn: { id: "turn-new", threadId: "codex-gen-order", status: "failed", error: { message: "invalid_request_error: malformed" } } } });
  const done = await getThread("order-thread", env);
  assert.equal(done.runtime.activeTurnId, null);
  assert.equal(done.runtime.lastTurnId, "turn-new");
});

test("back-to-back turns on the fake app-server at 30ms steps settle on the last turn", async (t) => {
  const { home, env: base } = await tempEnv(t, "orkestr-codex-fake-order-");
  const bin = path.join(home, "bin");
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${fakeCodexPath}" "$@"\n`, { mode: 0o755 });
  const env = { ...base, PATH: `${bin}${path.delimiter}${process.env.PATH || ""}`, FAKE_CODEX_STATE: path.join(home, "codex-state.json"), FAKE_CODEX_STEP_MS: "30" };
  t.after(() => stopCodexAppServerClients());
  const created = await createThread({ id: "fake-order", name: "Fake order", ownerUserId: "order-owner", cwd: home, executorId: "codex", executor: { type: "codex" } }, env);
  const { thread } = await startCodexAppServerThread(created, env);
  const turnIds = [];
  for (const index of [1, 2]) {
    const queued = await enqueueThreadInput(thread.id, { text: `hello ${index} [scenario:echo]`, source: "test", clientMessageId: `fake-order-${index}` }, env);
    await deliverCodexAppServerPendingInputs(await getThread(thread.id, env), env);
    turnIds.push(await waitFor(async () => (await listThreadMessages(thread.id, env)).find((message) => message.id === queued.id)?.codexTurnId));
    await waitFor(async () => (await getThread(thread.id, env)).runtime?.lastTurnId === turnIds.at(-1));
  }
  await sleep(150);
  const settled = await getThread(thread.id, env);
  assert.equal(settled.runtime.state, "ready");
  assert.equal(settled.runtime.activeTurnId, null);
  assert.equal(settled.runtime.lastTurnId, turnIds[1]);
  assert.ok(runtimeTurnGeneration(settled) >= 2, "each turn bumps the runtime turn generation");
  assert.equal(settled.runtime.liveness?.turnId, turnIds[1]);
});

test("concurrent liveness probe failures accumulate instead of dropping each other", async (t) => {
  const { home, env } = await tempEnv(t, "orkestr-liveness-merge-");
  await codexThread(env, home, { runtime: { state: "working", activeTurnId: "turn-live" } });
  await recordRuntimeLiveness("order-thread", { runtimeGeneration: "codex-gen-order", turnId: "turn-live", evidenceType: "model_started" }, env);
  await Promise.all([
    recordRuntimeLivenessProbeFailure("order-thread", { runtimeGeneration: "codex-gen-order", turnId: "turn-live", reason: "probe-a" }, env),
    recordRuntimeLivenessProbeFailure("order-thread", { runtimeGeneration: "codex-gen-order", turnId: "turn-live", reason: "probe-b" }, env),
    updateThreadRuntime("order-thread", { runtime: { codexStatus: { type: "active", activeFlags: ["running"] } } }, env),
  ]);
  const thread = await getThread("order-thread", env);
  assert.equal(thread.runtime.liveness.consecutiveProbeFailures, 2);
  assert.deepEqual(thread.runtime.codexStatus, { type: "active", activeFlags: ["running"] });
  assert.equal(thread.runtime.activeTurnId, "turn-live");
});

test("Claude turn finalize keeps runtime fields written while the fake runner was busy", async (t) => {
  const harness = await claudeCodeConformance.create();
  t.after(() => harness.teardown());
  const session = await harness.startSession({ sessionKey: "runtime-order" });
  const running = harness.runTurn(session, { text: "work slowly", scenario: "slow", inputId: "slow-1" });
  const env = { ORKESTR_HOME: process.env.ORKESTR_HOME };
  await waitFor(async () => (await getThread(session.threadId, env))?.runtime?.state === "working");
  // A liveness/checkpoint writer lands mid-turn on fields the finalizer does not own.
  await updateThreadRuntime(session.threadId, { runtime: { checkpoint: { checkpointId: "mid-turn" } } }, env);
  const cancelled = await harness.cancelTurn(session);
  assert.equal(cancelled.cancelled, true);
  const result = await running;
  assert.equal(result.status, "cancelled");
  const thread = await getThread(session.threadId, env);
  assert.equal(thread.runtime.state, "ready");
  assert.equal(thread.runtime.activeTurnId, null);
  assert.equal(thread.runtime.checkpoint?.checkpointId, "mid-turn");
});

test("a stale Claude finalizer cannot overwrite a newer turn", async (t) => {
  const { home, env } = await tempEnv(t, "orkestr-claude-stale-");
  await createThread({ id: "claude-order", name: "Claude order", ownerUserId: "order-owner", cwd: home, executorId: "claude-code", runtimeKind: "claude-code", runtime: { runtimeKind: "claude-code", state: "ready" } }, env);
  const message = await appendThreadMessage("claude-order", { role: "user", text: "first", state: "running" }, env);
  const oldTurn = await updateThreadRuntime("claude-order", { state: "working", runtime: { activeTurnId: "claude_turn_old", state: "working" } }, env);
  await updateThreadRuntime("claude-order", { state: "working", runtime: { activeTurnId: "claude_turn_new", state: "working" } }, env);
  await completeInterruptedClaudeCodeTurn(oldTurn, message, "claude_turn_old", env, { turnGeneration: runtimeTurnGeneration(oldTurn) });
  const thread = await getThread("claude-order", env);
  assert.equal(thread.state, "working");
  assert.equal(thread.runtime.activeTurnId, "claude_turn_new");
  assert.notEqual(thread.runtime.lastTurnId, "claude_turn_old");
});
