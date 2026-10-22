-- Conversation posts: assistant-side messages from outside a run (an external
-- coordinator session or operator alert tooling). A post never creates an
-- input, never wakes or steers a provider and never starts execution. The UI
-- shows it after the conversation event at `after_sequence`; the WhatsApp
-- delivery adapter exports it once and marks it delivered. 0064 precedes it.
CREATE TABLE conversation_posts (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 owner_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 request_key TEXT NOT NULL CHECK(length(request_key) BETWEEN 1 AND 128),
 author TEXT NOT NULL CHECK(author IN ('coordinator','operator')),
 label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 40),
 provider TEXT CHECK(provider IS NULL OR length(provider) BETWEEN 1 AND 64),
 model TEXT CHECK(model IS NULL OR length(model) BETWEEN 1 AND 64),
 text TEXT NOT NULL CHECK(length(CAST(text AS BLOB)) BETWEEN 1 AND 16000),
 after_sequence INTEGER NOT NULL CHECK(after_sequence >= 0),
 created_ms INTEGER NOT NULL,
 delivered_ms INTEGER,
 UNIQUE(owner_id,conversation_id,request_key),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
CREATE INDEX conversation_posts_pending ON conversation_posts(owner_id,conversation_id,delivered_ms,created_ms);
CREATE INDEX conversation_posts_recent ON conversation_posts(owner_id,conversation_id,created_ms);
CREATE TRIGGER conversation_posts_fixed BEFORE UPDATE ON conversation_posts
 WHEN NEW.id<>OLD.id OR NEW.owner_id<>OLD.owner_id OR NEW.conversation_id<>OLD.conversation_id
  OR NEW.request_key<>OLD.request_key OR NEW.author<>OLD.author OR NEW.label<>OLD.label
  OR NEW.provider IS NOT OLD.provider OR NEW.model IS NOT OLD.model OR NEW.text<>OLD.text
  OR NEW.after_sequence<>OLD.after_sequence OR NEW.created_ms<>OLD.created_ms
  OR (OLD.delivered_ms IS NOT NULL AND NEW.delivered_ms IS NOT OLD.delivered_ms)
BEGIN SELECT RAISE(ABORT,'conversation post identity is fixed'); END;
