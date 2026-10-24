import assert from "node:assert/strict";
import test from "node:test";
import { sessionHarness, sessionInput, supervisor } from "./fixtures/personal-agent-session-fixtures.js";

function recordWrites(store) {
  const patches = [], update = store.update;
  store.update = (id, input) => { patches.push(input.patch); return update(id, input); };
  return patches;
}
function unchangedDiagnosis(before, after, patches) {
  assert.equal(after.lifecycle, before.lifecycle, "refusal must preserve the lifecycle");
  assert.equal(after.blockedReason, before.blockedReason, "refusal must preserve the exact stored diagnosis");
  assert.equal(after.leaseToken, null, "a valid borrowed fence must be released");
  assert.equal(patches.some(patch => "lifecycle" in patch || "blockedReason" in patch), false,
    "refusal cleanup must not write lifecycle or diagnosis");
}

for (const method of ["runTurn", "startOrResume"]) {
  for (const reason of ["authentication_required", "reconciliation_required", "rate_limited"]) {
    test(`${method} refuses an already blocked ${reason} session without rewriting it`, async () => {
      const h = sessionHarness(), row = h.manager.ensure(sessionInput);
      h.store.tamper(row.id, { lifecycle: "blocked", blockedReason: reason });
      const before = h.store.get(row.id), patches = recordWrites(h.store);
      await assert.rejects(method === "runTurn" ? h.manager.runTurn(row.id, supervisor(), {}) : h.manager.startOrResume(row.id),
        /agent_session_reconnect_required/);
      unchangedDiagnosis(before, h.store.get(row.id), patches);
      assert.deepEqual(h.calls, [], "blocked sessions must not probe, open or run a provider");
    });
  }
  for (const lifecycle of ["busy", "stopped"]) {
    test(`${method} refuses ${lifecycle} sessions before any mutation or provider call`, async () => {
      const h = sessionHarness(), row = h.manager.ensure(sessionInput);
      h.store.tamper(row.id, { lifecycle, blockedReason: "reconciliation_required" });
      const before = h.store.get(row.id), patches = recordWrites(h.store);
      await assert.rejects(method === "runTurn" ? h.manager.runTurn(row.id, supervisor(), {}) : h.manager.startOrResume(row.id),
        /agent_session_(reconciliation_required|stopped)/);
      assert.deepEqual(h.store.get(row.id), before);
      assert.deepEqual(patches, []);
      assert.deepEqual(h.calls, []);
    });
  }
}

test("an unstarted fork turn releases its fence without changing starting state", async () => {
  const h = sessionHarness();
  const parent = await h.manager.startOrResume(h.manager.ensure(sessionInput).id);
  const child = h.manager.ensure({ ...sessionInput, role: "worker", forkFromSessionId: parent.id });
  const patches = recordWrites(h.store);
  h.calls.length = 0;
  await assert.rejects(h.manager.runTurn(child.id, supervisor(), {}), /fork_not_started/);
  unchangedDiagnosis(child, h.store.get(child.id), patches);
  assert.deepEqual(h.calls, []);
});

for (const lifecycle of ["blocked", "busy"]) {
  test(`fork refusal for a ${lifecycle} parent preserves both sessions`, async () => {
    const h = sessionHarness();
    const parent = await h.manager.startOrResume(h.manager.ensure(sessionInput).id);
    h.store.tamper(parent.id, { lifecycle, blockedReason: "reconciliation_required" });
    const child = h.manager.ensure({ ...sessionInput, role: "worker", forkFromSessionId: parent.id });
    const beforeParent = h.store.get(parent.id), patches = recordWrites(h.store);
    h.calls.length = 0;
    await assert.rejects(h.manager.startOrResume(child.id), /reconciliation_required/);
    unchangedDiagnosis(child, h.store.get(child.id), patches);
    assert.equal(h.store.get(parent.id).lifecycle, beforeParent.lifecycle);
    assert.equal(h.store.get(parent.id).blockedReason, beforeParent.blockedReason);
    assert.equal(h.store.get(parent.id).leaseToken, null);
    assert.deepEqual(h.calls, []);
  });
}

test("admitted provider failure keeps an existing specific diagnosis", async () => {
  const h = sessionHarness();
  const row = await h.manager.startOrResume(h.manager.ensure(sessionInput).id);
  h.adapter.run = async () => {
    h.store.tamper(row.id, { blockedReason: "authentication_required" });
    throw new Error("synthetic provider failure");
  };
  await assert.rejects(h.manager.runTurn(row.id, supervisor(), {}), /synthetic provider failure/);
  const current = h.store.get(row.id);
  assert.equal(current.lifecycle, "blocked");
  assert.equal(current.blockedReason, "authentication_required");
  assert.equal(current.leaseToken, null);
});

for (const cause of ["expired", "replaced"]) {
  test(`blocked refusal retains a ${cause} fence for reconciliation`, async () => {
    let now = 1000;
    const h = sessionHarness({ now: () => now, leaseMs: 100 }), row = h.manager.ensure(sessionInput);
    h.store.tamper(row.id, { lifecycle: "blocked", blockedReason: "reconciliation_required" });
    const acquire = h.store.acquireLease;
    h.store.acquireLease = (id, input) => {
      const result = acquire(id, input);
      if (cause === "expired") now = result.session.leaseExpiresAt;
      else h.store.tamper(id, { leaseToken: "synthetic-replacement-fence" });
      return result;
    };
    await assert.rejects(h.manager.runTurn(row.id, supervisor(), {}), /lease_lost/);
    const current = h.store.get(row.id);
    assert.equal(current.lifecycle, "blocked");
    assert.equal(current.blockedReason, "reconciliation_required");
    assert.ok(current.leaseToken);
    assert.equal(h.calls.filter(([kind]) => kind === "open" || kind === "run").length, 0);
  });
}
