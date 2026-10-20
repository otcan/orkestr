-- Durable owner intent to open an execution window once capacity is free.
-- A row is never execution authority: Core admission repeats every predicate
-- and marks the row dispatched in the same transaction that admits its input.
CREATE TABLE execution_window_queue (
 position INTEGER PRIMARY KEY AUTOINCREMENT,
 owner_id TEXT NOT NULL REFERENCES owners(id),
 conversation_id TEXT NOT NULL,
 request_key TEXT NOT NULL,
 semantic_digest TEXT NOT NULL,
 message_id TEXT NOT NULL REFERENCES messages(id),
 event_id TEXT NOT NULL UNIQUE REFERENCES events(id),
 input_request_key TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('queued','dispatched','withdrawn')),
 window_id TEXT REFERENCES execution_windows(id),
 withdrawal TEXT CHECK(withdrawal IS NULL OR withdrawal IN ('input_unavailable','reconciliation_required','admission_refused')),
 queued_at_ms INTEGER NOT NULL,
 CHECK((state='dispatched')=(window_id IS NOT NULL)),
 CHECK((state='withdrawn')=(withdrawal IS NOT NULL)),
 UNIQUE(owner_id,conversation_id,request_key),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
CREATE INDEX execution_window_queue_pending ON execution_window_queue(owner_id,state,position);
