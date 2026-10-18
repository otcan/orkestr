import assert from "node:assert/strict";
import test from "node:test";
import { sessionHarness, sessionInput, sessionProfile, sessionStore, supervisor } from "./fixtures/personal-agent-session-fixtures.js";

test("canonical CAS store needs no outer transaction or persisted owner column", async () => {
  const h = sessionHarness();
  delete h.store.transaction;
  const create = h.store.create;
  h.store.create = input => { assert.equal(Object.hasOwn(input, "ownerUserId"), false); return create(input); };
  const row = h.manager.ensure({ ...sessionInput, ownerUserId: "untrusted-input" });
  assert.equal(Object.hasOwn(row, "ownerUserId"), false);
  h.adapter.open = async native => {
    assert.equal(native.ownerUserId, "owner");
    return { nativeSessionId: "native-canonical", lifecycle: "ready" };
  };
  const opened = await h.manager.startOrResume(row.id);
  await h.manager.runTurn(row.id, supervisor(), {});
  const changed = h.manager.changeProfile(row.id, { ...sessionProfile, model: "gpt-next", effort: "low" });
  for (const key of ["id", "conversationId", "nativeSessionId"]) assert.equal(changed[key], opened[key]);
  assert.equal(Object.hasOwn(h.store.get(row.id), "ownerUserId"), false);
});

test("revoked app-owner authorization refuses reads and mutations before storage or providers", async () => {
  let allowed = true;
  const h = sessionHarness({ authorizeOwner: owner => owner === "owner" && allowed });
  const row = h.manager.ensure(sessionInput);
  allowed = false;
  for (const method of ["get", "create", "list", "acquireLease", "update"]) h.store[method] = () => assert.fail("unauthorized storage access");
  assert.throws(() => h.manager.get(row.id), /owner_required/);
  assert.throws(() => h.manager.ensure(sessionInput), /owner_required/);
  assert.throws(() => h.manager.changeProfile(row.id, sessionProfile), /owner_required/);
  await assert.rejects(h.manager.startOrResume(row.id), /owner_required/);
  await assert.rejects(h.manager.runTurn(row.id, supervisor(), {}), /owner_required/);
  assert.deepEqual(h.calls, []);
});

test("missing or asynchronous app-owner authorizer fails closed", () => {
  for (const authorizeOwner of [undefined, async () => true]) {
    const h = sessionHarness({ authorizeOwner });
    assert.throws(() => h.manager.ensure(sessionInput), /owner_required/);
    assert.deepEqual(h.store.list({ conversationId: "conversation-global", scopeKind: "global" }), []);
  }
});

test("trusted canonical resolver is rechecked on reads and mutations", async () => {
  let scopeKind = "global";
  const h = sessionHarness({ resolveConversation: id => ({ id, scopeKind, scopeId: scopeKind === "global" ? null : "project-example" }) });
  const row = h.manager.ensure(sessionInput);
  scopeKind = "project";
  assert.throws(() => h.manager.get(row.id), /scope_unavailable/);
  assert.throws(() => h.manager.ensure(sessionInput), /conversation_not_found/);
  assert.throws(() => h.manager.changeProfile(row.id, sessionProfile), /scope_unavailable/);
  await assert.rejects(h.manager.startOrResume(row.id), /scope_unavailable/);
  assert.equal(h.store.get(row.id).leaseToken, null);
  assert.deepEqual(h.calls, []);
});

test("injected canonical conversation lookup is required without a store fallback", () => {
  const h = sessionHarness({ resolveConversation: undefined });
  assert.throws(() => h.manager.ensure(sessionInput), /store_unavailable/);
  assert.deepEqual(h.calls, []);
});

test("scope is revalidated before a provider result can update the durable row", async () => {
  let scopeKind = "global";
  const h = sessionHarness({ resolveConversation: id => ({ id, scopeKind, scopeId: scopeKind === "global" ? null : "project-example" }) });
  const row = h.manager.ensure(sessionInput);
  h.adapter.open = async () => {
    scopeKind = "project";
    return { nativeSessionId: "must-not-persist", lifecycle: "ready" };
  };
  await assert.rejects(h.manager.startOrResume(row.id), /scope_unavailable/);
  assert.equal(h.store.get(row.id).nativeSessionId, null);
  assert.ok(h.store.get(row.id).leaseToken); // uncertain holder stays fenced
});

test("a replaced conversation binding cannot reuse the old in-flight lease", async () => {
  const h = sessionHarness();
  const row = await h.manager.startOrResume(h.manager.ensure(sessionInput).id), ctx = supervisor();
  h.adapter.run = async (_row, managed) => {
    h.store.tamper(row.id, { conversationId: "conversation-project", scopeKind: "project", scopeId: "project-example" });
    managed.emit({ type: "message.delta", text: "wrong conversation" });
    await assert.rejects(managed.executeTool({}), /binding_changed/);
    return { type: "final" };
  };
  await assert.rejects(h.manager.runTurn(row.id, ctx, {}), /binding_changed/);
  assert.deepEqual(ctx.events, []);
  assert.ok(h.store.get(row.id).leaseToken);
});

test("owner revocation during discovery prevents native session creation", async () => {
  let allowed = true;
  const h = sessionHarness({ authorizeOwner: () => allowed });
  const row = h.manager.ensure(sessionInput);
  h.adapter.probe = async () => { allowed = false; return { available: true }; };
  await assert.rejects(h.manager.startOrResume(row.id), /owner_required/);
  assert.deepEqual(h.calls, []);
  assert.equal(h.store.get(row.id).nativeSessionId, null);
  assert.ok(h.store.get(row.id).leaseToken); // no unauthorized cleanup write
});

test("fake CAS refuses expired busy rows even without a lease token", () => {
  let at = 1000;
  const store = sessionStore({ now: () => at });
  const row = store.create({ id: "session-example", conversationId: "conversation-global", scopeKind: "global", role: "fast", provider: "codex", accountProfileId: "profile-example" });
  const lease = store.acquireLease(row.id, { expectedVersion: 0, ttlMs: 100 });
  const busy = store.update(row.id, { expectedVersion: lease.session.version, leaseToken: lease.leaseToken, patch: { lifecycle: "busy" } });
  at = 1100;
  assert.equal(store.acquireLease(row.id, { expectedVersion: busy.version, ttlMs: 100 }), null);
  assert.deepEqual(store.get(row.id), busy);
  store.tamper(row.id, { leaseToken: null, leaseExpiresAt: null });
  const unfenced = store.get(row.id);
  assert.equal(store.acquireLease(row.id, { expectedVersion: unfenced.version, ttlMs: 100 }), null);
  assert.deepEqual(store.get(row.id), unfenced);
});
