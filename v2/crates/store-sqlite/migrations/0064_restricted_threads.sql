-- Restricted threads: a conversation whose model (self-hosted, OpenAI-compatible) has no
-- direct access to anything. Every action it asks for goes through the broker, is decided
-- against this per-thread policy and is audited here. 0062 (reply-to) and 0063 (calendar timers) precede it.
CREATE TABLE restricted_threads (
 conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
 owner_id TEXT NOT NULL REFERENCES owners(id),
 provider_kind TEXT NOT NULL DEFAULT 'openai_compatible_restricted' CHECK(provider_kind='openai_compatible_restricted'),
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 revision INTEGER NOT NULL CHECK(revision >= 1),
 policy_json TEXT NOT NULL CHECK(length(policy_json) <= 16384),
 -- Session-scoped approvals live and die with this id; resetting it revokes them all.
 session_id TEXT NOT NULL,
 -- Highest owner message sequence the runner has taken; inflight is set while it runs.
 cursor_sequence INTEGER NOT NULL DEFAULT 0 CHECK(cursor_sequence >= 0),
 inflight_sequence INTEGER,
 -- Owner input only (never model or tool traffic): the GPU idle timer may read this.
 last_owner_input_ms INTEGER,
 updated_at_ms INTEGER NOT NULL
);
CREATE INDEX restricted_threads_enabled ON restricted_threads(enabled) WHERE enabled = 1;

CREATE TABLE restricted_messages (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 conversation_id TEXT NOT NULL REFERENCES restricted_threads(conversation_id),
 session_id TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('user','assistant','tool','notice')),
 content TEXT CHECK(content IS NULL OR length(content) <= 262144),
 tool_calls_json TEXT CHECK(tool_calls_json IS NULL OR length(tool_calls_json) <= 262144),
 tool_call_id TEXT,
 source_sequence INTEGER,
 created_at_ms INTEGER NOT NULL
);
CREATE INDEX restricted_messages_thread ON restricted_messages(conversation_id, id);

-- Append-only audit: one row per model request. The decision starts as 'ask' when the
-- owner must decide and is settled exactly once; the result is written exactly once.
CREATE TABLE restricted_audit (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 conversation_id TEXT NOT NULL REFERENCES restricted_threads(conversation_id),
 session_id TEXT NOT NULL,
 at_ms INTEGER NOT NULL,
 action TEXT NOT NULL CHECK(length(action) <= 64),
 request_json TEXT NOT NULL CHECK(length(request_json) <= 16384),
 decision TEXT NOT NULL CHECK(decision IN ('allow','ask','deny')),
 decider TEXT NOT NULL CHECK(decider IN ('policy','owner','session_grant','timeout','system')),
 reason TEXT CHECK(reason IS NULL OR length(reason) <= 1024),
 approval_id TEXT,
 outcome TEXT CHECK(outcome IS NULL OR outcome IN ('ok','error','denied')),
 result_summary TEXT CHECK(result_summary IS NULL OR length(result_summary) <= 4096),
 finished_at_ms INTEGER
);
CREATE INDEX restricted_audit_thread ON restricted_audit(conversation_id, id);
CREATE TRIGGER restricted_audit_no_delete BEFORE DELETE ON restricted_audit
BEGIN SELECT RAISE(ABORT,'restricted audit is append-only'); END;
CREATE TRIGGER restricted_audit_guard BEFORE UPDATE ON restricted_audit
WHEN NEW.id IS NOT OLD.id OR NEW.conversation_id IS NOT OLD.conversation_id
  OR NEW.session_id IS NOT OLD.session_id OR NEW.at_ms IS NOT OLD.at_ms
  OR NEW.action IS NOT OLD.action OR NEW.request_json IS NOT OLD.request_json
  OR (OLD.decision <> 'ask' AND (NEW.decision IS NOT OLD.decision OR NEW.decider IS NOT OLD.decider
      OR NEW.reason IS NOT OLD.reason OR NEW.approval_id IS NOT OLD.approval_id))
  OR (OLD.outcome IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'restricted audit rows are immutable once settled'); END;

CREATE TABLE restricted_approvals (
 id TEXT PRIMARY KEY,
 conversation_id TEXT NOT NULL REFERENCES restricted_threads(conversation_id),
 session_id TEXT NOT NULL,
 audit_id INTEGER NOT NULL REFERENCES restricted_audit(id),
 action TEXT NOT NULL CHECK(length(action) <= 64),
 summary TEXT NOT NULL CHECK(length(summary) <= 2048),
 grant_key TEXT CHECK(grant_key IS NULL OR length(grant_key) <= 1024),
 state TEXT NOT NULL CHECK(state IN ('pending','approved','denied','expired')),
 scope TEXT CHECK(scope IS NULL OR scope IN ('once','session')),
 created_at_ms INTEGER NOT NULL,
 expires_at_ms INTEGER NOT NULL,
 decided_at_ms INTEGER
);
CREATE INDEX restricted_approvals_thread ON restricted_approvals(conversation_id, state, created_at_ms);

CREATE TABLE restricted_grants (
 conversation_id TEXT NOT NULL REFERENCES restricted_threads(conversation_id),
 session_id TEXT NOT NULL,
 grant_key TEXT NOT NULL CHECK(length(grant_key) <= 1024),
 created_at_ms INTEGER NOT NULL,
 expires_at_ms INTEGER NOT NULL,
 PRIMARY KEY(conversation_id, session_id, grant_key)
);
