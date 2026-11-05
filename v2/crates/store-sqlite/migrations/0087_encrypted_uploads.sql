-- Bounded browser ciphertext chunks. Never stores plaintext or private keys.
CREATE TABLE encrypted_uploads (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 descriptor_json TEXT NOT NULL,
 recipients_json TEXT NOT NULL,
 ingest_recipient TEXT,
 plaintext_size INTEGER NOT NULL CHECK(plaintext_size BETWEEN 1 AND 1000000000),
 created_at INTEGER NOT NULL,
 complete INTEGER NOT NULL DEFAULT 0 CHECK(complete IN (0,1)),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
CREATE INDEX encrypted_upload_owner ON encrypted_uploads(owner_id,complete,created_at);
CREATE TABLE encrypted_upload_chunks (
 upload_id TEXT NOT NULL REFERENCES encrypted_uploads(id) ON DELETE CASCADE,
 chunk_index INTEGER NOT NULL CHECK(chunk_index BETWEEN 0 AND 953),
 ciphertext BLOB NOT NULL CHECK(length(ciphertext) BETWEEN 1 AND 1114112),
 ciphertext_sha256 TEXT NOT NULL CHECK(length(ciphertext_sha256)=64),
 PRIMARY KEY(upload_id,chunk_index)
);
