-- Root-observed source is evidence, never a bearer. Core additionally requires
-- the consumed canonical Deep dispatch and current protected window authority.
CREATE TABLE managed_operations (
 id TEXT PRIMARY KEY NOT NULL,
 owner_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 window_id TEXT NOT NULL REFERENCES execution_windows(id),
 run_id TEXT NOT NULL REFERENCES production_runs(id),
 session_id TEXT NOT NULL,
 context_id TEXT NOT NULL,
 incarnation_id TEXT NOT NULL,
 binding_generation INTEGER NOT NULL,
 lease_generation INTEGER NOT NULL,
 dispatch_fence INTEGER NOT NULL,
 evidence_sha256 TEXT NOT NULL,
 operation TEXT NOT NULL CHECK(operation IN ('desk_login','root_request_submit')),
 request_json TEXT NOT NULL,
 expires_at_ms INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('delivery_unknown','helper_completed','submitted','failed','cancelled')),
 created_at_ms INTEGER NOT NULL
);
CREATE INDEX managed_operations_window ON managed_operations(window_id);
