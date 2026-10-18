-- Immutable issued-token history preserves authenticated committed observation replay.
-- The highest generation is current execution authority; prior rows grant no new writes.
CREATE TABLE fixture_run_leases (
 run_id TEXT NOT NULL REFERENCES fixture_runs(id),
 generation INTEGER NOT NULL CHECK(generation>0),
 lease_deadline_ms INTEGER NOT NULL,
 PRIMARY KEY(run_id,generation)
);
INSERT INTO fixture_run_leases(run_id,generation,lease_deadline_ms)
 SELECT id,lease_generation,lease_deadline_ms FROM fixture_runs;
