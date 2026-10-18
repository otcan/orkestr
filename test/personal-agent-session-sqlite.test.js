import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { closeAgentJobDbs, openAgentJobDb } from "../packages/core/src/agent-job-store.js";
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

test("session migration accepts an existing owner-free schema without inventing ownership", () => {
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
    migratePersonalAgentSessions(db, { dryRun: false });
    assert.equal(db.prepare("select count(*) as n from pragma_table_info('personal_agent_sessions') where name='owner_user_id'").get().n, 0);
    migratePersonalAgentSessions(db, { dryRun: false });
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
