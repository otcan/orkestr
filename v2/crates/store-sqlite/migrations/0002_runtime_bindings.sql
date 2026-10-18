-- Runtime foundation only. Run admission/event projection remains unavailable.
CREATE UNIQUE INDEX conversation_scope ON conversations(id, owner_id);
CREATE TABLE session_bindings (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('fast','deep','worker')),
 provider_kind TEXT NOT NULL DEFAULT 'unconfigured'
   CHECK(provider_kind IN ('unconfigured','codex','claude','explicit_fixture')),
 provider_namespace TEXT, native_session_id TEXT,
 parent_session_id TEXT, generation INTEGER NOT NULL DEFAULT 1 CHECK(generation > 0),
 state TEXT NOT NULL DEFAULT 'starting'
   CHECK(state IN ('starting','ready','busy','blocked','lost','retired')),
 request_key TEXT, request_digest TEXT,
 UNIQUE(id, owner_id, conversation_id), UNIQUE(owner_id, conversation_id, request_key),
 FOREIGN KEY(conversation_id, owner_id) REFERENCES conversations(id, owner_id),
 FOREIGN KEY(parent_session_id, owner_id, conversation_id)
   REFERENCES session_bindings(id, owner_id, conversation_id),
 CHECK((native_session_id IS NULL) OR
   (provider_kind <> 'unconfigured' AND provider_namespace IS NOT NULL)),
 CHECK(state NOT IN ('ready','busy') OR native_session_id IS NOT NULL),
 CHECK((role = 'worker' AND request_key IS NOT NULL AND request_digest IS NOT NULL)
   OR (role IN ('fast','deep') AND request_key IS NULL AND parent_session_id IS NULL))
);
CREATE UNIQUE INDEX canonical_role ON session_bindings(owner_id, conversation_id, role)
 WHERE role IN ('fast','deep') AND state <> 'retired';
-- Retired/lost identities remain reserved: never alias a historical native session.
CREATE UNIQUE INDEX native_identity ON session_bindings(provider_kind, provider_namespace, native_session_id)
 WHERE native_session_id IS NOT NULL;
ALTER TABLE reasoning_inbox ADD COLUMN claimant_session_id TEXT REFERENCES session_bindings(id);
ALTER TABLE reasoning_inbox ADD COLUMN claim_generation INTEGER NOT NULL DEFAULT 0 CHECK(claim_generation >= 0);
ALTER TABLE reasoning_inbox ADD COLUMN claim_deadline_ms INTEGER;
CREATE INDEX inbox_lease ON reasoning_inbox(conversation_id, state, sequence);
