import { createHash, randomUUID } from "node:crypto";
import { listThreadRecords } from "./thread-registry.js";

export async function threadBridgeOwner(threadId, env) {
  const thread = (await listThreadRecords(env)).find(thread => thread.id === threadId);
  return String(thread?.ownerUserId || "");
}

// The journal contains invalidations only. Transcript content is fetched under
// current authorization, never copied into a durable delivery payload.
export function ensureThreadBridgeSchema(db) {
  db.exec(`
    create table if not exists orkestr_thread_bridge_meta (id integer primary key check(id = 1), epoch text not null);
    create table if not exists orkestr_thread_bridge_counters (owner_id text primary key, cursor integer not null);
    create table if not exists orkestr_thread_bridge_changes (
      owner_id text not null, cursor integer not null, thread_id text not null,
      message_id text not null, kind text not null, origin_agent_id text not null,
      primary key(owner_id, cursor)
    );
    create table if not exists orkestr_thread_bridge_replies (
      owner_id text not null, agent_id text not null, grant_id text not null,
      thread_id text not null, request_id text not null, request_hash text not null,
      message_id text not null, primary key(owner_id, agent_id, grant_id, thread_id, request_id)
    );
  `);
  db.prepare("insert or ignore into orkestr_thread_bridge_meta(id, epoch) values(1, ?)").run(randomUUID());
}

export function bridgeMessageVisible(message) {
  if (!message || message.deletedAt || String(message.visibility || "").trim().toLowerCase() === "internal" || message.supersededBy) return false;
  if (message.role === "user") return true;
  return message.role === "assistant" && (!message.state || message.state === "completed") &&
    ["final_answer", "delegated_comment"].includes(message.phase || "final_answer") &&
    String(message.text || "").trim() !== "NO_REPLY";
}

function appendChange(db, threadId, message, kind, owner) {
  if (!owner || !message.id) return;
  const { cursor } = db.prepare(`insert into orkestr_thread_bridge_counters(owner_id, cursor) values(?, 1)
    on conflict(owner_id) do update set cursor = cursor + 1 returning cursor`).get(owner);
  db.prepare(`insert into orkestr_thread_bridge_changes
    (owner_id, cursor, thread_id, message_id, kind, origin_agent_id) values(?, ?, ?, ?, ?, ?)`)
    .run(owner, cursor, threadId, message.id, kind,
      message.source === "thread_bridge_agent" ? String(message.bridgeAgentId || "") : "");
}

// Must run inside the message mutation's SQLite transaction.
export function recordThreadBridgeChange(db, threadId, previous, next, owner) {
  if (JSON.stringify(previous) === JSON.stringify(next)) return;
  const wasVisible = bridgeMessageVisible(previous);
  const isVisible = bridgeMessageVisible(next);
  if (wasVisible && !isVisible) {
    appendChange(db, threadId, previous, "message.deleted", owner);
  }
  if (isVisible) appendChange(db, threadId, next, wasVisible ? "message.updated" : "message.created", owner);
}

export function readThreadBridgeChanges(db, ownerId, { cursor = "", limit = 100 } = {}) {
  const databaseEpoch = db.prepare("select epoch from orkestr_thread_bridge_meta where id = 1").get().epoch;
  const epoch = createHash("sha256").update(`${databaseEpoch}\0${ownerId}`).digest("hex");
  const current = Number(db.prepare("select cursor from orkestr_thread_bridge_counters where owner_id = ?").get(ownerId)?.cursor || 0);
  let after = 0;
  if (cursor) {
    const parts = String(cursor).split(":");
    after = Number(parts[1]);
    if (parts.length !== 2 || parts[0] !== epoch || !/^\d+$/.test(parts[1]) || !Number.isSafeInteger(after) || after > current) {
      throw Object.assign(new Error("bridge_cursor_reset_required"), { statusCode: 409 });
    }
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw Object.assign(new Error("bridge_limit_invalid"), { statusCode: 400 });
  const rows = db.prepare(`select cursor, thread_id, message_id, kind, origin_agent_id
    from orkestr_thread_bridge_changes where owner_id = ? and cursor > ? and cursor <= ? order by cursor asc limit ?`).all(ownerId, after, current, limit + 1);
  const hasMore = rows.length > limit;
  const events = rows.slice(0, limit).map(row => ({
    cursor: `${epoch}:${row.cursor}`, threadId: row.thread_id, messageId: row.message_id,
    type: row.kind, originAgentId: row.origin_agent_id || null,
  }));
  return { events, cursor: events.at(-1)?.cursor || `${epoch}:${after}`, currentCursor: `${epoch}:${current}`, hasMore };
}

export function writeThreadBridgeReply(db, threadId, message, identity, insert, touch) {
  const key = [identity.ownerId, identity.agentId, identity.grantId, threadId, identity.requestId];
  db.exec("begin immediate");
  try {
    const existing = db.prepare(`select request_hash, message_id from orkestr_thread_bridge_replies
      where owner_id = ? and agent_id = ? and grant_id = ? and thread_id = ? and request_id = ?`).get(...key);
    if (existing) {
      if (existing.request_hash !== identity.requestHash) throw Object.assign(new Error("bridge_idempotency_conflict"), { statusCode: 409 });
      db.exec("commit");
      return { messageId: existing.message_id, duplicate: true };
    }
    const next = db.prepare("select coalesce(max(position), 0) + 1 as position, coalesce(max(cursor), 0) + 1 as cursor from orkestr_thread_messages where thread_id = ?").get(threadId);
    const stored = { ...message, cursor: Number(next.cursor) };
    insert(stored, Number(next.position));
    recordThreadBridgeChange(db, threadId, null, stored, identity.ownerId);
    db.prepare(`insert into orkestr_thread_bridge_replies
      (owner_id, agent_id, grant_id, thread_id, request_id, request_hash, message_id) values(?, ?, ?, ?, ?, ?, ?)`)
      .run(...key, identity.requestHash, stored.id);
    touch();
    db.exec("commit");
    return { messageId: stored.id, duplicate: false };
  } catch (error) {
    db.exec("rollback");
    throw error;
  }
}
