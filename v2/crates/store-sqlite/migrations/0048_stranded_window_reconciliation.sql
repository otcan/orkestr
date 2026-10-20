-- Audited recovery for an execution window whose opening process incarnation
-- is gone. A reconciliation is an owner-authenticated terminal DECISION, never
-- acceptance, re-execution, dispatch or budget. History rows are retained.
CREATE TABLE execution_window_reconciliations (
 id TEXT PRIMARY KEY,
 window_id TEXT NOT NULL UNIQUE REFERENCES execution_windows(id),
 owner_id TEXT NOT NULL REFERENCES owners(id),
 conversation_id TEXT NOT NULL,
 generation INTEGER NOT NULL CHECK(generation>0),
 actor TEXT NOT NULL CHECK(actor IN ('startup','owner')),
 decision TEXT NOT NULL CHECK(decision IN ('abandon_unaccepted','retire_resolved')),
 outcome TEXT NOT NULL CHECK(outcome IN ('accepted','stopped','abandoned')),
 prior_run_id TEXT NOT NULL REFERENCES production_runs(id),
 terminal_event_id TEXT NOT NULL REFERENCES events(id),
 hard_deadline_passed INTEGER NOT NULL CHECK(hard_deadline_passed IN (0,1)),
 reconciled_at_ms INTEGER NOT NULL CHECK(reconciled_at_ms>0),
 CHECK(actor='owner' OR hard_deadline_passed=1),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
-- An unaccepted completed proposal, explicitly abandoned. The proposal and its
-- observations stay in history; the run can never be accepted afterwards.
CREATE TABLE production_run_abandonments (
 run_id TEXT PRIMARY KEY REFERENCES production_runs(id),
 reconciliation_id TEXT NOT NULL REFERENCES execution_window_reconciliations(id),
 completion_event_id TEXT NOT NULL UNIQUE REFERENCES production_observations(event_id),
 binding_generation INTEGER NOT NULL CHECK(binding_generation>0),
 abandoned_at_ms INTEGER NOT NULL CHECK(abandoned_at_ms>0)
);
-- Window association of an admitted input that no run ever consumed. Released
-- so the still-queued input can be admitted again; the original receipt is kept.
CREATE TABLE execution_window_released_inputs (
 event_id TEXT PRIMARY KEY REFERENCES events(id),
 reconciliation_id TEXT NOT NULL REFERENCES execution_window_reconciliations(id),
 window_id TEXT NOT NULL REFERENCES execution_windows(id),
 owner_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 request_key TEXT NOT NULL,
 semantic_digest TEXT NOT NULL,
 message_id TEXT NOT NULL REFERENCES messages(id),
 input_request_key TEXT NOT NULL,
 receipt_json TEXT NOT NULL
);
CREATE TABLE production_abandoned_retirements (
 context_id TEXT NOT NULL REFERENCES production_supervisors(context_id),
 incarnation_id TEXT NOT NULL,
 supervisor_generation INTEGER NOT NULL CHECK(supervisor_generation>0),
 prior_run_id TEXT NOT NULL UNIQUE REFERENCES production_run_abandonments(run_id),
 abandoned_event_id TEXT NOT NULL UNIQUE REFERENCES production_run_abandonments(completion_event_id),
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
 AND e.kind='provider_observed' AND e.schema_version=5;
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
 FROM production_abandoned_retirements;
