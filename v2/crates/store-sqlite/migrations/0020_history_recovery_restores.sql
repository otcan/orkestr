-- Separate inert recovery provenance; no execution/admission references.
CREATE TABLE history_recovery_restores (
 owner_id TEXT NOT NULL REFERENCES owners(id),
 restore_id TEXT NOT NULL,
 bundle_digest TEXT NOT NULL CHECK(length(bundle_digest)=64),
 request_digest TEXT NOT NULL CHECK(length(request_digest)=64),
 initial_receipt TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision IN (1,2)),
 state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','rolled_back')),
 rollback_request_key TEXT,
 rollback_request_digest TEXT,
 rollback_receipt TEXT,
 created_at INTEGER NOT NULL DEFAULT (unixepoch()),
 rolled_back_at INTEGER,
 PRIMARY KEY(owner_id,restore_id),
 CHECK((revision=1 AND state='active' AND rollback_request_key IS NULL
 AND rollback_request_digest IS NULL AND rollback_receipt IS NULL AND rolled_back_at IS NULL)
 OR (revision=2 AND state='rolled_back' AND rollback_request_key IS NOT NULL
 AND rollback_request_digest IS NOT NULL AND rollback_receipt IS NOT NULL AND rolled_back_at IS NOT NULL))
);
CREATE TABLE history_recovery_children (
 owner_id TEXT NOT NULL,
 namespace TEXT NOT NULL,
 restore_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('original','native_delta')),
 source_digest TEXT NOT NULL CHECK(length(source_digest)=64),
 initial_revision INTEGER NOT NULL CHECK(initial_revision IN (1,2)),
 initial_active INTEGER NOT NULL CHECK(initial_active IN (0,1)),
 PRIMARY KEY(owner_id,namespace),
 UNIQUE(owner_id,restore_id,kind),
 FOREIGN KEY(owner_id,restore_id) REFERENCES history_recovery_restores(owner_id,restore_id),
 FOREIGN KEY(owner_id,namespace) REFERENCES history_imports(owner_id,namespace),
 CHECK((initial_revision=1 AND initial_active=1) OR (initial_revision=2 AND initial_active=0)),
 CHECK(kind='original' OR (initial_revision=1 AND initial_active=1))
);
