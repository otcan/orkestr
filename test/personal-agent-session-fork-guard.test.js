import assert from "node:assert/strict";
import test from "node:test";
import { sessionHarness, sessionInput } from "./fixtures/personal-agent-session-fixtures.js";

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
  });
}
