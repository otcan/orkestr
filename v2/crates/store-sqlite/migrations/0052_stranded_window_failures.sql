-- Audited terminal decisions for the two stranded shapes 0048 refused: a
-- window whose open failed before any run of its own, and a Worker left in
-- cancel_requested after its lease deadline. Decisions only: nothing here is
-- acceptance, dispatch, budget or a replacement grant. History rows are kept.
CREATE TABLE execution_window_open_failures (
 id TEXT PRIMARY KEY,
 window_id TEXT NOT NULL UNIQUE REFERENCES execution_windows(id),
 owner_id TEXT NOT NULL REFERENCES owners(id),
 conversation_id TEXT NOT NULL,
 generation INTEGER NOT NULL CHECK(generation>0),
 actor TEXT NOT NULL CHECK(actor IN ('startup','owner')),
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
 CHECK(actor='owner' OR hard_deadline_passed=1),
 CHECK((restored_window_id IS NULL)=(restored_incarnation_id IS NULL)
  AND (restored_window_id IS NULL)=(restored_generation IS NULL)),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
-- Window association of an input the failed opening never consumed. Released
-- so the still-queued input can be admitted again; the original receipt is kept.
CREATE TABLE execution_window_open_failure_inputs (
 event_id TEXT PRIMARY KEY REFERENCES events(id),
 failure_id TEXT NOT NULL REFERENCES execution_window_open_failures(id),
 window_id TEXT NOT NULL REFERENCES execution_windows(id),
 owner_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 request_key TEXT NOT NULL,
 semantic_digest TEXT NOT NULL,
 message_id TEXT NOT NULL REFERENCES messages(id),
 input_request_key TEXT NOT NULL,
 receipt_json TEXT NOT NULL
);
-- Resume reservations made by the failed opening for the restored predecessor
-- turns. Archived (never confirmed again) so the next opening can reserve anew.
CREATE TABLE execution_window_failed_resume_metadata (
 id TEXT PRIMARY KEY,
 failure_id TEXT NOT NULL REFERENCES execution_window_open_failures(id),
 prior_run_id TEXT NOT NULL REFERENCES production_runs(id),
 terminal_event_id TEXT NOT NULL REFERENCES events(id),
 context_id TEXT NOT NULL,
 incarnation_id TEXT NOT NULL,
 session_id TEXT NOT NULL REFERENCES session_bindings(id),
 binding_generation INTEGER NOT NULL CHECK(binding_generation>0),
 state TEXT NOT NULL CHECK(state IN ('issued','confirmed')),
 confirmation_digest TEXT
);
-- A Worker whose deadline cancellation was requested but never acknowledged,
-- and whose lease and process are gone. Failed with its cause; never stopped,
-- accepted or re-executed. Its cancellation receipt stays cancel_requested.
CREATE TABLE production_run_failures (
 run_id TEXT PRIMARY KEY REFERENCES production_runs(id),
 reconciliation_id TEXT NOT NULL REFERENCES execution_window_reconciliations(id),
 cause TEXT NOT NULL CHECK(cause IN ('cancel_unacknowledged')),
 cancellation_event_id TEXT NOT NULL UNIQUE REFERENCES production_cancellations(event_id),
 lease_deadline_ms INTEGER NOT NULL,
 binding_generation INTEGER NOT NULL CHECK(binding_generation>0),
 failed_at_ms INTEGER NOT NULL CHECK(failed_at_ms>0)
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
 AND NOT EXISTS(SELECT 1 FROM production_acceptances a WHERE a.run_id=r.id);
