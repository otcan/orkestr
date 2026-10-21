-- Per-conversation owner choice to review proposals before accepting them.
-- Default 0: the server accepts owner turns automatically (V1 behaviour).
ALTER TABLE conversation_settings ADD COLUMN review_before_accepting INTEGER NOT NULL DEFAULT 0 CHECK(review_before_accepting IN (0,1));
