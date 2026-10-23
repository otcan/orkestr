-- A proven retired window may have confirmed metadata without a later run.
-- Each new supervisor incarnation gets its own one-use setup reservation;
-- old reservations and confirmations remain immutable historical evidence.
CREATE TABLE production_resume_metadata_new (
 id TEXT PRIMARY KEY NOT NULL,
 prior_run_id TEXT NOT NULL REFERENCES production_runs(id),
 terminal_event_id TEXT NOT NULL REFERENCES events(id),
 context_id TEXT NOT NULL,
 incarnation_id TEXT NOT NULL,
 session_id TEXT NOT NULL REFERENCES session_bindings(id),
 binding_generation INTEGER NOT NULL CHECK(binding_generation>0),
 state TEXT NOT NULL CHECK(state IN ('issued','confirmed')),
 confirmation_digest TEXT,
 CHECK((state='issued' AND confirmation_digest IS NULL) OR
       (state='confirmed' AND length(confirmation_digest)=64)),
 UNIQUE(prior_run_id,incarnation_id)
);
INSERT INTO production_resume_metadata_new SELECT * FROM production_resume_metadata;
DROP TABLE production_resume_metadata;
ALTER TABLE production_resume_metadata_new RENAME TO production_resume_metadata;

-- Metadata-only initialization does not advance the Claude binding generation.
-- Keep its unobserved history separate from the successor's actual observation.
CREATE TABLE production_requested_native_new (
 session_id TEXT NOT NULL REFERENCES session_bindings(id),
 binding_generation INTEGER NOT NULL CHECK(binding_generation>0),
 context_id TEXT NOT NULL REFERENCES production_supervisors(context_id),
 incarnation_id TEXT NOT NULL,
 requested_native_id TEXT NOT NULL,
 initialization_key TEXT NOT NULL,
 observed_run_id TEXT REFERENCES production_runs(id),
 observed_event_key TEXT,
 PRIMARY KEY(session_id,binding_generation,incarnation_id),
 CHECK((observed_run_id IS NULL AND observed_event_key IS NULL) OR
       (observed_run_id IS NOT NULL AND observed_event_key IS NOT NULL))
);
INSERT INTO production_requested_native_new SELECT * FROM production_requested_native;
DROP TABLE production_requested_native;
ALTER TABLE production_requested_native_new RENAME TO production_requested_native;
