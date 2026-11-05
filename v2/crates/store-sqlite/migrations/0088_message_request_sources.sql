-- Authentication provenance is distinct from an adapter's claimed text author.
-- Never backfill historical rows or infer their origin from an author label.
CREATE TABLE message_request_sources (
 message_id TEXT PRIMARY KEY REFERENCES messages(id),
 owner_id TEXT NOT NULL REFERENCES owners(id),
 session_kind TEXT NOT NULL CHECK(session_kind IN ('legacy','browser','machine','service_browser')),
 credential_hash TEXT NOT NULL,
 service_credential_id TEXT REFERENCES service_credentials(id),
 recorded_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE TRIGGER message_request_sources_fixed BEFORE UPDATE ON message_request_sources
 BEGIN SELECT RAISE(ABORT,'message request source is immutable'); END;
CREATE TRIGGER message_request_sources_no_delete BEFORE DELETE ON message_request_sources
 BEGIN SELECT RAISE(ABORT,'message request source is immutable'); END;
