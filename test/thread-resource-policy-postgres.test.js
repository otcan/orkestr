import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  __threadResourcePolicyStoreTestInternals,
  readThreadResourcePolicyState,
  withThreadResourcePolicyTransaction,
} from "../packages/core/src/thread-resource-policy-store.js";
import { threadResourcePolicyDoctorReport } from "../packages/core/src/thread-resource-policy-doctor.js";
import { ingestMailboxMessage } from "../packages/connectors/src/mailbox-inbox.js";
import { runMailboxDeliveryPump } from "../packages/connectors/src/mailbox-delivery-pump.js";
import { createMailbox, createMailboxThreadListener } from "../packages/core/src/mailboxes.js";
import { adminPrincipal } from "../packages/core/src/principal.js";
import { registerThreadResource, setThreadResourceGrants } from "../packages/core/src/thread-resource-grants.js";
import { createThread, listThreadMessages } from "../packages/core/src/threads.js";
import { listConnectorInboxEvents, markConnectorInboxEvent, resetConnectorInboxForTest } from "../packages/connectors/src/connector-inbox.js";

const stateTables = new Set([
  "orkestr_thread_resource_policy", "orkestr_thread_resources", "orkestr_thread_resource_grants",
  "orkestr_thread_resource_ceilings", "orkestr_thread_resource_mutations", "orkestr_mailbox_thread_listeners",
  "orkestr_mailbox_thread_deliveries", "orkestr_mailbox_thread_pump_leases", "orkestr_thread_resource_sessions",
]);

function clone(value) {
  return structuredClone(value);
}

function policyEnv(home) {
  return {
    ORKESTR_HOME: home,
    ORKESTR_THREAD_RESOURCE_POLICY_STORE: "postgres",
    ORKESTR_THREAD_RESOURCE_POLICY_POSTGRES_URL: "postgres://fixture/policy",
    ORKESTR_DESKTOP_ACCESS_MODE: "enforce",
    ORKESTR_OXRM_ACCESS_MODE: "enforce",
    ORKESTR_MAILBOX_ACCESS_MODE: "enforce",
  };
}

function fakePolicyPool() {
  const shared = { meta: new Map(), tables: Object.fromEntries([...stateTables].map((name) => [name, new Map()])), audit: new Map() };
  let writeTail = Promise.resolve();
  let serializationFailures = 0;

  const storeFor = (client) => client?.working || client?.snapshot || shared;
  const keyFor = (table, columns = {}, data = {}) => {
    if (table === "orkestr_thread_resource_policy") return `${columns.thread_id}|${columns.resource_type}`;
    if (table === "orkestr_thread_resources") return `${columns.resource_type}|${columns.resource_id}`;
    if (table === "orkestr_thread_resource_grants") return columns.id;
    if (table === "orkestr_thread_resource_ceilings") return `${columns.thread_id}|${columns.resource_type}|${columns.resource_id}`;
    if (table === "orkestr_thread_resource_mutations") return `${columns.action}|${columns.idempotency_key}`;
    if (table === "orkestr_mailbox_thread_listeners" || table === "orkestr_mailbox_thread_deliveries" || table === "orkestr_thread_resource_sessions") return columns.id;
    if (table === "orkestr_mailbox_thread_pump_leases") return columns.name;
    return data.id;
  };
  const lower = (sql) => String(sql).replace(/\s+/g, " ").trim().toLowerCase();
  const releaseWrite = (client) => {
    client?.unlock?.();
    client.unlock = null;
  };

  async function dispatch(client, sql, params = []) {
    const text = lower(sql);
    if (text.startsWith("create table") || text.startsWith("create unique index") || text.startsWith("create index")) return { rows: [] };
    if (text.startsWith("begin isolation level serializable")) {
      if (serializationFailures > 0) {
        serializationFailures -= 1;
        const error = new Error("could not serialize access due to concurrent update");
        error.code = "40001";
        throw error;
      }
      client.write = true;
      return { rows: [] };
    }
    if (text.startsWith("begin isolation level repeatable read")) { client.snapshot = clone(shared); return { rows: [] }; }
    if (text === "commit") {
      if (client.working) {
        shared.meta = client.working.meta;
        shared.tables = client.working.tables;
        shared.audit = client.working.audit;
      }
      releaseWrite(client);
      return { rows: [] };
    }
    if (text === "rollback") { releaseWrite(client); return { rows: [] }; }
    if (text.startsWith("insert into orkestr_thread_resource_meta")) {
      const target = storeFor(client);
      if (text.includes("do update")) target.meta.set(params[0], params[1]);
      else if (!target.meta.has(params[0])) target.meta.set(params[0], params[1]);
      return { rows: [] };
    }
    if (text.startsWith("select value from orkestr_thread_resource_meta")) {
      if (text.includes("for update") && !client.working) {
        const previous = writeTail;
        let unlock;
        writeTail = new Promise((resolve) => { unlock = resolve; });
        await previous;
        client.unlock = unlock;
        client.working = clone(shared);
      }
      const target = storeFor(client);
      return target.meta.has(params[0]) ? { rows: [{ value: target.meta.get(params[0]) }] } : { rows: [] };
    }
    const deleteMatch = text.match(/^delete from ([a-z0-9_]+)/);
    if (deleteMatch && stateTables.has(deleteMatch[1])) { storeFor(client).tables[deleteMatch[1]].clear(); return { rows: [] }; }
    const stateInsert = text.match(/^insert into ([a-z0-9_]+)\(([^)]+)\) values/);
    if (stateInsert && stateTables.has(stateInsert[1])) {
      const columns = stateInsert[2].split(",").map((item) => item.trim());
      const values = Object.fromEntries(columns.map((column, index) => [column, params[index]]));
      const data = typeof params.at(-1) === "string" ? JSON.parse(params.at(-1)) : params.at(-1);
      storeFor(client).tables[stateInsert[1]].set(keyFor(stateInsert[1], values, data), { data });
      return { rows: [] };
    }
    const dataSelect = text.match(/^select data from ([a-z0-9_]+)/);
    if (dataSelect && stateTables.has(dataSelect[1])) return { rows: [...storeFor(client).tables[dataSelect[1]].values()] };
    if (text.startsWith("insert into orkestr_thread_resource_audit_outbox")) {
      const target = storeFor(client);
      const record = {
        id: params[0], action: params[1], resource_type: params[2], outcome: params[3], actor_user_id: params[4], reason: params[5],
        expires_at: params[6], policy_revision: params[7], state: params[8], claim_token: params[9], claim_expires_at: params[10], delivered_at: params[11], created_at: params[12],
      };
      const existing = target.audit.get(record.id);
      target.audit.set(record.id, existing ? { ...existing, state: record.state, claim_token: record.claim_token, claim_expires_at: record.claim_expires_at, delivered_at: record.delivered_at } : record);
      return { rows: [] };
    }
    if (text.startsWith("select * from orkestr_thread_resource_audit_outbox")) return { rows: [...storeFor(client).audit.values()].sort((left, right) => String(left.created_at).localeCompare(String(right.created_at))) };
    throw new Error(`unexpected fake policy postgres query: ${sql}`);
  }

  return {
    setSerializationFailures(count = 0) { serializationFailures = Math.max(0, Number(count) || 0); },
    async query(sql, params = []) { return dispatch(null, sql, params); },
    async connect() {
      const client = {
        async query(sql, params = []) { return dispatch(client, sql, params); },
        release() {},
      };
      return client;
    },
  };
}

function resource(id = "local:admin:oxrm:crm") {
  return { id, nativeId: "crm", resourceType: "oxrm", resourceKey: "crm", ownerUserId: "admin", boundaryId: "local", generation: 1, status: "active", backend: "oxrm", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", retiredAt: null };
}

test("PostgreSQL policy store commits complete state, preserves audit, and rolls back", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-resource-postgres-"));
  const env = policyEnv(home);
  __threadResourcePolicyStoreTestInternals.setPostgresPoolFactory(() => fakePolicyPool());
  try {
    const audit = { id: "audit-old", action: "break_glass", resourceType: "oxrm", outcome: "allowed", actorUserId: "admin", reason: "incident", expiresAt: null, policyRevision: 1, state: "pending", claimToken: null, claimExpiresAt: null, deliveredAt: null, createdAt: "2026-01-01T00:00:00.000Z" };
    await withThreadResourcePolicyTransaction((state) => {
      state.revision = 1;
      state.resources = [resource()];
      state.policies = [{ threadId: "thread-1", resourceType: "oxrm", revision: 1, explicitEmpty: false, inheritanceMode: "explicit", parentSnapshotRevision: 0, createdAt: audit.createdAt, updatedAt: audit.createdAt }];
      state.grants = [{ id: "grant-1", threadId: "thread-1", resourceType: "oxrm", resourceId: resource().id, resourceKey: "crm", ownerUserId: "admin", boundaryId: "local", permissions: ["read"], revision: 1, source: "admin", createdAt: audit.createdAt, updatedAt: audit.createdAt, revokedAt: null, revokedBy: null, reason: null }];
      state.ceilings = [{ threadId: "thread-1", resourceType: "oxrm", resourceId: resource().id, permissions: ["read"], parentThreadId: "parent", createdAt: audit.createdAt }];
      state.mutations = [{ action: "grant.replace", idempotencyKey: "request-1", result: { ok: true }, policyRevision: 1, createdAt: audit.createdAt }];
      state.mailboxListeners = [{ id: "listener-1", resourceType: "mailbox", resourceId: "mail-1", threadId: "thread-1", filterKey: "filter", filter: {}, idempotencyKey: "listener-request", generation: 1, status: "active", grantRevision: 1, policyRevision: 1, resourceGeneration: 1, createdAt: audit.createdAt, updatedAt: audit.createdAt, revokedAt: null, revokedBy: null, reason: null }];
      state.mailboxDeliveries = [{ id: "delivery-1", dedupeKey: "delivery-1", resourceType: "mailbox", resourceId: "mail-1", mailboxId: "mail-1", listenerId: "listener-1", listenerGeneration: 1, threadId: "thread-1", state: "pending", epoch: 1, attemptCount: 0, maxAttempts: 5, nextAttemptAt: audit.createdAt, claimToken: null, claimExpiresAt: null, grantRevision: 1, policyRevision: 1, resourceGeneration: 1, messageKey: "message-hash", payload: {}, reason: null, createdAt: audit.createdAt, updatedAt: audit.createdAt, deliveredAt: null }];
      state.mailboxPumpLeases = [{ name: "mailbox-thread-delivery", token: "lease", expiresAt: audit.createdAt, updatedAt: audit.createdAt }];
      state.resourceSessions = [{ id: "session-1", jtiHash: "jti", tokenIdHash: "token", bearerHash: "bearer", audience: "orkestr-connectors-mcp", scopes: ["connectors:read"], principalKind: "external_instance", principalId: "instance", ownerUserId: "admin", instanceId: "instance", accountId: "account", accountService: "whatsapp", resourceType: "oxrm", resourceId: resource().id, actions: ["read"], threadId: "thread-1", grantThreadId: "thread-1", rootThreadId: "thread-1", boundaryId: "local", policyRevision: 1, grantRevision: 1, resourceGeneration: 1, state: "active", epoch: 1, issuedAt: audit.createdAt, expiresAt: "2026-01-01T00:01:00.000Z", lastUsedAt: null, createdAt: audit.createdAt, updatedAt: audit.createdAt, invalidatedAt: null, invalidationReason: null }];
      return { state, auditOutboxUpserts: [audit] };
    }, env);
    const committed = await readThreadResourcePolicyState(env);
    assert.equal(committed.resources.length, 1);
    assert.equal(committed.policies.length, 1);
    assert.equal(committed.grants.length, 1);
    assert.equal(committed.ceilings.length, 1);
    assert.equal(committed.mutations.length, 1);
    assert.equal(committed.mailboxListeners.length, 1);
    assert.equal(committed.mailboxDeliveries.length, 1);
    assert.equal(committed.mailboxPumpLeases.length, 1);
    assert.equal(committed.resourceSessions[0].audience, "orkestr-connectors-mcp");
    assert.equal((await readThreadResourcePolicyState({ ...env, ORKESTR_THREAD_RESOURCE_POLICY_STORE: "postgresql" })).revision, 1);
    assert.equal(await fs.stat(path.join(home, "thread-resource-policy.sqlite")).then(() => true, () => false), false);
    await assert.rejects(() => withThreadResourcePolicyTransaction((state) => { state.resources.push(resource("rollback")); throw new Error("rollback"); }, env), /rollback/);
    assert.equal((await readThreadResourcePolicyState(env)).resources.some((item) => item.id === "rollback"), false);
    await withThreadResourcePolicyTransaction((state) => ({ state, auditOutboxUpserts: [{ ...audit, id: "audit-new", action: "grants_replaced" }] }), env);
    const preserved = await readThreadResourcePolicyState(env);
    assert.equal(preserved.policyAuditOutbox.some((item) => item.id === "audit-old"), true);
    assert.equal(preserved.policyAuditOutbox.some((item) => item.id === "audit-new"), true);
  } finally {
    __threadResourcePolicyStoreTestInternals.setPostgresPoolFactory(null);
  }
});

test("PostgreSQL policy store serializes concurrent CAS writes and fails closed when unavailable", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-resource-postgres-cas-"));
  const env = policyEnv(home);
  __threadResourcePolicyStoreTestInternals.setPostgresPoolFactory(() => fakePolicyPool());
  try {
    await withThreadResourcePolicyTransaction((state) => { state.revision = 1; return { state }; }, env);
    const attempts = await Promise.allSettled(["one", "two"].map((id) => withThreadResourcePolicyTransaction((state) => {
      if (state.revision !== 1) throw Object.assign(new Error("thread_resource_policy_revision_conflict"), { statusCode: 409 });
      state.revision = 2;
      state.mutations.push({ action: "cas", idempotencyKey: id, result: { id }, policyRevision: 2, createdAt: "2026-01-01T00:00:00.000Z" });
      return { state };
    }, env)));
    assert.equal(attempts.filter((item) => item.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((item) => item.status === "rejected" && /thread_resource_policy_revision_conflict/.test(item.reason?.message)).length, 1);
    assert.equal((await readThreadResourcePolicyState(env)).mutations.length, 1);
  } finally {
    __threadResourcePolicyStoreTestInternals.setPostgresPoolFactory(() => { throw new Error("connection refused private-postgres.example"); });
  }
  try {
    await assert.rejects(() => readThreadResourcePolicyState(env), /thread_resource_policy_postgres_unavailable/);
    const report = await threadResourcePolicyDoctorReport(env);
    assert.equal(report.backend, "postgres");
    assert.equal(report.health, "unavailable");
    assert.equal(JSON.stringify(report).includes("private-postgres.example"), false);
  } finally {
    __threadResourcePolicyStoreTestInternals.setPostgresPoolFactory(null);
  }
});

test("exhausted PostgreSQL serialization conflicts leave mailbox ingress in the durable replay spool", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-resource-postgres-mailbox-"));
  const env = {
    ...policyEnv(home),
    ORKESTR_ADMIN_USER_ID: "admin",
    ORKESTR_MAILBOX_DOMAIN: "mail.example.test",
  };
  const pool = fakePolicyPool();
  __threadResourcePolicyStoreTestInternals.setPostgresPoolFactory(() => pool);
  resetConnectorInboxForTest();
  try {
    const principal = adminPrincipal("admin");
    const thread = await createThread({ id: "postgres-conflict-mailbox", name: "Postgres conflict", ownerUserId: "admin" }, env);
    const mailbox = await createMailbox({ ownerUserId: "admin", purpose: "alerts", suffix: "conflict", status: "active" }, env);
    await registerThreadResource({ resourceType: "mailbox", resourceId: mailbox.id, ownerUserId: "admin", status: "active" }, { principal }, env);
    await setThreadResourceGrants(thread.id, "mailbox", [{ resourceId: mailbox.id, permissions: ["read", "subscribe", "manage"] }], { principal }, env);
    await createMailboxThreadListener({ mailbox, threadId: thread.id, principal }, env);

    pool.setSerializationFailures(3);
    const ingested = await ingestMailboxMessage({
      recipient: mailbox.address,
      headers: { messageId: "<postgres-conflict@example.test>", from: "builds@example.test", subject: "Conflict" },
      envelope: { rcptTo: mailbox.address, mailFrom: "builds@example.test" },
      body: { text: "replay me" },
    }, env);
    assert.equal(ingested.action, "mailbox_policy_unavailable_spooled");
    const [spooled] = await listConnectorInboxEvents({ states: ["policy-unavailable"] }, env);
    assert.ok(spooled);
    assert.equal((await listThreadMessages(thread.id, env)).length, 0);

    pool.setSerializationFailures(0);
    await markConnectorInboxEvent(spooled.id, { nextAttemptAt: new Date(Date.now() - 1_000).toISOString() }, env);
    const replayed = await runMailboxDeliveryPump(env);
    assert.equal(replayed.replay.results[0].state, "routed");
    assert.equal((await listThreadMessages(thread.id, env)).filter((item) => item.source === "mailbox").length, 1);
  } finally {
    resetConnectorInboxForTest();
    __threadResourcePolicyStoreTestInternals.setPostgresPoolFactory(null);
  }
});

const realPostgresUrl = String(process.env.ORKESTR_TEST_THREAD_RESOURCE_POLICY_POSTGRES_URL || "").trim();

test("real PostgreSQL policy store round-trips a transactional record when an isolated test database is configured", { skip: !realPostgresUrl }, async () => {
  // This opt-in URL must point at a disposable test database. The test keeps
  // its marker isolated and removes it afterwards, but must not share an
  // operator's policy database with a running deployment.
  const marker = `integration-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const env = {
    ORKESTR_THREAD_RESOURCE_POLICY_STORE: "postgres",
    ORKESTR_THREAD_RESOURCE_POLICY_POSTGRES_URL: realPostgresUrl,
  };
  const markerId = `local:admin:oxrm:${marker}`;
  let inserted = false;
  try {
    await withThreadResourcePolicyTransaction((state) => {
      state.resources.push({ ...resource(markerId), nativeId: marker, resourceKey: marker });
      return { state };
    }, env);
    inserted = true;
    assert.equal((await readThreadResourcePolicyState(env)).resources.some((item) => item.id === markerId), true);
  } finally {
    if (inserted) {
      await withThreadResourcePolicyTransaction((state) => {
        state.resources = state.resources.filter((item) => item.id !== markerId);
        return { state };
      }, env);
    }
  }
});
