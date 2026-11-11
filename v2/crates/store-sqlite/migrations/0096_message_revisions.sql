-- An owner's edit or removal of their own earlier message. Messages stay
-- append-only: a revision references the original and never rewrites it, and
-- the agent is told through its own notice row in the ordinary input queue.
-- Additive only: no existing table, row, index or trigger changes.
CREATE TABLE message_revisions (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES owners(id),
 conversation_id TEXT NOT NULL,
 target_message_id TEXT NOT NULL REFERENCES messages(id),
 revision INTEGER NOT NULL CHECK(revision>=1),
 kind TEXT NOT NULL CHECK(kind IN ('edit','delete')),
 text TEXT CHECK((kind='edit' AND text IS NOT NULL AND length(text)>0) OR (kind='delete' AND text IS NULL)),
 source TEXT NOT NULL CHECK(source IN ('web','whatsapp')),
 request_key TEXT NOT NULL,
 payload_digest TEXT NOT NULL,
 notice_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
 -- 1: changes one source message merged into this one. It tells the agent but
 -- cannot be shown over the merged text, so it is audit and notice only.
 part INTEGER NOT NULL DEFAULT 0 CHECK(part IN (0,1)),
 -- 1: the notice is a live input the agent will receive.
 agent_notified INTEGER NOT NULL CHECK(agent_notified IN (0,1)),
 -- 0: the agent never received any earlier text of this message.
 agent_saw_earlier_text INTEGER NOT NULL CHECK(agent_saw_earlier_text IN (0,1)),
 credential_hash TEXT NOT NULL,
 session_kind TEXT NOT NULL,
 created_at_ms INTEGER NOT NULL,
 receipt_json TEXT NOT NULL,
 UNIQUE(target_message_id,revision),
 UNIQUE(owner_id,conversation_id,request_key),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
CREATE TRIGGER message_revisions_no_update BEFORE UPDATE ON message_revisions
BEGIN SELECT RAISE(ABORT,'message revision is immutable'); END;
CREATE TRIGGER message_revisions_no_delete BEFORE DELETE ON message_revisions
BEGIN SELECT RAISE(ABORT,'message revision is immutable'); END;
