-- A timer occurrence whose window open failed before any run is queued again
-- once (nothing of it ran). Its retry window can fail to open as well, so one
-- input may now be released by more than one failed opening: one archived
-- row per failure instead of one per input. Existing rows are kept unchanged.
CREATE TABLE execution_window_open_failure_inputs_0067 (
 event_id TEXT NOT NULL REFERENCES events(id),
 failure_id TEXT NOT NULL REFERENCES execution_window_open_failures(id),
 window_id TEXT NOT NULL REFERENCES execution_windows(id),
 owner_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 request_key TEXT NOT NULL,
 semantic_digest TEXT NOT NULL,
 message_id TEXT NOT NULL REFERENCES messages(id),
 input_request_key TEXT NOT NULL,
 receipt_json TEXT NOT NULL,
 PRIMARY KEY(event_id,failure_id)
);
INSERT INTO execution_window_open_failure_inputs_0067(event_id,failure_id,window_id,owner_id,conversation_id,request_key,semantic_digest,message_id,input_request_key,receipt_json)
 SELECT event_id,failure_id,window_id,owner_id,conversation_id,request_key,semantic_digest,message_id,input_request_key,receipt_json FROM execution_window_open_failure_inputs;
DROP TABLE execution_window_open_failure_inputs;
ALTER TABLE execution_window_open_failure_inputs_0067 RENAME TO execution_window_open_failure_inputs;
