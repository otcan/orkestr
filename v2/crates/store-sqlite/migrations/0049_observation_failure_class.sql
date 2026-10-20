-- Closed provider failure class (presentation evidence) for a failed
-- observation. Never provider text. Absent for unclassified failures; the
-- class is also bound into the observation's semantic digest.
CREATE TABLE production_failure_classes (
 event_id TEXT PRIMARY KEY REFERENCES production_observations(event_id),
 run_id TEXT NOT NULL REFERENCES production_runs(id),
 class TEXT NOT NULL CHECK(class IN ('authentication','quota','billing','provider','unknown'))
);
