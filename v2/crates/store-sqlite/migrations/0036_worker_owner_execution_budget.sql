-- NULL preserves legacy owner lifetime; host opt-in alone cannot widen it.
ALTER TABLE worker_tasks ADD COLUMN execution_budget_ms INTEGER
 CHECK(execution_budget_ms IS NULL OR (execution_budget_ms BETWEEN lifetime_ms AND 3600000));
-- Store the effective owner/host minimum while retaining the requested host cap.
ALTER TABLE worker_running_budgets RENAME TO worker_running_budgets_old;
CREATE TABLE worker_running_budgets (
 run_id TEXT PRIMARY KEY REFERENCES production_runs(id),
 task_id TEXT NOT NULL UNIQUE REFERENCES worker_tasks(id),
 max_run_ms INTEGER NOT NULL CHECK(max_run_ms BETWEEN 1 AND 3600000),
 anchor_ms INTEGER NOT NULL CHECK(anchor_ms>0),
 deadline_ms INTEGER NOT NULL CHECK(deadline_ms>anchor_ms AND deadline_ms<=anchor_ms+max_run_ms),
 original_delegation_deadline_ms INTEGER NOT NULL CHECK(original_delegation_deadline_ms>0)
);
INSERT INTO worker_running_budgets SELECT * FROM worker_running_budgets_old;
DROP TABLE worker_running_budgets_old;
