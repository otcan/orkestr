-- Calendar timers: per-timer policy (silent mode, pause, skip dates, digest,
-- event trigger), per-conversation pause, run outcomes, digests and trigger
-- events. The schedule itself stays in dormant_timers.schedule_json; a policy
-- row never grants execution authority and never changes a timer's generation.
CREATE TABLE timer_policies (
 owner_id TEXT NOT NULL, namespace TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0),
 silent_mode TEXT NOT NULL DEFAULT 'off' CHECK(silent_mode IN ('off','unless_changed')),
 pause_until_ms INTEGER CHECK(pause_until_ms IS NULL OR pause_until_ms>=0),
 skip_dates_json TEXT NOT NULL DEFAULT '[]',
 skip_timezone TEXT,
 digest_json TEXT,
 digest_since_ms INTEGER,
 trigger_json TEXT,
 updated_ms INTEGER NOT NULL,
 PRIMARY KEY(owner_id,namespace),
 FOREIGN KEY(owner_id,namespace) REFERENCES dormant_timers(owner_id,namespace)
);
CREATE TABLE conversation_timer_pauses (
 owner_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
 pause_until_ms INTEGER NOT NULL CHECK(pause_until_ms>=0),
 updated_ms INTEGER NOT NULL,
 PRIMARY KEY(owner_id,conversation_id),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
CREATE TABLE timer_outcomes (
 claim_id TEXT PRIMARY KEY REFERENCES dormant_timer_claims(claim_id),
 owner_id TEXT NOT NULL, namespace TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('delivered','silent','digest')),
 summary TEXT NOT NULL CHECK(length(CAST(summary AS BLOB))<=1200),
 recorded_ms INTEGER NOT NULL,
 digest_id TEXT,
 FOREIGN KEY(owner_id,namespace) REFERENCES dormant_timers(owner_id,namespace)
);
CREATE INDEX timer_outcomes_timer ON timer_outcomes(owner_id,namespace,recorded_ms);
CREATE TABLE timer_digests (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL, namespace TEXT NOT NULL, conversation_id TEXT NOT NULL,
 slot_ms INTEGER NOT NULL,
 text TEXT NOT NULL, item_count INTEGER NOT NULL CHECK(item_count>=0),
 created_ms INTEGER NOT NULL, delivered_ms INTEGER,
 UNIQUE(owner_id,namespace,slot_ms),
 FOREIGN KEY(owner_id,namespace) REFERENCES dormant_timers(owner_id,namespace)
);
CREATE INDEX timer_digests_pending ON timer_digests(owner_id,conversation_id,delivered_ms);
CREATE TABLE timer_trigger_events (
 owner_id TEXT NOT NULL, namespace TEXT NOT NULL, event_key TEXT NOT NULL,
 source TEXT NOT NULL CHECK(source IN ('message','email','other')),
 received_ms INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','admitted','coalesced','suppressed')),
 claim_id TEXT,
 PRIMARY KEY(owner_id,namespace,event_key),
 FOREIGN KEY(owner_id,namespace) REFERENCES dormant_timers(owner_id,namespace)
);
CREATE INDEX timer_trigger_events_pending ON timer_trigger_events(owner_id,state,received_ms);
