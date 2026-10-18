-- Offline subordinate tool authority; never a provider-role admission.
CREATE TABLE worker_tool_delegations (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES owners(id),
 conversation_id TEXT NOT NULL,
 parent_run_id TEXT NOT NULL REFERENCES production_runs(id),
 parent_session_id TEXT NOT NULL,
 context_id TEXT NOT NULL REFERENCES production_supervisors(context_id),
 -- Historical incarnations survive supervisor takeover.
 incarnation_id TEXT NOT NULL,
 parent_binding_generation INTEGER NOT NULL CHECK(parent_binding_generation>0),
 parent_lease_generation INTEGER NOT NULL CHECK(parent_lease_generation>0),
 parent_dispatch_fence INTEGER NOT NULL CHECK(parent_dispatch_fence>0),
 parent_deadline_ms INTEGER NOT NULL,
 operation TEXT NOT NULL CHECK(operation='python_offline_v1'),
 request_key TEXT NOT NULL,
 source_digest TEXT NOT NULL CHECK(length(source_digest)=64 AND source_digest NOT GLOB '*[^0-9a-f]*'),
 source_text TEXT NOT NULL CHECK(length(CAST(source_text AS BLOB))<=65536),
 requested_lifetime_ms INTEGER NOT NULL CHECK(requested_lifetime_ms BETWEEN 1 AND 30000),
 expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms<=parent_deadline_ms),
 state TEXT NOT NULL CHECK(state IN ('delegated','delivery_unknown','completed','failed','cancelled','blocked')),
 revision INTEGER NOT NULL CHECK(revision>0),
 grant_hash TEXT,
 outcome_digest TEXT CHECK(outcome_digest IS NULL OR (length(outcome_digest)=64 AND outcome_digest NOT GLOB '*[^0-9a-f]*')),
 UNIQUE(owner_id,parent_run_id,request_key),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id),
 FOREIGN KEY(parent_session_id,owner_id,conversation_id) REFERENCES session_bindings(id,owner_id,conversation_id),
 CHECK((state='delegated' AND grant_hash IS NOT NULL) OR (state!='delegated' AND grant_hash IS NULL))
);
