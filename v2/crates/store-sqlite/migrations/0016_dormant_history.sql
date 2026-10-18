-- Separate dormant ledger: no references into execution, intake or outbox.
CREATE TABLE history_imports (
 owner_id TEXT NOT NULL REFERENCES owners(id),
 namespace TEXT NOT NULL,
 source_digest TEXT NOT NULL,
 source_conversation_id TEXT NOT NULL,
 source_scope TEXT NOT NULL,
 source_watermark INTEGER NOT NULL CHECK(source_watermark >= 0),
 message_count INTEGER NOT NULL CHECK(message_count >= 0),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision IN (1,2)),
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
 created_at INTEGER NOT NULL DEFAULT (unixepoch()),
 rolled_back_at INTEGER,
 PRIMARY KEY(owner_id,namespace),
 CHECK((revision=1 AND active=1 AND rolled_back_at IS NULL)
    OR (revision=2 AND active=0 AND rolled_back_at IS NOT NULL))
);
CREATE TABLE history_messages (
 owner_id TEXT NOT NULL,
 namespace TEXT NOT NULL,
 ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
 source_message_id TEXT NOT NULL,
 source_sequence INTEGER NOT NULL CHECK(source_sequence > 0),
 actor_kind TEXT NOT NULL CHECK(actor_kind='owner'),
 text TEXT NOT NULL,
 PRIMARY KEY(owner_id,namespace,ordinal),
 UNIQUE(owner_id,namespace,source_message_id),
 UNIQUE(owner_id,namespace,source_sequence),
 FOREIGN KEY(owner_id,namespace) REFERENCES history_imports(owner_id,namespace)
);
