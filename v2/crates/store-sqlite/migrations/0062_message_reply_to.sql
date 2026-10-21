-- The earlier chat message an owner input quoted (WhatsApp reply), as bounded
-- JSON beside the input. Absent for ordinary inputs; never changes the input's
-- identity digest, ordering or events.
CREATE TABLE message_reply_to (
 message_id TEXT PRIMARY KEY REFERENCES messages(id),
 reply_to TEXT NOT NULL CHECK(json_valid(reply_to) AND length(reply_to)<=4096)
);
