-- Root manager is the ONLY attempt/byte reserve-before-forward ledger.
-- These rows authorize a finite window and its exact ordinary input associations.
CREATE TABLE execution_windows (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES owners(id),
 conversation_id TEXT NOT NULL,
 generation INTEGER NOT NULL CHECK(generation>0),
 state TEXT NOT NULL CHECK(state IN ('opening','active','retiring','closed','reconciliation_required')),
 input_message_id TEXT NOT NULL REFERENCES messages(id),
 input_event_id TEXT NOT NULL REFERENCES events(id),
 predecessor_window_id TEXT REFERENCES execution_windows(id),
 opened_at_ms INTEGER NOT NULL,
 work_deadline_ms INTEGER NOT NULL,
 expires_at_ms INTEGER NOT NULL,
 boot_id TEXT,
 manager_ack_hash TEXT,
 context_id TEXT REFERENCES production_supervisors(context_id),
 incarnation_id TEXT,
 credential_hash TEXT UNIQUE,
 credential_expires_at INTEGER,
 credential_bound INTEGER NOT NULL DEFAULT 0 CHECK(credential_bound IN (0,1)),
 credential_issued INTEGER NOT NULL DEFAULT 0 CHECK(credential_issued IN (0,1)),
 terminal_run_id TEXT REFERENCES production_runs(id),
 CHECK(work_deadline_ms=opened_at_ms+870000),
 CHECK(expires_at_ms=opened_at_ms+900000),
 UNIQUE(owner_id,conversation_id,generation),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
CREATE UNIQUE INDEX execution_window_unresolved ON execution_windows(owner_id,conversation_id)
 WHERE state!='closed';
CREATE TABLE execution_window_inputs (
 owner_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 request_key TEXT NOT NULL,
 semantic_digest TEXT NOT NULL,
 window_id TEXT NOT NULL REFERENCES execution_windows(id),
 message_id TEXT NOT NULL REFERENCES messages(id),
 event_id TEXT NOT NULL UNIQUE REFERENCES events(id),
 input_request_key TEXT NOT NULL,
 receipt_json TEXT NOT NULL,
 PRIMARY KEY(owner_id,conversation_id,request_key),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
