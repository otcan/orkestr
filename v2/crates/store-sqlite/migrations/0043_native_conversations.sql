-- Standalone owner threads do not replace the original home conversation or
-- invent a project/resource binding. Existing conversation/event IDs stay put.
ALTER TABLE conversations ADD COLUMN standalone INTEGER NOT NULL DEFAULT 0
 CHECK(standalone IN (0,1) AND (standalone=0 OR project_id IS NULL));
DROP INDEX main_global;
CREATE UNIQUE INDEX main_global ON conversations(owner_id)
 WHERE project_id IS NULL AND standalone=0;

CREATE TABLE conversation_directory (
 row_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 conversation_id TEXT NOT NULL UNIQUE,
 owner_id TEXT NOT NULL,
 name TEXT NOT NULL,
 request_key TEXT,
 payload_digest TEXT,
 UNIQUE(owner_id,request_key),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
INSERT INTO conversation_directory(conversation_id,owner_id,name)
 SELECT c.id,c.owner_id,coalesce(p.name,'Assistant') FROM conversations c
 LEFT JOIN projects p ON p.id=c.project_id ORDER BY c.rowid;
CREATE TRIGGER conversation_directory_insert AFTER INSERT ON conversations BEGIN
 INSERT INTO conversation_directory(conversation_id,owner_id,name)
 VALUES(NEW.id,NEW.owner_id,coalesce((SELECT name FROM projects WHERE id=NEW.project_id),'Assistant'));
END;
