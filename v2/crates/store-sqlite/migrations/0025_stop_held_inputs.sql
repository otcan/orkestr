-- Queue rows remain intact; Stop records a durable exclusion boundary.
CREATE TABLE production_stop_boundaries (
 event_id TEXT PRIMARY KEY REFERENCES production_cancellations(event_id),
 owner_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
 run_id TEXT NOT NULL UNIQUE REFERENCES production_runs(id),
 through_scope_sequence INTEGER NOT NULL CHECK(through_scope_sequence>=0),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
CREATE TABLE production_held_inputs (
 event_id TEXT PRIMARY KEY REFERENCES events(id),
 conversation_id TEXT NOT NULL, scope_sequence INTEGER NOT NULL,
 message_id TEXT NOT NULL REFERENCES messages(id),
 boundary_event_id TEXT NOT NULL REFERENCES production_stop_boundaries(event_id),
 reason TEXT NOT NULL CHECK(reason='stop_boundary'),
 UNIQUE(conversation_id,scope_sequence),
 FOREIGN KEY(conversation_id,scope_sequence) REFERENCES reasoning_inbox(conversation_id,sequence)
);
-- Upgrade preserves historical queue bytes while applying the same exclusion cut.
INSERT INTO production_stop_boundaries
 SELECT c.event_id,r.owner_id,r.conversation_id,r.id,e.sequence-1
 FROM production_cancellations c JOIN production_runs r ON r.id=c.run_id
 JOIN events e ON e.id=c.event_id WHERE r.role='deep';
INSERT INTO production_held_inputs
 SELECT i.event_id,i.conversation_id,i.sequence,i.message_id,
 (SELECT b.event_id FROM production_stop_boundaries b WHERE b.conversation_id=i.conversation_id AND i.sequence<=b.through_scope_sequence ORDER BY b.through_scope_sequence LIMIT 1), 'stop_boundary'
 FROM reasoning_inbox i WHERE i.state!='consumed' AND EXISTS(
 SELECT 1 FROM production_stop_boundaries b WHERE b.conversation_id=i.conversation_id AND i.sequence<=b.through_scope_sequence);
