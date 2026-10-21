-- "New WhatsApp chat" from the Rust UI: one durable, resumable record per
-- owner request. Each row links a native conversation to the V1 group thread
-- and adapter route created for it. Identity is fixed at insert; stages only
-- move forward; rows are retained. Nothing here admits input or runs work.
CREATE TABLE whatsapp_chat_provisions (
 owner_id TEXT NOT NULL,
 request_key TEXT NOT NULL CHECK(length(request_key)=36),
 conversation_id TEXT NOT NULL,
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 100),
 v1_thread_id TEXT NOT NULL CHECK(length(v1_thread_id) BETWEEN 1 AND 200),
 remote_thread_id TEXT NOT NULL CHECK(length(remote_thread_id)=36),
 workspace TEXT CHECK(workspace IS NULL OR length(workspace) BETWEEN 1 AND 512),
 chat_id TEXT CHECK(chat_id IS NULL OR length(chat_id) BETWEEN 1 AND 256),
 -- 0 conversation, 1 settings, 2 V1 thread, 3 group, 4 adapter binding,
 -- 5 V1 delegated binding (waiting for relay registration), 6 ready.
 stage INTEGER NOT NULL CHECK(stage BETWEEN 0 AND 6),
 last_error TEXT CHECK(last_error IS NULL OR length(last_error) BETWEEN 1 AND 64),
 archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
 created_at_ms INTEGER NOT NULL,
 updated_at_ms INTEGER NOT NULL,
 PRIMARY KEY(owner_id,request_key),
 UNIQUE(owner_id,conversation_id),
 UNIQUE(v1_thread_id),
 UNIQUE(remote_thread_id),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
CREATE TRIGGER whatsapp_chat_provisions_fixed BEFORE UPDATE ON whatsapp_chat_provisions
 WHEN NEW.owner_id<>OLD.owner_id OR NEW.request_key<>OLD.request_key
  OR NEW.conversation_id<>OLD.conversation_id OR NEW.name<>OLD.name
  OR NEW.v1_thread_id<>OLD.v1_thread_id OR NEW.remote_thread_id<>OLD.remote_thread_id
  OR NEW.workspace IS NOT OLD.workspace OR NEW.stage<OLD.stage OR NEW.archived<OLD.archived
  OR (OLD.chat_id IS NOT NULL AND NEW.chat_id IS NOT OLD.chat_id)
BEGIN SELECT RAISE(ABORT,'provision identity is fixed and only moves forward'); END;
CREATE TRIGGER whatsapp_chat_provisions_retained BEFORE DELETE ON whatsapp_chat_provisions
BEGIN SELECT RAISE(ABORT,'whatsapp chat provisions are retained'); END;
