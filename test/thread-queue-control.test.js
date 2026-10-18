import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createThread, appendThreadMessage, getThreadMessage, updateThreadMessage, getThread } from "../packages/core/src/threads.js";
import { setThreadQueueHold, threadQueueSnapshot, consolidateThreadQueue, rollbackThreadQueue, withThreadQueueBoundary } from "../packages/core/src/thread-queue-control.js";
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "queue-maintenance-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { ORKESTR_HOME: home, ORKESTR_AUTO_RUN_THREAD_INPUT: "0" };
  await createThread({ id: "coordinator", runtimeKind: "codex-app-server" }, env);
  return env;
}
async function plan(env) {
  const snapshot = await threadQueueSnapshot("coordinator", env);
  return { operationId: "example-repair-01", summary: "Current result and all preserved references", entries: snapshot.entries.map(e => ({ id: e.id, digest: e.digest,
    disposition: e.message.source === "cli" ? "supersede" : "retain", reason: "Exact prior revision replaced", evidence: "artifact:example/current" })) };
}
test("consolidation preserves every original and retained human input; repeat and rollback are idempotent", async t => {
  const env = await fixture(t);
  const old = await appendThreadMessage("coordinator", { role: "user", source: "cli", text: "old report", state: "queued" }, env);
  const human = await appendThreadMessage("coordinator", { role: "user", source: "ui", text: "keep this decision", state: "queued" }, env);
  const input = await plan(env);
  // Caller-supplied extra fields must never replace the server snapshot.
  input.entries[0].message = { text: "forged original" };
  await assert.rejects(consolidateThreadQueue("coordinator", input, env), /queue_hold_required/);
  await setThreadQueueHold("coordinator", { paused: true, reason: "reviewed maintenance" }, env);
  const result = await consolidateThreadQueue("coordinator", input, env);
  assert.equal(result.entries.length, 2);
  assert.equal(result.entries.find(e => e.id === old.id).message.text, old.text);
  assert.equal((await getThreadMessage("coordinator", old.id, env)).state, "superseded");
  assert.equal((await getThreadMessage("coordinator", human.id, env)).state, "queued");
  assert.equal((await consolidateThreadQueue("coordinator", input, env)).duplicate, true);
  await rollbackThreadQueue("coordinator", input.operationId, env);
  assert.equal((await threadQueueSnapshot("coordinator", env)).pendingCount, 2);
  assert.equal((await rollbackThreadQueue("coordinator", input.operationId, env)).duplicate, true);
});
test("stale snapshot, incomplete mapping and delivery evidence all fail closed", async t => {
  const env = await fixture(t);
  const row = await appendThreadMessage("coordinator", { role: "user", source: "cli", text: "report", state: "queued" }, env);
  await setThreadQueueHold("coordinator", { paused: true, reason: "review" }, env);
  const stale = await plan(env);
  await updateThreadMessage("coordinator", row.id, { deliveredAt: "2026-01-01T00:00:00Z" }, env);
  await assert.rejects(consolidateThreadQueue("coordinator", stale, env), /snapshot_changed/);
  await assert.rejects(consolidateThreadQueue("coordinator", { ...await plan(env), entries: [] }, env), /snapshot_changed/);
  await assert.rejects(consolidateThreadQueue("coordinator", await plan(env), env), /supersession_not_proven/);
  assert.equal((await getThreadMessage("coordinator", row.id, env)).state, "queued");
});
test("hold waits for dispatch boundary without interrupting a running turn", async t => {
  const env = await fixture(t);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const dispatch = withThreadQueueBoundary("coordinator", async () => { entered(); await held; }, env);
  await started;
  const hold = setThreadQueueHold("coordinator", { paused: true, reason: "boundary" }, env);
  assert.equal((await getThread("coordinator", env)).queueDispatchHold, undefined);
  release(); await dispatch; await hold;
  assert.equal((await threadQueueSnapshot("coordinator", env)).paused, true);
});
test("native pending dispatcher leaves held inputs and delivery attempts untouched", async t => {
  const env = await fixture(t);
  const row = await appendThreadMessage("coordinator", { role: "user", source: "cli", text: "work", state: "queued" }, env);
  await setThreadQueueHold("coordinator", { paused: true, reason: "boundary" }, env);
  const { deliverCodexAppServerPendingInputs } = await import("../packages/core/src/codex-app-server.js");
  assert.deepEqual(await deliverCodexAppServerPendingInputs(await getThread("coordinator", env), env), []);
  const current = await getThreadMessage("coordinator", row.id, env);
  assert.equal(current.state, "queued");
  assert.equal(current.deliveryReadyRetryAttempt, undefined);
  assert.equal(current.deliveredAt, undefined);
});
