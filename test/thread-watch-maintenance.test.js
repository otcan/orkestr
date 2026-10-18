import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createThread, appendThreadMessage, updateThreadMessage, listThreadMessages } from "../packages/core/src/threads.js";
import { ensureWorkerParentWatch, cancelThreadWatch, restoreThreadWatch, readThreadWatches } from "../packages/core/src/thread-watches.js";
import { setThreadQueueHold } from "../packages/core/src/thread-queue-control.js";
import { watchMaintenanceSnapshot, reconcileWatchFinals, rollbackWatchFinals } from "../packages/core/src/thread-watch-maintenance.js";
import { runThreadWatchPump } from "../packages/core/src/thread-watch-pump.js";
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "watch-maintenance-"));
  t.after(() => fs.rm(home, { recursive: true, force: true, maxRetries: 5 }));
  const env = { ORKESTR_HOME: home, ORKESTR_AUTO_RUN_THREAD_INPUT: "0" };
  await createThread({ id: "parent", runtimeKind: "codex-app-server" }, env);
  const worker = await createThread({ id: "worker", parentThreadId: "parent", threadKind: "worker" }, env);
  const watch = await ensureWorkerParentWatch(worker, env);
  await cancelThreadWatch(watch.id, {}, env);
  await setThreadQueueHold("parent", { paused: true, reason: "review" }, env);
  return { env, watch };
}
async function plan(env, watch) {
  const snapshot = await watchMaintenanceSnapshot("parent", watch.id, env);
  return { operationId: "example-watch-review-01", watchId: watch.id, summary: "All old report revisions preserved; current artifact replaces them.",
    entries: snapshot.entries.map(e => ({ id: e.id, digest: e.digest, disposition: "summarize", reason: "Replaced exact revision", evidence: "artifact:current" })) };
}
const final = text => ({ role: "assistant", phase: "final_answer", state: "completed", text });
test("reviewed historical finals cannot refill queue or consume rate limit; pending failures and changed results still forward", async t => {
  const { env, watch } = await fixture(t);
  const pending = await appendThreadMessage("worker", { role: "user", state: "queued", text: "unfinished work" }, env);
  for (let i = 0; i < 70; i++) await appendThreadMessage("worker", final(`DONE historical revision ${i}`), env);
  const input = await plan(env, watch);
  input.entries[0].message = { text: "forged" };
  const ledger = await reconcileWatchFinals("parent", input, env);
  assert.equal(ledger.entries.length, 70);
  assert.equal(ledger.entries[0].message.text, "DONE historical revision 0");
  assert.equal((await reconcileWatchFinals("parent", input, env)).duplicate, true);
  await restoreThreadWatch(watch.id, env);
  await runThreadWatchPump(env);
  assert.equal((await listThreadMessages("parent", env)).filter(m => m.role === "user").length, 0);
  assert.equal((await readThreadWatches(env))[0].fireCount, 0);
  await updateThreadMessage("worker", pending.id, { state: "failed", error: "new failure" }, env);
  await appendThreadMessage("worker", final("BLOCKED newly changed result"), env);
  await runThreadWatchPump(env);
  const delivered = (await listThreadMessages("parent", env)).filter(m => m.role === "user");
  assert.equal(delivered.length, 2);
  assert.equal(delivered.filter(m => m.threadWatchEvent === "failed").length, 1);
  assert.equal((await readThreadWatches(env))[0].fireCount, 2);
});
test("stale/incomplete plans, active watches and foreign watcher reject without suppressing reports", async t => {
  const { env, watch } = await fixture(t);
  const row = await appendThreadMessage("worker", final("DONE old"), env);
  const input = await plan(env, watch);
  await assert.rejects(watchMaintenanceSnapshot("other", watch.id, env), /automatic_watch_required/);
  await assert.rejects(reconcileWatchFinals("parent", { ...input, entries: [] }, env), /snapshot_changed/);
  await updateThreadMessage("worker", row.id, { text: "DONE changed artifact" }, env);
  await assert.rejects(reconcileWatchFinals("parent", input, env), /snapshot_changed/);
  await restoreThreadWatch(watch.id, env);
  await assert.rejects(reconcileWatchFinals("parent", await plan(env, watch), env), /cancellation_required/);
});
test("changed original final remains eligible and reconciliation rollback is reversible/idempotent", async t => {
  const { env, watch } = await fixture(t);
  const row = await appendThreadMessage("worker", final("DONE old"), env);
  const input = await plan(env, watch);
  await reconcileWatchFinals("parent", input, env);
  await restoreThreadWatch(watch.id, env);
  // A report changed before the pump sees it is not its reviewed digest.
  await updateThreadMessage("worker", row.id, { text: "BLOCKED new blocker" }, env);
  await runThreadWatchPump(env);
  assert.equal((await listThreadMessages("parent", env)).filter(m => m.role === "user").length, 1);
  await cancelThreadWatch(watch.id, {}, env);
  await rollbackWatchFinals("parent", input.operationId, env);
  assert.equal((await rollbackWatchFinals("parent", input.operationId, env)).duplicate, true);
  assert.deepEqual((await readThreadWatches(env))[0].reconciledFinals, {});
  assert.equal((await readThreadWatches(env))[0].cursor, watch.cursor);
});
