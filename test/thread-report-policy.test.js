import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createThread, appendThreadMessage, listThreadMessages, enqueueThreadInput } from "../packages/core/src/threads.js";
import { acknowledgementOnly, prepareAgentReport } from "../packages/core/src/thread-report-policy.js";
import { ensureWorkerParentWatch, cancelThreadWatch, ensureExistingWorkerWatches, readThreadWatches } from "../packages/core/src/thread-watches.js";
import { runThreadWatchPump } from "../packages/core/src/thread-watch-pump.js";
const principal = { kind: "user", userId: "admin", role: "admin" };
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "report-policy-"));
  t.after(() => fs.rm(home, { recursive: true, force: true, maxRetries: 5 }));
  const env = { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin", ORKESTR_AUTO_RUN_THREAD_INPUT: "0" };
  const parent = await createThread({ id: "parent", ownerUserId: "admin" }, env);
  const worker = await createThread({ id: "worker", ownerUserId: "admin", parentThreadId: parent.id, threadKind: "worker" }, env);
  await ensureWorkerParentWatch(worker, env);
  return { env, parent, worker };
}
test("exact ACKs are inert; changed results/blockers and mixed ACK plus work are preserved", () => {
  for (const text of ["DONE — confirmed.", "Acknowledged", "Standing by"]) assert.equal(acknowledgementOnly({ text }), true);
  for (const text of ["DONE — fixed the replay bug, commit abc123", "BLOCKED: database lock", "Confirmed. New blocker: build failed", "DONE — reviewed the contract, no changes required"]) assert.equal(acknowledgementOnly({ text }), false);
  assert.equal(acknowledgementOnly({ reportKind: "ack", text: "Receipt for revision" }), true);
  assert.equal(acknowledgementOnly({ reportKind: "result", text: "Confirmed" }), false);
});
test("CLI ACK records no queued input; CLI result retries and automatic copy deliver once", async t => {
  const { env, parent, worker } = await fixture(t);
  const ack = await prepareAgentReport(parent, { source: "cli", agentSourceThreadId: worker.id, reportKind: "ack", text: "DONE — confirmed" }, principal, env);
  assert.equal(ack.suppressed, true);
  assert.equal((await listThreadMessages(parent.id, env)).filter(m => m.role === "user").length, 0);
  const text = "DONE — fixed revision 1234567; unit regression passes";
  const input = { source: "cli", agentSourceThreadId: worker.id, reportKind: "result", text };
  const prepared = await prepareAgentReport(parent, input, principal, env);
  assert.equal(prepared.body.controlAllowed, false);
  await enqueueThreadInput(parent.id, prepared.body, env);
  assert.equal((await prepareAgentReport(parent, input, principal, env)).suppressed, true);
  await appendThreadMessage(worker.id, { role: "assistant", phase: "final_answer", text, state: "completed" }, env);
  await runThreadWatchPump(env);
  assert.equal((await listThreadMessages(parent.id, env)).filter(m => m.role === "user").length, 1);
  await appendThreadMessage(worker.id, { role: "assistant", phase: "final_answer", text: "BLOCKED: newly failing isolation probe", state: "completed" }, env);
  await runThreadWatchPump(env);
  assert.equal((await listThreadMessages(parent.id, env)).filter(m => m.role === "user").length, 2);
});
test("automatic ACK finals cannot regenerate a relay; explicit cancellation survives startup", async t => {
  const { env, parent, worker } = await fixture(t);
  for (let i = 0; i < 3; i++) {
    await appendThreadMessage(worker.id, { role: "assistant", phase: "final_answer", text: "DONE — acknowledged.", state: "completed" }, env);
    await runThreadWatchPump(env);
  }
  assert.equal((await listThreadMessages(parent.id, env)).length, 0);
  const watch = (await readThreadWatches(env))[0];
  await cancelThreadWatch(watch.id, {}, env);
  await ensureExistingWorkerWatches(env);
  assert.equal((await readThreadWatches(env)).length, 1);
  assert.equal((await readThreadWatches(env))[0].status, "cancelled");
});
test("cross-owner report provenance cannot confer authority or suppress human input", async t => {
  const { env, parent } = await fixture(t);
  await createThread({ id: "foreign", ownerUserId: "other", parentThreadId: parent.id }, env);
  await assert.rejects(prepareAgentReport(parent, { agentSourceThreadId: "foreign", text: "Ack" }, principal, env), /report_owner_mismatch/);
  const plain = await prepareAgentReport(parent, { text: "Confirmed", reportKind: "ack", reportSourceThreadId: "worker" }, principal, env);
  assert.equal(plain.suppressed, undefined);
  assert.equal(plain.body.reportKind, undefined);
  assert.equal(plain.body.reportSourceThreadId, undefined);
});
