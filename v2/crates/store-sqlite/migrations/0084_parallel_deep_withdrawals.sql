-- A read-only parallel Deep slot proposal still unaccepted when its live
-- window closes (docs/v2/parallel-deep.md, drain deadline). The live process
-- withdraws it: the run becomes Cancelled with abandoned terminal evidence
-- (never Succeeded, never accepted afterwards), its session is released, and
-- its input goes back to the writer (production_parallel_deep_deferrals).
-- Before this schema such a proposal kept the window unresolved until
-- stranded reconciliation after the hard deadline and acceptance grace.
CREATE TABLE production_parallel_deep_withdrawals (
 run_id TEXT PRIMARY KEY REFERENCES production_runs(id),
 completion_event_id TEXT NOT NULL UNIQUE REFERENCES production_observations(event_id),
 cause TEXT NOT NULL CHECK(cause IN ('window_closing')),
 binding_generation INTEGER NOT NULL CHECK(binding_generation>0),
 withdrawn_at_ms INTEGER NOT NULL CHECK(withdrawn_at_ms>0)
);
-- Evidence only: neither view grants setup, dispatch or cancellation authority.
-- Unchanged from 0055 except the last branch (withdrawn slot proposals).
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
 WHERE r.state='cancelled' AND r.role IN ('deep','fast','worker')
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
 AND NOT EXISTS(SELECT 1 FROM production_run_lost_failures lf WHERE lf.run_id=r.id)
 UNION ALL
 SELECT r.id,w.completion_event_id,'abandoned'
 FROM production_runs r
 JOIN production_parallel_deep_withdrawals w ON w.run_id=r.id
 JOIN production_observations o ON o.event_id=w.completion_event_id AND o.run_id=r.id
 JOIN events e ON e.id=o.event_id
 WHERE r.state='cancelled' AND r.role='deep' AND r.deep_slot>0
 AND NOT EXISTS(SELECT 1 FROM production_acceptances a WHERE a.run_id=r.id)
 AND NOT EXISTS(SELECT 1 FROM production_run_abandonments ab WHERE ab.run_id=r.id)
 AND o.kind='completed_proposal' AND o.receipt_state='awaiting_acceptance'
 AND e.owner_id=r.owner_id AND e.conversation_id=r.conversation_id
 AND e.kind='provider_observed' AND e.schema_version=5;
