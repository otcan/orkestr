-- Explicit offline fixture authority only; ordinary Store cannot dispatch.
CREATE TABLE fixture_supervisors (
 context_id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL REFERENCES owners(id),
 namespace TEXT NOT NULL,
 supervisor_key TEXT NOT NULL,
 incarnation_id TEXT NOT NULL UNIQUE,
 generation INTEGER NOT NULL CHECK(generation > 0),
 lease_deadline_ms INTEGER NOT NULL,
 UNIQUE(owner_id, namespace, supervisor_key)
);
