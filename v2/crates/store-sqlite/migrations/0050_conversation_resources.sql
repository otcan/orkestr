-- Per-conversation owner settings (V1 thread controls parity). Preferences
-- only: no execution, input or effect table references these rows.
CREATE TABLE conversation_settings (
 conversation_id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision > 0),
 provider TEXT NOT NULL CHECK(provider IN ('codex','claude')),
 model TEXT,
 reasoning_effort TEXT,
 honor_no_reply INTEGER NOT NULL CHECK(honor_no_reply IN (0,1)),
 reply_prefix TEXT,
 reply_footer TEXT,
 provider_generation INTEGER NOT NULL CHECK(provider_generation >= 0),
 updated_at_ms INTEGER NOT NULL,
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);

-- One V1 thread identity per conversation and per owner, so two V2
-- conversations can never share (and silently renew) one V1 lease holder.
CREATE TABLE desktop_bindings (
 conversation_id TEXT PRIMARY KEY,
 owner_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision > 0),
 v1_thread_id TEXT NOT NULL,
 desktop_slugs TEXT NOT NULL,
 grant_hash TEXT UNIQUE,
 grant_generation INTEGER NOT NULL DEFAULT 0 CHECK(grant_generation >= 0),
 UNIQUE(owner_id,v1_thread_id),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
-- V1 remains the lease authority; these rows fence V2 callers by the V1
-- fencing token hash. The raw token is never stored.
CREATE TABLE desktop_leases (
 row_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 owner_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 desktop_slug TEXT NOT NULL,
 v1_thread_id TEXT NOT NULL,
 v1_lease_id TEXT NOT NULL,
 fencing_version INTEGER NOT NULL,
 token_hash TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('active','released','lost')),
 expires_at TEXT,
 expires_at_ms INTEGER NOT NULL,
 acquired_at_ms INTEGER NOT NULL,
 heartbeat_at_ms INTEGER NOT NULL,
 ended_at_ms INTEGER,
 end_reason TEXT,
 CHECK((state='active') = (ended_at_ms IS NULL)),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
CREATE UNIQUE INDEX desktop_leases_one_active ON desktop_leases(owner_id,desktop_slug)
 WHERE state='active';
CREATE INDEX desktop_leases_conversation ON desktop_leases(conversation_id,row_sequence);
CREATE TRIGGER desktop_leases_terminal BEFORE UPDATE ON desktop_leases
 WHEN OLD.state <> 'active'
BEGIN SELECT RAISE(ABORT,'ended desktop lease is immutable'); END;

-- V1 worker sub-threads linked to the conversation their parent moved to.
-- Exactly one worktree writer; transitions are audited append-only.
CREATE TABLE legacy_worker_links (
 row_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 owner_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 source_instance TEXT NOT NULL,
 source_thread_id TEXT NOT NULL,
 source_parent_thread_id TEXT NOT NULL,
 worker_index INTEGER,
 title TEXT NOT NULL,
 source_state TEXT NOT NULL CHECK(source_state IN ('active','retired')),
 branch TEXT,
 worktree_path TEXT,
 last_snapshot_id TEXT NOT NULL,
 disposition TEXT NOT NULL CHECK(disposition IN ('archived','finish_in_v1','recreate_in_v2')),
 worktree_writer TEXT NOT NULL CHECK(worktree_writer IN ('v1','v2','none')),
 v2_task_id TEXT,
 revision INTEGER NOT NULL CHECK(revision > 0),
 UNIQUE(owner_id,source_instance,source_thread_id),
 CHECK(worktree_path IS NOT NULL OR worktree_writer <> 'v2'),
 CHECK(disposition <> 'finish_in_v1' OR worktree_writer <> 'v2'),
 FOREIGN KEY(conversation_id,owner_id) REFERENCES conversations(id,owner_id)
);
CREATE UNIQUE INDEX legacy_worker_single_v2_writer ON legacy_worker_links(owner_id,worktree_path)
 WHERE worktree_writer='v2';
CREATE TABLE legacy_worker_transitions (
 row_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 link_row INTEGER NOT NULL REFERENCES legacy_worker_links(row_sequence),
 revision INTEGER NOT NULL,
 action TEXT NOT NULL,
 disposition TEXT NOT NULL,
 worktree_writer TEXT NOT NULL,
 source_state TEXT NOT NULL,
 snapshot_id TEXT NOT NULL,
 recorded_at_ms INTEGER NOT NULL,
 UNIQUE(link_row,revision)
);
CREATE TRIGGER legacy_worker_transitions_immutable BEFORE UPDATE ON legacy_worker_transitions
BEGIN SELECT RAISE(ABORT,'legacy worker transitions are append-only'); END;
CREATE TRIGGER legacy_worker_transitions_retained BEFORE DELETE ON legacy_worker_transitions
BEGIN SELECT RAISE(ABORT,'legacy worker transitions are append-only'); END;
