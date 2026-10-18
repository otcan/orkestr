-- Independent of journal cursors: dispatch changes need a read-model revision too.
CREATE TABLE execution_revisions (
 conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),
 revision INTEGER NOT NULL CHECK(revision>=0)
);
INSERT INTO execution_revisions SELECT id,sequence FROM conversations;
CREATE TRIGGER execution_conversation_insert AFTER INSERT ON conversations BEGIN
 INSERT INTO execution_revisions VALUES(NEW.id,0);
END;
CREATE TRIGGER execution_inbox_insert AFTER INSERT ON reasoning_inbox BEGIN
 UPDATE execution_revisions SET revision=revision+1 WHERE conversation_id=NEW.conversation_id;
END;
CREATE TRIGGER execution_inbox_update AFTER UPDATE ON reasoning_inbox BEGIN
 UPDATE execution_revisions SET revision=revision+1 WHERE conversation_id=NEW.conversation_id;
END;
CREATE TRIGGER execution_run_insert AFTER INSERT ON production_runs BEGIN
 UPDATE execution_revisions SET revision=revision+1 WHERE conversation_id=NEW.conversation_id;
END;
CREATE TRIGGER execution_run_update AFTER UPDATE ON production_runs BEGIN
 UPDATE execution_revisions SET revision=revision+1 WHERE conversation_id=NEW.conversation_id;
END;
