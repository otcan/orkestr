-- Storage consent only. No inference, routing, timer or effect authority.
CREATE TABLE memory_settings (
 owner_id TEXT PRIMARY KEY REFERENCES owners(id),
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1))
);
CREATE TABLE memory_records (
 id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES owners(id),
 project_id TEXT REFERENCES projects(id),
 revision INTEGER NOT NULL CHECK(revision>0),
 candidate_json TEXT NOT NULL CHECK(length(CAST(candidate_json AS BLOB))<=32768),
 trust TEXT NOT NULL CHECK(trust IN ('owner_authored','owner_confirmed')),
 consented_at_ms INTEGER NOT NULL CHECK(consented_at_ms>0),
 updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms>0)
);
CREATE INDEX memory_records_owner ON memory_records(owner_id,project_id,updated_at_ms,id);
-- Opaque hashes and receipt only: correction/forget never retains old text.
CREATE TABLE memory_decisions (
 owner_id TEXT NOT NULL REFERENCES owners(id),
 request_key TEXT NOT NULL CHECK(length(CAST(request_key AS BLOB)) BETWEEN 1 AND 128),
 proposal_digest TEXT NOT NULL CHECK(length(proposal_digest)=64),
 action TEXT NOT NULL CHECK(action IN ('remember','approve','correct','forget')),
 memory_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0),
 forgotten INTEGER NOT NULL CHECK(forgotten IN (0,1)),
 PRIMARY KEY(owner_id,request_key)
);
