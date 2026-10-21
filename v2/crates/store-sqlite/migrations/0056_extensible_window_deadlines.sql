-- An active window's work deadline may be extended by its opener while a Deep
-- or Worker run is still producing work, up to a fixed ceiling. The 30-second
-- cleanup margin stays exact. Rebuilt only to widen the deadline CHECKs;
-- every row is kept unchanged.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE execution_windows_new (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES owners(id),
 conversation_id TEXT NOT NULL,
 generation INTEGER NOT NULL CHECK(generation>0),
 state TEXT NOT NULL CHECK(state IN ('opening','active','retiring','closed','reconciliation_required')),
 input_message_id TEXT NOT NULL REFERENCES messages(id),
 input_event_id TEXT NOT NULL REFERENCES events(id),
 predecessor_window_id TEXT REFERENCES execution_windows(id),
 opened_at_ms INTEGER NOT NULL,
 work_deadline_ms INTEGER NOT NULL,
 expires_at_ms INTEGER NOT NULL,
 boot_id TEXT,
 manager_ack_hash TEXT,
 context_id TEXT REFERENCES production_supervisors(context_id),
 incarnation_id TEXT,
 credential_hash TEXT UNIQUE,
 credential_expires_at INTEGER,
 credential_bound INTEGER NOT NULL DEFAULT 0 CHECK(credential_bound IN (0,1)),
 credential_issued INTEGER NOT NULL DEFAULT 0 CHECK(credential_issued IN (0,1)),
 terminal_run_id TEXT REFERENCES production_runs(id),
 -- Base 15-minute window, extendable to at most 4 hours in total.
 CHECK(work_deadline_ms>=opened_at_ms+870000 AND work_deadline_ms<=opened_at_ms+14370000),
 CHECK(expires_at_ms=work_deadline_ms+30000),
 UNIQUE(owner_id,conversation_id,generation),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
INSERT INTO execution_windows_new SELECT * FROM execution_windows;
DROP TABLE execution_windows;
ALTER TABLE execution_windows_new RENAME TO execution_windows;
CREATE UNIQUE INDEX execution_window_unresolved ON execution_windows(owner_id,conversation_id)
 WHERE state!='closed';
PRAGMA defer_foreign_keys = OFF;
