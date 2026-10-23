-- Preserve every input and foreign link while adding a distinct terminal state.
PRAGMA defer_foreign_keys = ON;
DROP VIEW ordinary_input_holds;
CREATE TABLE reasoning_inbox_new (
 conversation_id TEXT NOT NULL REFERENCES conversations(id), sequence INTEGER NOT NULL,
 message_id TEXT NOT NULL UNIQUE REFERENCES messages(id), event_id TEXT NOT NULL UNIQUE REFERENCES events(id),
 state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','claimed','consumed','retired')),
 claimant_session_id TEXT REFERENCES session_bindings(id),
 claim_generation INTEGER NOT NULL DEFAULT 0 CHECK(claim_generation>=0),
 claim_deadline_ms INTEGER,
 admitted_fixture_run_id TEXT REFERENCES fixture_runs(id),
 admitted_run_id TEXT REFERENCES production_runs(id),
 PRIMARY KEY(conversation_id,sequence)
);
INSERT INTO reasoning_inbox_new SELECT * FROM reasoning_inbox;
DROP TABLE reasoning_inbox;
ALTER TABLE reasoning_inbox_new RENAME TO reasoning_inbox;
CREATE INDEX inbox_lease ON reasoning_inbox(conversation_id,state,sequence);
CREATE TRIGGER execution_inbox_insert AFTER INSERT ON reasoning_inbox BEGIN
 UPDATE execution_revisions SET revision=revision+1 WHERE conversation_id=NEW.conversation_id;
END;
CREATE TRIGGER execution_inbox_update AFTER UPDATE ON reasoning_inbox BEGIN
 UPDATE execution_revisions SET revision=revision+1 WHERE conversation_id=NEW.conversation_id;
END;

CREATE TABLE owner_input_retirements (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES owners(id),
 conversation_id TEXT NOT NULL,
 message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
 event_id TEXT NOT NULL UNIQUE REFERENCES events(id),
 scope_sequence INTEGER NOT NULL,
 request_key TEXT NOT NULL,
 reason TEXT NOT NULL CHECK(length(reason)>0 AND length(reason)<=512),
 retired_at_ms INTEGER NOT NULL,
 receipt_json TEXT NOT NULL,
 UNIQUE(owner_id,conversation_id,request_key),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id),
 FOREIGN KEY(conversation_id,scope_sequence) REFERENCES reasoning_inbox(conversation_id,sequence)
);
CREATE TRIGGER owner_input_retirements_no_update BEFORE UPDATE ON owner_input_retirements BEGIN
 SELECT RAISE(ABORT,'immutable_input_retirement');
END;
CREATE TRIGGER owner_input_retirements_no_delete BEFORE DELETE ON owner_input_retirements BEGIN
 SELECT RAISE(ABORT,'immutable_input_retirement');
END;
CREATE TRIGGER retired_input_terminal BEFORE UPDATE ON reasoning_inbox WHEN OLD.state='retired' BEGIN
 SELECT RAISE(ABORT,'retired_input_terminal');
END;
CREATE TRIGGER retired_input_no_delete BEFORE DELETE ON reasoning_inbox WHEN OLD.state='retired' BEGIN
 SELECT RAISE(ABORT,'retired_input_terminal');
END;
CREATE TRIGGER retired_input_requires_receipt BEFORE UPDATE OF state ON reasoning_inbox
 WHEN NEW.state='retired' AND NOT EXISTS(SELECT 1 FROM owner_input_retirements r
 WHERE r.conversation_id=NEW.conversation_id AND r.scope_sequence=NEW.sequence
 AND r.message_id=NEW.message_id AND r.event_id=NEW.event_id) BEGIN
 SELECT RAISE(ABORT,'input_retirement_receipt_required');
END;

-- Negative authority shared by Fast, Deep, workers and window admission.
-- Stop/resume and timer changes cannot remove an owner retirement.
CREATE VIEW ordinary_input_holds AS
 SELECT event_id FROM production_held_inputs
 UNION SELECT event_id FROM owner_input_retirements
 UNION SELECT i.event_id FROM dormant_timer_inputs i
 JOIN dormant_timer_claims c ON c.claim_id=i.claim_id
 JOIN dormant_timers t ON t.owner_id=i.owner_id AND t.namespace=i.namespace
 WHERE c.cancelled=1 OR c.generation!=i.generation OR t.generation!=i.generation
    OR t.state NOT IN ('enabled','exhausted');
CREATE TEMP TABLE input_retirement_upgrade_fk_check (violations INTEGER CHECK(violations=0));
INSERT INTO input_retirement_upgrade_fk_check SELECT count(*) FROM pragma_foreign_key_check;
DROP TABLE input_retirement_upgrade_fk_check;
PRAGMA defer_foreign_keys = OFF;
