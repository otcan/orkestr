-- Explicit trusted-host continuation opt-in, separate from owner task lifetime.
-- Existing tasks and generic renewal acquire no extra authority on upgrade.
CREATE TABLE worker_running_budgets (
 run_id TEXT PRIMARY KEY REFERENCES production_runs(id),
 task_id TEXT NOT NULL UNIQUE REFERENCES worker_tasks(id),
 max_run_ms INTEGER NOT NULL CHECK(max_run_ms BETWEEN 1 AND 3600000),
 anchor_ms INTEGER NOT NULL CHECK(anchor_ms>0),
 deadline_ms INTEGER NOT NULL CHECK(deadline_ms=anchor_ms+max_run_ms),
 original_delegation_deadline_ms INTEGER NOT NULL CHECK(original_delegation_deadline_ms>0)
);
