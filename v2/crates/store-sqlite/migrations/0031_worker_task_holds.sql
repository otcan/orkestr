-- Preserve historical task receipts; unverifiable old pending authority is held.
ALTER TABLE worker_tasks ADD COLUMN issuer_token_hash TEXT
 CHECK(issuer_token_hash IS NULL OR
  (length(issuer_token_hash)=64 AND issuer_token_hash NOT GLOB '*[^0-9a-f]*'));
UPDATE worker_tasks SET state='held',claim_hash=NULL WHERE state IN ('queued','claimed');
CREATE INDEX worker_tasks_pending_issuer ON worker_tasks(issuer_token_hash,owner_id)
 WHERE state IN ('queued','claimed');
CREATE INDEX worker_tasks_pending_context ON worker_tasks(context_id,incarnation_id)
 WHERE state IN ('queued','claimed');
CREATE TRIGGER worker_tasks_require_issuer BEFORE INSERT ON worker_tasks
WHEN NEW.state IN ('queued','claimed') AND NEW.issuer_token_hash IS NULL BEGIN
 SELECT RAISE(ABORT,'pending task requires issuer lineage');
END;

-- Commit the negative task fence in the same transaction as the parent fence.
-- Ordinary running progress and same-process lease extensions do not hold work.
CREATE TRIGGER worker_tasks_parent_hold AFTER UPDATE ON production_runs
WHEN NEW.state!='running' OR NEW.dispatch_state!='delivery_unknown'
 OR OLD.dispatch_fence!=NEW.dispatch_fence OR OLD.incarnation_id!=NEW.incarnation_id
 OR OLD.context_id!=NEW.context_id OR OLD.owner_id!=NEW.owner_id
 OR OLD.conversation_id!=NEW.conversation_id OR OLD.session_id!=NEW.session_id
 OR OLD.native_session_id!=NEW.native_session_id OR OLD.binding_generation!=NEW.binding_generation
 OR OLD.provider_kind!=NEW.provider_kind OR OLD.message_id!=NEW.message_id OR OLD.event_id!=NEW.event_id
 OR NEW.lease_deadline_ms<=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
BEGIN
 UPDATE worker_tasks SET state='held',claim_hash=NULL
 WHERE parent_run_id=OLD.id AND state IN ('queued','claimed');
END;
CREATE TRIGGER worker_tasks_control_hold AFTER UPDATE ON production_control_revisions
WHEN OLD.revision!=NEW.revision BEGIN
 UPDATE worker_tasks SET state='held',claim_hash=NULL
 WHERE parent_run_id=OLD.run_id AND parent_control_revision!=NEW.revision
  AND state IN ('queued','claimed');
END;

CREATE TRIGGER worker_tasks_supervisor_hold AFTER UPDATE ON production_supervisors
WHEN OLD.incarnation_id!=NEW.incarnation_id OR OLD.generation!=NEW.generation
 OR OLD.owner_id!=NEW.owner_id OR OLD.provider_kind!=NEW.provider_kind
 OR OLD.namespace!=NEW.namespace OR OLD.supervisor_key!=NEW.supervisor_key
 OR NEW.lease_deadline_ms<=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
 OR OLD.lease_deadline_ms<=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
BEGIN
 UPDATE worker_tasks SET state='held',claim_hash=NULL
 WHERE context_id=OLD.context_id AND incarnation_id=OLD.incarnation_id
  AND state IN ('queued','claimed');
END;
CREATE TRIGGER worker_tasks_binding_hold AFTER UPDATE ON session_bindings
WHEN NEW.state!='busy' OR OLD.generation!=NEW.generation
 OR OLD.owner_id!=NEW.owner_id OR OLD.conversation_id!=NEW.conversation_id
 OR OLD.native_session_id IS NOT NEW.native_session_id OR OLD.provider_kind!=NEW.provider_kind
 OR OLD.provider_namespace IS NOT NEW.provider_namespace
BEGIN
 UPDATE worker_tasks SET state='held',claim_hash=NULL
 WHERE parent_run_id IN (SELECT id FROM production_runs WHERE session_id=OLD.id)
  AND state IN ('queued','claimed');
END;
CREATE TRIGGER worker_tasks_readiness_delete_hold AFTER DELETE ON production_readiness BEGIN
 UPDATE worker_tasks SET state='held',claim_hash=NULL
 WHERE parent_run_id IN (SELECT id FROM production_runs WHERE session_id=OLD.session_id)
  AND state IN ('queued','claimed');
END;
CREATE TRIGGER worker_tasks_readiness_update_hold AFTER UPDATE ON production_readiness
WHEN OLD.context_id!=NEW.context_id OR OLD.incarnation_id!=NEW.incarnation_id BEGIN
 UPDATE worker_tasks SET state='held',claim_hash=NULL
 WHERE parent_run_id IN (SELECT id FROM production_runs WHERE session_id=OLD.session_id)
  AND state IN ('queued','claimed');
END;

-- Match only the original machine issuer, never every browser login of its owner.
CREATE TRIGGER worker_tasks_auth_delete_hold AFTER DELETE ON auth_sessions BEGIN
 UPDATE worker_tasks SET state='held',claim_hash=NULL
 WHERE issuer_token_hash=OLD.token_hash AND owner_id=OLD.owner_id
  AND state IN ('queued','claimed');
END;
CREATE TRIGGER worker_tasks_auth_update_hold AFTER UPDATE ON auth_sessions
WHEN OLD.token_hash!=NEW.token_hash OR OLD.owner_id!=NEW.owner_id
 OR OLD.expires_at<=unixepoch() OR NEW.expires_at<=unixepoch()
BEGIN
 UPDATE worker_tasks SET state='held',claim_hash=NULL
 WHERE issuer_token_hash=OLD.token_hash AND owner_id=OLD.owner_id
  AND state IN ('queued','claimed');
END;
