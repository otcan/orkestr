-- Terminal restart validates the complete retained context and session history
-- under a short physical handoff. Cancelled/succeeded runs are deliberately
-- included: the occupied-session partial index cannot serve these lookups.
CREATE INDEX production_runs_context_lookup ON production_runs(context_id);
CREATE INDEX production_runs_session_generation ON production_runs(session_id,binding_generation);
