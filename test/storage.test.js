import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readJson, writeJson } from "../packages/storage/src/store.js";
import { listThreadRecords, saveThreadRecords } from "../packages/storage/src/thread-registry.js";

test("readJson recovers a valid JSON value with trailing garbage", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-storage-"));
  const file = path.join(dir, "threads.json");
  await fs.writeFile(file, '[{"id":"thread-1"}]\n.jsonl"\n', "utf8");

  const value = await readJson(file, []);

  assert.deepEqual(value, [{ id: "thread-1" }]);
});

test("writeJson writes valid JSON through concurrent writes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-storage-"));
  const file = path.join(dir, "threads.json");

  await Promise.all([
    writeJson(file, [{ id: "thread-1" }]),
    writeJson(file, [{ id: "thread-2" }]),
    writeJson(file, [{ id: "thread-3" }]),
  ]);

  const raw = await fs.readFile(file, "utf8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.length, 1);
  assert.match(parsed[0].id, /^thread-[123]$/);
  assert.equal((await fs.readdir(dir)).filter((name) => name.endsWith(".tmp")).length, 0);
});

test("thread registry migrates JSON records into SQLite", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-storage-"));
  const env = { ORKESTR_HOME: home, ORKESTR_THREAD_STORE: "sqlite" };
  await fs.writeFile(
    path.join(home, "threads.json"),
    JSON.stringify([{ id: "thread-1", name: "Thread One", createdAt: "2026-01-01T00:00:00.000Z" }]),
  );

  const migrated = await listThreadRecords(env);
  await saveThreadRecords([{ ...migrated[0], state: "ready" }], env);
  const listed = await listThreadRecords(env);

  assert.equal(migrated.length, 1);
  assert.equal(listed[0].state, "ready");
  assert.ok(await fs.stat(path.join(home, "threads.sqlite")));
  assert.equal((await readJson(path.join(home, "threads.json"), []))[0].state, "ready");
});

test("thread registry deduplicates visible thread names", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-storage-dedupe-"));
  const env = { ORKESTR_HOME: home, ORKESTR_THREAD_STORE: "json" };

  await saveThreadRecords([
    {
      id: "test-old",
      name: "TEST",
      createdAt: "2026-01-01T00:00:00.000Z",
      executor: { codexThreadId: "019e3c79-6327-78d2-89d7-61bed7b94b71", metadata: { codexModel: "gpt-5.5" } },
    },
    {
      id: "test-new",
      name: "TEST",
      createdAt: "2026-01-02T00:00:00.000Z",
      activeRuntimeLeaseId: "stale-lease",
      workspace: "/workspace/test-path",
    },
  ], env);

  const listed = await listThreadRecords(env);
  const stored = await readJson(path.join(home, "threads.json"), []);

  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, "test-old");
  assert.equal(stored.length, 1);
  assert.equal(stored[0].id, "test-old");
});
