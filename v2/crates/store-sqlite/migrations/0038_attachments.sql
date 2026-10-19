-- Copy-only attachments. No inbox, event, admission or provider authority.
CREATE TABLE attachment_manifests (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id),
 conversation_id TEXT NOT NULL REFERENCES conversations(id), manifest_json TEXT NOT NULL
);
CREATE TABLE attachment_objects (
 reference_id TEXT PRIMARY KEY, manifest_id TEXT NOT NULL REFERENCES attachment_manifests(id),
 bytes BLOB CHECK(bytes IS NULL OR length(bytes)<=16777216), removed INTEGER NOT NULL DEFAULT 0 CHECK(removed IN (0,1)),
 CHECK(removed=0 OR bytes IS NULL)
);
CREATE TABLE attachment_imports (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id),
 conversation_id TEXT NOT NULL REFERENCES conversations(id), request_key TEXT NOT NULL,
 request_digest TEXT NOT NULL, manifest_id TEXT NOT NULL UNIQUE REFERENCES attachment_manifests(id),
 source_manifest_json TEXT NOT NULL, receipt_json TEXT NOT NULL, UNIQUE(owner_id, conversation_id, request_key)
);
CREATE TABLE attachment_removals (
 owner_id TEXT NOT NULL REFERENCES owners(id), conversation_id TEXT NOT NULL REFERENCES conversations(id),
 request_key TEXT NOT NULL, manifest_id TEXT NOT NULL REFERENCES attachment_manifests(id),
 reference_id TEXT NOT NULL REFERENCES attachment_objects(reference_id), receipt_json TEXT NOT NULL,
 PRIMARY KEY(owner_id,conversation_id,request_key)
);
