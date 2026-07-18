import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { appendEvent, eventArchiveDownloadPath, eventStorageStatus, listEventArchives, listEvents, readJson, rotateEvents, writeJson } from "../packages/storage/src/store.js";
import { listThreadRecords, saveThreadRecords } from "../packages/storage/src/thread-registry.js";
import { createThreadMessageRepository } from "../packages/storage/src/repositories.js";
import { closeThreadMessageRegistryCache } from "../packages/storage/src/thread-message-registry.js";

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

test("thread message repository migrates JSON once and serves bounded SQLite candidates", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-message-storage-"));
  const env = { ORKESTR_HOME: home, ORKESTR_THREAD_STORE: "sqlite" };
  const messageDir = path.join(home, "thread-messages");
  const messageFile = path.join(messageDir, "thread-a.json");
  await fs.mkdir(messageDir, { recursive: true });
  const legacy = Array.from({ length: 12 }, (_, index) => ({
    id: `message-${index + 1}`,
    cursor: index + 1,
    role: index % 2 ? "assistant" : "user",
    state: index === 2 ? "queued" : "completed",
    phase: index === 7 ? "need_input" : "",
    text: `message ${index + 1}`,
    createdAt: `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
  }));
  await fs.writeFile(messageFile, JSON.stringify(legacy));

  const repository = createThreadMessageRepository(env);
  const candidates = await repository.listCandidates("thread-a", {
    afterCursor: 9,
    tailLimit: 2,
    states: ["queued", "awaiting_ack"],
    phases: ["need_input", "question"],
    ids: ["message-6"],
  });

  assert.deepEqual(candidates.map((message) => message.id), [
    "message-3",
    "message-6",
    "message-8",
    "message-10",
    "message-11",
    "message-12",
  ]);

  await repository.append("thread-a", {
    id: "message-13",
    cursor: 13,
    role: "assistant",
    state: "completed",
    text: "database only",
    createdAt: "2026-01-01T00:00:13.000Z",
  });
  assert.equal((await readJson(messageFile, [])).length, 12);
  assert.equal((await repository.list("thread-a")).at(-1).id, "message-13");

  await closeThreadMessageRegistryCache();
  const reopened = createThreadMessageRepository(env);
  assert.equal((await reopened.list("thread-a")).at(-1).id, "message-13");
  await closeThreadMessageRegistryCache();

  const db = new DatabaseSync(path.join(home, "thread-messages.sqlite"), { readOnly: true });
  const phasePlan = db.prepare(`
    explain query plan select position, data from orkestr_thread_messages
    where thread_id = ? and phase = ? order by position asc
  `).all("thread-a", "need_input");
  const statePlan = db.prepare(`
    explain query plan select position, data from orkestr_thread_messages
    where thread_id = ? and state = ? order by position asc
  `).all("thread-a", "queued");
  const recentPlan = db.prepare(`
    explain query plan select position, data from orkestr_thread_messages
    where thread_id = ? and source = ? and connector = ? and role = ? and state = ? and created_at >= ?
    order by position asc
  `).all("thread-a", "api-session", "whatsapp", "assistant", "completed", "2026-01-01T00:00:00.000Z");
  assert.match(phasePlan.map((row) => row.detail).join("\n"), /idx_orkestr_thread_messages_phase/);
  assert.match(statePlan.map((row) => row.detail).join("\n"), /idx_orkestr_thread_messages_state/);
  assert.match(recentPlan.map((row) => row.detail).join("\n"), /idx_orkestr_thread_messages_recent_delivery/);
  db.close();
});
