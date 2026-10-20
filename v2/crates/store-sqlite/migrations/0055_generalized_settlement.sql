-- Generalized terminal settlement for a stranded window (no live owner, no
-- live manager budget, past its hard deadline). 0054 settled only
-- starting/running/blocked runs and refused Worker proposals; any other
-- nonterminal shape still stranded the window. Now:
-- - every nonterminal run of any role and state whose lease has passed is
--   failed (`lease_expired_process_gone`);
-- - a proposal with no single readable completion is failed
--   (`proposal_execution_missing`);
-- - a proposal the owner cannot read or accept is abandoned with that cause;
--   one the owner can accept keeps the 24 h acceptance grace;
-- - Worker proposals can be abandoned like Deep and Fast ones.
-- Decisions only; every existing row is kept.
PRAGMA defer_foreign_keys = ON;
DROP VIEW production_terminal_evidence;
CREATE TABLE production_run_lapses_new (
 run_id TEXT PRIMARY KEY REFERENCES production_runs(id),
 window_id TEXT NOT NULL REFERENCES execution_windows(id),
 owner_id TEXT NOT NULL REFERENCES owners(id),
 conversation_id TEXT NOT NULL,
 actor TEXT NOT NULL CHECK(actor IN ('startup','owner')),
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
INSERT INTO production_run_lapses_new SELECT * FROM production_run_lapses;
DROP TABLE production_run_lapses;
ALTER TABLE production_run_lapses_new RENAME TO production_run_lapses;
-- Why each newly abandoned proposal was abandoned. Rows written before 0055
-- carry no cause (they were all owner or grace decisions).
CREATE TABLE production_abandonment_causes (
 run_id TEXT PRIMARY KEY REFERENCES production_run_abandonments(run_id),
 cause TEXT NOT NULL CHECK(cause IN ('acceptance_grace_expired','owner_decision','proposal_execution_missing'))
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
 AND NOT EXISTS(SELECT 1 FROM production_run_lost_failures lf WHERE lf.run_id=r.id);
PRAGMA defer_foreign_keys = OFF;
