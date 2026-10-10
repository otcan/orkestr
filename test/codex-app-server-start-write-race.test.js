import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  answerCodexAppServerPendingRequest,
  deliverCodexAppServerPendingInputs,
  startCodexAppServerThread,
  stopCodexAppServerClients,
} from "../packages/core/src/codex-app-server.js";
import { createThread, enqueueThreadInput, getThread, listThreadMessages, updateThread } from "../packages/core/src/threads.js";
import { turnLifecycleEventName } from "../packages/core/src/orkestr-events.js";
import { listEvents } from "../packages/storage/src/store.js";

// Regression: the post-turn/start bookkeeping write must not overwrite
// lifecycle updates that a fast provider delivered in the meantime
// (docs/spec/conformance.md, known gap 2).

const fakePath = fileURLToPath(new URL("./conformance/fakes/fake-codex-app-server.mjs", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(probe, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await sleep(10);
  }
  throw new Error("timed out waiting for adapter state");
}

async function setup(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-codex-start-race-"));
  const bin = path.join(home, "bin");
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${fakePath}" "$@"\n`, { mode: 0o755 });
  const env = {
    ORKESTR_HOME: path.join(home, "orkestr"),
    HOME: path.join(home, "runtime-home"),
    PATH: `${bin}${path.delimiter}${process.env.PATH || ""}`,
    FAKE_CODEX_STATE: path.join(home, "codex-state.json"),
    FAKE_CODEX_STEP_MS: "30",
    ORKESTR_ADMIN_USER_ID: "race-owner",
  };
  t.after(async () => {
    stopCodexAppServerClients();
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const created = await createThread({
    id: "codex-start-race",
    name: "Codex start race",
    ownerUserId: "race-owner",
    cwd: home,
    executorId: "codex",
    codexSandbox: "workspace-write",
    codexApprovalPolicy: "on-request",
    executor: { type: "codex", metadata: { codexSandbox: "workspace-write", codexApprovalPolicy: "on-request" } },
  }, env);
  const started = await startCodexAppServerThread(created, env);
  return { env, threadId: started.thread.id };
}

async function runInput(env, threadId, scenario) {
  const queued = await enqueueThreadInput(threadId, { text: `hello [scenario:${scenario}]`, source: "test", clientMessageId: `race-${scenario}` }, env);
  await deliverCodexAppServerPendingInputs(await getThread(threadId, env), env);
  const turnId = await waitFor(async () => (await listThreadMessages(threadId, env)).find((message) => message.id === queued.id)?.codexTurnId);
  return turnId;
}

async function waitForLifecycle(env, threadId, turnId, type) {
  await waitFor(async () => (await listEvents(env, 500))
    .some((event) => event.threadId === threadId && event.turnId === turnId && event.type === turnLifecycleEventName(type)));
}

test("fast auth failure is not overwritten by the post-turn/start runtime write", async (t) => {
  const { env, threadId } = await setup(t);
  const turnId = await runInput(env, threadId, "fault:auth");
  await waitForLifecycle(env, threadId, turnId, "failed");
  await sleep(100);
  const thread = await getThread(threadId, env);
  assert.equal(thread.state, "failed_auth");
  assert.equal(thread.runtime.state, "failed_auth");
  assert.equal(thread.runtime.activeTurnId, null);
  assert.equal(thread.runtime.lastTurnId, turnId);
});

test("fast approval request is not overwritten by the post-turn/start runtime write", async (t) => {
  const { env, threadId } = await setup(t);
  const turnId = await runInput(env, threadId, "tool");
  await waitForLifecycle(env, threadId, turnId, "awaiting_approval");
  await sleep(100);
  const thread = await getThread(threadId, env);
  assert.equal(thread.state, "awaiting_approval");
  assert.equal(thread.runtime.state, "awaiting_approval");
  assert.equal(thread.runtime.pendingRequest?.turnId, turnId);
  const answered = await answerCodexAppServerPendingRequest(thread, { decision: "decline" }, env);
  assert.equal(answered.answered, true);
  await waitForLifecycle(env, threadId, turnId, "completed");
});

test("updateThread merges a functional patch onto the latest record and skips on null", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-update-thread-fn-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "race-owner" };
  await createThread({ id: "fn-patch", name: "Fn patch", ownerUserId: "race-owner", cwd: home }, env);
  await updateThread("fn-patch", { runtime: { state: "failed_auth", lastTurnId: "turn_1" } }, env);
  const skipped = await updateThread("fn-patch", (current) => (current.runtime.lastTurnId === "turn_1" ? null : { state: "working" }), env);
  assert.equal(skipped.runtime.state, "failed_auth");
  const merged = await updateThread("fn-patch", (current) => ({ runtime: { ...current.runtime, liveness: { phase: "failed" } } }), env);
  assert.deepEqual(merged.runtime, { state: "failed_auth", lastTurnId: "turn_1", liveness: { phase: "failed" } });
});
