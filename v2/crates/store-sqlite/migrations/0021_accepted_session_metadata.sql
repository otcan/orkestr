-- Setup-only continuation reservation. It never grants provider inference.
CREATE TABLE production_resume_metadata (
    id TEXT PRIMARY KEY NOT NULL,
    prior_run_id TEXT NOT NULL UNIQUE REFERENCES production_runs(id),
    acceptance_event_id TEXT NOT NULL REFERENCES events(id),
    context_id TEXT NOT NULL,
    incarnation_id TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES session_bindings(id),
    binding_generation INTEGER NOT NULL CHECK(binding_generation > 0),
    state TEXT NOT NULL CHECK(state IN ('issued','confirmed')),
    confirmation_digest TEXT,
    CHECK((state='issued' AND confirmation_digest IS NULL) OR
          (state='confirmed' AND length(confirmation_digest)=64))
);
