import { dataPaths } from "./paths.js";
import { threadMessageStoreDatabase } from "./thread-message-registry.js";

// Fields needed to order and summarize a thread without parsing message bodies in JS.
const summaryFields = ["cursor", "timestamp", "createdAt", "updatedAt", "supersededBy", "id"];
const summaryPaths = summaryFields.map((field) => `'$.${field}'`).join(", ");

function messageRows(rows = []) {
  return rows.map((row) => ({ position: Number(row.position), message: JSON.parse(row.data) }));
}

function storeSnapshot(db, threadId, env) {
  return {
    key: `${dataPaths(env).threadMessagesDb}:${threadId}`,
    revision() {
      const row = db.prepare(`
        select revision, updated_at from orkestr_thread_message_meta where thread_id = ?
      `).get(threadId);
      return `${Number(row?.revision || 0)}:${String(row?.updated_at || "")}`;
    },
    // Position order, which is the order listThreadMessageRows returns.
    summaries() {
      return db.prepare(`
        select position, json_extract(data, ${summaryPaths}) as fields
        from orkestr_thread_messages where thread_id = ? order by position asc
      `).all(threadId).map((row) => {
        const values = JSON.parse(row.fields);
        const summary = { position: Number(row.position) };
        summaryFields.forEach((field, index) => { summary[field] = values[index]; });
        return summary;
      });
    },
    messagesAt(positions = []) {
      const loaded = [];
      for (let offset = 0; offset < positions.length; offset += 500) {
        const chunk = positions.slice(offset, offset + 500);
        loaded.push(...messageRows(db.prepare(`
          select position, data from orkestr_thread_messages
          where thread_id = ? and position in (${chunk.map(() => "?").join(",")})
        `).all(threadId, ...chunk)));
      }
      return loaded;
    },
    // Superset of the messages whose turn id is one of turnIds (callers re-check exactly).
    // Selecting rowids first keeps the scan on the covering codex index.
    messagesForTurns(turnIds = []) {
      if (!turnIds.length) return [];
      const rowids = db.prepare(`
        select rowid from orkestr_thread_messages
        where thread_id = ? and (${turnIds.map(() => "instr(codex_turn_id, ?) > 0").join(" or ")})
      `).all(threadId, ...turnIds).map((row) => row.rowid);
      const loaded = [];
      for (let offset = 0; offset < rowids.length; offset += 500) {
        const chunk = rowids.slice(offset, offset + 500);
        loaded.push(...messageRows(db.prepare(`
          select position, data from orkestr_thread_messages
          where rowid in (${chunk.map(() => "?").join(",")})
        `).all(...chunk)));
      }
      return loaded;
    },
  };
}

// Runs a synchronous reader inside one read transaction so every query sees the same snapshot.
// Returns null when the thread message store is not sqlite.
export async function readThreadMessageStore(threadId, read, env = process.env) {
  const db = await threadMessageStoreDatabase(threadId, env);
  if (!db) return null;
  db.exec("begin");
  try {
    return read(storeSnapshot(db, threadId, env));
  } finally {
    db.exec("commit");
  }
}
