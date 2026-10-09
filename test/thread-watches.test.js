import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendThreadMessage, createThread, listThreadMessages, updateThreadMessage } from "../packages/core/src/threads.js";
import {
  cancelThreadWatch,
  createThreadWatch,
  ensureExistingWorkerWatches,
  ensureWorkerParentWatch,
  listThreadWatches,
  readThreadWatches,
} from "../packages/core/src/thread-watches.js";
import { classifyWatchedMessage, runThreadWatchPump } from "../packages/core/src/thread-watch-pump.js";

async function fixtureEnv(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-watches-"));
  t.after(() => fs.rm(home, { recursive: true, force: true, maxRetries: 5 }));
  return { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin", ORKESTR_AUTO_RUN_THREAD_INPUT: "0" };
}

async function pair(env, watcherExtra = {}) {
  const watcher = await createThread({ id: "watcher-thread", name: "Parent", ownerUserId: "admin", ...watcherExtra }, env);
  const target = await createThread({ id: "target-thread", name: "Worker 1", ownerUserId: "admin" }, env);
  return { watcher, target };
}

function final(text, extra = {}) {
  return { role: "assistant", phase: "final_answer", state: "completed", source: "claude-code", text, ...extra };
}

async function watchInputs(env, threadId = "watcher-thread") {
  return (await listThreadMessages(threadId, env)).filter((message) => message.source === "thread_watch");
}

test("a once watch delivers the next final in full and then closes", async (t) => {
  const env = await fixtureEnv(t);
  const { watcher, target } = await pair(env);
  await appendThreadMessage(target.id, final("old final before the watch"), env);
  const watch = await createThreadWatch({ watcherThreadId: watcher.id, targetThreadId: target.id, mode: "once" }, env);

  await runThreadWatchPump(env);
  assert.equal((await watchInputs(env)).length, 0, "history before the watch is never replayed");

  const report = path.join(env.ORKESTR_HOME, "report.md");
  await fs.writeFile(report, "# Report\n");
  const done = await appendThreadMessage(target.id, final("DONE TASK-1 branch=b commit=c", { attachments: [{ path: report, name: "report.md" }] }), env);
  await appendThreadMessage(target.id, final("second final"), env);
  await runThreadWatchPump(env);
  await runThreadWatchPump(env);

  const inputs = await watchInputs(env);
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].role, "user");
  assert.equal(inputs[0].state, "queued");
  assert.equal(inputs[0].clientMessageId, `thread-watch:${watch.id}:${done.id}`);
  assert.equal(inputs[0].threadWatchSourceThreadId, target.id);
  assert.match(inputs[0].text, /Worker 1 final answer/);
  assert.match(inputs[0].text, /DONE TASK-1 branch=b commit=c/);
  assert.match(inputs[0].text, /Attachments:\n- \S*report\.md/);
  const [stored] = await readThreadWatches(env);
  assert.equal(stored.status, "fired");
  assert.equal(stored.fireCount, 1);
});

test("a continuous notification-only watch skips non-matching finals and carries no payload", async (t) => {
  const env = await fixtureEnv(t);
  const { watcher, target } = await pair(env);
  await createThreadWatch({ watcherThreadId: watcher.id, targetThreadId: target.id, mode: "continuous", payload: "none", match: "^DONE" }, env);

  await appendThreadMessage(target.id, final("I'm standing by for the next assignment."), env);
  await appendThreadMessage(target.id, final("NO_REPLY"), env);
  await appendThreadMessage(target.id, final("DONE A secret detail"), env);
  await runThreadWatchPump(env);
  await appendThreadMessage(target.id, final("DONE B"), env);
  await runThreadWatchPump(env);

  const inputs = await watchInputs(env);
  assert.equal(inputs.length, 2);
  assert.doesNotMatch(inputs[0].text, /secret detail/);
  assert.match(inputs[0].text, /orkestr watch read target-thread --message/);
  assert.match(inputs[0].text, /continuous watch/);
  const [stored] = await listThreadWatches({ threadId: watcher.id }, env);
  assert.equal(stored.status, "active");
  assert.equal(stored.fireCount, 2);
});

test("a failed turn fires even when the input failed after the cursor passed it", async (t) => {
  const env = await fixtureEnv(t);
  const { watcher, target } = await pair(env);
  await createThreadWatch({ watcherThreadId: watcher.id, targetThreadId: target.id, mode: "continuous", on: "failed" }, env);
  const input = await appendThreadMessage(target.id, { role: "user", source: "cli", text: "do it", state: "queued" }, env);
  await appendThreadMessage(target.id, final("unrelated final"), env);
  await runThreadWatchPump(env);
  assert.equal((await watchInputs(env)).length, 0, "finals are not wanted by an on=failed watch");

  await updateThreadMessage(target.id, input.id, { state: "failed", error: "Selected model is at capacity" }, env);
  await runThreadWatchPump(env);
  const inputs = await watchInputs(env);
  assert.equal(inputs.length, 1);
  assert.match(inputs[0].text, /turn failed/);
  assert.match(inputs[0].text, /at capacity/);
});

test("watch replies follow the watcher's chat binding unless internal", async (t) => {
  const env = await fixtureEnv(t);
  const { watcher, target } = await pair(env, { binding: { connector: "whatsapp", chatId: "1203@g.us", responderAccountId: "acct-1" } });
  await createThreadWatch({ watcherThreadId: watcher.id, targetThreadId: target.id, mode: "continuous" }, env);
  await appendThreadMessage(target.id, final("DONE chat"), env);
  await runThreadWatchPump(env);
  const [chatInput] = await watchInputs(env);
  assert.equal(chatInput.chatId, "1203@g.us");
  assert.equal(chatInput.connector, "whatsapp");

  const internal = await createThread({ id: "internal-watcher", ownerUserId: "admin", binding: { connector: "whatsapp", chatId: "999@g.us" } }, env);
  await createThreadWatch({ watcherThreadId: internal.id, targetThreadId: target.id, reply: "internal" }, env);
  await appendThreadMessage(target.id, final("DONE internal"), env);
  await runThreadWatchPump(env);
  const [internalInput] = await watchInputs(env, internal.id);
  assert.equal(internalInput.chatId || "", "");
  assert.equal(internalInput.visibility, "internal");
});

test("a no-wake watch records a notification instead of queuing input", async (t) => {
  const env = await fixtureEnv(t);
  const { watcher, target } = await pair(env);
  await createThreadWatch({ watcherThreadId: watcher.id, targetThreadId: target.id, wake: false }, env);
  await appendThreadMessage(target.id, final("DONE quietly"), env);
  await runThreadWatchPump(env);
  const [note] = await watchInputs(env);
  assert.equal(note.role, "assistant");
  assert.equal(note.phase, "notification");
});

test("mutual watches do not ping-pong", async (t) => {
  const env = await fixtureEnv(t);
  const { watcher, target } = await pair(env);
  await createThreadWatch({ watcherThreadId: watcher.id, targetThreadId: target.id, mode: "continuous" }, env);
  await createThreadWatch({ watcherThreadId: target.id, targetThreadId: watcher.id, mode: "continuous" }, env);

  await appendThreadMessage(target.id, final("DONE first"), env);
  await runThreadWatchPump(env);
  const [delivered] = await watchInputs(env, watcher.id);
  assert.ok(delivered);
  // The watcher answers the delivered input; that final must not bounce back.
  await appendThreadMessage(watcher.id, final("Thanks, merging.", { parentMessageId: delivered.id }), env);
  await runThreadWatchPump(env);
  assert.equal((await watchInputs(env, target.id)).length, 0);

  // A final the watcher writes for its own reasons still reaches the other side.
  await appendThreadMessage(watcher.id, final("Independent update"), env);
  await runThreadWatchPump(env);
  assert.equal((await watchInputs(env, target.id)).length, 1);
});

test("watches require the same owner and a different thread, and can be cancelled", async (t) => {
  const env = await fixtureEnv(t);
  const { watcher, target } = await pair(env);
  const foreign = await createThread({ id: "foreign-thread", ownerUserId: "someone-else" }, env);
  await assert.rejects(createThreadWatch({ watcherThreadId: watcher.id, targetThreadId: foreign.id }, env), /thread_watch_owner_mismatch/);
  await assert.rejects(createThreadWatch({ watcherThreadId: watcher.id, targetThreadId: watcher.id }, env), /thread_watch_self/);
  await assert.rejects(createThreadWatch({ watcherThreadId: watcher.id, targetThreadId: target.id, payload: "everything" }, env), /thread_watch_invalid_payload/);

  const watch = await createThreadWatch({ watcherThreadId: watcher.id, targetThreadId: target.id, mode: "continuous" }, env);
  await cancelThreadWatch(watch.id, {}, env);
  await appendThreadMessage(target.id, final("DONE after cancel"), env);
  await runThreadWatchPump(env);
  assert.equal((await watchInputs(env)).length, 0);
  assert.equal((await listThreadWatches({ threadId: watcher.id }, env)).length, 0);
  assert.equal((await listThreadWatches({ threadId: watcher.id, includeClosed: true }, env))[0].status, "cancelled");
});

test("workers report DONE and BLOCKED finals to their parent automatically", async (t) => {
  const env = await fixtureEnv(t);
  const parent = await createThread({ id: "parent-thread", ownerUserId: "admin" }, env);
  const worker = await createThread({ id: "worker-a", ownerUserId: "admin", threadKind: "worker", parentThreadId: parent.id }, env);
  const existing = await createThread({ id: "worker-b", ownerUserId: "admin", threadKind: "worker", parentThreadId: parent.id }, env);

  const watch = await ensureWorkerParentWatch(worker, env);
  assert.equal((await ensureWorkerParentWatch(worker, env)).id, watch.id, "idempotent");
  assert.equal((await ensureExistingWorkerWatches(env)).created, 1, "backfills the older worker only");

  await appendThreadMessage(worker.id, final("I'm standing by."), env);
  await appendThreadMessage(worker.id, final("**DONE** ACME-1 branch=x"), env);
  await appendThreadMessage(existing.id, final("BLOCKED needs a token"), env);
  await runThreadWatchPump(env);
  const inputs = await watchInputs(env, parent.id);
  assert.deepEqual(inputs.map((input) => input.threadWatchSourceThreadId).sort(), ["worker-a", "worker-b"]);
  assert.ok(inputs.every((input) => !/standing by/.test(input.text)));
});

test("classifyWatchedMessage separates finals, failures and pending turns", () => {
  assert.equal(classifyWatchedMessage(final("x")), "final");
  assert.equal(classifyWatchedMessage(final("NO_REPLY")), null);
  assert.equal(classifyWatchedMessage({ role: "assistant", phase: "final_answer", state: "running" }), "pending");
  assert.equal(classifyWatchedMessage({ role: "assistant", phase: "runtime_interrupted", state: "completed" }), "failed");
  assert.equal(classifyWatchedMessage({ role: "user", state: "failed" }), "failed");
  assert.equal(classifyWatchedMessage({ role: "user", state: "queued" }), "pending");
  assert.equal(classifyWatchedMessage({ role: "assistant", phase: "commentary", state: "completed" }), null);
});
