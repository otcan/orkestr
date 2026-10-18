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
  db.exec(`create table personal_agent_conversations (
    id text primary key, scope_kind text not null, project_id text,
    check ((scope_kind = 'global' and project_id is null) or (scope_kind = 'project' and project_id is not null))
  );
  insert into personal_agent_conversations values ('conv_global', 'global', null);
  insert into personal_agent_conversations values ('conv_project', 'project', 'prj_fixture');`);
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
    first.create(session("ses_a"));
    const lease = first.acquireLease("ses_a", { expectedVersion: 0, ttlMs: 1000 });
    assert.equal(lease.session.version, 1);
    assert.equal(second.acquireLease("ses_a", { expectedVersion: 1, ttlMs: 1000 }), null);
    assert.equal(first.update("ses_a", {
      expectedVersion: 1, leaseToken: "wrong-token", patch: { lifecycle: "busy" },
    }), null);
    const updated = second.update("ses_a", {
      expectedVersion: 1, leaseToken: lease.leaseToken,
      patch: { lifecycle: "busy", nativeSessionId: "native-a", heartbeatAt: new Date(clock).toISOString(), releaseLease: true },
    });
    assert.equal(updated.version, 2);
    assert.equal(updated.lifecycle, "busy");
    assert.equal(updated.leaseToken, null);
    assert.equal(first.update("ses_a", {
      expectedVersion: 1, leaseToken: lease.leaseToken, patch: { lifecycle: "ready" },
    }), null);
    const nextLease = second.acquireLease("ses_a", { expectedVersion: 2, ttlMs: 1000 });
    assert.ok(nextLease);
    clock += 1001;
    const expiredTakeover = first.acquireLease("ses_a", { expectedVersion: 3, ttlMs: 1000 });
    assert.ok(expiredTakeover);
    assert.notEqual(expiredTakeover.leaseToken, nextLease.leaseToken);
    assert.equal(first.get("ses_a").version, 4);
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
  } finally {
    await closeAgentJobDbs();
    await fs.rm(home, { recursive: true, force: true });
  }
});
