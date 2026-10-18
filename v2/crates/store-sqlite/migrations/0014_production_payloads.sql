PRAGMA defer_foreign_keys = ON;
CREATE TABLE events_new (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id),
 conversation_id TEXT NOT NULL REFERENCES conversations(id),
 message_id TEXT REFERENCES messages(id), sequence INTEGER NOT NULL,
 occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 kind TEXT NOT NULL DEFAULT 'message_accepted' CHECK(kind IN ('message_accepted','fixture_provider_observed','fixture_cancellation_requested','fixture_provider_stopped','provider_observed','cancellation_requested','provider_stopped')),
 schema_version INTEGER NOT NULL DEFAULT 1,
 UNIQUE(conversation_id, sequence),
 CHECK((kind='message_accepted' AND schema_version=1 AND message_id IS NOT NULL)
 OR (kind='fixture_provider_observed' AND schema_version=2 AND message_id IS NULL)
 OR (kind='fixture_cancellation_requested' AND schema_version=3 AND message_id IS NULL)
 OR (kind='fixture_provider_stopped' AND schema_version=4 AND message_id IS NULL)
 OR (kind='provider_observed' AND schema_version IN (5,8) AND message_id IS NULL)
 OR (kind='cancellation_requested' AND schema_version=6 AND message_id IS NULL)
 OR (kind='provider_stopped' AND schema_version=7 AND message_id IS NULL))
);
INSERT INTO events_new SELECT * FROM events;
DROP TABLE events;
ALTER TABLE events_new RENAME TO events;
CREATE UNIQUE INDEX message_accepted_event ON events(message_id) WHERE kind='message_accepted';
CREATE TABLE production_observations_new (
 event_id TEXT PRIMARY KEY REFERENCES events(id), run_id TEXT NOT NULL REFERENCES production_runs(id),
 run_sequence INTEGER NOT NULL CHECK(run_sequence>0), semantic_digest TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('started','approval_requested','completed_proposal','failed','lost','stopped','progress')),
 lease_generation INTEGER NOT NULL CHECK(lease_generation>0),
 dispatch_fence INTEGER NOT NULL CHECK(dispatch_fence>0),
 receipt_state TEXT NOT NULL CHECK(receipt_state IN ('running','awaiting_acceptance','failed','blocked','cancelled')),
 UNIQUE(run_id,run_sequence),
 CHECK((kind='stopped' AND receipt_state='cancelled') OR (kind!='stopped' AND receipt_state!='cancelled'))
);
INSERT INTO production_observations_new(event_id,run_id,run_sequence,semantic_digest,kind,lease_generation,dispatch_fence,receipt_state)
 SELECT event_id,run_id,run_sequence,semantic_digest,kind,lease_generation,dispatch_fence,receipt_state FROM production_observations;
DROP TABLE production_observations;
ALTER TABLE production_observations_new RENAME TO production_observations;
CREATE TABLE production_payloads (
 id TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE REFERENCES production_observations(event_id),
 owner_id TEXT NOT NULL REFERENCES owners(id), conversation_id TEXT NOT NULL,
 run_id TEXT NOT NULL REFERENCES production_runs(id),
 text TEXT CHECK(text IS NULL OR length(CAST(text AS BLOB))<=8192),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
CREATE TEMP TABLE payload_upgrade_fk_check (violations INTEGER CHECK(violations=0));
INSERT INTO payload_upgrade_fk_check SELECT count(*) FROM pragma_foreign_key_check;
DROP TABLE payload_upgrade_fk_check;
PRAGMA defer_foreign_keys = OFF;
