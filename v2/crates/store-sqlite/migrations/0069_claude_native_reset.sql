-- Explicit owner choices replace native continuity, never conversation history.
CREATE TABLE conversation_native_resets (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES owners(id),
 conversation_id TEXT NOT NULL,
 request_key TEXT NOT NULL,
 semantic_digest TEXT NOT NULL,
 window_id TEXT NOT NULL REFERENCES execution_windows(id),
 window_generation INTEGER NOT NULL CHECK(window_generation>0),
 reset_at_ms INTEGER NOT NULL,
 receipt_json TEXT NOT NULL,
 UNIQUE(owner_id,conversation_id,request_key),
 UNIQUE(window_id),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);

-- Failed resume setup may have reserved (but never observed) a Claude UUID.
-- Preserve that evidence before allowing a later setup at the same generation.
CREATE TABLE execution_window_failed_native_requests (
 failure_id TEXT NOT NULL REFERENCES execution_window_open_failures(id),
 session_id TEXT NOT NULL REFERENCES session_bindings(id),
 binding_generation INTEGER NOT NULL,
 context_id TEXT NOT NULL,
 incarnation_id TEXT NOT NULL,
 requested_native_id TEXT NOT NULL,
 initialization_key TEXT NOT NULL,
 PRIMARY KEY(failure_id,session_id,binding_generation)
);
