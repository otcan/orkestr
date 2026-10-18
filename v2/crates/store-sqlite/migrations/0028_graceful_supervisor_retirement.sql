-- No backfill: an expired/zero deadline is not proof of graceful retirement.
CREATE TABLE production_graceful_retirements (
 context_id TEXT NOT NULL REFERENCES production_supervisors(context_id),
 incarnation_id TEXT NOT NULL,
 supervisor_generation INTEGER NOT NULL CHECK(supervisor_generation>0),
 prior_run_id TEXT NOT NULL REFERENCES production_acceptances(run_id),
 acceptance_event_id TEXT NOT NULL REFERENCES production_acceptances(event_id),
 session_id TEXT NOT NULL REFERENCES session_bindings(id),
 binding_generation INTEGER NOT NULL CHECK(binding_generation>0),
 retired_at_ms INTEGER NOT NULL CHECK(retired_at_ms>0),
 PRIMARY KEY(context_id,incarnation_id,supervisor_generation),
 UNIQUE(prior_run_id)
);
