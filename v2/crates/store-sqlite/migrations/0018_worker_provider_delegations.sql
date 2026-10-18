-- Independent native provider Worker authority, never a Deep inbox claim.
CREATE TABLE worker_provider_delegations (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES owners(id),
 conversation_id TEXT NOT NULL,
 parent_run_id TEXT NOT NULL REFERENCES production_runs(id),
 parent_session_id TEXT NOT NULL,
 context_id TEXT NOT NULL REFERENCES production_supervisors(context_id),
 incarnation_id TEXT NOT NULL,
 parent_binding_generation INTEGER NOT NULL CHECK(parent_binding_generation>0),
 parent_lease_generation INTEGER NOT NULL CHECK(parent_lease_generation>0),
 parent_dispatch_fence INTEGER NOT NULL CHECK(parent_dispatch_fence>0),
 parent_deadline_ms INTEGER NOT NULL,
 worker_session_id TEXT NOT NULL,
 worker_binding_generation INTEGER NOT NULL CHECK(worker_binding_generation>0),
 source_message_id TEXT NOT NULL REFERENCES messages(id),
 source_event_id TEXT NOT NULL REFERENCES events(id),
 request_key TEXT NOT NULL,
 input_digest TEXT NOT NULL,
 requested_lifetime_ms INTEGER NOT NULL CHECK(requested_lifetime_ms BETWEEN 1 AND 30000),
 expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms<=parent_deadline_ms),
 state TEXT NOT NULL CHECK(state IN ('delegated','admitted','blocked')),
 grant_hash TEXT,
 admitted_run_id TEXT UNIQUE REFERENCES production_runs(id),
 UNIQUE(owner_id,parent_run_id,request_key),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id),
 FOREIGN KEY(parent_session_id,owner_id,conversation_id) REFERENCES session_bindings(id,owner_id,conversation_id),
 FOREIGN KEY(worker_session_id,owner_id,conversation_id) REFERENCES session_bindings(id,owner_id,conversation_id),
 CHECK(worker_session_id!=parent_session_id),
 CHECK((state='delegated' AND grant_hash IS NOT NULL AND admitted_run_id IS NULL)
 OR (state='admitted' AND grant_hash IS NULL AND admitted_run_id IS NOT NULL)
 OR (state='blocked' AND grant_hash IS NULL))
);
-- Preserve genuine parent evidence while removing every unused descendant grant.
CREATE TRIGGER worker_provider_parent_fence AFTER UPDATE ON production_runs BEGIN
 UPDATE worker_provider_delegations SET state='blocked',grant_hash=NULL
 WHERE parent_run_id=NEW.id AND state='delegated'
 AND (NEW.state!='running' OR NEW.dispatch_state!='delivery_unknown'
 OR NEW.lease_generation!=parent_lease_generation OR NEW.dispatch_fence!=parent_dispatch_fence
 OR NEW.binding_generation!=parent_binding_generation OR NEW.lease_deadline_ms!=parent_deadline_ms);
END;
