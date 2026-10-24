import assert from "node:assert/strict";
import test from "node:test";
import { deferred, sessionHarness, sessionInput, supervisor } from "./fixtures/personal-agent-session-fixtures.js";

for (const initial of ["starting", "ready"]) {
  for (const lost of [false, true]) {
    test(`propagated workspace abort: ${initial}, own lease ${lost ? "lost" : "valid"}`, async () => {
      const h = sessionHarness();
      let row = h.manager.ensure(sessionInput);
      if (initial === "ready") row = await h.manager.startOrResume(row.id);
      const caller = new AbortController(), entered = deferred(), resume = deferred();
      let starts = 0;
      const ctx = supervisor(caller.signal);
      ctx.prepareWorkspace = async () => { entered.resolve(); await resume.promise; return { path: "/tmp/example-project" }; };
      // Like the native adapters, propagate prepareWorkspace's rejection.
      h.adapter.run = async (_row, managed) => { await managed.prepareWorkspace({}); starts++; return { type: "final" }; };
      const pending = h.manager.runTurn(row.id, ctx, {});
      await entered.promise;
      caller.abort();
      if (lost) h.store.tamper(row.id, { leaseToken: "replacement-fence" });
      resume.resolve();
      if (lost) {
        await assert.rejects(pending, /lease_lost/);
        assert.equal(h.store.get(row.id).leaseToken, "replacement-fence");
        assert.equal(h.store.get(row.id).lifecycle, "busy");
      } else {
        const outcome = await pending.catch(error => ({ type: "rejected", error: error.name }));
        assert.equal(outcome.type, "cancelled", "a propagated owner abort must return cancelled, not reject or block");
        assert.equal(h.store.get(row.id).leaseToken, null);
        assert.equal(h.store.get(row.id).lifecycle, initial);
        assert.equal(h.store.get(row.id).blockedReason, null);
        assert.equal(h.store.get(row.id).nativeSessionId, row.nativeSessionId);
      }
      assert.equal(starts, 0);
    });
  }
}

test("propagated owner abort cannot clear a heartbeat-failed fence", async () => {
  const h = sessionHarness({ leaseMs: 100 });
  const row = await h.manager.startOrResume(h.manager.ensure(sessionInput).id);
  const caller = new AbortController(), entered = deferred(), resume = deferred(), renewal = deferred();
  const ctx = supervisor(caller.signal);
  ctx.prepareWorkspace = async () => { entered.resolve(); await resume.promise; return { path: "/tmp/example-project" }; };
  h.adapter.run = async (_row, managed) => { await managed.prepareWorkspace({}); return { type: "final" }; };
  const update = h.store.update.bind(h.store);
  let failRenewal = false, renewalFailed = false;
  h.store.update = (id, input) => {
    if (failRenewal && input.patch.leaseTtlMs) { renewalFailed = true; renewal.resolve(); return null; }
    return update(id, input);
  };
  const pending = h.manager.runTurn(row.id, ctx, {});
  await entered.promise;
  failRenewal = true;
  // Keep the test event loop alive while the manager's unref'ed heartbeat runs.
  const keepAlive = setTimeout(() => renewal.resolve(), 1000);
  await renewal.promise;
  clearTimeout(keepAlive);
  caller.abort();
  resume.resolve();
  await assert.rejects(pending, /lease_lost/);
  assert.equal(renewalFailed, true, "the synthetic heartbeat CAS must actually fail");
  assert.ok(h.store.get(row.id).leaseToken, "a failed renewal retains its fence for reconciliation");
  assert.equal(h.store.get(row.id).lifecycle, "busy");
});
