import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { agentJobDbPath, closeAgentJobDbs, openAgentJobDb } from "../packages/core/src/agent-job-store.js";
import {
  migratePersonalAgentSessions,
  planPersonalAgentSessionMigration,
} from "../packages/core/src/personal-agent-session-migration.js";
import { openPersonalAgentSessionStore } from "../packages/core/src/personal-agent-session-sqlite.js";

function conversationFixture(db) {
  const exists = db.prepare("select 1 from sqlite_master where type='table' and name='personal_agent_conversations'").get();
  if (!exists) db.exec(`create table personal_agent_conversations (
    id text primary key, scope_kind text not null, project_id text,
    check ((scope_kind = 'global' and project_id is null) or (scope_kind = 'project' and project_id is not null))
  )`);
  const projects = db.prepare("select 1 from sqlite_master where type='table' and name='personal_agent_projects'").get();
  if (projects) db.prepare("insert or ignore into personal_agent_projects (id,title,created_at,updated_at) values ('prj_fixture','fixture','now','now')").run();
  const columns = new Set(db.prepare("pragma table_info(personal_agent_conversations)").all().map(row => row.name));
  const names = ["id", "scope_kind", "project_id", ...(columns.has("created_at") ? ["created_at"] : []), ...(columns.has("updated_at") ? ["updated_at"] : [])];
  const insert = db.prepare(`insert or ignore into personal_agent_conversations (${names.join(",")}) values (${names.map(() => "?").join(",")})`);
  insert.run("conv_global", "global", null, ...names.slice(3).map(() => "now"));
  insert.run("conv_project", "project", "prj_fixture", ...names.slice(3).map(() => "now"));
}

function session(id, overrides = {}) {
  return {
    id, conversationId: "conv_global", scopeKind: "global", scopeId: null,
    role: "fast", provider: "codex", accountProfileId: "codex-fixture",
    modelProfile: { model: "fixture-model" }, lifecycle: "ready",
    createdAt: "2026-10-18T10:00:00.000Z", updatedAt: "2026-10-18T10:00:00.000Z",
    ...overrides,
  };
}

function createE744SessionSchema(db) {
  db.exec(`create table if not exists personal_agent_sessions (
      id text primary key,
      conversation_id text not null references personal_agent_conversations(id) on delete restrict,
      scope_kind text not null check (scope_kind in ('global', 'project')),
      scope_id text,
      role text not null check (role in ('fast', 'deep', 'worker')),
      provider text not null check (provider in ('codex', 'claude-code')),
      account_profile_id text not null,
      model_profile_json text not null,
      native_session_id text,
      fork_from_session_id text references personal_agent_sessions(id) on delete set null,
      lifecycle text not null check (lifecycle in ('starting', 'ready', 'busy', 'blocked', 'stopped')),
      blocked_reason text,
      version integer not null default 0 check (version >= 0),
      lease_token text,
      lease_expires_at integer,
      heartbeat_at text,
      created_at text not null,
      updated_at text not null,
      check ((scope_kind = 'global' and scope_id is null) or (scope_kind = 'project' and scope_id is not null)),
      check ((lifecycle = 'blocked' and blocked_reason is not null) or (lifecycle <> 'blocked' and blocked_reason is null)),
      check ((lease_token is null and lease_expires_at is null) or (lease_token is not null and lease_expires_at is not null))
    );
    create unique index if not exists personal_agent_sessions_active_role
      on personal_agent_sessions(conversation_id, role)
      where role in ('fast', 'deep') and lifecycle in ('starting', 'ready', 'busy', 'blocked');
    create unique index if not exists personal_agent_sessions_native_identity
      on personal_agent_sessions(provider, account_profile_id, native_session_id)
      where native_session_id is not null;
    create index if not exists personal_agent_sessions_scope_lifecycle on personal_agent_sessions(scope_kind, scope_id, lifecycle, updated_at);
    create index if not exists personal_agent_sessions_lease on personal_agent_sessions(lease_expires_at) where lease_token is not null;
    create trigger personal_agent_sessions_scope_insert
      before insert on personal_agent_sessions
      when not exists (
        select 1 from personal_agent_conversations c where c.id = new.conversation_id
          and c.scope_kind = new.scope_kind
          and ((c.scope_kind = 'global' and new.scope_id is null)
            or (c.scope_kind = 'project' and c.project_id = new.scope_id))
      )
      begin select raise(abort, 'personal_agent_session_scope_mismatch'); end;
    create trigger personal_agent_sessions_scope_update
      before update of conversation_id, scope_kind, scope_id on personal_agent_sessions
      when not exists (
        select 1 from personal_agent_conversations c where c.id = new.conversation_id
          and c.scope_kind = new.scope_kind
          and ((c.scope_kind = 'global' and new.scope_id is null)
            or (c.scope_kind = 'project' and c.project_id = new.scope_id))
      )
      begin select raise(abort, 'personal_agent_session_scope_mismatch'); end`);
}

test("session migration is additive, dry-runnable, idempotent, and fail-closed on missing conversations", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const blocked = planPersonalAgentSessionMigration(db);
    assert.equal(blocked.prerequisiteMissing, true);
    assert.throws(() => migratePersonalAgentSessions(db, { dryRun: false }), /personal_agent_session_conversations_required/);
    conversationFixture(db);
    const dry = planPersonalAgentSessionMigration(db);
    assert.equal(dry.dryRun, true);
    assert.deepEqual(dry.missingColumns, [
      "id", "conversation_id", "scope_kind", "scope_id", "role", "provider", "account_profile_id",
      "model_profile_json", "native_session_id", "fork_from_session_id", "lifecycle", "blocked_reason",
      "version", "lease_token", "lease_expires_at", "heartbeat_at", "created_at", "updated_at",
    ]);
    migratePersonalAgentSessions(db, { dryRun: false });
    migratePersonalAgentSessions(db, { dryRun: false });
    assert.equal(db.prepare("select count(*) as n from sqlite_master where type='table' and name='personal_agent_sessions'").get().n, 1);
    assert.equal(db.prepare("pragma foreign_key_list(personal_agent_sessions)").all().some(row => row.table === "personal_agent_conversations"), true);
  } finally { db.close(); }
});

test("agent-job store reopens the e744 session schema without changing its rows", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-session-e744-reopen-"));
  const env = { ORKESTR_HOME: home, ORKESTR_PERSONAL_AGENT_ENABLED: "1" };
  try {
    const initialized = await openAgentJobDb(env);
    conversationFixture(initialized);
    await closeAgentJobDbs();

    const historical = new DatabaseSync(await agentJobDbPath(env));
    try {
      historical.exec("pragma foreign_keys = on; drop table personal_agent_sessions;");
      createE744SessionSchema(historical);
      historical.prepare(`insert into personal_agent_sessions
        (id,conversation_id,scope_kind,scope_id,role,provider,account_profile_id,model_profile_json,lifecycle,version,created_at,updated_at)
        values ('ses_e744_fixture','conv_global','global',null,'fast','codex','fixture-account','{}','ready',0,'now','now')`).run();
    } finally {
      historical.close();
    }

    const reopened = await openAgentJobDb(env);
    const row = reopened.prepare("select id, conversation_id, scope_kind, scope_id, role, lifecycle from personal_agent_sessions where id = 'ses_e744_fixture'").get();
    assert.deepEqual({ ...row }, {
      id: "ses_e744_fixture", conversation_id: "conv_global", scope_kind: "global",
      scope_id: null, role: "fast", lifecycle: "ready",
    });
  } finally {
    await closeAgentJobDbs();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("session table enforces active role uniqueness, native identity non-aliasing, and conversation scope", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("pragma foreign_keys=on");
    conversationFixture(db);
    migratePersonalAgentSessions(db, { dryRun: false });
    const insert = db.prepare(`insert into personal_agent_sessions
      (id,conversation_id,scope_kind,scope_id,role,provider,account_profile_id,model_profile_json,native_session_id,lifecycle,version,created_at,updated_at)
      values (?,?,?,?,?,?,?,?,?,?,0,'now','now')`);
    insert.run("ses_fast", "conv_global", "global", null, "fast", "codex", "acct", "{}", "native-1", "ready");
    assert.throws(() => insert.run("ses_fast_dup", "conv_global", "global", null, "fast", "claude-code", "acct-b", "{}", "native-2", "starting"), /UNIQUE constraint failed/);
    insert.run("ses_worker", "conv_global", "global", null, "worker", "codex", "acct", "{}", null, "starting");
    assert.throws(() => insert.run("ses_alias", "conv_global", "global", null, "worker", "codex", "acct", "{}", "native-1", "ready"), /UNIQUE constraint failed/);
    assert.throws(() => insert.run("ses_wrong_scope", "conv_project", "global", null, "deep", "codex", "acct", "{}", null, "ready"), /personal_agent_session_scope_mismatch/);
  } finally { db.close(); }
});

test("session migration refuses a table whose stored DDL differs from the canonical schema", () => {
  const db = new DatabaseSync(":memory:");
  try {
    conversationFixture(db);
    db.exec(`create table personal_agent_sessions (
      id text primary key, conversation_id text not null references personal_agent_conversations(id) on delete restrict,
      scope_kind text not null check (scope_kind in ('global', 'project')), scope_id text,
      role text not null check (role in ('fast', 'deep', 'worker')),
      provider text not null check (provider in ('codex', 'claude-code')), account_profile_id text not null,
      model_profile_json text not null, native_session_id text, fork_from_session_id text references personal_agent_sessions(id),
      lifecycle text not null check (lifecycle in ('starting', 'ready', 'busy', 'blocked', 'stopped')),
      blocked_reason text, version integer not null default 0, lease_token text, lease_expires_at integer,
      heartbeat_at text, created_at text not null, updated_at text not null,
      check ((scope_kind = 'global' and scope_id is null) or (scope_kind = 'project' and scope_id is not null)),
      check ((lease_token is null and lease_expires_at is null) or (lease_token is not null and lease_expires_at is not null))
    );
    insert into personal_agent_sessions
      (id,conversation_id,scope_kind,role,provider,account_profile_id,model_profile_json,lifecycle,version,created_at,updated_at)
      values ('legacy','conv_global','global','fast','codex','acct','{}','ready',0,'now','now');`);
    db.exec(`create trigger personal_agent_sessions_scope_insert before insert on personal_agent_sessions begin select 1; end;
      create trigger personal_agent_sessions_scope_update before update of conversation_id, scope_kind, scope_id on personal_agent_sessions begin select 1; end`);
    const plan = planPersonalAgentSessionMigration(db);
    assert.equal(plan.missingColumns.length, 0);
    const before = db.prepare("select sql from sqlite_master where type='table' and name='personal_agent_sessions'").get().sql;
    assert.throws(() => migratePersonalAgentSessions(db, { dryRun: false }), {
      message: "personal_agent_session_schema_incompatible",
    });
    assert.equal(db.prepare("select count(*) as n from pragma_table_info('personal_agent_sessions') where name='owner_user_id'").get().n, 0);
    assert.equal(db.prepare("select sql from sqlite_master where type='table' and name='personal_agent_sessions'").get().sql, before);
  } finally { db.close(); }
});

test("session lease acquisition and updates use version/token CAS across store handles", async () => {
  let clock = 1_800_000_000_000;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-session-store-"));
  const env = { ORKESTR_HOME: home, ORKESTR_PERSONAL_AGENT_ENABLED: "1" };
  try {
    const db = await openAgentJobDb(env);
    conversationFixture(db);
    migratePersonalAgentSessions(db, { dryRun: false });
    const first = await openPersonalAgentSessionStore({ env, now: () => clock });
    const second = await openPersonalAgentSessionStore({ env, now: () => clock });
    assert.deepEqual(first.conversation("conv_global"), { id: "conv_global", scopeKind: "global", scopeId: null });
    assert.deepEqual(first.conversation("conv_project"), { id: "conv_project", scopeKind: "project", scopeId: "prj_fixture" });
    assert.equal(first.conversation("missing"), null);
    assert.equal(Object.hasOwn(first.create(session("ses_owner_free", { role: "worker" })), "ownerUserId"), false);
    first.create(session("ses_a"));
    const lease = first.acquireLease("ses_a", { expectedVersion: 0, ttlMs: 1000 });
    assert.equal(lease.session.version, 1);
    assert.equal(second.acquireLease("ses_a", { expectedVersion: 1, ttlMs: 1000 }), null);
    assert.equal(first.update("ses_a", {
      expectedVersion: 1, leaseToken: "wrong-token", patch: { lifecycle: "busy" },
    }), null);
    const updated = second.update("ses_a", {
      expectedVersion: 1, leaseToken: lease.leaseToken,
      patch: { lifecycle: "ready", nativeSessionId: "native-a", heartbeatAt: new Date(clock).toISOString(), releaseLease: true },
    });
    assert.equal(updated.version, 2);
    assert.equal(updated.lifecycle, "ready");
    assert.equal(updated.leaseToken, null);
    assert.equal(first.update("ses_a", {
      expectedVersion: 1, leaseToken: lease.leaseToken, patch: { lifecycle: "ready" },
    }), null);
    const nextLease = second.acquireLease("ses_a", { expectedVersion: 2, ttlMs: 1000 });
    assert.ok(nextLease);
    const busy = first.update("ses_a", {
      expectedVersion: 3, leaseToken: nextLease.leaseToken, patch: { lifecycle: "busy", releaseLease: true },
    });
    assert.equal(second.acquireLease("ses_a", { expectedVersion: 4, ttlMs: 1000 }), null);
    assert.equal(first.get("ses_a").lifecycle, "busy");
    first.create(session("ses_expiring", { role: "worker" }));
    const expiring = second.acquireLease("ses_expiring", { expectedVersion: 0, ttlMs: 1000 });
    clock += 1001;
    assert.equal(first.acquireLease("ses_expiring", { expectedVersion: expiring.session.version, ttlMs: 1000 }), null);
    assert.equal(first.get("ses_expiring").leaseToken, expiring.leaseToken);
    assert.equal(busy.version, 4);
  } finally {
    await closeAgentJobDbs();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("invalid lease renewal TTL is rejected without consuming the current lease", async () => {
  let clock = 1_800_000_000_000;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-session-invalid-ttl-"));
  const env = { ORKESTR_HOME: home, ORKESTR_PERSONAL_AGENT_ENABLED: "1" };
  try {
    const db = await openAgentJobDb(env);
    conversationFixture(db);
    migratePersonalAgentSessions(db, { dryRun: false });
    const store = await openPersonalAgentSessionStore({ env, now: () => clock });
    store.create(session("ses_invalid_ttl", { role: "worker" }));
    const lease = store.acquireLease("ses_invalid_ttl", { expectedVersion: 0, ttlMs: 1000 });

    for (const leaseTtlMs of [0, -1]) {
      assert.throws(() => store.update("ses_invalid_ttl", {
        expectedVersion: store.get("ses_invalid_ttl").version,
        leaseToken: lease.leaseToken,
        patch: { leaseTtlMs },
      }), { code: "personal_agent_session_invalid_lease_ttl" });
    }

    const released = store.update("ses_invalid_ttl", {
      expectedVersion: 1, leaseToken: lease.leaseToken, patch: { releaseLease: true },
    });
    assert.equal(released.leaseToken, null);
    assert.ok(store.acquireLease("ses_invalid_ttl", { expectedVersion: released.version, ttlMs: 1000 }));
  } finally {
    await closeAgentJobDbs();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("update checks lease expiry using the clock sampled after acquiring the write lock", async () => {
  let clock = 1000;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-session-lock-clock-"));
  const env = { ORKESTR_HOME: home, ORKESTR_PERSONAL_AGENT_ENABLED: "1" };
  try {
    const db = await openAgentJobDb(env);
    conversationFixture(db);
    migratePersonalAgentSessions(db, { dryRun: false });
    const store = await openPersonalAgentSessionStore({ env, now: () => clock });
    store.create(session("ses_clock_fence", { role: "worker" }));
    const lease = store.acquireLease("ses_clock_fence", { expectedVersion: 0, ttlMs: 100 });
    assert.equal(lease.session.leaseExpiresAt, 1100);
    const exec = db.exec.bind(db);
    db.exec = sql => {
      const result = exec(sql);
      if (sql === "begin immediate") clock = 1200;
      return result;
    };

    assert.equal(store.update("ses_clock_fence", {
      expectedVersion: 1,
      leaseToken: lease.leaseToken,
      patch: { nativeSessionId: "native-after-expiry" },
    }), null);
    assert.equal(store.get("ses_clock_fence").nativeSessionId, null);
  } finally {
    await closeAgentJobDbs();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("session migration repairs same-name scope triggers before accepting an existing schema", () => {
  const db = new DatabaseSync(":memory:");
  try {
    conversationFixture(db);
    migratePersonalAgentSessions(db, { dryRun: false });
    db.exec(`drop trigger personal_agent_sessions_scope_insert;
      drop trigger personal_agent_sessions_scope_update;
      create trigger personal_agent_sessions_scope_insert before insert on personal_agent_sessions begin select 1; end;
      create trigger personal_agent_sessions_scope_update before update of conversation_id, scope_kind, scope_id on personal_agent_sessions begin select 1; end`);

    migratePersonalAgentSessions(db, { dryRun: false });
    const insert = db.prepare(`insert into personal_agent_sessions
      (id,conversation_id,scope_kind,scope_id,role,provider,account_profile_id,model_profile_json,lifecycle,version,created_at,updated_at)
      values (?,?,?,?,?,?,?,?,?,0,'now','now')`);
    assert.throws(() => insert.run(
      "ses_wrong_scope_after_rerun", "conv_project", "global", null,
      "worker", "codex", "acct", "{}", "starting",
    ), /personal_agent_session_scope_mismatch/);
  } finally { db.close(); }
});

test("session migration rebuilds a stale non-unique active-role index", () => {
  const db = new DatabaseSync(":memory:");
  try {
    conversationFixture(db);
    migratePersonalAgentSessions(db, { dryRun: false });
    db.exec("drop index personal_agent_sessions_active_role;");
    db.exec("create index personal_agent_sessions_active_role on personal_agent_sessions(role);");

    assert.equal(planPersonalAgentSessionMigration(db).schemaCompatible, true);
    migratePersonalAgentSessions(db, { dryRun: false });
    const index = db.prepare("pragma index_list(personal_agent_sessions)").all()
      .find(row => row.name === "personal_agent_sessions_active_role");
    assert.equal(index.unique, 1);
  } finally { db.close(); }
});

test("session migration refuses no-op triggers when existing rows violate scope", () => {
  const db = new DatabaseSync(":memory:");
  try {
    conversationFixture(db);
    migratePersonalAgentSessions(db, { dryRun: false });
    db.exec(`drop trigger personal_agent_sessions_scope_insert;
      drop trigger personal_agent_sessions_scope_update;
      create trigger personal_agent_sessions_scope_insert before insert on personal_agent_sessions begin select 1; end;
      create trigger personal_agent_sessions_scope_update before update of conversation_id, scope_kind, scope_id on personal_agent_sessions begin select 1; end;
      insert into personal_agent_sessions
        (id,conversation_id,scope_kind,scope_id,role,provider,account_profile_id,model_profile_json,lifecycle,version,created_at,updated_at)
        values ('bad_scope','conv_project','global',null,'worker','codex','acct','{}','ready',0,'now','now');`);

    assert.throws(() => migratePersonalAgentSessions(db, { dryRun: false }), {
      message: "personal_agent_session_scope_mismatch",
    });
    assert.equal(db.prepare("select count(*) as n from personal_agent_sessions where id='bad_scope'").get().n, 1);
    assert.match(db.prepare("select sql from sqlite_master where type='trigger' and name='personal_agent_sessions_scope_insert'").get().sql, /select 1/i);
  } finally { db.close(); }
});

test("session migration refuses duplicate active roles before rebuilding a stale index", () => {
  const db = new DatabaseSync(":memory:");
  try {
    conversationFixture(db);
    migratePersonalAgentSessions(db, { dryRun: false });
    db.exec(`drop index personal_agent_sessions_active_role;
      create index personal_agent_sessions_active_role on personal_agent_sessions(role);
      insert into personal_agent_sessions
        (id,conversation_id,scope_kind,role,provider,account_profile_id,model_profile_json,lifecycle,version,created_at,updated_at)
        values ('role_a','conv_global','global','fast','codex','acct','{}','ready',0,'now','now');
      insert into personal_agent_sessions
        (id,conversation_id,scope_kind,role,provider,account_profile_id,model_profile_json,lifecycle,version,created_at,updated_at)
        values ('role_b','conv_global','global','fast','codex','acct','{}','busy',0,'now','now');`);

    assert.throws(() => migratePersonalAgentSessions(db, { dryRun: false }), {
      message: "personal_agent_session_active_role_duplicates",
    });
    assert.equal(db.prepare("select count(*) as n from personal_agent_sessions where role='fast'").get().n, 2);
    assert.equal(db.prepare("pragma index_list(personal_agent_sessions)").all().find(row => row.name === "personal_agent_sessions_active_role").unique, 0);
  } finally { db.close(); }
});

test("session migration refuses a foreign-table namesake without touching it", () => {
  const db = new DatabaseSync(":memory:");
  try {
    conversationFixture(db);
    db.exec("create table unrelated_sessions(role text); create index personal_agent_sessions_active_role on unrelated_sessions(role);");
    assert.throws(() => migratePersonalAgentSessions(db, { dryRun: false }), {
      message: "personal_agent_session_schema_incompatible",
    });
    assert.equal(db.prepare("select tbl_name from sqlite_master where type='index' and name='personal_agent_sessions_active_role'").get().tbl_name, "unrelated_sessions");
    assert.equal(db.prepare("select count(*) as n from sqlite_master where type='table' and name='personal_agent_sessions'").get().n, 0);
  } finally { db.close(); }
});

test("flag-gated Agent Job initializer creates sessions after ingress and is idempotent", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-session-init-"));
  const env = { ORKESTR_HOME: home, ORKESTR_PERSONAL_AGENT_ENABLED: "1" };
  try {
    const db = await openAgentJobDb(env);
    const names = () => db.prepare("select name from sqlite_master where type='table' and name like 'personal_agent_%' order by name").all().map(row => row.name);
    assert.ok(names().includes("personal_agent_reasoning_inbox"));
    assert.ok(names().includes("personal_agent_sessions"));
    assert.deepEqual(planPersonalAgentSessionMigration(db).missingColumns, []);
    assert.deepEqual(planPersonalAgentSessionMigration(db).missingTriggers, []);
    assert.ok(db.prepare("pragma foreign_key_list(personal_agent_sessions)").all().some(row => row.table === "personal_agent_conversations"));
    const beforeRerun = names();
    await openAgentJobDb(env);
    assert.deepEqual(names(), beforeRerun);
  } finally {
    await closeAgentJobDbs();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("expired busy session lease is retained and never acquired by another store", async () => {
  let clock = 1_800_000_000_000;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-session-busy-lease-"));
  const env = { ORKESTR_HOME: home, ORKESTR_PERSONAL_AGENT_ENABLED: "1" };
  try {
    const db = await openAgentJobDb(env);
    conversationFixture(db);
    migratePersonalAgentSessions(db, { dryRun: false });
    const first = await openPersonalAgentSessionStore({ env, now: () => clock });
    const second = await openPersonalAgentSessionStore({ env, now: () => clock });
    first.create(session("ses_busy_expired", { role: "worker" }));
    const lease = first.acquireLease("ses_busy_expired", { expectedVersion: 0, ttlMs: 100 });
    const busy = first.update("ses_busy_expired", {
      expectedVersion: 1, leaseToken: lease.leaseToken,
      patch: { lifecycle: "busy", leaseTtlMs: 100 },
    });
    clock += 101;
    assert.equal(second.acquireLease("ses_busy_expired", { expectedVersion: busy.version, ttlMs: 100 }), null);
    assert.equal(first.get("ses_busy_expired").leaseToken, lease.leaseToken);
    assert.equal(first.get("ses_busy_expired").lifecycle, "busy");
  } finally {
    await closeAgentJobDbs();
    await fs.rm(home, { recursive: true, force: true });
  }
});

test("feature-off session store refuses access without adding session schema", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-session-off-"));
  try {
    await assert.rejects(openPersonalAgentSessionStore({ env: { ORKESTR_HOME: home } }), { code: "personal_agent_disabled" });
    const db = await openAgentJobDb({ ORKESTR_HOME: home });
    assert.equal(db.prepare("select count(*) as n from sqlite_master where name='personal_agent_sessions'").get().n, 0);
    assert.equal(db.prepare("select count(*) as n from sqlite_master where name='personal_agent_reasoning_inbox'").get().n, 0);
  } finally {
    await closeAgentJobDbs();
    await fs.rm(home, { recursive: true, force: true });
  }
});
