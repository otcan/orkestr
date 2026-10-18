import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createThreadMessageSnapshot } from "../packages/core/src/thread-message-snapshot.js";
import { createThreadMessageRepository } from "../packages/storage/src/repositories.js";
import { closeThreadMessageRegistryCache } from "../packages/storage/src/thread-message-registry.js";
import { createThread, listThreadMessages } from "../packages/core/src/threads.js";
import { hydrateCodexAppServerThreadMessages } from "../packages/core/src/codex-app-server.js";

async function fixture(t, store = "sqlite") {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-history-snapshot-"));
  const env = { ORKESTR_HOME: home, ORKESTR_THREAD_MESSAGE_STORE: store };
  t.after(async () => {
    closeThreadMessageRegistryCache();
    await fs.rm(home, { recursive: true, force: true });
  });
  return { env, repository: createThreadMessageRepository(env) };
}

function countFullReads(t) {
  const prepare = DatabaseSync.prototype.prepare;
  let reads = 0;
  t.mock.method(DatabaseSync.prototype, "prepare", function (sql) {
    const statement = prepare.call(this, sql);
    if (!/select position, data from orkestr_thread_messages\s+where thread_id = \? order by position asc\s*$/i.test(sql.trim())) return statement;
    return new Proxy(statement, {
      get(target, key) {
        if (key === "all") return (...args) => { reads += 1; return target.all(...args); };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  });
  return () => reads;
}

test("history hydration reads a long sqlite thread once per pass, preserving repeat identity", async (t) => {
  const { env, repository } = await fixture(t);
  const thread = await createThread({
    id: "history", name: "History", cwd: env.ORKESTR_HOME,
    executorId: "codex", executor: { type: "codex" },
  }, env);
  await repository.save(thread.id, Array.from({ length: 2000 }, (_, i) => ({
    id: `old-${i}`, role: "assistant", phase: "commentary", text: `Earlier output ${i}`, state: "completed",
  })));
  const history = {
    id: "synthetic-codex-history",
    turns: Array.from({ length: 30 }, (_, i) => ({
      id: `turn-${i}`, status: "completed", items: [
        { id: `input-${i}`, type: "userMessage", content: [{ type: "text", text: `Request ${i}` }] },
        { id: `output-${i}`, type: "agentMessage", phase: "final_answer", text: `Answer ${i}` },
      ],
    })),
  };
  const fullReads = countFullReads(t);
  const first = await hydrateCodexAppServerThreadMessages(thread, history, env);
  assert.equal(first.created, 60);
  assert.equal(fullReads(), 1, "one snapshot, not a full read for each history item");
  const second = await hydrateCodexAppServerThreadMessages(thread, history, env);
  assert.equal(second.count, 0);
  assert.equal(fullReads(), 2, "a new pass starts fresh but still reads only once");
  const messages = await listThreadMessages(thread.id, env);
  assert.equal(messages.length, 2060);
  for (let i = 0; i < 30; i += 1) {
    const user = messages.find(m => m.codexItemId === `input-${i}`);
    const reply = messages.find(m => m.codexItemId === `output-${i}`);
    assert.equal(reply.parentMessageId, user.id);
  }
});

test("snapshot observes other writers and changed delivery state before the next mutation", async (t) => {
  const { env, repository } = await fixture(t);
  const input = { id: "input", role: "user", state: "queued", text: "Request" };
  await repository.save("thread", [input]);
  const fullReads = countFullReads(t);
  const snapshot = createThreadMessageSnapshot("thread", env);
  await snapshot.run(messages => assert.equal(messages[0].state, "queued"));
  await snapshot.run(messages => assert.equal(messages.length, 1));
  assert.equal(fullReads(), 1);
  await repository.update("thread", "input", { ...input, state: "completed" });
  await repository.append("thread", { id: "second", role: "user", state: "queued", text: "Next request" });
  await snapshot.run(messages => {
    assert.deepEqual(messages.map(m => [m.id, m.state]), [["input", "completed"], ["second", "queued"]]);
  });
  assert.equal(fullReads(), 2);
});

test("snapshot invalidates after an operation fails following a persisted write", async (t) => {
  const { env, repository } = await fixture(t);
  await repository.save("thread", []);
  const snapshot = createThreadMessageSnapshot("thread", env);
  await snapshot.run(() => {});
  await assert.rejects(snapshot.run(async () => {
    await repository.append("thread", { id: "persisted", text: "Saved before failure" });
    throw new Error("partial_operation");
  }), /partial_operation/);
  await snapshot.run(messages => assert.equal(messages[0].id, "persisted"));
});

test("a concurrent live writer waits for reconciliation and is visible on its next item", async (t) => {
  const { env, repository } = await fixture(t);
  await repository.save("thread", []);
  const snapshot = createThreadMessageSnapshot("thread", env);
  let enter;
  const entered = new Promise(resolve => { enter = resolve; });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const reconciliation = snapshot.run(async messages => {
    enter();
    await gate;
    messages.push(await repository.append("thread", { id: "history", text: "Historical output" }));
  });
  await entered;
  let liveWriteFinished = false;
  const liveWrite = repository.append("thread", { id: "live", text: "New input" })
    .then(() => { liveWriteFinished = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(liveWriteFinished, false);
  } finally {
    release();
    await Promise.all([reconciliation, liveWrite]);
  }
  await snapshot.run(messages => assert.deepEqual(messages.map(m => m.id), ["history", "live"]));
});

test("JSON snapshots reread without a store revision and homes remain isolated", async (t) => {
  const a = await fixture(t, "json");
  const b = await fixture(t, "json");
  await a.repository.save("same-id", [{ id: "first", text: "Home A" }]);
  await b.repository.save("same-id", [{ id: "second", text: "Home B" }]);
  const one = createThreadMessageSnapshot("same-id", a.env);
  const two = createThreadMessageSnapshot("same-id", b.env);
  await one.run(messages => assert.equal(messages[0].text, "Home A"));
  await two.run(messages => assert.equal(messages[0].text, "Home B"));
  await a.repository.save("same-id", [{ id: "updated", text: "Updated A" }]);
  await one.run(messages => assert.equal(messages[0].text, "Updated A"));
  await two.run(messages => assert.equal(messages[0].text, "Home B"));
});
