import assert from "node:assert/strict";
import test from "node:test";
import { sessionHarness, sessionInput, sessionProfile, sessionStore, supervisor } from "./fixtures/personal-agent-session-fixtures.js";

test("session creation persists the trusted app owner, ignoring caller ownership", () => {
  const h = sessionHarness();
  const row = h.manager.ensure({ ...sessionInput, ownerUserId: "untrusted-owner" });
  assert.equal(row.ownerUserId, "owner");
  assert.equal(h.store.get(row.id).ownerUserId, "owner");
});

test("a stored owner mismatch refuses access and dispatch without overwriting ownership", async () => {
  const h = sessionHarness();
  const row = h.manager.ensure(sessionInput);
  h.store.tamper(row.id, { ownerUserId: "other-owner" });
  assert.throws(() => h.manager.get(row.id), /owner_required/);
  assert.throws(() => h.manager.changeProfile(row.id, sessionProfile), /owner_required/);
  await assert.rejects(h.manager.startOrResume(row.id), /owner_required/);
  await assert.rejects(h.manager.runTurn(row.id, supervisor(), {}), /owner_required/);
  assert.equal(h.store.get(row.id).ownerUserId, "other-owner");
  assert.equal(h.store.get(row.id).leaseToken, null);
  assert.deepEqual(h.calls, []);
});

test("owner replacement during native start cannot persist its result", async () => {
  const h = sessionHarness();
  const row = h.manager.ensure(sessionInput);
  let signal;
  h.adapter.open = async (_row, options) => {
    signal = options.signal;
    h.store.tamper(row.id, { ownerUserId: "other-owner" });
    return { nativeSessionId: "must-not-persist", lifecycle: "ready" };
  };
  await assert.rejects(h.manager.startOrResume(row.id), /owner_required/);
  assert.equal(signal.aborted, true);
  assert.equal(h.store.get(row.id).nativeSessionId, null);
  assert.ok(h.store.get(row.id).leaseToken);
});

test("manager mutations join the store's synchronous transaction; provider awaits stay outside", async () => {
  const h = sessionHarness();
  let depth = 0, transactions = 0;
  const transaction = h.store.transaction?.bind(h.store);
  h.store.transaction = callback => {
    transactions++;
    const run = () => { depth++; try { return callback(h.store); } finally { depth--; } };
    return transaction ? transaction(run) : run();
  };
  for (const name of ["create", "acquireLease", "update"]) {
    const method = h.store[name];
    h.store[name] = (...args) => { assert.ok(depth > 0, `${name} must share the transaction with validation`); return method(...args); };
  }
  const row = h.manager.ensure(sessionInput);
  h.adapter.open = async () => {
    assert.equal(depth, 0);
    return { nativeSessionId: "native-transaction", lifecycle: "ready" };
  };
  await h.manager.startOrResume(row.id);
  await h.manager.runTurn(row.id, supervisor(), {});
  h.manager.changeProfile(row.id, { ...sessionProfile, model: "gpt-next" });
  assert.ok(transactions >= 4);
});

test("missing transaction support fails closed before creation or runtime use", () => {
  const h = sessionHarness();
  delete h.store.transaction;
  assert.throws(() => h.manager.ensure(sessionInput), /store_unavailable/);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.store.list({ conversationId: sessionInput.conversationId, scopeKind: "global" }), []);
});

test("fake store requires owner and rolls nested synchronous operations back atomically", () => {
  const store = sessionStore();
  const input = { id: "session-transaction", conversationId: "conversation-global", scopeKind: "global", role: "fast", ...sessionProfile };
  assert.throws(() => store.create(input), /owner_required/);
  assert.throws(() => store.transaction(tx => {
    const row = tx.create({ ...input, ownerUserId: "owner" });
    tx.transaction(nested => nested.acquireLease(row.id, { expectedVersion: 0, ttlMs: 1000 }));
    throw new Error("rollback-fixture");
  }), /rollback-fixture/);
  assert.equal(store.get(input.id), null);
  assert.throws(() => store.transaction(async tx => { tx.create({ ...input, ownerUserId: "owner" }); }), /must_be_synchronous/);
  assert.equal(store.get(input.id), null);
});

test("an invalid lease result rolls acquisition back with owner/version validation", async () => {
  const h = sessionHarness();
  const row = h.manager.ensure(sessionInput);
  const acquire = h.store.acquireLease;
  h.store.acquireLease = (...args) => {
    const result = acquire(...args);
    h.store.tamper(row.id, { ownerUserId: "other-owner" });
    return { ...result, session: h.store.get(row.id) };
  };
  await assert.rejects(h.manager.startOrResume(row.id), /binding_changed/);
  assert.deepEqual(h.store.get(row.id), row, "validation failure rolls the whole acquisition back");
  assert.deepEqual(h.calls, []);
});

test("a failed profile replacement rolls acquisition and update back together", () => {
  const h = sessionHarness();
  const row = h.manager.ensure(sessionInput);
  h.store.update = () => null;
  assert.throws(() => h.manager.changeProfile(row.id, { ...sessionProfile, model: "gpt-next" }), /lease_lost/);
  assert.deepEqual(h.store.get(row.id), row);
});
