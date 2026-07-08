import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendEvent, eventArchiveDownloadPath, eventStorageStatus, listEventArchives, listEvents, readJson, rotateEvents, writeJson } from "../packages/storage/src/store.js";
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

test("listEvents reads recent JSONL records from a bounded tail", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-storage-events-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_EVENTS_TAIL_INITIAL_BYTES: "80",
    ORKESTR_EVENTS_TAIL_MAX_BYTES: "1024",
  };

  for (let index = 0; index < 30; index += 1) {
    await appendEvent({ type: `event_${index}`, filler: "x".repeat(20) }, env);
  }

  const events = await listEvents(env, 4);

  assert.deepEqual(events.map((event) => event.type), ["event_26", "event_27", "event_28", "event_29"]);
});

test("event log rotation archives, gzips, and keeps current log writable", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-storage-events-rotate-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_EVENTS_MAX_BYTES: "240",
    ORKESTR_EVENTS_GZIP_SYNC: "1",
  };

  await appendEvent({ type: "event_before_rotate", filler: "x".repeat(140) }, env);
  await appendEvent({ type: "event_after_rotate", filler: "y".repeat(140) }, env);

  const archives = await listEventArchives(env);
  const events = await listEvents(env, 10);
  const status = await eventStorageStatus(env);
  const archive = await eventArchiveDownloadPath(archives[0].name, env);

  assert.equal(archives.length, 1);
  assert.equal(archives[0].compressed, true);
  assert.match(archives[0].name, /^events-\d{8}-\d{6}-\d+\.jsonl\.gz$/);
  assert.equal(events.at(-1).type, "event_after_rotate");
  assert.equal(status.archiveCount, 1);
  assert.equal(path.dirname(archive.path), home);
  await assert.rejects(() => eventArchiveDownloadPath("../events.jsonl", env), /invalid_event_archive_name/);
});

test("event log rotation prunes archives beyond the configured file limit", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-storage-events-prune-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_EVENTS_ARCHIVE_MAX_FILES: "1",
  };

  await appendEvent({ type: "event_one" }, env);
  await rotateEvents(env, { force: true, waitForCompression: true });
  await appendEvent({ type: "event_two" }, env);
  await rotateEvents(env, { force: true, waitForCompression: true });

  const archives = await listEventArchives(env);

  assert.equal(archives.length, 1);
});

test("appendEvent truncates oversized event payloads before writing", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-storage-events-truncate-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_EVENTS_MAX_EVENT_BYTES: "240",
  };

  const stored = await appendEvent({ type: "huge_event", body: "x".repeat(1000), other: "kept as key name only" }, env);
  const events = await listEvents(env, 5);

  assert.equal(stored.type, "event_payload_truncated");
  assert.equal(stored.originalType, "huge_event");
  assert.equal(events[0].type, "event_payload_truncated");
  assert.equal(events[0].originalType, "huge_event");
  assert.equal("body" in events[0], false);
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
