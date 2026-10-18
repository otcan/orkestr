import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { closeAgentJobDbs, openAgentJobDb, tx } from "../packages/core/src/agent-job-store.js";
import { dataPaths } from "../packages/storage/src/paths.js";
import {
  dispatchPersonalAgentEvents,
  listPersonalAgentEvents,
  queuePersonalAgentEvent,
} from "../packages/core/src/personal-agent-events.js";

// Outbox → journal recovery and feed paging. Synthetic events only.

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-pa-events-recovery-"));
  const env = { ORKESTR_HOME: home, ORKESTR_PERSONAL_AGENT_ENABLED: "1" };
  t.after(async () => {
    await closeAgentJobDbs();
    await fs.rm(home, { recursive: true, force: true });
  });
  return env;
}

const eventInput = (key) => ({
  type: "message.received",
  actor: { kind: "owner", id: "owner-fixture", origin: "web" },
  projectId: "prj_fixture",
  taskId: null,
  threadId: "thread-fixture",
  runId: null,
  causationId: null,
  idempotencyKey: `message:fixture:${key}`,
  data: { messageId: `message-${key}`, phase: "accepted" },
});

// Queue without dispatching, as if the process stopped right after commit.
async function queueOnly(env, count) {
  const db = await openAgentJobDb(env);
  const queued = [];
  tx(db, () => {
    for (let index = 1; index <= count; index += 1) queued.push(queuePersonalAgentEvent(db, eventInput(index), { env }));
  });
  return queued;
}

test("a partial journal record from an interrupted append is fenced off before redispatch", async (t) => {
  const env = await fixture(t);
  const [first] = await queueOnly(env, 1);
  const db = await openAgentJobDb(env);
  const payload = db.prepare("select payload_json from personal_agent_event_outbox where event_id = ?").get(first.eventId).payload_json;
  const journal = dataPaths(env).events;
  await fs.mkdir(path.dirname(journal), { recursive: true });
  // The original append died halfway through this event's record.
  await fs.writeFile(journal, payload.slice(0, Math.floor(payload.length / 2)));

  await dispatchPersonalAgentEvents(env);
  const feed = await listPersonalAgentEvents({}, env);
  assert.equal(feed.resetRequired, false);
  assert.deepEqual(feed.events.map((event) => event.eventId), [first.eventId]);
});

test("an event is acknowledged only once it can be read back from the journal", async (t) => {
  const env = await fixture(t);
  const [first] = await queueOnly(env, 1);
  const journal = dataPaths(env).events;
  await fs.mkdir(path.dirname(journal), { recursive: true });
  await fs.writeFile(journal, "{\"unterminated\":");
  await dispatchPersonalAgentEvents(env);
  const db = await openAgentJobDb(env);
  const row = db.prepare("select dispatched_at from personal_agent_event_outbox where event_id = ?").get(first.eventId);
  assert.ok(row.dispatched_at, "the readable event is acknowledged");
  const lines = (await fs.readFile(journal, "utf8")).split("\n").filter(Boolean);
  assert.ok(lines.some((line) => { try { return JSON.parse(line).eventId === first.eventId; } catch { return false; } }));
});

test("hasMore stays true while undispatched outbox events remain beyond one dispatch batch", async (t) => {
  const env = await fixture(t);
  const queued = await queueOnly(env, 201);
  const seen = [];
  let cursor = null;
  for (let page = 0; page < 10; page += 1) {
    const feed = await listPersonalAgentEvents({ afterCursor: cursor, limit: 200 }, env);
    assert.equal(feed.resetRequired, false, `page ${page} must not demand a reset`);
    seen.push(...feed.events.map((event) => event.eventId));
    cursor = feed.cursor;
    if (!feed.hasMore) break;
  }
  assert.deepEqual(seen, queued.map((event) => event.eventId), "following hasMore reaches every queued event in order");
});

test("the feed reads its high-water mark and first pending row from one snapshot", async (t) => {
  const env = await fixture(t);
  const { DatabaseSync } = await import("node:sqlite");
  const { agentJobDbPath } = await import("../packages/core/src/agent-job-store.js");
  await queueOnly(env, 1);
  await dispatchPersonalAgentEvents(env);
  const db = await openAgentJobDb(env);
  const other = new DatabaseSync(await agentJobDbPath(env));
  t.after(() => other.close());
  const journal = dataPaths(env).events;
  const prepare = db.prepare;
  let interleaved = false;
  // After the feed's first outbox aggregate, another process publishes seq 2
  // and queues seq 3 before any further feed query runs.
  db.prepare = function (sql) {
    const statement = prepare.call(this, sql);
    if (interleaved || !/max\(seq\)/.test(sql)) return statement;
    return { get: (...args) => {
      const row = statement.get(...args);
      interleaved = true;
      const published = queuePersonalAgentEvent(other, eventInput(2), { env });
      const payload = other.prepare("select payload_json from personal_agent_event_outbox where event_id = ?").get(published.eventId).payload_json;
      fsSync.appendFileSync(journal, `${payload}\n`);
      other.prepare("update personal_agent_event_outbox set dispatched_at = 'now', payload_json = null where event_id = ?").run(published.eventId);
      queuePersonalAgentEvent(other, eventInput(3), { env });
      return row;
    }, all: (...args) => statement.all(...args), run: (...args) => statement.run(...args) };
  };
  t.after(() => { db.prepare = prepare; });
  const feed = await listPersonalAgentEvents({}, env);
  db.prepare = prepare;
  assert.ok(interleaved, "the interleaving ran");
  const seq = (cursor) => Number.parseInt(cursor.split(".")[1], 36);
  assert.ok(seq(feed.cursor) <= seq(feed.currentCursor), "the cursor never runs ahead of the snapshot");
  assert.ok(feed.events.every((event) => seq(event.cursor) <= seq(feed.currentCursor)));
});
