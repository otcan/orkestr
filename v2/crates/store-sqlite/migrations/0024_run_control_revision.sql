-- Projection revision continues to change on every published progress sample.
-- Control CAS changes only with this exact run's dispatch/control state.
CREATE TABLE production_control_revisions (
 run_id TEXT PRIMARY KEY REFERENCES production_runs(id),
 revision INTEGER NOT NULL CHECK(revision>0)
);
INSERT INTO production_control_revisions SELECT id,1 FROM production_runs;
CREATE TRIGGER production_control_revision_insert AFTER INSERT ON production_runs BEGIN
 INSERT INTO production_control_revisions(run_id,revision) VALUES(NEW.id,1);
END;
CREATE TRIGGER production_control_revision_update AFTER UPDATE ON production_runs
WHEN OLD.state!=NEW.state OR OLD.dispatch_state!=NEW.dispatch_state
 OR OLD.dispatch_fence!=NEW.dispatch_fence OR OLD.incarnation_id!=NEW.incarnation_id
BEGIN
 UPDATE production_control_revisions SET revision=revision+1 WHERE run_id=NEW.id;
END;
ALTER TABLE production_cancellations ADD COLUMN request_control_revision INTEGER CHECK(request_control_revision>0);
