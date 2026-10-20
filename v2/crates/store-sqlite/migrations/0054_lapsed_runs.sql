-- A run whose lease passed while its process was gone (service restart, dead
-- broker) and that never reached a terminal observation. Reconciliation, run
-- only by a process that holds no custody of the window after the manager
-- reports no live budget for it, records it FAILED with cause
-- `lease_expired_process_gone`. Never stopped, accepted or re-executed; a
-- parent proposal it belonged to stays acceptable. Decision only.
PRAGMA defer_foreign_keys = ON;
-- A window whose last Deep turn lapsed closes with outcome `failed`, naming
-- that turn. Rebuilt only to widen the outcome CHECK; every row is kept.
CREATE TABLE execution_window_reconciliations_new (
 id TEXT PRIMARY KEY,
 window_id TEXT NOT NULL UNIQUE REFERENCES execution_windows(id),
 owner_id TEXT NOT NULL REFERENCES owners(id),
 conversation_id TEXT NOT NULL,
 generation INTEGER NOT NULL CHECK(generation>0),
 actor TEXT NOT NULL CHECK(actor IN ('startup','owner')),
 decision TEXT NOT NULL CHECK(decision IN ('abandon_unaccepted','retire_resolved')),
 outcome TEXT NOT NULL CHECK(outcome IN ('accepted','stopped','abandoned','failed')),
 prior_run_id TEXT NOT NULL REFERENCES production_runs(id),
 terminal_event_id TEXT NOT NULL REFERENCES events(id),
 hard_deadline_passed INTEGER NOT NULL CHECK(hard_deadline_passed IN (0,1)),
 reconciled_at_ms INTEGER NOT NULL CHECK(reconciled_at_ms>0),
 CHECK(actor='owner' OR hard_deadline_passed=1),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
INSERT INTO execution_window_reconciliations_new SELECT * FROM execution_window_reconciliations;
DROP TABLE execution_window_reconciliations;
ALTER TABLE execution_window_reconciliations_new RENAME TO execution_window_reconciliations;
-- One audit row per lapsed run, with the exact lease it lapsed under.
CREATE TABLE production_run_lapses (
 run_id TEXT PRIMARY KEY REFERENCES production_runs(id),
 window_id TEXT NOT NULL REFERENCES execution_windows(id),
 owner_id TEXT NOT NULL REFERENCES owners(id),
 conversation_id TEXT NOT NULL,
 actor TEXT NOT NULL CHECK(actor IN ('startup','owner')),
 cause TEXT NOT NULL CHECK(cause IN ('lease_expired_process_gone')),
 prior_state TEXT NOT NULL CHECK(prior_state IN ('starting','running','blocked')),
 evidence_event_id TEXT NOT NULL REFERENCES events(id),
 lease_generation INTEGER NOT NULL CHECK(lease_generation>0),
 dispatch_fence INTEGER NOT NULL CHECK(dispatch_fence>0),
 lease_deadline_ms INTEGER NOT NULL,
 binding_generation INTEGER NOT NULL CHECK(binding_generation>0),
 failed_at_ms INTEGER NOT NULL CHECK(failed_at_ms>0),
 CHECK(lease_deadline_ms<failed_at_ms),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
CREATE TABLE production_lapsed_retirements (
 context_id TEXT NOT NULL REFERENCES production_supervisors(context_id),
 incarnation_id TEXT NOT NULL,
 supervisor_generation INTEGER NOT NULL CHECK(supervisor_generation>0),
 prior_run_id TEXT NOT NULL UNIQUE REFERENCES production_run_lapses(run_id),
 lapsed_event_id TEXT NOT NULL REFERENCES events(id),
 session_id TEXT NOT NULL REFERENCES session_bindings(id),
 binding_generation INTEGER NOT NULL CHECK(binding_generation>0),
 retired_at_ms INTEGER NOT NULL CHECK(retired_at_ms>0),
 PRIMARY KEY(context_id,incarnation_id,supervisor_generation)
);
-- Evidence only: neither view grants setup, dispatch or cancellation authority.
DROP VIEW production_terminal_evidence;
CREATE VIEW production_terminal_evidence AS
 SELECT r.id AS run_id,a.event_id,'accepted' AS terminal_kind
 FROM production_runs r JOIN production_acceptances a ON a.run_id=r.id
 WHERE r.state='succeeded' AND a.owner_id=r.owner_id AND a.conversation_id=r.conversation_id
 UNION ALL
 SELECT r.id,o.event_id,'stopped'
 FROM production_runs r
 JOIN production_observations o ON o.run_id=r.id
 JOIN production_cancellations pc ON pc.run_id=r.id
 JOIN production_control_outbox co ON co.run_id=r.id AND co.event_id=pc.event_id
 JOIN production_run_leases l ON l.run_id=r.id AND l.generation=r.lease_generation
 JOIN events e ON e.id=o.event_id
 WHERE r.state='cancelled' AND r.dispatch_state='delivery_unknown'
 AND o.kind='stopped' AND o.receipt_state='cancelled'
 AND o.lease_generation=r.lease_generation AND o.dispatch_fence=r.dispatch_fence
 AND pc.lease_generation=r.lease_generation AND pc.dispatch_fence=r.dispatch_fence
 AND pc.lease_deadline_ms=r.lease_deadline_ms
 AND pc.inflight_status='unknown' AND pc.receipt_state='cancel_requested'
 AND co.state='acknowledged' AND l.purpose='cancellation_acknowledgement'
 AND l.dispatch_fence=r.dispatch_fence AND l.lease_deadline_ms=r.lease_deadline_ms
 AND e.owner_id=r.owner_id AND e.conversation_id=r.conversation_id
 AND e.kind='provider_stopped' AND e.schema_version=7
 UNION ALL
 SELECT r.id,ab.completion_event_id,'abandoned'
 FROM production_runs r
 JOIN production_run_abandonments ab ON ab.run_id=r.id
 JOIN production_observations o ON o.event_id=ab.completion_event_id AND o.run_id=r.id
 JOIN events e ON e.id=o.event_id
 WHERE r.state='cancelled' AND r.role IN ('deep','fast')
 AND NOT EXISTS(SELECT 1 FROM production_acceptances a WHERE a.run_id=r.id)
 AND o.kind='completed_proposal' AND o.receipt_state='awaiting_acceptance'
 AND e.owner_id=r.owner_id AND e.conversation_id=r.conversation_id
 AND e.kind='provider_observed' AND e.schema_version=5
 UNION ALL
 SELECT r.id,f.cancellation_event_id,'failed'
 FROM production_runs r
 JOIN production_run_failures f ON f.run_id=r.id
 JOIN production_cancellations pc ON pc.run_id=r.id AND pc.event_id=f.cancellation_event_id
 WHERE r.state='cancelled' AND r.role='worker' AND r.dispatch_state='delivery_unknown'
 AND pc.receipt_state='cancel_requested' AND pc.inflight_status='unknown'
 AND pc.lease_generation=r.lease_generation AND pc.dispatch_fence=r.dispatch_fence
 AND f.lease_deadline_ms=r.lease_deadline_ms
 AND NOT EXISTS(SELECT 1 FROM production_acceptances a WHERE a.run_id=r.id)
 UNION ALL
 SELECT r.id,f.lost_event_id,'failed'
 FROM production_runs r
 JOIN production_run_lost_failures f ON f.run_id=r.id
 JOIN production_observations o ON o.event_id=f.lost_event_id AND o.run_id=r.id
 JOIN events e ON e.id=o.event_id
 WHERE r.state='cancelled' AND r.role='worker' AND r.dispatch_state='delivery_unknown'
 AND o.kind='lost' AND o.receipt_state='blocked'
 AND o.lease_generation=r.lease_generation AND o.dispatch_fence=r.dispatch_fence
 AND f.lease_deadline_ms=r.lease_deadline_ms
 AND e.owner_id=r.owner_id AND e.conversation_id=r.conversation_id
 AND NOT EXISTS(SELECT 1 FROM production_acceptances a WHERE a.run_id=r.id)
 AND NOT EXISTS(SELECT 1 FROM production_run_failures pf WHERE pf.run_id=r.id)
 UNION ALL
 SELECT r.id,l.evidence_event_id,'failed'
 FROM production_runs r
 JOIN production_run_lapses l ON l.run_id=r.id
 WHERE r.state='cancelled' AND r.lease_generation=l.lease_generation
 AND r.dispatch_fence=l.dispatch_fence AND r.lease_deadline_ms=l.lease_deadline_ms
 AND r.owner_id=l.owner_id AND r.conversation_id=l.conversation_id
 AND NOT EXISTS(SELECT 1 FROM production_acceptances a WHERE a.run_id=r.id)
 AND NOT EXISTS(SELECT 1 FROM production_run_failures pf WHERE pf.run_id=r.id)
 AND NOT EXISTS(SELECT 1 FROM production_run_lost_failures lf WHERE lf.run_id=r.id);
DROP VIEW production_retirement_provenance;
CREATE VIEW production_retirement_provenance AS
 SELECT context_id,incarnation_id,supervisor_generation,prior_run_id,
 acceptance_event_id AS terminal_event_id,session_id,binding_generation,retired_at_ms
 FROM production_graceful_retirements
 UNION ALL
 SELECT context_id,incarnation_id,supervisor_generation,prior_run_id,
 stopped_event_id,session_id,binding_generation,retired_at_ms
 FROM production_stopped_retirements
 UNION ALL
 SELECT context_id,incarnation_id,supervisor_generation,prior_run_id,
 abandoned_event_id,session_id,binding_generation,retired_at_ms
 FROM production_abandoned_retirements
 UNION ALL
 SELECT context_id,incarnation_id,supervisor_generation,prior_run_id,
 lapsed_event_id,session_id,binding_generation,retired_at_ms
 FROM production_lapsed_retirements;
-- A Worker task whose native setup was still in progress when its parent
-- stopped running (for example it proposed first). It never ran and no
-- delegation can be admitted any more: ended visibly as failed. Its unused
-- setup binding (if readiness was confirmed) is lost and no longer counts as
-- unresolved setup.
CREATE TABLE worker_task_failures (
 task_id TEXT PRIMARY KEY REFERENCES worker_tasks(id),
 cause TEXT NOT NULL CHECK(cause IN ('parent_left_running_during_setup')),
 setup_session_id TEXT UNIQUE REFERENCES session_bindings(id),
 failed_at_ms INTEGER NOT NULL CHECK(failed_at_ms>0)
);
PRAGMA defer_foreign_keys = OFF;
