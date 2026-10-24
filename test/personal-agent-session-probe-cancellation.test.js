import assert from "node:assert/strict";
import test from "node:test";
import { deferred, sessionHarness, sessionInput, supervisor } from "./fixtures/personal-agent-session-fixtures.js";

for (const initial of ["starting", "ready"]) {
  for (const failure of ["rejects", "unavailable"]) {
    test(`caller cancellation preserves ${initial} session when pending probe ${failure}`, async () => {
      const h = sessionHarness();
      let row = h.manager.ensure(sessionInput);
      if (initial === "ready") row = await h.manager.startOrResume(row.id);
      const caller = new AbortController(), entered = deferred(), resume = deferred();
      h.adapter.probe = async () => {
        entered.resolve();
        await resume.promise;
        if (failure === "rejects") throw new Error("synthetic discovery failure");
        return { available: false, reason: "authentication_required" };
      };
      const patches = [], update = h.store.update;
      h.store.update = (id, input) => { patches.push(input.patch); return update(id, input); };
      h.calls.length = 0;
      const pending = h.manager.runTurn(row.id, supervisor(caller.signal), {});
      await entered.promise;
      caller.abort();
      resume.resolve();
      const outcome = await pending.catch(() => ({ type: "rejected" }));
      assert.equal(outcome.type, "cancelled", "a failed probe after owner abort must return cancelled");
      const current = h.store.get(row.id);
      assert.equal(current.lifecycle, row.lifecycle);
      assert.equal(current.blockedReason, row.blockedReason);
      assert.equal(current.nativeSessionId, row.nativeSessionId);
      assert.equal(current.leaseToken, null, "cancellation must release the valid fence");
      assert.equal(patches.some(patch => "lifecycle" in patch || "blockedReason" in patch), false,
        "probe cancellation cleanup must not write lifecycle or diagnosis");
      assert.equal(h.calls.filter(([kind]) => kind === "run" || kind === "open").length, 0);
    });
  }
}

for (const cause of ["expired", "replaced"]) {
  for (const failure of ["rejects", "unavailable"]) {
    test(`own ${cause} fence takes precedence over cancellation when probe ${failure}`, async () => {
      let now = 1000;
      const h = sessionHarness({ now: () => now, leaseMs: 100 });
      const row = await h.manager.startOrResume(h.manager.ensure(sessionInput).id);
      const caller = new AbortController(), entered = deferred(), resume = deferred();
      h.adapter.probe = async () => {
        entered.resolve();
        await resume.promise;
        if (failure === "rejects") throw new Error("synthetic discovery failure");
        return { available: false };
      };
      h.calls.length = 0;
      const pending = h.manager.runTurn(row.id, supervisor(caller.signal), {});
      await entered.promise;
      caller.abort();
      if (cause === "expired") now = h.store.get(row.id).leaseExpiresAt;
      else h.store.tamper(row.id, { leaseToken: "synthetic-replacement-fence" });
      const uncertain = h.store.get(row.id);
      resume.resolve();
      await assert.rejects(pending, /agent_session_lease_lost/);
      assert.deepEqual(h.store.get(row.id), uncertain, "an uncertain fence must remain untouched for reconciliation");
      assert.equal(h.calls.filter(([kind]) => kind === "run" || kind === "open").length, 0);
    });
  }
}
