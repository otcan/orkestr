import assert from "node:assert/strict";
import test from "node:test";
import { sessionStore } from "./fixtures/personal-agent-session-fixtures.js";

// Behavioral parity for the fake CAS surface, not SQLite/trigger evidence.
const input = (id = "session-example", extra = {}) => ({ id, conversationId: "conversation-global",
  scopeKind: "global", role: "fast", provider: "codex", accountProfileId: "profile-example",
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", ...extra });
const notFound = { code: "personal_agent_session_not_found", statusCode: 404 };

test("fake store applies canonical nullable fields, lifecycle and version defaults", () => {
  const row = sessionStore().create(input());
  for (const key of ["scopeId", "nativeSessionId", "forkFromSessionId", "blockedReason", "heartbeatAt", "leaseToken", "leaseExpiresAt"]) assert.equal(row[key], null, key);
  assert.equal(row.lifecycle, "starting");
  assert.equal(row.version, 0);
  assert.deepEqual(row.modelProfile, {});
});

test("fake get returns null but missing mutation IDs throw the canonical 404", () => {
  const store = sessionStore();
  assert.equal(store.get("missing"), null);
  assert.throws(() => store.acquireLease("missing", { expectedVersion: 0, ttlMs: 100 }), notFound);
  assert.throws(() => store.update("missing", { expectedVersion: 0, leaseToken: "missing", patch: {} }), notFound);
});

test("fake rejects invalid acquisition TTL before mutating", () => {
  const store = sessionStore({ now: () => 1000 });
  const row = store.create(input());
  for (const ttlMs of [0, -1, 1.5, NaN, Infinity, "100"]) {
    assert.throws(() => store.acquireLease(row.id, { expectedVersion: 0, ttlMs }), { code: "personal_agent_session_invalid_lease_ttl", statusCode: 400 });
    assert.deepEqual(store.get(row.id), row);
  }
});

test("fake lease CAS fences stale versions, tokens and expiry with exact version increments", () => {
  let at = 1000;
  const store = sessionStore({ now: () => at }), row = store.create(input());
  assert.equal(store.acquireLease(row.id, { expectedVersion: 1, ttlMs: 100 }), null);
  const claimed = store.acquireLease(row.id, { expectedVersion: 0, ttlMs: 100 });
  assert.equal(claimed.session.version, 1);
  assert.equal(claimed.session.leaseToken, claimed.leaseToken);
  assert.equal(store.acquireLease(row.id, { expectedVersion: 1, ttlMs: 100 }), null);
  const update = (version, token, patch = {}) => store.update(row.id, { expectedVersion: version, leaseToken: token, patch });
  assert.equal(update(0, claimed.leaseToken), null);
  assert.equal(update(1, "wrong"), null);
  const renewed = update(1, claimed.leaseToken, { leaseTtlMs: 200, heartbeatAt: "2026-01-01T00:00:01.000Z" });
  assert.equal(renewed.version, 2);
  assert.equal(renewed.leaseExpiresAt, 1200);
  at = 1200;
  assert.equal(update(2, claimed.leaseToken), null);
  const reclaimed = store.acquireLease(row.id, { expectedVersion: 2, ttlMs: 100 });
  assert.equal(reclaimed.session.version, 3);
  assert.notEqual(reclaimed.leaseToken, claimed.leaseToken);
  const released = update(3, reclaimed.leaseToken, { releaseLease: true });
  assert.equal(released.version, 4);
  assert.equal(released.leaseToken, null);
  assert.equal(released.leaseExpiresAt, null);
  assert.equal(update(4, null), null);
});

test("fake list uses canonical optional roles and lifecycles with NULL global scope", () => {
  const store = sessionStore();
  store.create(input("fast"));
  store.create(input("deep", { role: "deep", lifecycle: "blocked", blockedReason: "provider_unavailable" }));
  store.create(input("project", { conversationId: "conversation-project", scopeKind: "project", scopeId: "project-example" }));
  const scope = { conversationId: "conversation-global", scopeKind: "global" };
  assert.deepEqual(store.list({ ...scope, roles: ["deep"], lifecycles: ["blocked"] }).map(row => row.id), ["deep"]);
  assert.deepEqual(store.list({ ...scope, lifecycles: ["ready"] }), []);
  assert.deepEqual(store.list({ ...scope, scopeId: "project-example" }), []);
});

test("fake enforces active role and cross-role native identity uniqueness", () => {
  const store = sessionStore();
  store.create(input("fast", { nativeSessionId: "native-example" }));
  assert.throws(() => store.create(input("duplicate-role")), /active role conflict/);
  assert.throws(() => store.create(input("deep", { role: "deep", nativeSessionId: "native-example" })), { code: "agent_session_native_identity_reused" });
  store.create(input("worker-a", { role: "worker" }));
  store.create(input("worker-b", { role: "worker" }));
  store.create(input("historical", { lifecycle: "stopped" }));
});
