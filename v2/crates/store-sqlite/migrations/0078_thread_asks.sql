-- Scoped agent requests between conversations of one owner ("ask thread X").
-- Additive only: no existing input, run, window, grant or setting is rewritten.
-- A request's target input and its returned outcome are ordinary owner-scoped
-- messages; these rows add provenance, correlation and the exactly-once return.
CREATE TABLE thread_ask_grants (
 conversation_id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 -- NULL once revoked; the generation never decreases.
 grant_hash TEXT CHECK(grant_hash IS NULL OR (length(grant_hash)=64 AND grant_hash NOT GLOB '*[^0-9a-f]*')),
 generation INTEGER NOT NULL CHECK(generation>0),
 -- NULL: every other conversation of the same owner; else a JSON array of ids.
 targets_json TEXT CHECK(targets_json IS NULL OR json_valid(targets_json)),
 issued_ms INTEGER NOT NULL,
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
CREATE UNIQUE INDEX thread_ask_grant_hash ON thread_ask_grants(grant_hash) WHERE grant_hash IS NOT NULL;

CREATE TABLE thread_asks (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 owner_id TEXT NOT NULL,
 source_conversation_id TEXT NOT NULL,
 -- The asking conversation's Deep run that was running when it asked.
 source_run_id TEXT NOT NULL REFERENCES production_runs(id),
 grant_generation INTEGER NOT NULL CHECK(grant_generation>0),
 request_key TEXT NOT NULL CHECK(length(request_key) BETWEEN 1 AND 128),
 target_conversation_id TEXT NOT NULL,
 text_digest TEXT NOT NULL CHECK(length(text_digest)=64 AND text_digest NOT GLOB '*[^0-9a-f]*'),
 depth INTEGER NOT NULL CHECK(depth BETWEEN 0 AND 1),
 input_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
 input_event_id TEXT NOT NULL UNIQUE REFERENCES events(id),
 -- Set once by the trusted scheduler that queued the target's Deep turn.
 window_queued_ms INTEGER,
 created_ms INTEGER NOT NULL,
 outcome TEXT CHECK(outcome IS NULL OR outcome IN ('answered','failed')),
 outcome_detail TEXT CHECK(outcome_detail IS NULL OR length(outcome_detail) BETWEEN 1 AND 64),
 target_run_id TEXT REFERENCES production_runs(id),
 answer_text TEXT CHECK(answer_text IS NULL OR length(CAST(answer_text AS BLOB))<=8192),
 settled_ms INTEGER,
 return_path TEXT CHECK(return_path IS NULL OR return_path IN ('tool_result','input')),
 reply_message_id TEXT UNIQUE REFERENCES messages(id),
 reply_event_id TEXT UNIQUE REFERENCES events(id),
 returned_ms INTEGER,
 UNIQUE(owner_id,source_conversation_id,request_key),
 FOREIGN KEY(source_conversation_id,owner_id) REFERENCES conversations(id,owner_id),
 FOREIGN KEY(target_conversation_id,owner_id) REFERENCES conversations(id,owner_id),
 CHECK(source_conversation_id!=target_conversation_id),
 CHECK((outcome IS NULL)=(settled_ms IS NULL)),
 CHECK(outcome IS NOT NULL OR (outcome_detail IS NULL AND answer_text IS NULL)),
 CHECK(outcome!='answered' OR target_run_id IS NOT NULL),
 CHECK((return_path IS NULL)=(returned_ms IS NULL)),
 CHECK(return_path IS NULL OR outcome IS NOT NULL),
 CHECK((return_path IS 'input')=(reply_message_id IS NOT NULL)),
 CHECK((reply_message_id IS NULL)=(reply_event_id IS NULL))
);
CREATE INDEX thread_asks_open ON thread_asks(owner_id,return_path,created_ms);
CREATE INDEX thread_asks_target ON thread_asks(target_conversation_id,created_ms);
-- Identity, correlation and every settled decision are write-once.
CREATE TRIGGER thread_asks_fixed BEFORE UPDATE ON thread_asks
 WHEN NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id
  OR NEW.source_conversation_id<>OLD.source_conversation_id OR NEW.source_run_id<>OLD.source_run_id
  OR NEW.grant_generation<>OLD.grant_generation OR NEW.request_key<>OLD.request_key
  OR NEW.target_conversation_id<>OLD.target_conversation_id OR NEW.text_digest<>OLD.text_digest
  OR NEW.depth<>OLD.depth OR NEW.input_message_id<>OLD.input_message_id
  OR NEW.input_event_id<>OLD.input_event_id OR NEW.created_ms<>OLD.created_ms
  OR (OLD.window_queued_ms IS NOT NULL AND NEW.window_queued_ms IS NOT OLD.window_queued_ms)
  OR (OLD.outcome IS NOT NULL AND (NEW.outcome IS NOT OLD.outcome OR NEW.outcome_detail IS NOT OLD.outcome_detail
   OR NEW.target_run_id IS NOT OLD.target_run_id OR NEW.answer_text IS NOT OLD.answer_text
   OR NEW.settled_ms IS NOT OLD.settled_ms))
  OR (OLD.return_path IS NOT NULL AND (NEW.return_path IS NOT OLD.return_path
   OR NEW.reply_message_id IS NOT OLD.reply_message_id OR NEW.reply_event_id IS NOT OLD.reply_event_id
   OR NEW.returned_ms IS NOT OLD.returned_ms))
BEGIN SELECT RAISE(ABORT,'thread ask decision is fixed'); END;
CREATE TRIGGER thread_asks_no_delete BEFORE DELETE ON thread_asks
BEGIN SELECT RAISE(ABORT,'thread ask decision is fixed'); END;

-- Append-only audit of every authenticated attempt, including refusals.
-- The target is recorded as requested and may name no conversation of this owner.
CREATE TABLE thread_ask_audit (
 row_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 owner_id TEXT NOT NULL,
 source_conversation_id TEXT NOT NULL,
 source_run_id TEXT,
 grant_generation INTEGER NOT NULL,
 target_conversation_id TEXT NOT NULL CHECK(length(target_conversation_id)=36),
 request_key TEXT NOT NULL CHECK(length(request_key) BETWEEN 1 AND 128),
 text_digest TEXT NOT NULL CHECK(length(text_digest)=64 AND text_digest NOT GLOB '*[^0-9a-f]*'),
 ask_id TEXT,
 outcome TEXT NOT NULL CHECK(length(outcome) BETWEEN 1 AND 64),
 at_ms INTEGER NOT NULL,
 FOREIGN KEY(source_conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
CREATE INDEX thread_ask_audit_rate ON thread_ask_audit(source_conversation_id,outcome,at_ms);
CREATE TRIGGER thread_ask_audit_append_only BEFORE UPDATE ON thread_ask_audit
BEGIN SELECT RAISE(ABORT,'thread ask audit is append-only'); END;
CREATE TRIGGER thread_ask_audit_no_delete BEFORE DELETE ON thread_ask_audit
BEGIN SELECT RAISE(ABORT,'thread ask audit is append-only'); END;
