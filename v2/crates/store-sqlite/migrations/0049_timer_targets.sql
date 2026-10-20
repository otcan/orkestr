-- Parallel-run timer import mapping: which owned conversation a dormant V1
-- timer was moved into, with a display label and its source thread reference.
-- Provenance only: enabling still requires an explicit owner grant, and an
-- enable for a mapped timer must target exactly this conversation.
CREATE TABLE dormant_timer_targets (
 owner_id TEXT NOT NULL, namespace TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 label TEXT NOT NULL CHECK(length(CAST(label AS BLOB)) BETWEEN 1 AND 200),
 source_thread_id TEXT NOT NULL CHECK(length(CAST(source_thread_id AS BLOB)) BETWEEN 1 AND 128),
 PRIMARY KEY(owner_id,namespace),
 FOREIGN KEY(owner_id,namespace) REFERENCES dormant_timers(owner_id,namespace),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
CREATE INDEX dormant_timer_targets_conversation ON dormant_timer_targets(owner_id,conversation_id);
CREATE TRIGGER dormant_timer_targets_no_update BEFORE UPDATE ON dormant_timer_targets
 BEGIN SELECT RAISE(ABORT,'immutable timer target'); END;
CREATE TRIGGER dormant_timer_targets_no_delete BEFORE DELETE ON dormant_timer_targets
 BEGIN SELECT RAISE(ABORT,'retain timer target provenance'); END;
