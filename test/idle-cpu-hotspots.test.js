import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { snapshotEnvironment } from "../packages/storage/src/test-storage-isolation.js";
import { threadMessageFilePath, createThreadMessageRepository } from "../packages/storage/src/repositories.js";
import {
  appendThreadMessageRecord,
  closeThreadMessageRegistryCache,
  threadMessageStoreFingerprint,
} from "../packages/storage/src/thread-message-registry.js";
import { createCodexHydrationIndex } from "../packages/core/src/codex-hydration-index.js";
import { clean } from "../packages/core/src/codex-app-server-common.js";
import { createThread, getThread } from "../packages/core/src/threads.js";
import { createThreadMessageSnapshot } from "../packages/core/src/thread-message-snapshot.js";
import {
  cachedThreadSummaryCount,
  storedThreadMessagePage,
} from "../dist/server/apps/server/src/modules/threads/thread-message-store-page.js";

async function sqliteHome(t, prefix) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(async () => {
    closeThreadMessageRegistryCache();
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  return { ORKESTR_HOME: home, ORKESTR_THREAD_STORE: "sqlite", ORKESTR_THREAD_MESSAGE_STORE: "sqlite" };
}

test("an environment snapshot is reused as is, and still isolates later environment changes", () => {
  const env = { ORKESTR_HOME: "/tmp/example-home", EMPTY: undefined };
  const snapshot = snapshotEnvironment(env);
  assert.deepEqual(snapshot, { ORKESTR_HOME: "/tmp/example-home", EMPTY: "" });
  assert.ok(Object.isFrozen(snapshot));
  assert.equal(snapshotEnvironment(snapshot), snapshot);
  env.ORKESTR_HOME = "/tmp/other-home";
  assert.equal(snapshot.ORKESTR_HOME, "/tmp/example-home");
  // A frozen object the module did not produce is still copied and normalized.
  const foreign = Object.freeze({ VALUE: null });
  const copied = snapshotEnvironment(foreign);
  assert.notEqual(copied, foreign);
  assert.deepEqual(copied, { VALUE: "" });
});

test("the message mutation lock path matches the repository path", async (t) => {
  const env = await sqliteHome(t, "orkestr-mutation-path-");
  const repository = createThreadMessageRepository(env);
  for (const threadId of ["plain", "with spaces/and:colons", ""]) {
    assert.equal(threadMessageFilePath(threadId, env), await repository.pathForThread(threadId));
  }
});

test("reads through a cached sqlite handle skip the data-directory mkdir calls", async (t) => {
  const env = await sqliteHome(t, "orkestr-cached-handle-");
  await createThread({ id: "example-thread", name: "Example thread" }, env);
  await appendThreadMessageRecord("example-thread", { id: "m-1", role: "user", text: "hello" }, env);
  let mkdirs = 0;
  const mkdir = fs.mkdir;
  t.mock.method(fs, "mkdir", function (...args) {
    mkdirs += 1;
    return mkdir.apply(this, args);
  });
  for (let index = 0; index < 5; index += 1) {
    assert.ok(await threadMessageStoreFingerprint("example-thread", env));
    assert.equal((await getThread("example-thread", env))?.id, "example-thread");
  }
  assert.equal(mkdirs, 0);
  // A fresh handle still creates every data directory first.
  closeThreadMessageRegistryCache();
  await fs.rm(path.join(env.ORKESTR_HOME, "thread-messages"), { recursive: true, force: true });
  assert.ok(await threadMessageStoreFingerprint("example-thread", env));
  assert.ok(mkdirs > 0);
  await fs.access(path.join(env.ORKESTR_HOME, "thread-messages"));
});

function countSummaryScans(t) {
  const prepare = DatabaseSync.prototype.prepare;
  let scans = 0;
  t.mock.method(DatabaseSync.prototype, "prepare", function (sql) {
    if (/json_extract\(data/.test(sql)) scans += 1;
    return prepare.call(this, sql);
  });
  return () => scans;
}

test("polling more than eight unchanged threads keeps every message summary cached", async (t) => {
  const env = await sqliteHome(t, "orkestr-summary-cache-");
  const previous = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(env)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  Object.assign(process.env, env);
  const threads = Array.from({ length: 12 }, (_, index) => ({ id: `poll-${index}` }));
  for (const thread of threads) {
    for (let index = 1; index <= 3; index += 1) {
      await appendThreadMessageRecord(thread.id, {
        id: `${thread.id}-m-${index}`, role: index % 2 ? "user" : "assistant", text: `message ${index}`,
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(), state: "completed",
      }, env);
    }
  }
  const scans = countSummaryScans(t);
  const firstPass = [];
  for (const thread of threads) firstPass.push(await storedThreadMessagePage(thread, { limit: "50" }));
  assert.equal(scans(), threads.length);
  assert.ok(cachedThreadSummaryCount() >= threads.length);
  for (const [index, thread] of threads.entries()) {
    assert.deepEqual(await storedThreadMessagePage(thread, { limit: "50" }), firstPass[index]);
  }
  assert.equal(scans(), threads.length, "a second polling pass re-reads no summary");
  // A write still invalidates exactly that thread's summary.
  await appendThreadMessageRecord("poll-3", {
    id: "poll-3-m-4", role: "assistant", text: "new", state: "completed",
    timestamp: new Date(Date.UTC(2026, 0, 1, 1)).toISOString(),
  }, env);
  const page = await storedThreadMessagePage(threads[3], { limit: "50" });
  assert.equal(scans(), threads.length + 1);
  assert.equal(page.messages.at(-1).id, "poll-3-m-4");
});

function rng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function pick(random, values) {
  return values[Math.floor(random() * values.length)];
}

// Ids with padding, executor fallbacks, missing values and shared event ids.
function randomMessage(random, index) {
  const message = { id: `m-${index}`, role: pick(random, ["user", "assistant"]) };
  const thread = pick(random, ["codex-a", " codex-a ", "codex-b", "", undefined]);
  const turn = pick(random, ["turn-1", "turn-2", " turn-2", "", undefined]);
  if (thread !== undefined) message[random() < 0.7 ? "codexThreadId" : "executorThreadId"] = thread;
  if (turn !== undefined) message[random() < 0.7 ? "codexTurnId" : "executorTurnId"] = turn;
  if (random() < 0.6) message.eventId = pick(random, ["event-1", " event-1", "event-2", ""]);
  return message;
}

function assertIndexMatchesScans(index, messages) {
  const generation = (row) => clean(row?.codexThreadId || row?.executorThreadId);
  const turn = (row) => clean(row?.codexTurnId || row?.executorTurnId);
  for (const threadId of ["codex-a", " codex-a", "codex-b", "", undefined]) {
    for (const turnId of ["turn-1", "turn-2 ", "", undefined]) {
      assert.deepEqual(index.codexTurn(threadId, turnId), messages.filter((row) =>
        clean(row.codexThreadId) === clean(threadId) && clean(row.codexTurnId) === clean(turnId)));
      assert.deepEqual(index.identityTurn(threadId, turnId), messages.filter((row) =>
        generation(row) === clean(threadId) && turn(row) === clean(turnId)));
      const input = { codexThreadId: threadId, codexTurnId: turnId };
      assert.deepEqual(index.identityScopeOf(input), messages.filter((row) =>
        generation(row) === generation(input) && turn(row) === turn(input)));
    }
  }
  for (const eventId of ["event-1", "event-2 ", "", undefined]) {
    assert.deepEqual(index.eventId(eventId), messages.filter((row) => clean(row.eventId) === clean(eventId)));
  }
}

test("the hydration index returns exactly the rows a full scan would, in order, across edits", () => {
  const random = rng(42);
  const messages = Array.from({ length: 400 }, (_, index) => randomMessage(random, index));
  const index = createCodexHydrationIndex(messages);
  index.sync(1);
  assertIndexMatchesScans(index, messages);
  for (let step = 0; step < 40; step += 1) {
    if (random() < 0.6) {
      const message = randomMessage(random, 400 + step);
      messages.push(message);
      index.appended(message);
    } else {
      const position = Math.floor(random() * messages.length);
      messages[position] = randomMessage(random, 1000 + step);
      index.invalidate();
    }
    assertIndexMatchesScans(index, messages);
  }
  // A reload of the array is picked up through the snapshot load counter.
  messages.length = 0;
  for (let step = 0; step < 50; step += 1) messages.push(randomMessage(random, 2000 + step));
  index.sync(2);
  assertIndexMatchesScans(index, messages);
});

test("the message snapshot counts reloads only when the store changed", async (t) => {
  const env = await sqliteHome(t, "orkestr-snapshot-loads-");
  await appendThreadMessageRecord("loads", { id: "m-1", role: "user", text: "one" }, env);
  const snapshot = createThreadMessageSnapshot("loads", env);
  await snapshot.run(() => {});
  assert.equal(snapshot.loads, 1);
  await snapshot.run(() => {});
  assert.equal(snapshot.loads, 1);
  await appendThreadMessageRecord("loads", { id: "m-2", role: "assistant", text: "two" }, env);
  await snapshot.run(() => {});
  assert.equal(snapshot.loads, 2);
  assert.deepEqual(snapshot.messages.map((message) => message.id), ["m-1", "m-2"]);
});
