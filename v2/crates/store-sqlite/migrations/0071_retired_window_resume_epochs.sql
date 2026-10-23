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
