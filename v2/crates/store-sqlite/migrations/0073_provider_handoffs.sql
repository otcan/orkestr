-- Owner-approved provider change: fresh native identity, retained context.
-- No execution authority, input admission, delivery or replay is granted here.
CREATE TABLE conversation_provider_handoffs (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES owners(id),
 conversation_id TEXT NOT NULL,
 request_key TEXT NOT NULL,
 semantic_digest TEXT NOT NULL,
 window_id TEXT NOT NULL REFERENCES execution_windows(id),
 window_generation INTEGER NOT NULL CHECK(window_generation>0),
 from_provider TEXT NOT NULL CHECK(from_provider IN ('codex','claude')),
 to_provider TEXT NOT NULL CHECK(to_provider IN ('codex','claude')),
 settings_revision INTEGER NOT NULL CHECK(settings_revision>0),
 provider_generation INTEGER NOT NULL CHECK(provider_generation>0),
 history_summary TEXT NOT NULL CHECK(length(history_summary)>0),
 history_sha256 TEXT NOT NULL,
 created_at_ms INTEGER NOT NULL,
 receipt_json TEXT NOT NULL,
 UNIQUE(owner_id,conversation_id,request_key),
 UNIQUE(window_id),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
CREATE TRIGGER conversation_provider_handoffs_immutable
BEFORE UPDATE ON conversation_provider_handoffs BEGIN
 SELECT RAISE(ABORT,'immutable_provider_handoff');
END;
CREATE TRIGGER conversation_provider_handoffs_no_delete
BEFORE DELETE ON conversation_provider_handoffs BEGIN
 SELECT RAISE(ABORT,'immutable_provider_handoff');
END;

-- Bind the transferred context to the fresh sessions actually issued by Core.
CREATE TABLE conversation_handoff_sessions (
 session_id TEXT PRIMARY KEY REFERENCES session_bindings(id),
 handoff_id TEXT NOT NULL REFERENCES conversation_provider_handoffs(id)
);
CREATE TABLE conversation_handoff_context_delivery (
 session_id TEXT PRIMARY KEY REFERENCES conversation_handoff_sessions(session_id),
 handoff_id TEXT NOT NULL REFERENCES conversation_provider_handoffs(id),
 run_id TEXT UNIQUE NOT NULL REFERENCES production_runs(id),
 history_sha256 TEXT NOT NULL,
 consumed_at_ms INTEGER NOT NULL
);
