-- Core-reserved 0033 proposal. Core owns authoritative numbering/registration.
-- No session credential, bearer hash or legacy prompt is stored here.
CREATE TABLE durable_timer_authorities (
 owner_id TEXT NOT NULL, namespace TEXT NOT NULL, generation INTEGER NOT NULL CHECK(generation>0),
 authority_id TEXT NOT NULL UNIQUE, conversation_id TEXT NOT NULL REFERENCES conversations(id),
 request_key TEXT NOT NULL, expected_revision INTEGER NOT NULL CHECK(expected_revision>0),
 instruction TEXT NOT NULL CHECK(length(CAST(instruction AS BLOB)) BETWEEN 1 AND 32768),
 instruction_digest TEXT NOT NULL CHECK(length(instruction_digest)=64),
 stop_sequence INTEGER NOT NULL CHECK(stop_sequence>=0),
 PRIMARY KEY(owner_id,namespace,generation), UNIQUE(owner_id,namespace,request_key),
 FOREIGN KEY(owner_id,namespace,generation) REFERENCES dormant_timer_input_guards(owner_id,namespace,generation)
);
CREATE TRIGGER durable_timer_authorities_no_update BEFORE UPDATE ON durable_timer_authorities
 BEGIN SELECT RAISE(ABORT,'immutable timer instruction provenance'); END;
CREATE TRIGGER durable_timer_authorities_no_delete BEFORE DELETE ON durable_timer_authorities
 BEGIN SELECT RAISE(ABORT,'retain timer authority provenance'); END;
