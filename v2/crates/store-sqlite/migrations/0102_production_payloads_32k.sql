-- One progress payload, and so one reply (a run's last progress payload), may
-- hold 32 KiB instead of 8 KiB (MAX_PROVIDER_PROGRESS_BYTES). Only the CHECK
-- bound changes: every row is copied with its rowid, columns, keys and
-- references unchanged. No table, trigger or view refers to this table; its
-- one index is recreated as 0059 defined it.
ALTER TABLE production_payloads RENAME TO production_payloads_before_32k;
CREATE TABLE production_payloads (
 id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE REFERENCES production_observations(event_id),
 owner_id TEXT NOT NULL REFERENCES owners(id), conversation_id TEXT NOT NULL,
 run_id TEXT NOT NULL REFERENCES production_runs(id),
 text TEXT CHECK(text IS NULL OR length(CAST(text AS BLOB))<=32768),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
INSERT INTO production_payloads(rowid,id,event_id,owner_id,conversation_id,run_id,text)
 SELECT rowid,id,event_id,owner_id,conversation_id,run_id,text FROM production_payloads_before_32k;
DROP TABLE production_payloads_before_32k;
CREATE INDEX production_payloads_run ON production_payloads(run_id,owner_id);
