import assert from "node:assert/strict";
import test from "node:test";
import { sessionHarness, sessionInput, sessionProfile, supervisor } from "./fixtures/personal-agent-session-fixtures.js";

// Contract tests against the prepared CAS API. SQLite durability and concurrent
// processes remain the schema lane's integration tests, not claims of this fake.
test("canonical session rows use modelProfile and NULL global scope without an owner column", async () => {
  const h = sessionHarness();
  const created = h.manager.ensure(sessionInput);
  assert.equal(created.scopeId, null);
  assert.deepEqual(created.modelProfile, { model: sessionProfile.model, effort: sessionProfile.effort });
  for (const key of ["profile", "model", "effort", "ownerUserId"]) assert.equal(Object.hasOwn(created, key), false);
  assert.equal(h.store.transaction, undefined);
  h.adapter.open = async row => {
    assert.equal(row.ownerUserId, "owner");
    assert.equal(row.model, sessionProfile.model);
    assert.equal(row.effort, sessionProfile.effort);
    return { nativeSessionId: "native-canonical", lifecycle: "ready" };
  };
  const opened = await h.manager.startOrResume(created.id);
  assert.equal(opened.version, created.version + 2); // acquire + fenced release
  const changed = h.manager.changeProfile(opened.id, { ...sessionProfile, model: "gpt-next" });
  assert.equal(changed.version, opened.version + 2);
  assert.equal(changed.nativeSessionId, opened.nativeSessionId);
  assert.equal(Object.hasOwn(h.store.get(created.id), "ownerUserId"), false);
});

test("missing or revoked trusted conversation access prevents all native calls", async () => {
  let allowed = true;
  const h = sessionHarness({ resolveConversation: id => allowed ? { id, scopeKind: "global", scopeId: null } : null });
  const row = h.manager.ensure(sessionInput);
  allowed = false;
  await assert.rejects(h.manager.startOrResume(row.id), /not_found/);
  assert.throws(() => h.manager.ensure(sessionInput), /conversation_not_found/);
  assert.deepEqual(h.calls, []);
  assert.equal(h.store.get(row.id).leaseToken, null);
  const unavailable = sessionHarness({ resolveConversation() { throw Object.assign(new Error("canonical_conversations_unavailable"), { statusCode: 503 }); } });
  assert.throws(() => unavailable.manager.ensure(sessionInput), { statusCode: 503 });
  assert.deepEqual(unavailable.calls, []);
});

test("lease acquisition uses expectedVersion and loses a competing CAS without native dispatch", async () => {
  const h = sessionHarness();
  const row = h.manager.ensure(sessionInput);
  const acquire = h.store.acquireLease;
  h.store.acquireLease = (id, input) => {
    assert.equal(input.expectedVersion, row.version);
    assert.deepEqual(Object.keys(input).sort(), ["expectedVersion", "ttlMs"]);
    h.store.tamper(id, { version: row.version + 1 });
    return acquire(id, input);
  };
  await assert.rejects(h.manager.startOrResume(row.id), /lease_conflict/);
  assert.deepEqual(h.calls, []);
  assert.equal(h.store.get(row.id).leaseToken, null);
});

test("an expired token is rejected before any store acquisition attempt", async () => {
  const h = sessionHarness({ now: () => 1000 });
  const row = h.manager.ensure(sessionInput);
  h.store.tamper(row.id, { leaseToken: "former-holder", leaseExpiresAt: 999, lifecycle: "busy" });
  h.store.acquireLease = () => assert.fail("manager attempted expired-token takeover");
  await assert.rejects(h.manager.startOrResume(row.id), /reconciliation_required/);
  assert.equal(h.store.get(row.id).leaseToken, "former-holder");
  assert.deepEqual(h.calls, []);
});

test("native identity CAS conflict aborts before forwarding events or invoking effects", async () => {
  const h = sessionHarness();
  const row = h.manager.ensure(sessionInput), ctx = supervisor();
  const update = h.store.update;
  h.store.update = (id, input) => {
    if (input.patch.nativeSessionId) {
      h.store.tamper(id, { version: input.expectedVersion + 1 });
      return update(id, input);
    }
    return update(id, input);
  };
  h.adapter.run = async (_row, managed) => {
    managed.emit({ type: "session.started", sessionRef: "uncommitted-native" });
    assert.equal(managed.signal.aborted, true);
    await assert.rejects(managed.executeTool({}), /lease_lost/);
    managed.emit({ type: "message.completed", text: "must not escape" });
    return { type: "final" };
  };
  await assert.rejects(h.manager.runTurn(row.id, ctx, {}), /lease_lost/);
  assert.deepEqual(ctx.events, []);
  assert.equal(h.store.get(row.id).nativeSessionId, null);
  assert.ok(h.store.get(row.id).leaseToken); // never overwrite the uncertain holder
});

test("a replaced lease suppresses normal output and authorization before the heartbeat tick", async () => {
  const h = sessionHarness();
  const row = await h.manager.startOrResume(h.manager.ensure(sessionInput).id);
  const ctx = supervisor();
  ctx.authorizeTool = () => assert.fail("authorization crossed lost lease");
  h.adapter.run = async (_row, managed) => {
    h.store.tamper(row.id, { leaseToken: "reconciler-token" });
    managed.emit({ type: "message.delta", text: "stale output" });
    assert.equal(managed.signal.aborted, true);
    await assert.rejects(managed.authorizeTool({}), /lease_lost/);
    return { type: "final" };
  };
  await assert.rejects(h.manager.runTurn(row.id, ctx, {}), /lease_lost/);
  assert.deepEqual(ctx.events, []);
  assert.equal(h.store.get(row.id).leaseToken, "reconciler-token");
});

test("concurrent role creation returns the unique winner, never a second native session", () => {
  const h = sessionHarness();
  const create = h.store.create;
  let winner;
  h.store.create = input => {
    winner = create({ ...input, id: "ags-other-creator" });
    return create(input);
  };
  assert.deepEqual(h.manager.ensure(sessionInput), winner);
  assert.equal(h.store.list({ conversationId: "conversation-global", scopeKind: "global" }).length, 1);
  assert.deepEqual(h.calls, []);
});

test("a concurrent role winner with another profile cannot silently change the selection", () => {
  const h = sessionHarness();
  const create = h.store.create;
  h.store.create = input => {
    create({ ...input, id: "ags-other-creator", modelProfile: { model: "other-model", effort: "low" } });
    return create(input);
  };
  assert.throws(() => h.manager.ensure(sessionInput), /use_change_profile/);
  assert.deepEqual(h.calls, []);
});

test("stopped roles do not block a replacement but cannot be resumed or rebound", async () => {
  const h = sessionHarness();
  const first = h.manager.ensure(sessionInput);
  h.store.tamper(first.id, { lifecycle: "stopped" });
  const replacement = h.manager.ensure(sessionInput);
  assert.notEqual(replacement.id, first.id);
  await assert.rejects(h.manager.startOrResume(first.id), /agent_session_stopped/);
  assert.throws(() => h.manager.changeProfile(first.id, sessionProfile), /agent_session_stopped/);
  assert.deepEqual(h.calls, []);
});

test("SQLite native-identity constraint errors are normalized without leaking SQL", async () => {
  const h = sessionHarness();
  const row = h.manager.ensure(sessionInput);
  const update = h.store.update;
  h.store.update = (id, input) => {
    if (input.patch.nativeSessionId) throw new Error("UNIQUE constraint failed: personal_agent_sessions.provider, personal_agent_sessions.account_profile_id, personal_agent_sessions.native_session_id");
    return update(id, input);
  };
  await assert.rejects(h.manager.startOrResume(row.id), { code: "agent_session_native_identity_reused" });
  assert.equal(h.manager.get(row.id).blockedReason, "native_session_unavailable");
  assert.equal(h.manager.get(row.id).nativeSessionId, null);
});

test("unavailable before native creation persists a blocked row with NULL native identity", async () => {
  const h = sessionHarness();
  const row = h.manager.ensure(sessionInput);
  h.adapter.probe = async () => ({ available: false, reason: "authentication_required" });
  await assert.rejects(h.manager.startOrResume(row.id), /auth_required/);
  const blocked = h.manager.get(row.id);
  assert.equal(blocked.lifecycle, "blocked");
  assert.equal(blocked.nativeSessionId, null);
  assert.equal(blocked.leaseToken, null);
});

test("parking before native creation never reports a ready NULL native session", async () => {
  const h = sessionHarness();
  const row = h.manager.ensure(sessionInput);
  h.adapter.run = async () => ({ type: "park", approval: { approvalId: "synthetic-before-start" } });
  assert.equal((await h.manager.runTurn(row.id, supervisor(), {})).type, "park");
  const parked = h.manager.get(row.id);
  assert.equal(parked.nativeSessionId, null);
  assert.equal(parked.lifecycle, "starting");
  assert.equal(parked.leaseToken, null);
});
