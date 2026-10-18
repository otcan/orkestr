import assert from "node:assert/strict";
import test from "node:test";
import { createPersonalAgentSessionManager } from "../packages/core/src/personal-agent-session-manager.js";
import { deferred, sessionHarness, sessionInput, sessionProfile, supervisor } from "./fixtures/personal-agent-session-fixtures.js";

test("AT-03: fast/deep have distinct Orkestr/native identities per conversation and survive a manager restart", async () => {
  const h = sessionHarness();
  const roles = await h.manager.ensureScope({ ...sessionInput, profiles: { fast: sessionProfile, deep: sessionProfile } });
  assert.notEqual(roles.fast.id, roles.deep.id);
  assert.notEqual(roles.fast.nativeSessionId, roles.deep.nativeSessionId);
  assert.notEqual(roles.fast.id, roles.fast.nativeSessionId);
  const restarted = h.another();
  assert.deepEqual(restarted.ensure(sessionInput), roles.fast);
  assert.equal((await restarted.startOrResume(roles.fast.id)).nativeSessionId, roles.fast.nativeSessionId);
  const changed = restarted.changeProfile(roles.fast.id, { ...sessionProfile, model: "gpt-other", effort: "low" });
  for (const key of ["id", "nativeSessionId", "conversationId"]) assert.equal(changed[key], roles.fast[key]);
  assert.equal(changed.modelProfile.model, "gpt-other");
  assert.throws(() => restarted.changeProfile(changed.id, { ...sessionProfile, accountProfileId: "other-profile" }), /profile_rebind_required/);
});

test("project/global binding, owner and profile validation fail before native calls", () => {
  const h = sessionHarness();
  const project = h.manager.ensure({ ...sessionInput, conversationId: "conversation-project", scope: { kind: "project", id: "project-example" } });
  assert.equal(project.scopeId, "project-example");
  for (const input of [{ ...sessionInput, conversationId: "conversation-other" }, { ...sessionInput, conversationId: "conversation-project" },
    { ...sessionInput, scope: { kind: "global", id: "project-example" } }, { ...sessionInput, profile: { ...sessionProfile, endpoint: "http://example.invalid" } }]) {
    assert.throws(() => h.manager.ensure(input));
  }
  const other = createPersonalAgentSessionManager({ store: h.store, ownerUserId: "other", env: { ORKESTR_PERSONAL_AGENT_ENABLED: "1" } });
  assert.throws(() => other.get(project.id), /owner_required/);
  assert.deepEqual(h.calls, []);
});

test("flag off does not touch store or runtimes", async () => {
  const h = sessionHarness({ env: {}, store: new Proxy({}, { get() { assert.fail("storage touched"); } }) });
  assert.throws(() => h.manager.ensure(sessionInput), /personal_agent_disabled/);
  await assert.rejects(h.manager.runTurn("example", supervisor(), {}), /personal_agent_disabled/);
  assert.deepEqual(h.calls, []);
});

test("only one turn owns a session across managers, while fast and deep may run concurrently", async () => {
  const h = sessionHarness();
  const fast = await h.manager.startOrResume(h.manager.ensure(sessionInput).id);
  const deep = await h.manager.startOrResume(h.manager.ensure({ ...sessionInput, role: "deep" }).id);
  const entered = deferred(), finish = deferred();
  h.adapter.run = async () => { entered.resolve(); await finish.promise; return { type: "final" }; };
  const first = h.manager.runTurn(fast.id, supervisor(), {});
  await entered.promise;
  await assert.rejects(h.another().runTurn(fast.id, supervisor(), {}), /agent_session_busy/);
  assert.throws(() => h.manager.changeProfile(fast.id, sessionProfile), /agent_session_busy/);
  const second = h.another().runTurn(deep.id, supervisor(), {});
  finish.resolve();
  await Promise.all([first, second]);
  assert.equal(h.manager.get(fast.id).leaseToken, null);
});

test("heartbeat renews a long turn and an expired/crashed lease is never stolen", async () => {
  let clock = Date.now();
  const h = sessionHarness({ leaseMs: 120, now: () => clock });
  const row = await h.manager.startOrResume(h.manager.ensure(sessionInput).id);
  h.adapter.run = async () => {
    clock += 60;
    await new Promise(done => setTimeout(done, 60)); // heartbeat extends expiry beyond the original lease
    clock += 80;
    return { type: "final" };
  };
  assert.equal((await h.manager.runTurn(row.id, supervisor(), {})).type, "final");
  const updated = h.manager.get(row.id);
  assert.ok(Date.parse(updated.heartbeatAt) >= Date.parse(row.heartbeatAt));
  h.store.tamper(row.id, { lifecycle: "busy", leaseToken: "crashed", leaseExpiresAt: 946684800000 });
  await assert.rejects(h.another().startOrResume(row.id), /reconciliation_required/);
  assert.equal(h.manager.get(row.id).leaseToken, "crashed");
});

test("a lost heartbeat aborts the native turn and retains its fence for reconciliation", async () => {
  const h = sessionHarness({ leaseMs: 120 });
  const row = await h.manager.startOrResume(h.manager.ensure(sessionInput).id);
  const entered = deferred();
  h.adapter.run = async (_row, ctx) => { entered.resolve(); await new Promise(done => ctx.signal.addEventListener("abort", done, { once: true })); return { type: "final" }; };
  const pending = h.manager.runTurn(row.id, supervisor(), {});
  await entered.promise;
  h.store.tamper(row.id, { leaseExpiresAt: 946684800000 });
  // Keep the fake process alive while the manager's unref'ed heartbeat runs.
  const keepAlive = setTimeout(() => {}, 500);
  try { await assert.rejects(pending, /lease_lost/); } finally { clearTimeout(keepAlive); }
  assert.ok(h.manager.get(row.id).leaseToken);
});

for (const reason of ["authentication_required", "rate_limited", "runtime_unavailable"]) {
  test(`${reason} is a persisted blocked state without fallback`, async () => {
    const h = sessionHarness();
    h.adapter.probe = async () => ({ available: false, reason });
    const row = h.manager.ensure(sessionInput);
    await assert.rejects(h.manager.startOrResume(row.id));
    assert.equal(h.manager.get(row.id).lifecycle, "blocked");
    assert.equal(h.manager.get(row.id).blockedReason, reason);
    assert.deepEqual(h.calls, []);
  });
}

test("cancellation discards a late provider success and reaches the native signal", async () => {
  const h = sessionHarness();
  const row = await h.manager.startOrResume(h.manager.ensure(sessionInput).id);
  const cancelled = new AbortController();
  h.adapter.run = async (_row, ctx) => { cancelled.abort(); assert.equal(ctx.signal.aborted, true); return { type: "final", output: "late success" }; };
  assert.deepEqual(await h.manager.runTurn(row.id, supervisor(cancelled.signal), {}), { type: "cancelled" });
  assert.equal(h.manager.get(row.id).leaseToken, null);
});

test("native identity cannot change during resume or after the first session announcement", async () => {
  const h = sessionHarness();
  const row = await h.manager.startOrResume(h.manager.ensure(sessionInput).id);
  h.adapter.open = async () => ({ nativeSessionId: "replacement", lifecycle: "ready" });
  await assert.rejects(h.manager.startOrResume(row.id), /native_identity_changed/);
  assert.equal(h.manager.get(row.id).nativeSessionId, row.nativeSessionId);
  const fresh = h.manager.ensure({ ...sessionInput, role: "deep" });
  const ctx = supervisor();
  h.adapter.run = async (_row, managed) => {
    managed.emit({ type: "session.started", sessionRef: "first-native" });
    managed.emit({ type: "session.started", sessionRef: "tampered-native" });
    assert.equal(managed.signal.aborted, true);
    await assert.rejects(managed.executeTool({}), /native_identity_changed/);
    return { type: "final" };
  };
  await assert.rejects(h.manager.runTurn(fresh.id, ctx, {}), /native_identity_changed/);
  assert.equal(h.manager.get(fresh.id).nativeSessionId, "first-native");
  assert.equal(ctx.events.length, 1);
});

test("after cancellation, tool callbacks and late message emissions fail closed", async () => {
  const h = sessionHarness();
  const row = await h.manager.startOrResume(h.manager.ensure(sessionInput).id);
  const cancelled = new AbortController(), ctx = supervisor(cancelled.signal);
  let executed = false;
  ctx.executeTool = async () => { executed = true; };
  h.adapter.run = async (_row, managed) => {
    cancelled.abort();
    managed.emit({ type: "message.completed", text: "late unapproved reply" });
    await assert.rejects(managed.executeTool({}), { name: "AbortError" });
    return { type: "final" };
  };
  assert.equal((await h.manager.runTurn(row.id, ctx, {})).type, "cancelled");
  assert.equal(executed, false);
  assert.deepEqual(ctx.events, []);
});

test("native identity cannot alias another role, including a provider response during start", async () => {
  const h = sessionHarness();
  const fast = await h.manager.startOrResume(h.manager.ensure(sessionInput).id);
  h.adapter.open = async () => ({ nativeSessionId: fast.nativeSessionId, lifecycle: "ready" });
  const deep = h.manager.ensure({ ...sessionInput, role: "deep" });
  await assert.rejects(h.manager.startOrResume(deep.id), /native_identity_reused/);
  assert.equal(h.manager.get(deep.id).nativeSessionId, null);
});

test("malformed native identities and null scope fail before persisting a binding", async () => {
  const h = sessionHarness();
  assert.throws(() => h.manager.ensure({ ...sessionInput, scope: null }), /scope_invalid/);
  h.adapter.open = async () => ({ nativeSessionId: { id: "not-a-string" }, lifecycle: "ready" });
  const row = h.manager.ensure(sessionInput);
  await assert.rejects(h.manager.startOrResume(row.id), /identity_invalid/);
  assert.equal(h.manager.get(row.id).nativeSessionId, null);
});

test("a late authorization cannot return allow after owner cancellation", async () => {
  const h = sessionHarness();
  const row = await h.manager.startOrResume(h.manager.ensure(sessionInput).id);
  const cancelled = new AbortController(), ctx = supervisor(cancelled.signal);
  ctx.authorizeTool = async () => { cancelled.abort(); return { decision: "allow" }; };
  h.adapter.run = async (_row, managed) => {
    await assert.rejects(managed.authorizeTool({}), { name: "AbortError" });
    return { type: "final" };
  };
  assert.equal((await h.manager.runTurn(row.id, ctx, {})).type, "cancelled");
});

test("cancellation during discovery does not invoke a native turn or claim initial readiness", async () => {
  const h = sessionHarness(), cancelled = new AbortController();
  const row = h.manager.ensure(sessionInput);
  h.adapter.probe = async () => { cancelled.abort(); return { available: true }; };
  assert.equal((await h.manager.runTurn(row.id, supervisor(cancelled.signal), {})).type, "cancelled");
  assert.deepEqual(h.calls, []);
  assert.equal(h.manager.get(row.id).lifecycle, "starting");
  assert.equal(h.manager.get(row.id).leaseToken, null);
});

test("fork lineage is same conversation/account and serialized against the parent", async () => {
  const h = sessionHarness();
  const parent = await h.manager.startOrResume(h.manager.ensure(sessionInput).id);
  const child = h.manager.ensure({ ...sessionInput, role: "worker", forkFromSessionId: parent.id });
  assert.equal((await h.manager.startOrResume(child.id)).forkFromSessionId, parent.id);
  assert.notEqual(h.manager.get(child.id).nativeSessionId, parent.nativeSessionId);
  assert.throws(() => h.manager.ensure({ ...sessionInput, role: "worker", profile: { ...sessionProfile, accountProfileId: "other" }, forkFromSessionId: parent.id }), /fork_invalid/);
  const entered = deferred(), finish = deferred();
  h.adapter.run = async () => { entered.resolve(); await finish.promise; return { type: "final" }; };
  const busy = h.manager.runTurn(parent.id, supervisor(), {});
  await entered.promise;
  const next = h.manager.ensure({ ...sessionInput, role: "worker", forkFromSessionId: parent.id });
  await assert.rejects(h.manager.startOrResume(next.id), /agent_session_busy/);
  finish.resolve();
  await busy;
});

test("fork refuses an unreconciled parent after an uncertain provider failure", async () => {
  const h = sessionHarness();
  const parent = await h.manager.startOrResume(h.manager.ensure(sessionInput).id);
  h.adapter.run = async () => { throw new Error("synthetic lost provider acknowledgement"); };
  await assert.rejects(h.manager.runTurn(parent.id, supervisor(), {}));
  assert.equal(h.manager.get(parent.id).lifecycle, "blocked");
  const child = h.manager.ensure({ ...sessionInput, role: "worker", forkFromSessionId: parent.id });
  const opens = h.calls.filter(([type]) => type === "open").length;
  await assert.rejects(h.manager.startOrResume(child.id), /reconciliation_required/);
  assert.equal(h.calls.filter(([type]) => type === "open").length, opens);
});

test("native callbacks use the supervisor's policy/effect decisions; no raw runner is accepted", async () => {
  const h = sessionHarness();
  const row = h.manager.ensure(sessionInput);
  await assert.rejects(h.manager.runTurn(row.id, { signal: new AbortController().signal }, {}), /supervisor_required/);
  const ctx = supervisor();
  let authorization = 0, execution = 0;
  ctx.authorizeTool = async tool => { assert.equal(tool, "example.tool"); authorization++; return { decision: "deny" }; };
  ctx.executeTool = async () => { execution++; return { status: "denied" }; };
  h.adapter.run = async (_row, managed) => {
    managed.emit({ type: "session.started", sessionRef: "policy-native" });
    assert.deepEqual(await managed.authorizeTool("example.tool"), { decision: "deny" });
    assert.deepEqual(await managed.executeTool("example.tool"), { status: "denied" });
    return { type: "park", approval: { approvalId: "synthetic-approval" } };
  };
  assert.equal((await h.manager.runTurn(row.id, ctx, {})).type, "park");
  assert.equal(authorization, 1);
  assert.equal(execution, 1);
});

test("final replies require a persisted native identity and a recognized native outcome", async () => {
  const h = sessionHarness();
  const row = h.manager.ensure(sessionInput);
  h.adapter.run = async () => ({ type: "final" });
  await assert.rejects(h.manager.runTurn(row.id, supervisor(), {}), /native_session_missing/);
  // A blocked row requires explicit reconciliation; use an independent
  // admitted session to check the separate invalid-outcome failure.
  const other = await h.manager.startOrResume(h.manager.ensure({ ...sessionInput, role: "worker" }).id);
  h.adapter.run = async () => ({ type: "invented" });
  await assert.rejects(h.manager.runTurn(other.id, supervisor(), {}), /outcome_invalid/);
});
