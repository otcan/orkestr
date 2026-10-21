-- Owner sidebar read marks and durable V1 lineage of imported conversations.
-- Neither table admits input, starts execution or references runs.

-- Last view per sidebar entry: `v2:<conversation>` (conversation sequence) or
-- `v1:<thread>` (V1 message cursor). A mark only moves forward.
CREATE TABLE sidebar_read_marks (
 owner_id TEXT NOT NULL REFERENCES owners(id),
 entry_key TEXT NOT NULL CHECK(length(entry_key) BETWEEN 4 AND 220),
 marker INTEGER NOT NULL CHECK(marker >= 0),
 updated_at_ms INTEGER NOT NULL,
 PRIMARY KEY(owner_id,entry_key)
);
CREATE TRIGGER sidebar_read_marks_forward BEFORE UPDATE ON sidebar_read_marks
 WHEN NEW.marker < OLD.marker
BEGIN SELECT RAISE(ABORT,'read marks never move back'); END;

-- The V1 thread an imported conversation came from and, for a V1 worker
-- sub-thread, its V1 parent. Write-once and retained.
CREATE TABLE conversation_lineage (
 owner_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 source_instance TEXT NOT NULL,
 source_thread_id TEXT NOT NULL,
 source_parent_thread_id TEXT,
 recorded_at_ms INTEGER NOT NULL,
 PRIMARY KEY(owner_id,conversation_id),
 CHECK(source_parent_thread_id IS NULL OR source_parent_thread_id <> source_thread_id),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
CREATE INDEX conversation_lineage_parent ON conversation_lineage(owner_id,source_parent_thread_id);
CREATE TRIGGER conversation_lineage_write_once BEFORE UPDATE ON conversation_lineage
BEGIN SELECT RAISE(ABORT,'conversation lineage is write-once'); END;
CREATE TRIGGER conversation_lineage_retained BEFORE DELETE ON conversation_lineage
BEGIN SELECT RAISE(ABORT,'conversation lineage is retained'); END;
