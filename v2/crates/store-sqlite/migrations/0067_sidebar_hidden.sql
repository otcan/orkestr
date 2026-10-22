-- Owner-hidden sidebar entries: system or technical chats (health probes,
-- rehearsals, acceptance tests) kept out of the default sidebar list. Keyed
-- like read marks: `v2:<conversation>` or `v1:<thread>`. Visibility only: a
-- row never stops, unbinds or deletes the chat, and it stays reachable by URL.
-- Showing an entry again deletes its row.
CREATE TABLE sidebar_hidden_entries (
 owner_id TEXT NOT NULL REFERENCES owners(id),
 entry_key TEXT NOT NULL CHECK(length(entry_key) BETWEEN 4 AND 220),
 reason TEXT CHECK(reason IS NULL OR length(reason) BETWEEN 1 AND 200),
 hidden_at_ms INTEGER NOT NULL,
 PRIMARY KEY(owner_id,entry_key)
);
