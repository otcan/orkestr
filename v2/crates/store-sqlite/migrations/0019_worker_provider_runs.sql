PRAGMA defer_foreign_keys = ON;
DROP TRIGGER execution_run_insert;
DROP TRIGGER execution_run_update;
DROP TRIGGER worker_provider_parent_fence;
CREATE TABLE production_runs_new (
 id TEXT PRIMARY KEY, context_id TEXT NOT NULL REFERENCES production_supervisors(context_id),
 incarnation_id TEXT NOT NULL, owner_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
 session_id TEXT NOT NULL, native_session_id TEXT NOT NULL,
 provider_kind TEXT NOT NULL CHECK(provider_kind IN ('codex','claude')),
 binding_generation INTEGER NOT NULL CHECK(binding_generation>0),
 message_id TEXT NOT NULL REFERENCES messages(id), event_id TEXT NOT NULL REFERENCES events(id),
 scope_sequence INTEGER NOT NULL, claim_generation INTEGER NOT NULL,
 request_key TEXT NOT NULL, input_digest TEXT NOT NULL,
 lease_generation INTEGER NOT NULL CHECK(lease_generation>0),
 dispatch_fence INTEGER NOT NULL CHECK(dispatch_fence>0), lease_deadline_ms INTEGER NOT NULL,
 attempt INTEGER NOT NULL CHECK(attempt=1), state TEXT NOT NULL CHECK(state IN ('starting','running','awaiting_acceptance','failed','blocked','cancel_requested','cancelled','succeeded')),
 dispatch_state TEXT NOT NULL CHECK(dispatch_state IN ('candidate','reserved','delivery_unknown','quarantined')),
 candidate_hash TEXT, reservation_hash TEXT, reserve_key TEXT,
 role TEXT NOT NULL DEFAULT 'deep' CHECK(role IN ('deep','worker')),
 parent_session_id TEXT, worker_delegation_id TEXT UNIQUE REFERENCES worker_provider_delegations(id),
 UNIQUE(owner_id,conversation_id,request_key),
 CHECK((role='deep' AND parent_session_id IS NULL AND worker_delegation_id IS NULL AND claim_generation>0)
 OR (role='worker' AND parent_session_id IS NOT NULL AND worker_delegation_id IS NOT NULL AND claim_generation=0)),
 FOREIGN KEY(session_id,owner_id,conversation_id) REFERENCES session_bindings(id,owner_id,conversation_id),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id),
 CHECK((dispatch_state='candidate' AND candidate_hash IS NOT NULL AND reservation_hash IS NULL)
 OR (dispatch_state='reserved' AND candidate_hash IS NOT NULL AND reservation_hash IS NOT NULL AND reserve_key IS NOT NULL)
 OR (dispatch_state IN ('delivery_unknown','quarantined') AND candidate_hash IS NULL AND reservation_hash IS NULL))
);
INSERT INTO production_runs_new SELECT *,'deep',NULL,NULL FROM production_runs;
DROP TABLE production_runs;
ALTER TABLE production_runs_new RENAME TO production_runs;
CREATE TRIGGER execution_run_insert AFTER INSERT ON production_runs BEGIN
 UPDATE execution_revisions SET revision=revision+1 WHERE conversation_id=NEW.conversation_id;
END;
CREATE TRIGGER execution_run_update AFTER UPDATE ON production_runs BEGIN
 UPDATE execution_revisions SET revision=revision+1 WHERE conversation_id=NEW.conversation_id;
END;
CREATE UNIQUE INDEX production_occupied_session ON production_runs(session_id) WHERE state NOT IN ('cancelled','succeeded');
CREATE UNIQUE INDEX production_deep_claim ON production_runs(conversation_id,scope_sequence) WHERE role='deep';
CREATE TRIGGER worker_provider_parent_fence AFTER UPDATE ON production_runs BEGIN
 UPDATE session_bindings SET state='lost'
 WHERE id IN (SELECT r.session_id FROM production_runs r JOIN worker_provider_delegations d ON d.id=r.worker_delegation_id
 WHERE d.parent_run_id=NEW.id AND r.state NOT IN ('cancelled','succeeded') AND (NEW.state!='running' OR NEW.dispatch_state!='delivery_unknown' OR NEW.lease_generation!=d.parent_lease_generation OR NEW.dispatch_fence!=d.parent_dispatch_fence OR NEW.binding_generation!=d.parent_binding_generation OR NEW.lease_deadline_ms!=d.parent_deadline_ms));
 UPDATE production_runs SET state='blocked',dispatch_state=CASE WHEN dispatch_state='delivery_unknown' THEN 'delivery_unknown' ELSE 'quarantined' END,candidate_hash=NULL,reservation_hash=NULL,reserve_key=NULL
 WHERE worker_delegation_id IN (SELECT d.id FROM worker_provider_delegations d WHERE d.parent_run_id=NEW.id AND (NEW.state!='running' OR NEW.dispatch_state!='delivery_unknown' OR NEW.lease_generation!=d.parent_lease_generation OR NEW.dispatch_fence!=d.parent_dispatch_fence OR NEW.binding_generation!=d.parent_binding_generation OR NEW.lease_deadline_ms!=d.parent_deadline_ms))
 AND state NOT IN ('cancelled','succeeded','failed','blocked');
 UPDATE worker_provider_delegations SET state='blocked',grant_hash=NULL
 WHERE parent_run_id=NEW.id AND state!='blocked' AND (NEW.state!='running' OR NEW.dispatch_state!='delivery_unknown' OR NEW.lease_generation!=parent_lease_generation OR NEW.dispatch_fence!=parent_dispatch_fence OR NEW.binding_generation!=parent_binding_generation OR NEW.lease_deadline_ms!=parent_deadline_ms);
END;
CREATE TEMP TABLE worker_upgrade_fk_check (violations INTEGER CHECK(violations=0));
INSERT INTO worker_upgrade_fk_check SELECT count(*) FROM pragma_foreign_key_check;
DROP TABLE worker_upgrade_fk_check;
PRAGMA defer_foreign_keys = OFF;
