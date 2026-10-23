-- Native-reported model evidence is bound to the exact observation envelope.
CREATE TABLE production_run_models (
 id TEXT PRIMARY KEY,
 run_id TEXT NOT NULL REFERENCES production_runs(id),
 source TEXT NOT NULL CHECK(source IN ('resolved','answer','refused')),
 model TEXT NOT NULL CHECK(length(model) BETWEEN 1 AND 120),
 request_key TEXT NOT NULL,
 semantic_digest TEXT NOT NULL,
 sequence INTEGER NOT NULL CHECK(sequence>0),
 observed_at_ms INTEGER NOT NULL,
 UNIQUE(run_id,request_key),
 UNIQUE(run_id,sequence)
);
CREATE INDEX production_run_models_run ON production_run_models(run_id);
CREATE TRIGGER execution_model_insert AFTER INSERT ON production_run_models BEGIN
 UPDATE execution_revisions SET revision=revision+1
 WHERE conversation_id=(SELECT conversation_id FROM production_runs WHERE id=NEW.run_id);
END;

-- Extend the closed presentation class without rewriting old observations.
ALTER TABLE production_failure_classes RENAME TO production_failure_classes_before_policy;
CREATE TABLE production_failure_classes (
 event_id TEXT PRIMARY KEY REFERENCES production_observations(event_id),
 run_id TEXT NOT NULL REFERENCES production_runs(id),
 class TEXT NOT NULL CHECK(class IN ('authentication','quota','billing','provider','unknown','policy'))
);
INSERT INTO production_failure_classes SELECT * FROM production_failure_classes_before_policy;
DROP TABLE production_failure_classes_before_policy;
