-- Instruction text an agent set for its own timer while one of that timer's
-- runs was still queued or running (ORK-756). A new timer generation would
-- fence that run, so the text is recorded against the current generation
-- instead. The next firing of that generation uses the newest row in place of
-- the generation's original instruction; a later generation never reads it.
-- Rows are append-only provenance, like durable_timer_authorities.
CREATE TABLE agent_timer_instruction_updates (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 owner_id TEXT NOT NULL,
 namespace TEXT NOT NULL,
 generation INTEGER NOT NULL CHECK(generation>0),
 request_key TEXT NOT NULL CHECK(length(CAST(request_key AS BLOB)) BETWEEN 1 AND 128),
 instruction TEXT NOT NULL CHECK(length(CAST(instruction AS BLOB)) BETWEEN 1 AND 32768),
 instruction_digest TEXT NOT NULL CHECK(length(instruction_digest)=64),
 created_ms INTEGER NOT NULL,
 UNIQUE(owner_id,namespace,generation,request_key),
 FOREIGN KEY(owner_id,namespace) REFERENCES agent_timers(owner_id,namespace),
 FOREIGN KEY(owner_id,namespace,generation) REFERENCES durable_timer_authorities(owner_id,namespace,generation)
);
CREATE TRIGGER agent_timer_instruction_updates_fixed BEFORE UPDATE ON agent_timer_instruction_updates
 BEGIN SELECT RAISE(ABORT,'immutable timer instruction update'); END;
CREATE TRIGGER agent_timer_instruction_updates_no_delete BEFORE DELETE ON agent_timer_instruction_updates
 BEGIN SELECT RAISE(ABORT,'retain timer instruction update'); END;
