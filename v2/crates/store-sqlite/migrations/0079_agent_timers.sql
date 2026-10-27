-- Agent-facing timers (TASK-52): a running Deep turn may create, cancel,
-- pause, resume and skip timers of its OWN conversation only.
-- Additive only. Requires 0078 (#341, thread asks) first; #348 (parallel
-- Fast) renumbers to 0080 after this one. The grant design is the thread-ask grant's, with a separate grant so a
-- thread-ask grant never implies timer authority and vice versa.
CREATE TABLE agent_timer_grants (
 conversation_id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 -- NULL once revoked; the generation never decreases.
 grant_hash TEXT CHECK(grant_hash IS NULL OR (length(grant_hash)=64 AND grant_hash NOT GLOB '*[^0-9a-f]*')),
 generation INTEGER NOT NULL CHECK(generation>0),
 issued_ms INTEGER NOT NULL,
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
CREATE UNIQUE INDEX agent_timer_grant_hash ON agent_timer_grants(grant_hash) WHERE grant_hash IS NOT NULL;

-- Provenance of each timer an agent created. The conversation is the
-- grant's, never a request field, and is immutable like the timer mapping.
CREATE TABLE agent_timers (
 owner_id TEXT NOT NULL,
 namespace TEXT NOT NULL CHECK(length(namespace)=36),
 conversation_id TEXT NOT NULL,
 request_key TEXT NOT NULL CHECK(length(request_key) BETWEEN 1 AND 128),
 -- SHA-256 of the exact request (label, schedule, text): a replay must match.
 request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
 created_run_id TEXT NOT NULL REFERENCES production_runs(id),
 grant_generation INTEGER NOT NULL CHECK(grant_generation>0),
 created_ms INTEGER NOT NULL,
 PRIMARY KEY(owner_id,namespace),
 UNIQUE(owner_id,conversation_id,request_key),
 FOREIGN KEY(owner_id,namespace) REFERENCES dormant_timers(owner_id,namespace),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
CREATE INDEX agent_timers_conversation ON agent_timers(owner_id,conversation_id,created_ms);
CREATE TRIGGER agent_timers_fixed BEFORE UPDATE ON agent_timers
BEGIN SELECT RAISE(ABORT,'agent timer provenance is fixed'); END;
CREATE TRIGGER agent_timers_no_delete BEFORE DELETE ON agent_timers
BEGIN SELECT RAISE(ABORT,'agent timer provenance is fixed'); END;

-- Append-only audit of every authenticated attempt, accepted or refused.
CREATE TABLE agent_timer_audit (
 row_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 owner_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 run_id TEXT,
 grant_generation INTEGER NOT NULL,
 operation TEXT NOT NULL CHECK(operation IN ('create','cancel','pause','resume','skip_next')),
 namespace TEXT CHECK(namespace IS NULL OR length(namespace)=36),
 request_key TEXT NOT NULL CHECK(length(request_key) BETWEEN 1 AND 128),
 outcome TEXT NOT NULL CHECK(length(outcome) BETWEEN 1 AND 64),
 at_ms INTEGER NOT NULL,
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
CREATE INDEX agent_timer_audit_rate ON agent_timer_audit(conversation_id,outcome,at_ms);
CREATE TRIGGER agent_timer_audit_append_only BEFORE UPDATE ON agent_timer_audit
BEGIN SELECT RAISE(ABORT,'agent timer audit is append-only'); END;
CREATE TRIGGER agent_timer_audit_no_delete BEFORE DELETE ON agent_timer_audit
BEGIN SELECT RAISE(ABORT,'agent timer audit is append-only'); END;
