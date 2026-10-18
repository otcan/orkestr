-- Additive fixture cancellation; prior event bytes and migration checksums retained.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE events_new (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id),
 conversation_id TEXT NOT NULL REFERENCES conversations(id),
 message_id TEXT REFERENCES messages(id), sequence INTEGER NOT NULL,
 occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 kind TEXT NOT NULL DEFAULT 'message_accepted' CHECK(kind IN ('message_accepted','fixture_provider_observed','fixture_cancellation_requested','fixture_provider_stopped')),
 schema_version INTEGER NOT NULL DEFAULT 1,
 UNIQUE(conversation_id, sequence),
 CHECK((kind='message_accepted' AND schema_version=1 AND message_id IS NOT NULL)
 OR (kind='fixture_provider_observed' AND schema_version=2 AND message_id IS NULL)
 OR (kind='fixture_cancellation_requested' AND schema_version=3 AND message_id IS NULL)
 OR (kind='fixture_provider_stopped' AND schema_version=4 AND message_id IS NULL))
);
INSERT INTO events_new SELECT * FROM events;
DROP TABLE events;
ALTER TABLE events_new RENAME TO events;
CREATE UNIQUE INDEX message_accepted_event ON events(message_id) WHERE kind='message_accepted';
CREATE TABLE fixture_runs_new (
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
 state TEXT NOT NULL CHECK(state IN ('starting','running','awaiting_acceptance','failed','blocked','cancel_requested','cancelled')),
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
INSERT INTO fixture_runs_new SELECT * FROM fixture_runs;
DROP TABLE fixture_runs;
ALTER TABLE fixture_runs_new RENAME TO fixture_runs;
CREATE TABLE fixture_observations_new (
 event_id TEXT PRIMARY KEY REFERENCES events(id), run_id TEXT NOT NULL REFERENCES fixture_runs(id),
 run_sequence INTEGER NOT NULL CHECK(run_sequence>0), semantic_digest TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('started','approval_requested','completed_proposal','failed','lost','stopped')),
 synthetic INTEGER CHECK(synthetic IN (0,1)),
 lease_generation INTEGER NOT NULL CHECK(lease_generation>0),
 dispatch_fence INTEGER NOT NULL CHECK(dispatch_fence>0),
 receipt_state TEXT NOT NULL CHECK(receipt_state IN ('running','awaiting_acceptance','failed','blocked','cancelled')),
 UNIQUE(run_id,run_sequence),
 CHECK((kind='completed_proposal' AND synthetic IS NOT NULL) OR (kind!='completed_proposal' AND synthetic IS NULL)),
 CHECK((kind='stopped' AND receipt_state='cancelled') OR (kind!='stopped' AND receipt_state!='cancelled'))
);
INSERT INTO fixture_observations_new SELECT * FROM fixture_observations;
DROP TABLE fixture_observations;
ALTER TABLE fixture_observations_new RENAME TO fixture_observations;
CREATE UNIQUE INDEX fixture_occupied_session ON fixture_runs(session_id);
ALTER TABLE fixture_run_leases ADD COLUMN purpose TEXT NOT NULL DEFAULT 'execution'
 CHECK(purpose IN ('execution','cancellation_acknowledgement'));
ALTER TABLE fixture_run_leases ADD COLUMN dispatch_fence INTEGER NOT NULL DEFAULT 1 CHECK(dispatch_fence>0);
UPDATE fixture_run_leases SET dispatch_fence=(SELECT dispatch_fence FROM fixture_runs WHERE id=run_id);
CREATE TABLE fixture_cancellations (
 run_id TEXT PRIMARY KEY REFERENCES fixture_runs(id),
 event_id TEXT NOT NULL UNIQUE REFERENCES events(id),
 request_key TEXT NOT NULL,
 lease_generation INTEGER NOT NULL CHECK(lease_generation>0),
 dispatch_fence INTEGER NOT NULL CHECK(dispatch_fence>0),
 lease_deadline_ms INTEGER NOT NULL,
 receipt_state TEXT NOT NULL CHECK(receipt_state IN ('cancel_requested','cancelled')),
 inflight_status TEXT NOT NULL CHECK(inflight_status IN ('not_dispatched','unknown')),
 UNIQUE(event_id,run_id),
 FOREIGN KEY(run_id,lease_generation) REFERENCES fixture_run_leases(run_id,generation),
 CHECK((receipt_state='cancelled' AND inflight_status='not_dispatched')
 OR (receipt_state='cancel_requested' AND inflight_status='unknown'))
);
-- Separate from public journal delivery; a row does not itself grant provider I/O.
CREATE TABLE fixture_control_outbox (
 event_id TEXT PRIMARY KEY,
 run_id TEXT NOT NULL UNIQUE REFERENCES fixture_runs(id),
 state TEXT NOT NULL CHECK(state IN ('not_dispatched','pending','acknowledged')),
 FOREIGN KEY(event_id,run_id) REFERENCES fixture_cancellations(event_id,run_id)
);
-- Fail the migration if any inbound link was lost during either table rebuild.
CREATE TEMP TABLE fixture_upgrade_fk_check (violations INTEGER CHECK(violations=0));
INSERT INTO fixture_upgrade_fk_check SELECT count(*) FROM pragma_foreign_key_check;
DROP TABLE fixture_upgrade_fk_check;
PRAGMA defer_foreign_keys = OFF;
