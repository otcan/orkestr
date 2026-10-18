-- Native correlation is trusted protocol evidence, never browser input authority.
CREATE TABLE production_steering_turns (
 run_id TEXT PRIMARY KEY REFERENCES production_runs(id),
 native_turn_id TEXT NOT NULL CHECK(length(native_turn_id) BETWEEN 1 AND 128)
);
CREATE TABLE production_steering (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id),
 conversation_id TEXT NOT NULL REFERENCES conversations(id), run_id TEXT NOT NULL REFERENCES production_runs(id),
 request_key TEXT NOT NULL, semantic_digest TEXT NOT NULL, browser_token_hash TEXT NOT NULL,
 message_id TEXT NOT NULL UNIQUE REFERENCES messages(id), event_id TEXT NOT NULL UNIQUE REFERENCES events(id),
 scope_sequence INTEGER NOT NULL CHECK(scope_sequence>0),
 disposition TEXT NOT NULL CHECK(disposition IN ('reserved','queued_unsupported','queued_ordered')),
 state TEXT NOT NULL CHECK(state IN ('queued','reserved','delivery_unknown','acknowledged','rejected')),
 grant_hash TEXT, delivery_hash TEXT, written_bytes INTEGER NOT NULL DEFAULT 0 CHECK(written_bytes BETWEEN 0 AND 65536),
 UNIQUE(owner_id,conversation_id,request_key),
 CHECK((state='reserved' AND grant_hash IS NOT NULL AND delivery_hash IS NULL)
 OR (state='queued' AND grant_hash IS NULL AND delivery_hash IS NULL)
 OR (state IN ('delivery_unknown','acknowledged','rejected') AND grant_hash IS NULL AND delivery_hash IS NOT NULL))
);
-- Admission into steering consumes this exact inbox input once. Neither loss of
-- a reply nor native rejection ever makes it a new ordinary turn.
CREATE UNIQUE INDEX production_steering_one_pending ON production_steering(run_id)
 WHERE state IN ('reserved','delivery_unknown');
