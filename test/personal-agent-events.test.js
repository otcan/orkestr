import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { closeAgentJobDbs, openAgentJobDb, tx } from "../packages/core/src/agent-job-store.js";
import { appendEvent as appendJournalEvent } from "../packages/storage/src/store.js";
import { dataPaths } from "../packages/storage/src/paths.js";
import {
  appendPersonalAgentEvent,
  dispatchPersonalAgentEvents,
  listPersonalAgentEvents,
  personalAgentEventFeed,
  queuePersonalAgentEvent,
} from "../packages/core/src/personal-agent-events.js";
import { createPersonalAgentTask, transitionPersonalAgentTask } from "../packages/core/src/personal-agent-tasks.js";
import {
  migratePersonalAgentEvents,
  planPersonalAgentEventsMigration,
} from "../packages/core/src/personal-agent-events-migration.js";

async function fixture(t, enabled = true) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-pa-events-"));
  const env = { ORKESTR_HOME: home, ORKESTR_PERSONAL_AGENT_ENABLED: enabled ? "1" : "0" };
  t.after(async () => {
    await closeAgentJobDbs();
    await fs.rm(home, { recursive: true, force: true });
  });
  return { env, home };
}

const eventInput = (overrides = {}) => ({
  type: "message.received",
  actor: { kind: "owner", id: "owner-fixture", origin: "web" },
  projectId: "prj_fixture",
  taskId: null,
  threadId: "thread-fixture",
  runId: null,
  causationId: null,
  idempotencyKey: "message:fixture:1",
  data: { messageId: "message-fixture", phase: "accepted" },
  ...overrides,
});

test("event outbox migration dry-runs, applies, reruns, and rolls back incompatible DDL", () => {
  const db = new DatabaseSync(":memory:");
  try {
    assert.deepEqual(planPersonalAgentEventsMigration(db).missingColumns, [
      "seq", "event_id", "source", "idempotency_key", "payload_hash", "payload_json", "created_at", "dispatched_at",
    ]);
    assert.deepEqual(db.prepare("select name from sqlite_master where type = 'table'").all(), []);
    migratePersonalAgentEvents(db, { dryRun: false });
    migratePersonalAgentEvents(db, { dryRun: false });
    assert.equal(db.prepare("select count(*) as count from sqlite_master where type = 'table' and name = 'personal_agent_event_outbox'").get().count, 1);

    const incompatible = new DatabaseSync(":memory:");
    try {
      incompatible.exec("create table personal_agent_event_outbox (legacy text)");
      assert.throws(() => migratePersonalAgentEvents(incompatible, { dryRun: false }), { message: "personal_agent_events_schema_incompatible" });
      assert.deepEqual(incompatible.prepare("pragma table_info(personal_agent_event_outbox)").all().map((row) => row.name), ["legacy"]);
    } finally {
      incompatible.close();
    }
  } finally {
    db.close();
  }
});

test("event envelope is idempotent and cursor reconnect resumes after restart", async (t) => {
  const { env } = await fixture(t);
  const first = await appendPersonalAgentEvent(eventInput(), env);
  const replay = await appendPersonalAgentEvent(eventInput(), env);
  assert.equal(replay.replayed, true);
  assert.equal(replay.eventId, first.eventId);
  assert.equal(replay.cursor, first.cursor);

  const second = await appendPersonalAgentEvent(eventInput({
    idempotencyKey: "message:fixture:2",
    data: { messageId: "message-fixture-2", phase: "accepted" },
  }), env);
  assert.ok(Number.parseInt(second.cursor.slice(4), 36) > Number.parseInt(first.cursor.slice(4), 36));
  const firstPage = await listPersonalAgentEvents({ limit: 1 }, env);
  assert.equal(firstPage.events[0].eventId, first.eventId);
  assert.equal(firstPage.hasMore, true);
  assert.equal((await listPersonalAgentEvents({ afterCursor: firstPage.cursor }, env)).events[0].eventId, second.eventId);
  await closeAgentJobDbs();

  const page = await listPersonalAgentEvents({ afterCursor: first.cursor, limit: 10 }, env);
  assert.equal(page.resetRequired, false);
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0].eventId, second.eventId);
  assert.equal(page.events[0].schemaVersion, 1);
  assert.equal(page.events[0].actor.origin, "web");
});

test("replay after journal append-before-ack is one logical feed event", async (t) => {
  const { env } = await fixture(t);
  const db = await openAgentJobDb(env);
  let queued;
  tx(db, () => { queued = queuePersonalAgentEvent(db, eventInput(), { env }); });
  const row = db.prepare("select payload_json from personal_agent_event_outbox where event_id = ?").get(queued.eventId);
  await appendJournalEvent(JSON.parse(row.payload_json), env);

  const recovered = await dispatchPersonalAgentEvents(env);
  assert.equal(recovered.dispatched, 1);
  const feed = await listPersonalAgentEvents({}, env);
  assert.equal(feed.events.filter((event) => event.eventId === queued.eventId).length, 1);
  const journal = await fs.readFile(dataPaths(env).events, "utf8");
  assert.equal(journal.trim().split("\n").length, 1, "replay detects a journaled event before acknowledging its outbox row");
});

test("expired journal cursors require reset instead of claiming a complete replay", async (t) => {
  const { env } = await fixture(t);
  const first = await appendPersonalAgentEvent(eventInput(), env);
  await appendPersonalAgentEvent(eventInput({ idempotencyKey: "message:fixture:2" }), env);
  await fs.rm(dataPaths(env).events, { force: true });
  const response = await listPersonalAgentEvents({ afterCursor: first.cursor }, env);
  assert.equal(response.resetRequired, true);
  assert.equal(response.events.length, 0);
  const initial = await listPersonalAgentEvents({}, env);
  assert.equal(initial.resetRequired, true, "a first-page client must not mistake an expired journal for a complete feed");
});

test("task lifecycle events are atomic with transitions and do not copy task content", async (t) => {
  const { env } = await fixture(t);
  const db = await openAgentJobDb(env);
  db.prepare(`insert into personal_agent_projects (id, title, created_at, updated_at)
    values ('prj_fixture', 'private fixture title', 'now', 'now')`).run();
  const created = await createPersonalAgentTask({
    projectId: "prj_fixture",
    title: "sensitive task title",
    outcome: "sensitive outcome",
    nextAction: "private next action",
    acceptanceCriteria: ["verified"],
    scope: { permissions: [], resources: [] },
    dependencies: [],
    budget: { maxAttempts: 1, maxRuntimeMs: 1000 },
    idempotencyKey: "task-create-fixture",
  }, env);
  await transitionPersonalAgentTask({
    taskId: created.task.id,
    to: "running",
    actor: { kind: "system", id: "controller-fixture", origin: "agent_job" },
    idempotencyKey: "task-start-fixture",
    // A start must prove admitted execution (task lifecycle, #66).
    evidence: { admission: { runId: "run-fixture" } },
  }, env);
  const feed = await listPersonalAgentEvents({}, env);
  assert.deepEqual(feed.events.map((event) => event.type), ["task.created", "task.state_changed"]);
  assert.equal(feed.events[0].data.state, "queued");
  assert.equal(feed.events[1].data.from, "queued");
  assert.equal(feed.events[1].data.to, "running");
  assert.equal(feed.events[1].runId, "run-fixture", "the transition event carries the admitted run");
  assert.doesNotMatch(JSON.stringify(feed.events), /sensitive task title|sensitive outcome|private next action/);
  assert.equal(db.prepare("select count(*) as count from personal_agent_event_outbox where dispatched_at is not null and payload_json is null").get().count, 2);
});

test("event feed is feature-gated and validates cursor/envelope boundaries", async (t) => {
  const { env } = await fixture(t, false);
  await assert.rejects(() => appendPersonalAgentEvent(eventInput(), env), { code: "personal_agent_disabled" });
  env.ORKESTR_PERSONAL_AGENT_ENABLED = "true";
  await assert.rejects(() => appendPersonalAgentEvent(eventInput({ actor: { kind: "arbitrary", origin: "web" } }), env), { code: "personal_agent_event_actor_invalid" });
  await assert.rejects(() => appendPersonalAgentEvent(eventInput({ data: { messageBody: "private" } }), env), { code: "personal_agent_event_data_key_forbidden" });
  await assert.rejects(() => listPersonalAgentEvents({ afterCursor: "bad-cursor" }, env), { code: "personal_agent_event_cursor_invalid" });
  await assert.rejects(() => appendPersonalAgentEvent(eventInput({ data: { messageBody: "private" } }), env), { code: "personal_agent_event_data_key_forbidden" });
  await assert.rejects(() => appendPersonalAgentEvent(eventInput({ data: { diagnostic: "x".repeat(30_000) } }), env), { code: "personal_agent_event_too_large" });
  await assert.rejects(() => personalAgentEventFeed({}, {}, env), { statusCode: 403, message: "personal_agent_owner_required" });
  const owner = { orkestrPrincipal: { kind: "user", userId: "owner-fixture", role: "admin" } };
  const response = await personalAgentEventFeed(owner, { limit: "25" }, env);
  assert.deepEqual(response.events, []);
});
