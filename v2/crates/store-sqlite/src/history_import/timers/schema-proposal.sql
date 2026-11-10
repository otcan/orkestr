-- Proposal only. Core owns authoritative migration 0027 and registration.
CREATE TABLE dormant_timers (
 owner_id TEXT NOT NULL REFERENCES owners(id), namespace TEXT NOT NULL,
 source_namespace TEXT NOT NULL, source_timer_id TEXT NOT NULL,
 source_enabled INTEGER NOT NULL CHECK(source_enabled IN (0,1)),
 source_digest TEXT NOT NULL, schedule_json TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('paused','enabled','disabled','stopped','rolled_back','exhausted')),
 dormant_reason TEXT, revision INTEGER NOT NULL CHECK(revision>0),
 generation INTEGER NOT NULL CHECK(generation>=0), conversation_id TEXT REFERENCES conversations(id),
 next_due_ms INTEGER, PRIMARY KEY(owner_id,namespace),
 UNIQUE(owner_id,source_namespace,source_timer_id),
 CHECK((state='enabled' AND conversation_id IS NOT NULL AND next_due_ms IS NOT NULL) OR state!='enabled')
);
CREATE TABLE dormant_timer_controls (
 owner_id TEXT NOT NULL, namespace TEXT NOT NULL, request_key TEXT NOT NULL,
 semantic_digest TEXT NOT NULL, action TEXT NOT NULL CHECK(action IN ('enable','disable','stop','rollback')),
 receipt_revision INTEGER NOT NULL, generation INTEGER NOT NULL,
 conversation_id TEXT, due_ms INTEGER,
 PRIMARY KEY(owner_id,namespace,request_key),
 FOREIGN KEY(owner_id,namespace) REFERENCES dormant_timers(owner_id,namespace)
);
CREATE TABLE dormant_timer_claims (
 owner_id TEXT NOT NULL, namespace TEXT NOT NULL, request_key TEXT NOT NULL,
 generation INTEGER NOT NULL, due_ms INTEGER NOT NULL, claim_id TEXT NOT NULL UNIQUE,
 conversation_id TEXT NOT NULL REFERENCES conversations(id), source_digest TEXT NOT NULL,
 cancelled INTEGER NOT NULL DEFAULT 0 CHECK(cancelled IN (0,1)),
 PRIMARY KEY(owner_id,namespace,request_key), UNIQUE(owner_id,namespace,generation,due_ms),
 FOREIGN KEY(owner_id,namespace) REFERENCES dormant_timers(owner_id,namespace)
);
