-- The server's own immediate recovery of a window whose task in this process
-- ended and reaped every original child is recorded as actor `server`. It was
-- recorded as `owner`, so audits named the owner for windows the server
-- closed. Like the owner's decision it may run before the hard deadline, but
-- Core refuses it every plan that abandons a run.
-- Rebuilt only to widen the actor CHECKs; every row is kept with its rowid.
-- Each table is copied out, dropped, recreated under its own name and copied
-- back, so the tables that reference it and the terminal evidence view keep
-- resolving to it (a rename would leave those references dangling).
PRAGMA defer_foreign_keys = ON;
CREATE TEMP TABLE reconciliations_copy AS
 SELECT rowid AS copied_rowid,* FROM execution_window_reconciliations;
DROP TABLE execution_window_reconciliations;
CREATE TABLE execution_window_reconciliations (
 id TEXT PRIMARY KEY,
 window_id TEXT NOT NULL UNIQUE REFERENCES execution_windows(id),
 owner_id TEXT NOT NULL REFERENCES owners(id),
 conversation_id TEXT NOT NULL,
 generation INTEGER NOT NULL CHECK(generation>0),
 actor TEXT NOT NULL CHECK(actor IN ('startup','owner','server')),
 decision TEXT NOT NULL CHECK(decision IN ('abandon_unaccepted','retire_resolved')),
 outcome TEXT NOT NULL CHECK(outcome IN ('accepted','stopped','abandoned','failed')),
 prior_run_id TEXT NOT NULL REFERENCES production_runs(id),
 terminal_event_id TEXT NOT NULL REFERENCES events(id),
 hard_deadline_passed INTEGER NOT NULL CHECK(hard_deadline_passed IN (0,1)),
 reconciled_at_ms INTEGER NOT NULL CHECK(reconciled_at_ms>0),
 CHECK(actor!='startup' OR hard_deadline_passed=1),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
INSERT INTO execution_window_reconciliations(rowid,id,window_id,owner_id,conversation_id,generation,
 actor,decision,outcome,prior_run_id,terminal_event_id,hard_deadline_passed,reconciled_at_ms)
 SELECT copied_rowid,id,window_id,owner_id,conversation_id,generation,
 actor,decision,outcome,prior_run_id,terminal_event_id,hard_deadline_passed,reconciled_at_ms
 FROM reconciliations_copy ORDER BY copied_rowid;
DROP TABLE reconciliations_copy;
CREATE TEMP TABLE open_failures_copy AS
 SELECT rowid AS copied_rowid,* FROM execution_window_open_failures;
DROP TABLE execution_window_open_failures;
CREATE TABLE execution_window_open_failures (
 id TEXT PRIMARY KEY,
 window_id TEXT NOT NULL UNIQUE REFERENCES execution_windows(id),
 owner_id TEXT NOT NULL REFERENCES owners(id),
 conversation_id TEXT NOT NULL,
 generation INTEGER NOT NULL CHECK(generation>0),
 actor TEXT NOT NULL CHECK(actor IN ('startup','owner','server')),
 decision TEXT NOT NULL CHECK(decision IN ('abandon_unaccepted','retire_resolved')),
 cause TEXT NOT NULL CHECK(cause IN ('credential_unissued','credential_unbound','setup_incomplete')),
 context_id TEXT REFERENCES production_supervisors(context_id),
 failed_incarnation_id TEXT,
 failed_generation INTEGER CHECK(failed_generation IS NULL OR failed_generation>0),
 -- The gracefully retired window this conversation continues from, restored
 -- exactly as it was before the failed opening. NULL: no retired lineage yet.
 restored_window_id TEXT REFERENCES execution_windows(id),
 restored_incarnation_id TEXT,
 restored_generation INTEGER CHECK(restored_generation IS NULL OR restored_generation>0),
 hard_deadline_passed INTEGER NOT NULL CHECK(hard_deadline_passed IN (0,1)),
 reconciled_at_ms INTEGER NOT NULL CHECK(reconciled_at_ms>0),
 CHECK(actor!='startup' OR hard_deadline_passed=1),
 CHECK((restored_window_id IS NULL)=(restored_incarnation_id IS NULL)
  AND (restored_window_id IS NULL)=(restored_generation IS NULL)),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
INSERT INTO execution_window_open_failures(rowid,id,window_id,owner_id,conversation_id,generation,
 actor,decision,cause,context_id,failed_incarnation_id,failed_generation,restored_window_id,
 restored_incarnation_id,restored_generation,hard_deadline_passed,reconciled_at_ms)
 SELECT copied_rowid,id,window_id,owner_id,conversation_id,generation,
 actor,decision,cause,context_id,failed_incarnation_id,failed_generation,restored_window_id,
 restored_incarnation_id,restored_generation,hard_deadline_passed,reconciled_at_ms
 FROM open_failures_copy ORDER BY copied_rowid;
DROP TABLE open_failures_copy;
CREATE TEMP TABLE lapses_copy AS
 SELECT rowid AS copied_rowid,* FROM production_run_lapses;
DROP TABLE production_run_lapses;
CREATE TABLE production_run_lapses (
 run_id TEXT PRIMARY KEY REFERENCES production_runs(id),
 window_id TEXT NOT NULL REFERENCES execution_windows(id),
 owner_id TEXT NOT NULL REFERENCES owners(id),
 conversation_id TEXT NOT NULL,
 actor TEXT NOT NULL CHECK(actor IN ('startup','owner','server')),
 cause TEXT NOT NULL CHECK(cause IN ('lease_expired_process_gone','proposal_execution_missing')),
 prior_state TEXT NOT NULL CHECK(prior_state IN ('starting','running','blocked','cancel_requested','failed','cancelled','awaiting_acceptance')),
 evidence_event_id TEXT NOT NULL REFERENCES events(id),
 lease_generation INTEGER NOT NULL CHECK(lease_generation>0),
 dispatch_fence INTEGER NOT NULL CHECK(dispatch_fence>0),
 lease_deadline_ms INTEGER NOT NULL,
 binding_generation INTEGER NOT NULL CHECK(binding_generation>0),
 failed_at_ms INTEGER NOT NULL CHECK(failed_at_ms>0),
 CHECK(cause!='lease_expired_process_gone' OR lease_deadline_ms<failed_at_ms),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
INSERT INTO production_run_lapses(rowid,run_id,window_id,owner_id,conversation_id,actor,cause,
 prior_state,evidence_event_id,lease_generation,dispatch_fence,lease_deadline_ms,binding_generation,failed_at_ms)
 SELECT copied_rowid,run_id,window_id,owner_id,conversation_id,actor,cause,
 prior_state,evidence_event_id,lease_generation,dispatch_fence,lease_deadline_ms,binding_generation,failed_at_ms
 FROM lapses_copy ORDER BY copied_rowid;
DROP TABLE lapses_copy;
