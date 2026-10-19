-- Trusted local operator projects. Inventory and browser paths are not grants.
CREATE TABLE workspace_projects (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id),
 conversation_id TEXT NOT NULL REFERENCES conversations(id),
 generation INTEGER NOT NULL CHECK(generation>0), active INTEGER NOT NULL CHECK(active IN(0,1)),
 identity_json TEXT NOT NULL, UNIQUE(owner_id,conversation_id)
);
CREATE TABLE workspace_session_projects (
 session_id TEXT PRIMARY KEY REFERENCES session_bindings(id),
 project_id TEXT NOT NULL REFERENCES workspace_projects(id), generation INTEGER NOT NULL,
 context_id TEXT NOT NULL REFERENCES production_supervisors(context_id), incarnation_id TEXT NOT NULL
);
CREATE TABLE workspace_launches (
 id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES workspace_projects(id), generation INTEGER NOT NULL,
 session_id TEXT NOT NULL REFERENCES session_bindings(id), binding_generation INTEGER NOT NULL,
 context_id TEXT NOT NULL REFERENCES production_supervisors(context_id), incarnation_id TEXT NOT NULL,
 request_key TEXT NOT NULL, metadata_key TEXT NOT NULL, nonce_hash TEXT, callback_attempted INTEGER NOT NULL DEFAULT 0 CHECK(callback_attempted IN(0,1)), state TEXT NOT NULL CHECK(state IN('reserved','delivery_unknown')),
 UNIQUE(context_id,incarnation_id,request_key), UNIQUE(session_id,context_id,incarnation_id,binding_generation)
);
