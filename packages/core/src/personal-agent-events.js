import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { appendEvent, listEventArchives, terminateEventJournalTail } from "../../storage/src/store.js";
import { dataPaths } from "../../storage/src/paths.js";
import { withStorageFileLock } from "../../storage/src/storage-lock.js";
import { requirePersonalAgentOwner } from "./personal-agent-capability.js";
import { newId, nowIso, openAgentJobDb, stableStringify, tx } from "./agent-job-store.js";
import { personalAgentFeature } from "./personal-agent-feature.js";

const actorKinds = new Set(["owner", "assistant", "worker", "system", "connector"]);
const maxEventBytes = 48 * 1024;

function fail(code, statusCode = 400) {
  throw Object.assign(new Error(code), { code, statusCode });
}

function text(value, code, maxLength = 256, { optional = false } = {}) {
  if (value == null && optional) return null;
  if (typeof value !== "string") fail(code);
  const result = value.trim();
  if (!result && optional) return null;
  if (!result || result.length > maxLength) fail(code);
  return result;
}

function normalizeInput(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("personal_agent_event_invalid");
  const actor = input.actor;
  if (!actor || typeof actor !== "object" || Array.isArray(actor) || !actorKinds.has(actor.kind)) fail("personal_agent_event_actor_invalid");
  if (!input.data || typeof input.data !== "object" || Array.isArray(input.data)) fail("personal_agent_event_data_invalid");
  let dataJson;
  try { dataJson = JSON.stringify(input.data); } catch { fail("personal_agent_event_data_invalid"); }
  if (!dataJson) fail("personal_agent_event_data_invalid");
  assertSafeData(input.data);
  if (Buffer.byteLength(dataJson) > maxEventBytes / 2) fail("personal_agent_event_too_large", 413);
  const event = {
    schemaVersion: 1,
    eventId: newId("evt"),
    type: text(input.type, "personal_agent_event_type_invalid", 120),
    occurredAt: text(input.occurredAt ?? nowIso(), "personal_agent_event_time_invalid", 40),
    actor: {
      kind: actor.kind,
      id: text(actor.id, "personal_agent_event_actor_id_invalid", 256, { optional: true }),
      origin: text(actor.origin, "personal_agent_event_actor_origin_invalid", 80),
    },
    projectId: text(input.projectId, "personal_agent_event_project_id_invalid", 256, { optional: true }),
    taskId: text(input.taskId, "personal_agent_event_task_id_invalid", 256, { optional: true }),
    threadId: text(input.threadId, "personal_agent_event_thread_id_invalid", 256, { optional: true }),
    runId: text(input.runId, "personal_agent_event_run_id_invalid", 256, { optional: true }),
    causationId: text(input.causationId, "personal_agent_event_causation_invalid", 256, { optional: true }),
    idempotencyKey: text(input.idempotencyKey, "personal_agent_event_idempotency_invalid", 512),
    data: JSON.parse(dataJson),
  };
  return event;
}

function cursorFor(seq) {
  return `pa1.${Number(seq).toString(36)}`;
}

function assertSafeData(value) {
  if (Array.isArray(value)) {
    for (const item of value) assertSafeData(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  const forbidden = new Set(["body", "text", "message", "messagebody", "messagetext", "content", "contentjson", "password", "token", "secret", "credential", "authorization", "accesstoken", "refreshtoken"]);
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key.toLowerCase().replace(/[_-]/g, ""))) fail("personal_agent_event_data_key_forbidden");
    assertSafeData(child);
  }
}

function parseCursor(value) {
  if (value == null || value === "") return 0;
  const match = /^pa1\.([0-9a-z]+)$/.exec(String(value));
  if (!match) fail("personal_agent_event_cursor_invalid");
  const seq = Number.parseInt(match[1], 36);
  if (!Number.isSafeInteger(seq) || seq < 0) fail("personal_agent_event_cursor_invalid");
  return seq;
}

function eventFingerprint(event) {
  const { eventId, occurredAt, ...semanticEvent } = event;
  return crypto.createHash("sha256").update(stableStringify(semanticEvent)).digest("hex");
}

export function queuePersonalAgentEvent(db, input, { source = "personal_agent", env = process.env } = {}) {
  if (!personalAgentFeature(env)) fail("personal_agent_disabled", 404);
  const event = normalizeInput(input);
  const sourceKey = text(source, "personal_agent_event_source_invalid", 120);
  const fingerprint = eventFingerprint(event);
  const prior = db.prepare(`select event_id, seq, payload_hash from personal_agent_event_outbox
    where source = ? and idempotency_key = ?`).get(sourceKey, event.idempotencyKey);
  if (prior) {
    if (prior.payload_hash !== fingerprint) fail("personal_agent_event_idempotency_conflict", 409);
    return { eventId: prior.event_id, cursor: cursorFor(prior.seq), replayed: true };
  }

  const result = db.prepare(`insert into personal_agent_event_outbox
    (event_id, source, idempotency_key, payload_hash, payload_json, created_at)
    values (?, ?, ?, ?, ?, ?)`)
    .run(event.eventId, sourceKey, event.idempotencyKey, fingerprint, JSON.stringify(event), event.occurredAt);
  const seq = Number(result.lastInsertRowid);
  event.cursor = cursorFor(seq);
  db.prepare("update personal_agent_event_outbox set payload_json = ? where seq = ?")
    .run(JSON.stringify(event), seq);
  return { eventId: event.eventId, cursor: event.cursor, replayed: false };
}

export async function appendPersonalAgentEvent(input, env = process.env) {
  const db = await openAgentJobDb(env);
  let result;
  tx(db, () => { result = queuePersonalAgentEvent(db, input, { env }); });
  await dispatchPersonalAgentEvents(env);
  return result;
}

export async function dispatchPersonalAgentEvents(env = process.env, { limit = 100 } = {}) {
  if (!personalAgentFeature(env)) fail("personal_agent_disabled", 404);
  const db = await openAgentJobDb(env);
  const paths = dataPaths(env);
  const boundedLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  return withStorageFileLock(`${paths.events}.personal-agent-dispatch`, async () => {
    const pending = db.prepare(`select seq, event_id, payload_json from personal_agent_event_outbox
      where dispatched_at is null order by seq limit ?`).all(boundedLimit);
    if (!pending.length) {
      return { dispatched: 0, remaining: 0 };
    }
    // An interrupted earlier append may have left a partial record; fence it
    // off so the redispatched record is not glued onto the fragment.
    await terminateEventJournalTail(env);
    const journaledIds = await readableEventIds(env);
    let appended = false;
    for (const row of pending) {
      const event = JSON.parse(row.payload_json);
      if (!journaledIds.has(event.eventId)) {
        await appendEvent(event, env);
        appended = true;
      }
    }
    // Acknowledge (and drop the payload of) only events the journal returns.
    const readable = appended ? await readableEventIds(env) : journaledIds;
    let dispatched = 0;
    for (const row of pending) {
      if (!readable.has(JSON.parse(row.payload_json).eventId)) continue;
      tx(db, () => {
        db.prepare(`update personal_agent_event_outbox
          set dispatched_at = ?, payload_json = null where seq = ? and dispatched_at is null`)
          .run(nowIso(), row.seq);
      });
      dispatched += 1;
    }
    return { dispatched, remaining: Number(db.prepare("select count(*) as count from personal_agent_event_outbox where dispatched_at is null").get().count) };
  });
}

async function readableEventIds(env) {
  const ids = new Set();
  for await (const existing of retainedEvents(env)) {
    if (typeof existing?.eventId === "string") ids.add(existing.eventId);
  }
  return ids;
}

async function* readJsonLines(filePath, compressed = false) {
  let input = fs.createReadStream(filePath, { encoding: "utf8" });
  if (compressed) input = input.pipe(createGunzip());
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    try { yield JSON.parse(line); } catch { /* Ignore legacy/corrupt records without hiding later events. */ }
  }
}

async function* retainedEvents(env) {
  const archives = await listEventArchives(env);
  const files = archives.sort((a, b) => a.name.localeCompare(b.name));
  for (const archive of files) {
    const filePath = path.join(path.dirname(dataPaths(env).events), archive.name);
    try {
      yield* readJsonLines(filePath, archive.compressed);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  try {
    yield* readJsonLines(dataPaths(env).events);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function listPersonalAgentEvents({ afterCursor = null, limit = 100 } = {}, env = process.env) {
  if (!personalAgentFeature(env)) fail("personal_agent_disabled", 404);
  await dispatchPersonalAgentEvents(env);
  const after = parseCursor(afterCursor);
  const pageSize = Math.max(1, Math.min(200, Number(limit) || 100));
  const db = await openAgentJobDb(env);
  const highWater = Number(db.prepare("select coalesce(max(seq), 0) as seq from personal_agent_event_outbox").get().seq);
  if (after > highWater) fail("personal_agent_event_cursor_ahead", 409);
  // Page only the contiguous dispatched prefix; rows still in the outbox
  // (beyond one dispatch batch, or awaiting a readable append) keep hasMore.
  const firstPending = db.prepare("select min(seq) as seq from personal_agent_event_outbox where dispatched_at is null").get().seq;
  const visible = firstPending == null ? highWater : Number(firstPending) - 1;

  const bySequence = new Map();
  for await (const event of retainedEvents(env)) {
    if (event?.schemaVersion !== 1 || typeof event.cursor !== "string") continue;
    let seq;
    try { seq = parseCursor(event.cursor); } catch { continue; }
    if (seq > after && seq <= visible && typeof event.eventId === "string" && !bySequence.has(seq)) {
      bySequence.set(seq, event);
    }
  }
  const ordered = [...bySequence.entries()].sort(([a], [b]) => a - b);
  const oldest = ordered[0]?.[0] ?? null;
  const firstExpected = after + 1;
  if (oldest !== null && oldest > firstExpected) {
    return { events: [], cursor: afterCursor, currentCursor: cursorFor(highWater), resetRequired: true, hasMore: false };
  }
  if (oldest === null && after < visible) {
    return { events: [], cursor: afterCursor, currentCursor: cursorFor(highWater), resetRequired: true, hasMore: false };
  }
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index][0] !== ordered[index - 1][0] + 1) {
      return { events: [], cursor: afterCursor, currentCursor: cursorFor(highWater), resetRequired: true, hasMore: false };
    }
  }
  const events = ordered.slice(0, pageSize).map(([, event]) => event);
  const hasMore = ordered.length > events.length || visible < highWater;
  const cursor = events.at(-1)?.cursor || cursorFor(Math.max(after, visible));
  return { events, cursor, currentCursor: cursorFor(highWater), resetRequired: false, hasMore };
}

export async function personalAgentEventFeed(request, query = {}, env = process.env) {
  requirePersonalAgentOwner(request);
  return listPersonalAgentEvents({ afterCursor: query.cursor ?? null, limit: query.limit }, env);
}
