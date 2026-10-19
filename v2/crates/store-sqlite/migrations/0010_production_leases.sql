-- Preserve exact issued tokens for authenticated historical receipt replay.
CREATE TABLE production_run_leases (
 run_id TEXT NOT NULL REFERENCES production_runs(id),
 generation INTEGER NOT NULL CHECK(generation>0),
 lease_deadline_ms INTEGER NOT NULL,
 dispatch_fence INTEGER NOT NULL CHECK(dispatch_fence>0),
 purpose TEXT NOT NULL DEFAULT 'execution' CHECK(purpose IN ('execution','cancellation_acknowledgement')),
 PRIMARY KEY(run_id,generation)
);
INSERT INTO production_run_leases(run_id,generation,lease_deadline_ms,dispatch_fence)
 SELECT id,lease_generation,lease_deadline_ms,dispatch_fence FROM production_runs;
