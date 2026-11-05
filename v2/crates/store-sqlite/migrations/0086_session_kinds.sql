-- Existing hashes cannot reveal whether their original token was browser-prefixed.
-- Keep these explicitly legacy until they expire, rather than guessing authority.
ALTER TABLE auth_sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'legacy'
 CHECK(kind IN ('legacy','browser','machine','service_browser'));
CREATE TABLE service_credentials (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id),
 label TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
 expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1))
);
ALTER TABLE auth_sessions ADD COLUMN service_credential_id TEXT REFERENCES service_credentials(id);
