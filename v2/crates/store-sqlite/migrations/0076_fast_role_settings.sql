-- Preferences only: no input, run, provider identity or Deep setting is changed.
CREATE TABLE conversation_fast_settings (
 conversation_id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0),
 model TEXT CHECK(model IS NULL OR length(model) BETWEEN 1 AND 120),
 reasoning_effort TEXT CHECK(reasoning_effort IS NULL OR reasoning_effort IN('none','minimal','low','medium','high','xhigh','max','ultra')),
 updated_at_ms INTEGER NOT NULL,
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
