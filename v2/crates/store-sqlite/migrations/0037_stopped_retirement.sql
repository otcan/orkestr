-- No backfill: canonical Stop alone does not prove trusted graceful teardown.
-- Keep 0028's acceptance-only FKs and historical rows unchanged.
CREATE TABLE production_stopped_retirements (
 context_id TEXT NOT NULL REFERENCES production_supervisors(context_id),
 incarnation_id TEXT NOT NULL,
 supervisor_generation INTEGER NOT NULL CHECK(supervisor_generation>0),
 prior_run_id TEXT NOT NULL UNIQUE REFERENCES production_runs(id),
 stopped_event_id TEXT NOT NULL UNIQUE REFERENCES production_observations(event_id),
 session_id TEXT NOT NULL REFERENCES session_bindings(id),
 binding_generation INTEGER NOT NULL CHECK(binding_generation>0),
 retired_at_ms INTEGER NOT NULL CHECK(retired_at_ms>0),
 PRIMARY KEY(context_id,incarnation_id,supervisor_generation)
);
-- Evidence only: neither view grants setup, dispatch or cancellation authority.
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
 AND e.kind='provider_stopped' AND e.schema_version=7;
CREATE VIEW production_retirement_provenance AS
 SELECT context_id,incarnation_id,supervisor_generation,prior_run_id,
 acceptance_event_id AS terminal_event_id,session_id,binding_generation,retired_at_ms
 FROM production_graceful_retirements
 UNION ALL
 SELECT context_id,incarnation_id,supervisor_generation,prior_run_id,
 stopped_event_id,session_id,binding_generation,retired_at_ms
 FROM production_stopped_retirements;
