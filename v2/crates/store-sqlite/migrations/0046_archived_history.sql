-- Archived legacy history attached to a native conversation. Display-only
-- provenance: no references from messages, events, inbox, outbox or runs, so
-- imported rows can never be admitted, replayed or dispatched.
CREATE TABLE archived_history_sources (
 row_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 owner_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 source_instance TEXT NOT NULL,
 source_thread_id TEXT NOT NULL,
 last_snapshot_id TEXT NOT NULL,
 cursor INTEGER NOT NULL DEFAULT 0 CHECK(cursor >= 0),
 message_count INTEGER NOT NULL DEFAULT 0 CHECK(message_count >= 0),
 checksum TEXT NOT NULL DEFAULT '',
 UNIQUE(owner_id,conversation_id,source_instance,source_thread_id),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
CREATE TABLE archived_history_messages (
 archive_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 source_row INTEGER NOT NULL REFERENCES archived_history_sources(row_sequence),
 source_message_id TEXT NOT NULL,
 source_position INTEGER NOT NULL CHECK(source_position > 0),
 source_cursor INTEGER NOT NULL CHECK(source_cursor >= 0),
 role TEXT NOT NULL,
 phase TEXT,
 state TEXT,
 source_kind TEXT,
 created_at TEXT,
 updated_at TEXT,
 text TEXT NOT NULL,
 attachments TEXT NOT NULL,
 content_digest TEXT NOT NULL,
 snapshot_id TEXT NOT NULL,
 imported_at INTEGER NOT NULL DEFAULT (unixepoch()),
 UNIQUE(source_row,source_message_id),
 UNIQUE(source_row,source_position)
);
CREATE TABLE archived_history_quarantine (
 row_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 source_row INTEGER NOT NULL REFERENCES archived_history_sources(row_sequence),
 source_message_id TEXT NOT NULL,
 source_position INTEGER NOT NULL,
 reason TEXT NOT NULL CHECK(reason IN ('content_changed','position_conflict','out_of_order')),
 content_digest TEXT NOT NULL,
 payload TEXT NOT NULL,
 snapshot_id TEXT NOT NULL,
 quarantined_at INTEGER NOT NULL DEFAULT (unixepoch()),
 UNIQUE(source_row,source_message_id,content_digest,reason)
);
CREATE TRIGGER archived_history_messages_immutable BEFORE UPDATE ON archived_history_messages
BEGIN SELECT RAISE(ABORT,'archived history is append-only'); END;
CREATE TRIGGER archived_history_messages_retained BEFORE DELETE ON archived_history_messages
BEGIN SELECT RAISE(ABORT,'archived history is append-only'); END;
CREATE TRIGGER archived_history_quarantine_immutable BEFORE UPDATE ON archived_history_quarantine
BEGIN SELECT RAISE(ABORT,'archived quarantine is append-only'); END;
