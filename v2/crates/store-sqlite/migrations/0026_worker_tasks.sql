-- Owner-authored task intent is separate from provider dispatch authority.
CREATE TABLE worker_tasks (
 ordinal INTEGER PRIMARY KEY AUTOINCREMENT,
 id TEXT NOT NULL UNIQUE,
 owner_id TEXT NOT NULL REFERENCES owners(id),
 conversation_id TEXT NOT NULL,
 parent_run_id TEXT NOT NULL REFERENCES production_runs(id),
 context_id TEXT NOT NULL REFERENCES production_supervisors(context_id),
 incarnation_id TEXT NOT NULL,
 parent_control_revision INTEGER NOT NULL CHECK(parent_control_revision>0),
 source_message_id TEXT NOT NULL REFERENCES messages(id),
 source_event_id TEXT NOT NULL REFERENCES events(id),
 request_key TEXT NOT NULL CHECK(length(CAST(request_key AS BLOB)) BETWEEN 1 AND 128),
 request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
 lifetime_ms INTEGER NOT NULL CHECK(lifetime_ms BETWEEN 1 AND 30000),
 created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
 state TEXT NOT NULL CHECK(state IN ('queued','claimed','delegated','held')),
 claim_hash TEXT,
 delegation_id TEXT UNIQUE REFERENCES worker_provider_delegations(id),
 UNIQUE(owner_id,parent_run_id,request_key),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id),
 CHECK((state='queued' AND claim_hash IS NULL AND delegation_id IS NULL)
    OR (state='claimed' AND claim_hash IS NOT NULL AND length(claim_hash)=64 AND delegation_id IS NULL)
    OR (state='delegated' AND claim_hash IS NULL AND delegation_id IS NOT NULL)
    OR (state='held' AND claim_hash IS NULL))
);
CREATE INDEX worker_tasks_parent_queue ON worker_tasks(parent_run_id,state,ordinal);
CREATE TABLE worker_task_payloads (
 task_id TEXT PRIMARY KEY REFERENCES worker_tasks(id),
 title TEXT NOT NULL CHECK(length(CAST(title AS BLOB)) BETWEEN 1 AND 160),
 instructions TEXT NOT NULL CHECK(length(CAST(instructions AS BLOB)) BETWEEN 1 AND 16384)
);
