-- Owner credential vault (ORK-784). A login's secret part is age ciphertext
-- for the stored-login reader and the owner's enrolled browsers; the server
-- keeps no identity that opens it. Additive only: no existing table, row,
-- index or trigger changes.
CREATE TABLE vault_items (
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 9 AND 67 AND substr(id,1,3)='vi_'),
 owner_id TEXT NOT NULL REFERENCES owners(id),
 name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 200),
 url TEXT NOT NULL CHECK(length(url)<=2048),
 domain TEXT NOT NULL CHECK(length(domain)<=253),
 tags_json TEXT NOT NULL CHECK(json_valid(tags_json) AND json_type(tags_json)='array'),
 has_password INTEGER NOT NULL CHECK(has_password IN (0,1)),
 has_totp INTEGER NOT NULL CHECK(has_totp IN (0,1)),
 single_use INTEGER NOT NULL CHECK(single_use IN (0,1)),
 sealed BLOB NOT NULL CHECK(length(sealed) BETWEEN 64 AND 131072),
 sealed_sha256 TEXT NOT NULL CHECK(length(sealed_sha256)=64),
 recipients_json TEXT NOT NULL CHECK(json_valid(recipients_json) AND json_type(recipients_json)='array'),
 revision INTEGER NOT NULL CHECK(revision>=1),
 created_at_ms INTEGER NOT NULL,
 updated_at_ms INTEGER NOT NULL,
 login_updated_at_ms INTEGER NOT NULL,
 last_used_at_ms INTEGER
);
CREATE INDEX vault_items_owner_domain ON vault_items(owner_id,domain);
-- V1 thread grants, carried over as data (helper `configured` mode).
CREATE TABLE vault_thread_grants (
 item_id TEXT NOT NULL REFERENCES vault_items(id) ON DELETE CASCADE,
 v1_thread_id TEXT NOT NULL CHECK(length(v1_thread_id) BETWEEN 1 AND 200),
 granted_at_ms INTEGER NOT NULL,
 PRIMARY KEY(item_id,v1_thread_id)
);
-- One row per imported source item; keeps the import idempotent and keeps an
-- owner's V2 deletion from being undone by a later import.
CREATE TABLE vault_import_sources (
 owner_id TEXT NOT NULL REFERENCES owners(id),
 source TEXT NOT NULL CHECK(source IN ('v1')),
 source_id TEXT NOT NULL CHECK(length(source_id) BETWEEN 1 AND 128),
 source_checksum TEXT NOT NULL CHECK(length(source_checksum)=64),
 item_id TEXT,
 item_revision INTEGER NOT NULL,
 imported_at_ms INTEGER NOT NULL,
 PRIMARY KEY(owner_id,source,source_id)
);
-- Value-free events only: ids, a fixed event name and a short code.
CREATE TABLE vault_audit (
 sequence INTEGER PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES owners(id),
 at_ms INTEGER NOT NULL,
 event TEXT NOT NULL CHECK(event IN ('item_created','item_updated','login_replaced','item_deleted','grants_changed','import_applied','owner_reveal','stored_login_read','stored_login_check','stored_login_refused')),
 item_id TEXT CHECK(item_id IS NULL OR length(item_id)<=128),
 conversation_id TEXT CHECK(conversation_id IS NULL OR length(conversation_id)=36),
 desk TEXT CHECK(desk IS NULL OR length(desk)<=64),
 site TEXT CHECK(site IS NULL OR length(site)<=253),
 operation TEXT CHECK(operation IS NULL OR length(operation)<=128),
 detail TEXT CHECK(detail IS NULL OR length(detail)<=64)
);
CREATE INDEX vault_audit_owner ON vault_audit(owner_id,sequence);
