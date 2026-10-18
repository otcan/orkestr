import { openAgentJobDb, tx } from "./agent-job-store.js";
import { personalAgentFeature } from "./personal-agent-feature.js";
import { memoryError, memoryId } from "./personal-agent-memory-rules.js";
import { createPersonalAgentMemoryService } from "./personal-agent-memory-service.js";

const columns = ["id", "idempotency_key", "category", "scope_kind", "scope_id", "content_json", "provenance_json", "source_event_id", "source_cursor", "consented_by", "consented_at", "created_at", "updated_at"];

// Internal single-owner binding. Only Agent Job's initializer owns migrations;
// no alternate database, table creation, or in-memory fallback lives here.
export async function openPersonalAgentMemoryStore({ ownerUserId, env = process.env }) {
  const enabled = () => { if (!personalAgentFeature(env)) throw memoryError("personal_agent_disabled", 404); };
  enabled();
  memoryId(ownerUserId);
  let db, statements;
  try {
    db = await openAgentJobDb(env);
    statements = {
      get: db.prepare("select * from personal_agent_memories where id = ?"),
      find: db.prepare("select * from personal_agent_memories where idempotency_key = ?"),
      // One extra row makes the service's explicit 5,000-record limit bounded.
      list: db.prepare("select * from personal_agent_memories order by id limit 5001"),
      insert: db.prepare(`insert into personal_agent_memories (${columns.join(",")}) values (${columns.map(() => "?").join(",")})`),
      replace: db.prepare(`update personal_agent_memories set ${columns.filter(key => key !== "id").map(key => `${key} = ?`).join(",")} where id = ?`),
      delete: db.prepare("delete from personal_agent_memories where id = ?"),
      project: db.prepare("select id from personal_agent_projects where id = ?"),
      task: db.prepare("select project_id from personal_agent_tasks where id = ?"),
    };
  } catch { throw memoryError("memory_store_unavailable", 503); }
  return Object.freeze({
    ownerUserId,
    transaction(fn) {
      enabled();
      if (typeof fn !== "function" || fn.constructor?.name === "AsyncFunction") throw memoryError("memory_store_must_be_synchronous", 503);
      return tx(db, () => {
        let active = true;
        const call = operation => {
          if (!active) throw memoryError("memory_transaction_closed", 503);
          try { return operation(); }
          catch { throw memoryError("memory_storage_failure", 503); }
        };
        const api = Object.freeze({
          get: id => call(() => statements.get.get(id) || null),
          findByIdempotencyKey: key => call(() => statements.find.get(key) || null),
          list: () => call(() => statements.list.all()),
          insert: row => call(() => statements.insert.run(...columns.map(key => row[key]))),
          replace: (id, row) => call(() => {
            if (row.id !== id || statements.replace.run(...columns.filter(key => key !== "id").map(key => row[key]), id).changes !== 1) throw Error("missing");
          }),
          delete: id => call(() => { if (statements.delete.run(id).changes !== 1) throw Error("missing"); }),
          hasProject: id => call(() => Boolean(statements.project.get(id))),
          taskProjectId: id => call(() => statements.task.get(id)?.project_id || null),
        });
        try {
          const result = fn(api);
          if (result && typeof result.then === "function") {
            // A rejected accidental promise must not become an unhandled error.
            Promise.resolve(result).catch(() => {});
            throw memoryError("memory_store_must_be_synchronous", 503);
          }
          return result;
        } finally { active = false; }
      });
    },
  });
}

export async function openPersonalAgentMemoryService({ ownerUserId, env = process.env, now, newId }) {
  const store = await openPersonalAgentMemoryStore({ ownerUserId, env });
  return createPersonalAgentMemoryService({ store, ownerUserId, env, now, newId });
}
