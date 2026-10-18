CREATE TABLE owners (
 id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
 singleton INTEGER NOT NULL UNIQUE DEFAULT 1 CHECK(singleton = 1)
);
CREATE TABLE auth_sessions (
 token_hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id), expires_at INTEGER NOT NULL
);
CREATE TABLE projects (
 row_sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
 owner_id TEXT NOT NULL REFERENCES owners(id), request_key TEXT NOT NULL,
 payload_digest TEXT NOT NULL, name TEXT NOT NULL, UNIQUE(owner_id, request_key)
);
CREATE TABLE conversations (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id),
 project_id TEXT REFERENCES projects(id), sequence INTEGER NOT NULL DEFAULT 0 CHECK(sequence >= 0)
);
CREATE UNIQUE INDEX main_global ON conversations(owner_id) WHERE project_id IS NULL;
CREATE UNIQUE INDEX main_project ON conversations(owner_id, project_id) WHERE project_id IS NOT NULL;
CREATE TABLE messages (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id),
 conversation_id TEXT NOT NULL REFERENCES conversations(id), request_key TEXT NOT NULL,
 payload_digest TEXT NOT NULL, text TEXT NOT NULL, actor_kind TEXT NOT NULL CHECK(actor_kind = 'owner'),
 sequence INTEGER NOT NULL, UNIQUE(owner_id, conversation_id, request_key), UNIQUE(conversation_id, sequence)
);
CREATE TABLE events (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id),
 conversation_id TEXT NOT NULL REFERENCES conversations(id), message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
 sequence INTEGER NOT NULL, occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 UNIQUE(conversation_id, sequence)
);
CREATE TABLE reasoning_inbox (
 conversation_id TEXT NOT NULL REFERENCES conversations(id), sequence INTEGER NOT NULL,
 message_id TEXT NOT NULL UNIQUE REFERENCES messages(id), event_id TEXT NOT NULL UNIQUE REFERENCES events(id),
 state TEXT NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','claimed','consumed')),
 PRIMARY KEY(conversation_id, sequence)
);
CREATE TABLE outbox (
 event_id TEXT PRIMARY KEY REFERENCES events(id), state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','delivered'))
);
