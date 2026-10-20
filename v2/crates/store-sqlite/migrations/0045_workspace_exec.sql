-- Explicit trusted workspace-execution opt-in, separate from offline Python.
CREATE TABLE workspace_exec_profiles (
 project_id TEXT PRIMARY KEY REFERENCES workspace_projects(id),
 owner_id TEXT NOT NULL REFERENCES owners(id),
 conversation_id TEXT NOT NULL,
 project_generation INTEGER NOT NULL CHECK(project_generation>0),
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
-- Workspace command delegation; never a provider-role admission.
CREATE TABLE workspace_exec_delegations (
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
 project_id TEXT NOT NULL REFERENCES workspace_projects(id),
 project_generation INTEGER NOT NULL CHECK(project_generation>0),
 operation TEXT NOT NULL CHECK(operation='workspace_exec_v1'),
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

-- Native correlation is input. Only private, current-authenticated handles can
-- consume launch or result authority; historical rows never reissue either.
CREATE TABLE workspace_exec_results (
 delegation_id TEXT PRIMARY KEY REFERENCES workspace_exec_delegations(id),
 parent_run_id TEXT NOT NULL REFERENCES production_runs(id),
 request_kind TEXT NOT NULL CHECK(request_kind IN ('text','integer')),
 request_id TEXT NOT NULL CHECK(length(CAST(request_id AS BLOB)) BETWEEN 1 AND 128),
 call_id TEXT NOT NULL CHECK(length(CAST(call_id AS BLOB)) BETWEEN 1 AND 128),
 native_thread TEXT NOT NULL CHECK(length(CAST(native_thread AS BLOB)) BETWEEN 1 AND 512),
 native_turn TEXT NOT NULL CHECK(length(CAST(native_turn AS BLOB)) BETWEEN 1 AND 512),
 call_digest TEXT NOT NULL CHECK(length(call_digest)=64 AND call_digest NOT GLOB '*[^0-9a-f]*'),
 state TEXT NOT NULL CHECK(state IN ('bound','prepared','delivery_unknown','delivered')),
 output_digest TEXT,
 response_text TEXT,
 response_digest TEXT,
 success INTEGER CHECK(success IS NULL OR success IN (0,1)),
 grant_hash TEXT,
 delivery_hash TEXT,
 written_bytes INTEGER NOT NULL DEFAULT 0 CHECK(written_bytes BETWEEN 0 AND 65536),
 CHECK(output_digest IS NULL OR (length(output_digest)=64 AND output_digest NOT GLOB '*[^0-9a-f]*')),
 CHECK(response_digest IS NULL OR (length(response_digest)=64 AND response_digest NOT GLOB '*[^0-9a-f]*')),
 CHECK(response_text IS NULL OR length(CAST(response_text AS BLOB))<=8192),
 CHECK((state='bound' AND output_digest IS NULL AND response_text IS NULL AND response_digest IS NULL AND success IS NULL AND grant_hash IS NULL AND delivery_hash IS NULL)
    OR (state='prepared' AND output_digest IS NOT NULL AND response_text IS NOT NULL AND response_digest IS NOT NULL AND success IS NOT NULL AND grant_hash IS NOT NULL AND delivery_hash IS NULL)
    OR (state IN ('delivery_unknown','delivered') AND output_digest IS NOT NULL AND response_text IS NOT NULL AND response_digest IS NOT NULL AND success IS NOT NULL AND grant_hash IS NULL AND delivery_hash IS NOT NULL)),
 UNIQUE(parent_run_id,native_thread,native_turn,request_kind,request_id),
 UNIQUE(parent_run_id,native_thread,native_turn,call_id)
);
