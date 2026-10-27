-- Read-only parallel Deep runtime (docs/v2/parallel-deep.md, phase 2).
-- A Deep run records the Deep slot of the session it ran on (0 = the
-- canonical writer), copied at admission. Existing runs are slot 0.
ALTER TABLE production_runs ADD COLUMN deep_slot INTEGER NOT NULL DEFAULT 0
 CHECK(deep_slot BETWEEN 0 AND 3 AND (deep_slot = 0 OR role = 'deep'));
-- One canonical Deep run per inbox input, and at most one parallel run. A
-- parallel run that deferred (PARALLEL_DEFER) returns its input to the
-- writer, which then takes it exactly once. The claim index is keyed on
-- (deep_slot>0) and keeps the old `role='deep'` partial predicate, so every
-- existing Deep query keeps its index plan (grouping, stranded, status).
-- The parallel-only index (empty while the switch is off) serves the slot
-- lookups.
DROP INDEX production_deep_claim;
CREATE UNIQUE INDEX production_deep_claim ON production_runs(conversation_id,scope_sequence,deep_slot>0)
 WHERE role='deep';
CREATE UNIQUE INDEX production_parallel_deep_claim ON production_runs(conversation_id,scope_sequence)
 WHERE role='deep' AND deep_slot>0;
-- An accepted parallel answer that was exactly the defer marker. The input
-- went back to the writer's queue; a slot never takes it again.
CREATE TABLE production_parallel_deep_deferrals (
 event_id TEXT PRIMARY KEY REFERENCES events(id),
 run_id TEXT NOT NULL UNIQUE REFERENCES production_runs(id),
 deferred_at_ms INTEGER NOT NULL
);
-- Which writer turn first carried each accepted parallel answer in its
-- handoff note, so every answer is noted once.
CREATE TABLE production_parallel_deep_notes (
 run_id TEXT PRIMARY KEY REFERENCES production_runs(id),
 noted_by_run_id TEXT NOT NULL REFERENCES production_runs(id)
);
