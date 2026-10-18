-- Production metadata is distinct from fixture evidence; prior event bytes stay intact.
PRAGMA defer_foreign_keys = ON;
DROP TRIGGER execution_run_insert;
DROP TRIGGER execution_run_update;
CREATE TABLE events_new (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id),
 conversation_id TEXT NOT NULL REFERENCES conversations(id),
 message_id TEXT REFERENCES messages(id), sequence INTEGER NOT NULL,
 occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 kind TEXT NOT NULL DEFAULT 'message_accepted' CHECK(kind IN ('message_accepted','fixture_provider_observed','fixture_cancellation_requested','fixture_provider_stopped','provider_observed')),
 schema_version INTEGER NOT NULL DEFAULT 1,
 UNIQUE(conversation_id, sequence),
 CHECK((kind='message_accepted' AND schema_version=1 AND message_id IS NOT NULL)
 OR (kind='fixture_provider_observed' AND schema_version=2 AND message_id IS NULL)
 OR (kind='fixture_cancellation_requested' AND schema_version=3 AND message_id IS NULL)
 OR (kind='fixture_provider_stopped' AND schema_version=4 AND message_id IS NULL)
 OR (kind='provider_observed' AND schema_version=5 AND message_id IS NULL))
);
INSERT INTO events_new SELECT * FROM events;
DROP TABLE events;
ALTER TABLE events_new RENAME TO events;
CREATE UNIQUE INDEX message_accepted_event ON events(message_id) WHERE kind='message_accepted';
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
 attempt INTEGER NOT NULL CHECK(attempt=1), state TEXT NOT NULL CHECK(state IN ('starting','running','awaiting_acceptance','failed','blocked')),
 dispatch_state TEXT NOT NULL CHECK(dispatch_state IN ('candidate','reserved','delivery_unknown','quarantined')),
 candidate_hash TEXT, reservation_hash TEXT, reserve_key TEXT,
 UNIQUE(owner_id,conversation_id,request_key), UNIQUE(conversation_id,scope_sequence),
 UNIQUE(session_id),
 FOREIGN KEY(session_id,owner_id,conversation_id) REFERENCES session_bindings(id,owner_id,conversation_id),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id),
 CHECK((dispatch_state='candidate' AND candidate_hash IS NOT NULL AND reservation_hash IS NULL)
 OR (dispatch_state='reserved' AND candidate_hash IS NOT NULL AND reservation_hash IS NOT NULL AND reserve_key IS NOT NULL)
 OR (dispatch_state IN ('delivery_unknown','quarantined') AND candidate_hash IS NULL AND reservation_hash IS NULL))
);
INSERT INTO production_runs_new SELECT * FROM production_runs;
DROP TABLE production_runs;
ALTER TABLE production_runs_new RENAME TO production_runs;
CREATE TRIGGER execution_run_insert AFTER INSERT ON production_runs BEGIN
 UPDATE execution_revisions SET revision=revision+1 WHERE conversation_id=NEW.conversation_id;
END;
CREATE TRIGGER execution_run_update AFTER UPDATE ON production_runs BEGIN
 UPDATE execution_revisions SET revision=revision+1 WHERE conversation_id=NEW.conversation_id;
END;
CREATE TABLE production_observations (
 event_id TEXT PRIMARY KEY REFERENCES events(id), run_id TEXT NOT NULL REFERENCES production_runs(id),
 run_sequence INTEGER NOT NULL CHECK(run_sequence>0), semantic_digest TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('started','approval_requested','completed_proposal','failed','lost')),
 lease_generation INTEGER NOT NULL CHECK(lease_generation>0), dispatch_fence INTEGER NOT NULL CHECK(dispatch_fence>0),
 receipt_state TEXT NOT NULL CHECK(receipt_state IN ('running','awaiting_acceptance','failed','blocked')),
 UNIQUE(run_id,run_sequence)
);
CREATE TEMP TABLE production_upgrade_fk_check (violations INTEGER CHECK(violations=0));
INSERT INTO production_upgrade_fk_check SELECT count(*) FROM pragma_foreign_key_check;
DROP TABLE production_upgrade_fk_check;
PRAGMA defer_foreign_keys = OFF;
