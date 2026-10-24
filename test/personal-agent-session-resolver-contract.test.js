import assert from "node:assert/strict";
import test from "node:test";
import { resolveSessionConversation, sessionHarness, sessionInput, supervisor } from "./fixtures/personal-agent-session-fixtures.js";

test("canonical conversation resolver is injected independently of the prepared session store", async () => {
  const h = sessionHarness({ resolveConversation: resolveSessionConversation });
  delete h.store.conversation;
  const row = h.manager.ensure(sessionInput);
  assert.equal(row.scopeId, null);
  assert.equal((await h.manager.startOrResume(row.id)).lifecycle, "ready");
  assert.equal((await h.manager.runTurn(row.id, supervisor(), {})).type, "final");
});

test("missing injected canonical resolver is unavailable even if a legacy store lookup exists", () => {
  const h = sessionHarness({ resolveConversation: undefined });
  h.store.conversation = id => ({ id, scopeKind: "global", scopeId: null });
  assert.throws(() => h.manager.ensure(sessionInput), { statusCode: 503 });
  assert.deepEqual(h.store.list({ conversationId: sessionInput.conversationId, scopeKind: "global" }), []);
  assert.deepEqual(h.calls, []);
});

test("async or malformed canonical resolver fails closed before session creation", () => {
  for (const resolveConversation of [async id => ({ id, scopeKind: "global", scopeId: null }),
    id => ({ id, scopeKind: "global", scopeId: "sentinel" }), id => ({ id: `${id}-wrong`, scopeKind: "global", scopeId: null })]) {
    const h = sessionHarness({ resolveConversation });
    assert.throws(() => h.manager.ensure(sessionInput));
    assert.deepEqual(h.store.list({ conversationId: sessionInput.conversationId, scopeKind: "global" }), []);
    assert.deepEqual(h.calls, []);
  }
});

test("missing canonical storage propagates 503 without creating or claiming a session", () => {
  const h = sessionHarness({ resolveConversation() { throw Object.assign(new Error("canonical_store_unavailable"), { statusCode: 503 }); } });
  h.store.create = () => assert.fail("created without canonical conversation storage");
  h.store.acquireLease = () => assert.fail("claimed without canonical conversation storage");
  assert.throws(() => h.manager.ensure(sessionInput), { statusCode: 503 });
  assert.deepEqual(h.calls, []);
});

test("native-start persistence conflict aborts its signal without replay or cleanup writes", async () => {
  const h = sessionHarness();
  const row = h.manager.ensure(sessionInput);
  let signal, opens = 0, writes = 0;
  h.adapter.open = async (_row, options) => { signal = options.signal; opens++; return { nativeSessionId: "native-not-committed", lifecycle: "ready" }; };
  h.store.update = () => { writes++; return null; };
  await assert.rejects(h.manager.startOrResume(row.id), /lease_lost/);
  assert.equal(signal.aborted, true);
  assert.equal(opens, 1);
  assert.equal(writes, 1);
  assert.equal(h.store.get(row.id).nativeSessionId, null);
  assert.ok(h.store.get(row.id).leaseToken);
});

test("a fence conflict during a tool callback immediately aborts the active signal", async () => {
  const h = sessionHarness();
  const row = await h.manager.startOrResume(h.manager.ensure(sessionInput).id);
  const ctx = supervisor();
  ctx.authorizeTool = async () => {
    h.store.tamper(row.id, { leaseToken: "synthetic-reconciler-fence" });
    return { decision: "allow" };
  };
  let runs = 0, immediateAborted = false;
  h.adapter.run = async (_row, managed) => {
    runs++;
    await assert.rejects(managed.authorizeTool("example.tool"), /lease_lost/);
    immediateAborted = managed.signal.aborted;
    return { type: "final" };
  };
  await assert.rejects(h.manager.runTurn(row.id, ctx, {}), /lease_lost/);
  assert.equal(runs, 1);
  assert.equal(immediateAborted, true);
  assert.deepEqual(ctx.events, []);
  assert.equal(h.store.get(row.id).leaseToken, "synthetic-reconciler-fence");
});


test("renewal CAS conflict aborts a native turn once and retains its fence", async () => {
  const h = sessionHarness({ leaseMs: 120 });
  const row = await h.manager.startOrResume(h.manager.ensure(sessionInput).id);
  const update = h.store.update;
  let runs = 0, renewals = 0, aborted = false;
  h.store.update = (id, input) => {
    if (input.patch.leaseTtlMs) { renewals++; return null; }
    return update(id, input);
  };
  h.adapter.run = async (_row, ctx) => {
    runs++;
    await new Promise(resolve => ctx.signal.addEventListener("abort", resolve, { once: true }));
    aborted = ctx.signal.aborted;
    return { type: "final" };
  };
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(h.manager.runTurn(row.id, supervisor(), {}), /lease_lost/); }
  finally { clearTimeout(keepAlive); }
  assert.equal(aborted, true);
  assert.equal(runs, 1);
  assert.equal(renewals, 1);
  assert.equal(h.store.get(row.id).lifecycle, "busy");
  assert.ok(h.store.get(row.id).leaseToken);
});

test("prepared store keeps epoch lease expiry and ISO timestamps without new lifecycle values", async () => {
  const h = sessionHarness({ now: () => 1700000000000 });
  const row = h.manager.ensure(sessionInput);
  const lease = h.store.acquireLease(row.id, { expectedVersion: 0, ttlMs: 30000 });
  assert.equal(lease.session.leaseExpiresAt, 1700000030000);
  assert.equal(typeof lease.session.leaseExpiresAt, "number");
  for (const key of ["createdAt", "updatedAt"]) assert.equal(lease.session[key], "2023-11-14T22:13:20.000Z");
  assert.equal(lease.session.heartbeatAt, null);
  assert.equal(lease.session.lifecycle, "starting");
  assert.equal(lease.session.nativeSessionId, null);
  const updated = h.store.update(row.id, { expectedVersion: lease.session.version, leaseToken: lease.leaseToken,
    patch: { lifecycle: "blocked", blockedReason: "authentication_required", heartbeatAt: "2023-11-14T22:13:20.000Z", releaseLease: true } });
  assert.equal(updated.lifecycle, "blocked");
  assert.equal(updated.nativeSessionId, null);
  assert.equal(updated.heartbeatAt, "2023-11-14T22:13:20.000Z");
  assert.equal(updated.leaseExpiresAt, null);
  assert.equal(h.store.list({ conversationId: sessionInput.conversationId, scopeKind: "global", lifecycles: ["blocked"] }).length, 1);
});
