-- Automatic effect authority is separate from native intake and manual sends.
CREATE TABLE automatic_reply_routes (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id),
 conversation_id TEXT NOT NULL REFERENCES conversations(id),
 context_id TEXT NOT NULL, incarnation_id TEXT NOT NULL, account_scope TEXT NOT NULL,
 generation INTEGER NOT NULL CHECK(generation>0),
 permission_revision INTEGER NOT NULL DEFAULT 0 CHECK(permission_revision>=0),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1))
);
CREATE TABLE automatic_reply_permissions (
 route_id TEXT NOT NULL REFERENCES automatic_reply_routes(id), request_key TEXT NOT NULL,
 request_json TEXT NOT NULL, receipt_json TEXT NOT NULL,
 PRIMARY KEY(route_id,request_key)
);
CREATE TABLE automatic_reply_inputs (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id),
 conversation_id TEXT NOT NULL REFERENCES conversations(id),
 source_namespace TEXT NOT NULL, source_identity TEXT NOT NULL,
 route_id TEXT REFERENCES automatic_reply_routes(id), route_generation INTEGER,
 provenance_json TEXT NOT NULL, dormant INTEGER NOT NULL CHECK(dormant IN(0,1)),
 held INTEGER NOT NULL CHECK(held IN(0,1)), hold_reason TEXT,
 UNIQUE(owner_id,source_namespace,source_identity),
 CHECK(dormant=0 OR (held=1 AND route_id IS NULL AND route_generation IS NULL))
);
CREATE TABLE automatic_reply_sends (
 id TEXT PRIMARY KEY, input_id TEXT NOT NULL UNIQUE REFERENCES automatic_reply_inputs(id),
 route_id TEXT NOT NULL REFERENCES automatic_reply_routes(id),
 route_generation INTEGER NOT NULL, permission_revision INTEGER NOT NULL,
 account_scope TEXT NOT NULL, context_id TEXT NOT NULL, incarnation_id TEXT NOT NULL,
 request_key TEXT NOT NULL, output_sha256 TEXT NOT NULL, byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 65536),
 reservation_hash TEXT NOT NULL, delivery_hash TEXT,
 state TEXT NOT NULL CHECK(state IN('reserved','delivery_unknown')),
 written_bytes INTEGER NOT NULL DEFAULT 0 CHECK(written_bytes>=0 AND written_bytes<=byte_length),
 UNIQUE(route_id,request_key)
);
