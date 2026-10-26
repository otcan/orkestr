-- Fresh Fast identities and historical context are separate from Worker keys.
-- No input, run, settings, native identity or historical dispatch is rewritten.
CREATE TABLE production_fast_continuity (
 session_id TEXT PRIMARY KEY REFERENCES session_bindings(id),
 predecessor_session_id TEXT UNIQUE REFERENCES session_bindings(id),
 context_id TEXT NOT NULL REFERENCES production_supervisors(context_id),
 incarnation_id TEXT NOT NULL,
 created_at_ms INTEGER NOT NULL
);
CREATE TABLE production_fast_digests (
 run_id TEXT PRIMARY KEY REFERENCES production_runs(id),
 session_id TEXT NOT NULL REFERENCES production_fast_continuity(session_id),
 source_event_id TEXT NOT NULL REFERENCES events(id),
 cutoff_sequence INTEGER NOT NULL CHECK(cutoff_sequence>0),
 digest_text TEXT NOT NULL CHECK(length(CAST(digest_text AS BLOB))<=8192)
);
