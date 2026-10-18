-- Synthetic fixture only. No real provider, lifecycle journal or effect authority.
CREATE TABLE fixture_readiness (
 session_id TEXT PRIMARY KEY REFERENCES session_bindings(id),
 context_id TEXT NOT NULL REFERENCES fixture_supervisors(context_id),
 incarnation_id TEXT NOT NULL,
 protocol_version INTEGER NOT NULL CHECK(protocol_version = 1)
);
CREATE TABLE fixture_runs (
 id TEXT PRIMARY KEY,
 context_id TEXT NOT NULL REFERENCES fixture_supervisors(context_id),
 incarnation_id TEXT NOT NULL,
 owner_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
 session_id TEXT NOT NULL, native_session_id TEXT NOT NULL,
 binding_generation INTEGER NOT NULL CHECK(binding_generation > 0),
 message_id TEXT NOT NULL REFERENCES messages(id), event_id TEXT NOT NULL REFERENCES events(id),
 scope_sequence INTEGER NOT NULL, claim_generation INTEGER NOT NULL,
 request_key TEXT NOT NULL, input_digest TEXT NOT NULL,
 lease_generation INTEGER NOT NULL CHECK(lease_generation > 0),
 dispatch_fence INTEGER NOT NULL CHECK(dispatch_fence > 0),
 lease_deadline_ms INTEGER NOT NULL, attempt INTEGER NOT NULL CHECK(attempt = 1),
 state TEXT NOT NULL CHECK(state IN ('starting','blocked')),
 dispatch_state TEXT NOT NULL CHECK(dispatch_state IN ('candidate','reserved','delivery_unknown','quarantined')),
 candidate_hash TEXT, reservation_hash TEXT, reserve_key TEXT,
 UNIQUE(owner_id, conversation_id, request_key),
 UNIQUE(conversation_id, scope_sequence),
 FOREIGN KEY(session_id,owner_id,conversation_id) REFERENCES session_bindings(id,owner_id,conversation_id),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id),
 CHECK((dispatch_state='candidate' AND candidate_hash IS NOT NULL AND reservation_hash IS NULL)
 OR (dispatch_state='reserved' AND candidate_hash IS NOT NULL AND reservation_hash IS NOT NULL AND reserve_key IS NOT NULL)
 OR (dispatch_state IN ('delivery_unknown','quarantined') AND candidate_hash IS NULL AND reservation_hash IS NULL))
);
CREATE UNIQUE INDEX fixture_active_turn ON fixture_runs(session_id) WHERE state='starting';
ALTER TABLE reasoning_inbox ADD COLUMN admitted_fixture_run_id TEXT REFERENCES fixture_runs(id);
