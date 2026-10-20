-- Ordinary parent completion closes new delegation, not already consumed work.
-- No historical blocked row is restored and no acceptance/cleanup is inferred.
DROP TRIGGER worker_provider_parent_fence;
CREATE TRIGGER worker_provider_parent_fence AFTER UPDATE ON production_runs BEGIN
 UPDATE worker_provider_delegations SET state='blocked',grant_hash=NULL
 WHERE parent_run_id=NEW.id AND state!='blocked' AND (
  NEW.role!='deep' OR NEW.owner_id!=owner_id OR NEW.conversation_id!=conversation_id
  OR NEW.context_id!=context_id OR NEW.incarnation_id!=incarnation_id
  OR NEW.session_id!=parent_session_id OR NEW.message_id!=source_message_id OR NEW.event_id!=source_event_id
  OR NEW.dispatch_state!='delivery_unknown' OR NEW.lease_generation!=parent_lease_generation
  OR NEW.dispatch_fence!=parent_dispatch_fence OR NEW.binding_generation!=parent_binding_generation
  OR NEW.lease_deadline_ms!=parent_deadline_ms
  OR NOT (NEW.state='running' OR (
   NEW.state='awaiting_acceptance' AND state='admitted'
   AND EXISTS(SELECT 1 FROM production_runs child
    WHERE child.id=admitted_run_id AND child.worker_delegation_id=worker_provider_delegations.id
    AND child.state IN ('starting','running','cancel_requested','awaiting_acceptance')
    AND child.dispatch_state='delivery_unknown')
   AND EXISTS(SELECT 1 FROM production_observations o JOIN events e ON e.id=o.event_id
    WHERE o.run_id=NEW.id AND o.kind='completed_proposal' AND o.receipt_state='awaiting_acceptance'
    AND o.lease_generation=NEW.lease_generation AND o.dispatch_fence=NEW.dispatch_fence
    AND e.kind='provider_observed' AND e.schema_version=5
    AND e.owner_id=NEW.owner_id AND e.conversation_id=NEW.conversation_id)
  )));
 UPDATE session_bindings SET state='lost'
 WHERE id IN (SELECT r.session_id FROM production_runs r JOIN worker_provider_delegations d ON d.id=r.worker_delegation_id
  WHERE d.parent_run_id=NEW.id AND d.state='blocked' AND r.state NOT IN ('cancelled','succeeded'));
 UPDATE production_runs SET state='blocked',
  dispatch_state=CASE WHEN dispatch_state='delivery_unknown' THEN 'delivery_unknown' ELSE 'quarantined' END,
  candidate_hash=NULL,reservation_hash=NULL,reserve_key=NULL
 WHERE worker_delegation_id IN (SELECT id FROM worker_provider_delegations WHERE parent_run_id=NEW.id AND state='blocked')
 AND state NOT IN ('cancelled','succeeded','failed','blocked');
END;
