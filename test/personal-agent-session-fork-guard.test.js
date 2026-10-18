import assert from "node:assert/strict";
import test from "node:test";
import { sessionHarness, sessionInput, supervisor } from "./fixtures/personal-agent-session-fixtures.js";

for (const cause of ["expired", "replaced"]) {
  test(`fork refuses a child lease ${cause} while acquiring the parent lease`, async () => {
    let now = 1000;
    const h = sessionHarness({ now: () => now, leaseMs: 100 });
    const parent = await h.manager.startOrResume(h.manager.ensure(sessionInput).id);
    const child = h.manager.ensure({ ...sessionInput, role: "worker", forkFromSessionId: parent.id });
    const acquire = h.store.acquireLease;
    h.store.acquireLease = (id, input) => {
      if (id === parent.id) {
        // The child was valid before entering the nested parent acquisition.
        const held = h.store.get(child.id);
        assert.ok(held.leaseToken);
        if (cause === "expired") now = held.leaseExpiresAt;
        else h.store.tamper(child.id, { leaseToken: "replacement-fence" });
      }
      return acquire(id, input);
    };
    let forks = 0;
    h.adapter.open = async () => { forks++; return { nativeSessionId: "must-not-fork", lifecycle: "ready" }; };
    await assert.rejects(h.manager.startOrResume(child.id), /agent_session_lease_lost/);
    assert.equal(forks, 0, "no native fork may be dispatched after losing the child lease");
    const retained = h.store.get(child.id);
    assert.equal(retained.nativeSessionId, null);
    assert.equal(retained.lifecycle, "starting");
    assert.ok(retained.leaseToken, "uncertain child fence must remain for reconciliation");
    assert.equal(h.store.get(parent.id).nativeSessionId, parent.nativeSessionId);
    assert.equal(h.store.get(parent.id).lifecycle, parent.lifecycle);
    assert.equal(h.store.get(parent.id).leaseToken, null, "the still-valid parent fence must be released");
    h.store.acquireLease = acquire;
    assert.equal((await h.manager.runTurn(parent.id, supervisor(), {})).type, "final");
  });
}

for (const cause of ["expired", "replaced", "write_conflict"]) {
  test(`fork retains a genuinely ${cause} parent fence for reconciliation`, async () => {
    let now = 1000;
    const h = sessionHarness({ now: () => now, leaseMs: 100 });
    const parent = await h.manager.startOrResume(h.manager.ensure(sessionInput).id);
    const child = h.manager.ensure({ ...sessionInput, role: "worker", forkFromSessionId: parent.id });
    let forks = 0;
    h.adapter.open = async () => {
      forks++;
      const held = h.store.get(parent.id);
      if (cause === "expired") now = held.leaseExpiresAt;
      else if (cause === "replaced") h.store.tamper(parent.id, { leaseToken: "replacement-parent-fence" });
      else {
        const update = h.store.update;
        let attempts = 0;
        h.store.update = (id, input) => {
          if (id === parent.id) {
            attempts++;
            assert.equal(attempts, 1, "a failed parent CAS must not be retried for cleanup");
            return null;
          }
          return update(id, input);
        };
      }
      return { nativeSessionId: "unconfirmed-fork", lifecycle: "ready" };
    };
    await assert.rejects(h.manager.startOrResume(child.id), /agent_session_lease_lost/);
    assert.equal(forks, 1, "uncertain native dispatch is never replayed");
    assert.ok(h.store.get(parent.id).leaseToken, "a lost parent fence cannot be released");
    assert.equal(h.store.get(parent.id).nativeSessionId, parent.nativeSessionId);
    assert.equal(h.store.get(child.id).nativeSessionId, null);
    await assert.rejects(h.manager.runTurn(parent.id, supervisor(), {}), /agent_session_(busy|reconciliation_required)/);
  });
}
