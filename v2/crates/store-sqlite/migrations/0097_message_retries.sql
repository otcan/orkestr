-- A re-admitted owner input names the attempt it replaces (ORK-780). The
-- delivery adapter retires an attempt whose window never ran it, then admits
-- the same input again under fresh keys; this link lets every message list
-- show one message for the input. Messages stay append-only: the link never
-- rewrites either row. Additive only: no existing table, row, index or
-- trigger changes.
CREATE TABLE message_retries (
 message_id TEXT PRIMARY KEY REFERENCES messages(id),
 retry_of TEXT NOT NULL UNIQUE REFERENCES messages(id),
 owner_id TEXT NOT NULL REFERENCES owners(id),
 conversation_id TEXT NOT NULL,
 created_at_ms INTEGER NOT NULL,
 CHECK(message_id<>retry_of),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
CREATE TRIGGER message_retries_no_update BEFORE UPDATE ON message_retries
BEGIN SELECT RAISE(ABORT,'message retry link is immutable'); END;
CREATE TRIGGER message_retries_no_delete BEFORE DELETE ON message_retries
BEGIN SELECT RAISE(ABORT,'message retry link is immutable'); END;
