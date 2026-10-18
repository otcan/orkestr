import assert from "node:assert/strict";
import test from "node:test";
import { createPersonalAgentSessionManager } from "../packages/core/src/personal-agent-session-manager.js";
import { sessionHarness, sessionInput, sessionProfile, sessionStore, supervisor } from "./fixtures/personal-agent-session-fixtures.js";

const input = { id: "session-example", ownerUserId: "owner", conversationId: "conversation-global", scopeKind: "global", role: "fast", provider: "codex", accountProfileId: "profile-example", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };

test("session pins authenticated owner without assuming an owner column on conversations", () => {
  const h = sessionHarness({ resolveConversation: id => ({ id, scopeKind: "global", scopeId: null }) });
  const row = h.manager.ensure({ ...sessionInput, ownerUserId: "untrusted-input" });
  assert.equal(row.ownerUserId, "owner");
  assert.equal(h.manager.changeProfile(row.id, { ...sessionProfile, model: "gpt-next" }).ownerUserId, "owner");
});

test("another owner cannot use a row even when the conversation projection permits lookup", async () => {
  const h = sessionHarness();
  const row = h.manager.ensure(sessionInput);
  const other = createPersonalAgentSessionManager({ store: h.store, ownerUserId: "other", resolveConversation: id => ({ id, scopeKind: "global", scopeId: null }), env: { ORKESTR_PERSONAL_AGENT_ENABLED: "1" }, runtimes: { codex: h.adapter } });
  assert.throws(() => other.get(row.id), /not_found/);
  assert.throws(() => other.ensure(sessionInput), /not_found/);
  assert.throws(() => other.changeProfile(row.id, sessionProfile), /not_found/);
  await assert.rejects(other.startOrResume(row.id), /not_found/);
  await assert.rejects(other.runTurn(row.id, supervisor(), {}), /not_found/);
  assert.deepEqual(h.calls, []);
  assert.equal(h.store.get(row.id).leaseToken, null);
});

test("fake refuses owner replacement under a valid lease", () => {
  const store = sessionStore({ now: () => 1000 });
  const row = store.create(input), lease = store.acquireLease(row.id, { expectedVersion: 0, ttlMs: 100 });
  assert.throws(() => store.update(row.id, { expectedVersion: lease.session.version, leaseToken: lease.leaseToken, patch: { ownerUserId: "other" } }), /owner_immutable/);
  assert.deepEqual(store.get(row.id), lease.session);
});

test("fake transaction rolls back lease, heartbeat and version together", () => {
  const store = sessionStore({ now: () => 1000 }), row = store.create(input);
  assert.throws(() => store.transaction(() => {
    const lease = store.acquireLease(row.id, { expectedVersion: 0, ttlMs: 100 });
    store.update(row.id, { expectedVersion: lease.session.version, leaseToken: lease.leaseToken, patch: { heartbeatAt: "2026-01-01T00:00:01.000Z", lifecycle: "busy" } });
    throw new Error("synthetic rollback");
  }), /synthetic rollback/);
  assert.deepEqual(store.get(row.id), row);
  assert.throws(() => store.transaction(async () => assert.fail("async callback invoked")), /async_transaction/);
  assert.throws(() => store.transaction(() => { store.create({ ...input, id: "worker", role: "worker" }); return Promise.resolve(); }), /async_transaction/);
  assert.equal(store.get("worker"), null);
});

test("manager groups writes synchronously and never holds a transaction over a provider await", async () => {
  const h = sessionHarness();
  let depth = 0, transactions = 0;
  const transaction = h.store.transaction;
  h.store.transaction = fn => transaction(() => { depth++; transactions++; try { return fn(); } finally { depth--; } });
  for (const method of ["create", "acquireLease", "update"]) {
    const original = h.store[method];
    h.store[method] = (...args) => { assert.ok(depth > 0, `${method} outside transaction`); return original(...args); };
  }
  h.adapter.probe = async () => { assert.equal(depth, 0); return { available: true }; };
  h.adapter.open = async () => { assert.equal(depth, 0); await Promise.resolve(); assert.equal(depth, 0); return { nativeSessionId: "native-example", lifecycle: "ready" }; };
  h.adapter.run = async () => { assert.equal(depth, 0); await Promise.resolve(); assert.equal(depth, 0); return { type: "final" }; };
  const row = h.manager.ensure(sessionInput);
  await h.manager.startOrResume(row.id);
  await h.manager.runTurn(row.id, supervisor(), {});
  h.manager.changeProfile(row.id, { ...sessionProfile, effort: "low" });
  assert.ok(transactions >= 8);
  assert.equal(depth, 0);
});

test("store refuses expired busy leases without changing lifecycle, version or holder", () => {
  let at = 1000;
  const store = sessionStore({ now: () => at }), row = store.create(input);
  const lease = store.acquireLease(row.id, { expectedVersion: 0, ttlMs: 100 });
  const busy = store.update(row.id, { expectedVersion: lease.session.version, leaseToken: lease.leaseToken, patch: { lifecycle: "busy" } });
  at = 1100;
  assert.equal(store.acquireLease(row.id, { expectedVersion: busy.version, ttlMs: 100 }), null);
  assert.deepEqual(store.get(row.id), busy);
  store.tamper(row.id, { leaseToken: null, leaseExpiresAt: null });
  const unfencedBusy = store.get(row.id);
  assert.equal(store.acquireLease(row.id, { expectedVersion: busy.version, ttlMs: 100 }), null);
  assert.deepEqual(store.get(row.id), unfencedBusy);
});

test("manager refuses an old store without synchronous transactions", () => {
  const h = sessionHarness();
  delete h.store.transaction;
  assert.throws(() => h.manager.ensure(sessionInput), { code: "agent_session_store_unavailable", statusCode: 503 });
  assert.deepEqual(h.store.list({ conversationId: "conversation-global", scopeKind: "global" }), []);
  assert.deepEqual(h.calls, []);
});
