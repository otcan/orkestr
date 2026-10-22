-- Attachment objects at rest are age ciphertext for the owner's verified browser
-- recipients (the V1 model). Only public `age1...` recipients are stored here;
-- private identities stay in the browser. 0064 (restricted threads) precedes it.
CREATE TABLE attachment_recipients (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES owners(id),
 label TEXT NOT NULL CHECK(length(label) <= 120),
 recipient TEXT NOT NULL CHECK(length(recipient) BETWEEN 5 AND 500 AND substr(recipient,1,4)='age1'),
 fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 39),
 status TEXT NOT NULL CHECK(status IN ('pending_verification','active','revoked')),
 -- 'enrolled': possession proven to this server; 'v1_import': proven to the V1 app.
 origin TEXT NOT NULL CHECK(origin IN ('enrolled','v1_import')),
 created_at INTEGER NOT NULL,
 verified_at INTEGER,
 revoked_at INTEGER,
 revoked_reason TEXT CHECK(revoked_reason IS NULL OR length(revoked_reason) <= 300),
 challenge_id TEXT,
 challenge_nonce_hash TEXT,
 challenge_ciphertext BLOB CHECK(challenge_ciphertext IS NULL OR length(challenge_ciphertext) <= 4096),
 challenge_expires_at INTEGER,
 challenge_attempts INTEGER NOT NULL DEFAULT 0 CHECK(challenge_attempts >= 0),
 UNIQUE(owner_id, fingerprint),
 CHECK(status <> 'active' OR (verified_at IS NOT NULL AND revoked_at IS NULL AND challenge_id IS NULL)),
 CHECK(status <> 'revoked' OR revoked_at IS NOT NULL),
 CHECK(status <> 'pending_verification' OR (challenge_id IS NOT NULL AND challenge_nonce_hash IS NOT NULL
   AND challenge_ciphertext IS NOT NULL AND challenge_expires_at IS NOT NULL))
);
CREATE INDEX attachment_recipients_active ON attachment_recipients(owner_id) WHERE status = 'active';

-- Per-owner fail-closed switch. With required=1 and no active recipient, new
-- attachment objects are refused instead of being stored in plaintext.
CREATE TABLE attachment_encryption_policies (
 owner_id TEXT PRIMARY KEY REFERENCES owners(id),
 required INTEGER NOT NULL CHECK(required IN (0,1)),
 revision INTEGER NOT NULL CHECK(revision >= 1),
 updated_at INTEGER NOT NULL
);

-- Ciphertext of one attachment object. Its attachment_objects row keeps
-- bytes NULL; the manifest still describes the plaintext (length, sha256).
CREATE TABLE attachment_sealed_objects (
 reference_id TEXT PRIMARY KEY REFERENCES attachment_objects(reference_id),
 format TEXT NOT NULL CHECK(format = 'age-x25519-v1'),
 ciphertext BLOB NOT NULL CHECK(length(ciphertext) <= 17825792),
 ciphertext_sha256 TEXT NOT NULL CHECK(length(ciphertext_sha256) = 64),
 recipient_fingerprints_json TEXT NOT NULL CHECK(length(recipient_fingerprints_json) <= 65536),
 sealed_at INTEGER NOT NULL
);
