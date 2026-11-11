-- Local folder relay (ORK-750, proof of concept): a running Deep turn queues
-- file requests for its own conversation; only the owner's browser tab that
-- granted a folder performs them. Additive only: no existing table, row,
-- index or trigger changes. (0097 is taken by the desk sharing change.)

-- Separate per-conversation grant, same design as the agent-timer grant: a
-- thread-ask or timer grant never implies folder access and vice versa.
CREATE TABLE local_file_grants (
 conversation_id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 -- NULL once revoked; the generation never decreases.
 grant_hash TEXT CHECK(grant_hash IS NULL OR (length(grant_hash)=64 AND grant_hash NOT GLOB '*[^0-9a-f]*')),
 generation INTEGER NOT NULL CHECK(generation>0),
 issued_ms INTEGER NOT NULL,
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
CREATE UNIQUE INDEX local_file_grant_hash ON local_file_grants(grant_hash) WHERE grant_hash IS NOT NULL;

-- The one browser tab currently serving the conversation's folder. A row
-- whose seen_ms is older than the connection lifetime is not connected.
CREATE TABLE local_file_connections (
 conversation_id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 connection_id TEXT NOT NULL CHECK(length(connection_id)=36),
 folder_name TEXT NOT NULL CHECK(length(folder_name) BETWEEN 1 AND 255),
 connected_ms INTEGER NOT NULL,
 seen_ms INTEGER NOT NULL,
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);

-- Every request, kept as the log. Write content is cleared once the request
-- is finished; its size and SHA-256 stay.
CREATE TABLE local_file_requests (
 id TEXT PRIMARY KEY CHECK(length(id)=36),
 owner_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 run_id TEXT NOT NULL REFERENCES production_runs(id),
 grant_generation INTEGER NOT NULL CHECK(grant_generation>0),
 request_key TEXT NOT NULL CHECK(length(request_key) BETWEEN 1 AND 128),
 request_digest TEXT NOT NULL CHECK(length(request_digest)=64 AND request_digest NOT GLOB '*[^0-9a-f]*'),
 operation TEXT NOT NULL CHECK(operation IN ('list','read','hash','write','package')),
 path TEXT,
 paths_json TEXT NOT NULL,
 content BLOB CHECK(content IS NULL OR length(content)<=1048576),
 content_bytes INTEGER,
 content_sha256 TEXT CHECK(content_sha256 IS NULL OR length(content_sha256)=64),
 state TEXT NOT NULL CHECK(state IN ('queued','working','done','failed')),
 connection_id TEXT,
 error TEXT CHECK(error IS NULL OR length(error) BETWEEN 1 AND 64),
 result_json TEXT,
 created_ms INTEGER NOT NULL,
 deadline_ms INTEGER NOT NULL,
 claimed_ms INTEGER,
 finished_ms INTEGER,
 CHECK((state IN ('done','failed'))=(finished_ms IS NOT NULL)),
 CHECK(state<>'failed' OR error IS NOT NULL),
 UNIQUE(conversation_id,run_id,request_key),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
CREATE INDEX local_file_requests_open ON local_file_requests(conversation_id,state,created_ms);
CREATE INDEX local_file_requests_recent ON local_file_requests(conversation_id,created_ms);
