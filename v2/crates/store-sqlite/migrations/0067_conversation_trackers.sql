-- Structured per-conversation tracker (job-tracking recipe): one tracker per
-- conversation, application rows, an append-only event timeline, canonical
-- job links per row (URL dedupe), a processed-message ledger (idempotent mail
-- intake), batch receipts (idempotent producer requests) and an optional
-- conversation-scoped grant for the assistant. No raw mail body is stored.
CREATE TABLE trackers (
 owner_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 recipe TEXT NOT NULL CHECK(length(recipe) BETWEEN 1 AND 80),
 notify_on_json TEXT NOT NULL DEFAULT '[]' CHECK(length(notify_on_json)<=2000),
 grant_hash TEXT,
 grant_generation INTEGER NOT NULL DEFAULT 0 CHECK(grant_generation>=0),
 source_json TEXT CHECK(source_json IS NULL OR length(source_json)<=16000),
 cursor_json TEXT CHECK(cursor_json IS NULL OR length(cursor_json)<=8000000),
 last_scan_ms INTEGER,
 last_scan_json TEXT CHECK(last_scan_json IS NULL OR length(last_scan_json)<=16000),
 created_ms INTEGER NOT NULL,
 updated_ms INTEGER NOT NULL,
 PRIMARY KEY(owner_id,conversation_id),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
CREATE UNIQUE INDEX trackers_grant ON trackers(grant_hash) WHERE grant_hash IS NOT NULL;
CREATE TABLE tracker_rows (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 owner_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 company TEXT NOT NULL CHECK(length(company) BETWEEN 1 AND 480),
 company_key TEXT NOT NULL,
 role TEXT NOT NULL DEFAULT '' CHECK(length(role)<=640),
 role_key TEXT NOT NULL DEFAULT '',
 source TEXT NOT NULL CHECK(length(source) BETWEEN 1 AND 40),
 status TEXT NOT NULL CHECK(status IN ('saved','applied','in_review','assessment','interview','offer','rejected','withdrawn','no_response')),
 status_changed_ms INTEGER NOT NULL,
 applied_ms INTEGER,
 last_contact_ms INTEGER NOT NULL,
 next_step TEXT CHECK(next_step IS NULL OR length(next_step)<=800),
 link TEXT CHECK(link IS NULL OR length(link)<=2048),
 location TEXT CHECK(location IS NULL OR length(location)<=480),
 notes TEXT NOT NULL DEFAULT '' CHECK(length(CAST(notes AS BLOB))<=16000),
 confidence INTEGER NOT NULL CHECK(confidence BETWEEN 0 AND 100),
 needs_review INTEGER NOT NULL CHECK(needs_review IN (0,1)),
 archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
 events_count INTEGER NOT NULL DEFAULT 0 CHECK(events_count>=0),
 revision INTEGER NOT NULL CHECK(revision>0),
 created_ms INTEGER NOT NULL,
 updated_ms INTEGER NOT NULL,
 FOREIGN KEY(owner_id,conversation_id) REFERENCES trackers(owner_id,conversation_id)
);
CREATE INDEX tracker_rows_keys ON tracker_rows(owner_id,conversation_id,company_key,role_key);
CREATE INDEX tracker_rows_recent ON tracker_rows(owner_id,conversation_id,last_contact_ms);
CREATE TABLE tracker_row_links (
 owner_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 link TEXT NOT NULL CHECK(length(link) BETWEEN 1 AND 2048),
 row_id TEXT NOT NULL REFERENCES tracker_rows(id),
 PRIMARY KEY(owner_id,conversation_id,link)
);
CREATE INDEX tracker_row_links_row ON tracker_row_links(row_id);
CREATE TABLE tracker_events (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 owner_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 row_id TEXT NOT NULL REFERENCES tracker_rows(id),
 kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 40),
 occurred_ms INTEGER NOT NULL,
 source TEXT NOT NULL,
 message_ref TEXT CHECK(message_ref IS NULL OR length(message_ref)=24),
 sender_domain TEXT,
 evidence TEXT CHECK(evidence IS NULL OR length(evidence)<=800),
 classifier TEXT NOT NULL CHECK(length(classifier) BETWEEN 1 AND 80),
 confidence INTEGER NOT NULL CHECK(confidence BETWEEN 0 AND 100),
 recorded_ms INTEGER NOT NULL
);
CREATE INDEX tracker_events_row ON tracker_events(row_id,occurred_ms);
CREATE TRIGGER tracker_events_append_only BEFORE UPDATE ON tracker_events
 WHEN NEW.id<>OLD.id OR NEW.kind<>OLD.kind OR NEW.occurred_ms<>OLD.occurred_ms
  OR NEW.message_ref IS NOT OLD.message_ref OR NEW.evidence IS NOT OLD.evidence
  OR NEW.classifier<>OLD.classifier OR NEW.confidence<>OLD.confidence
BEGIN SELECT RAISE(ABORT,'tracker events are append-only'); END;
CREATE TABLE tracker_ledger (
 owner_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 message_ref TEXT NOT NULL CHECK(length(message_ref)=24),
 outcome TEXT NOT NULL CHECK(length(outcome) BETWEEN 1 AND 80),
 recorded_ms INTEGER NOT NULL,
 PRIMARY KEY(owner_id,conversation_id,message_ref),
 FOREIGN KEY(owner_id,conversation_id) REFERENCES trackers(owner_id,conversation_id)
);
CREATE TABLE tracker_batches (
 owner_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 request_key TEXT NOT NULL CHECK(length(request_key) BETWEEN 1 AND 128),
 digest TEXT NOT NULL,
 changes_json TEXT NOT NULL,
 created_ms INTEGER NOT NULL,
 PRIMARY KEY(owner_id,conversation_id,request_key),
 FOREIGN KEY(owner_id,conversation_id) REFERENCES trackers(owner_id,conversation_id)
);
-- Hashed Message-IDs of recorded mail per row: a reply in the thread of a
-- known application or lead (In-Reply-To / References) attaches to its row.
CREATE TABLE tracker_messages (
 owner_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 message_ref TEXT NOT NULL CHECK(length(message_ref)=24),
 row_id TEXT NOT NULL REFERENCES tracker_rows(id),
 PRIMARY KEY(owner_id,conversation_id,message_ref)
);
CREATE INDEX tracker_messages_row ON tracker_messages(row_id);
