import assert from "node:assert/strict";
import test from "node:test";
import { deferred, sessionHarness, sessionInput, supervisor } from "./fixtures/personal-agent-session-fixtures.js";

for (const cause of ["cancellation", "lease loss"]) {
  for (const phase of ["before preparation", "during preparation"]) {
    test(`manager fences workspace ${cause} ${phase}`, async () => {
      const h = sessionHarness();
      const row = await h.manager.startOrResume(h.manager.ensure(sessionInput).id);
      const cancelled = new AbortController();
      const ctx = supervisor(cancelled.signal);
      const entered = deferred(), resume = deferred();
      let workspaceCalls = 0, starts = 0;
      const errors = [];
      const interrupt = () => cause === "cancellation" ? cancelled.abort()
        : h.store.tamper(row.id, { leaseToken: "replacement-fence" });
      ctx.prepareWorkspace = async () => {
        workspaceCalls++;
        if (phase === "during preparation") {
          entered.resolve();
          await resume.promise;
        }
        return { path: "/tmp/example-project", kind: "project" };
      };
      h.adapter.run = async (_row, managed) => {
        if (phase === "before preparation") interrupt();
        try {
          await managed.prepareWorkspace({});
          starts++;
        } catch (error) { errors.push(error); }
        // An executor must not be able to retry preparation after interruption.
        try { await managed.prepareWorkspace({}); }
        catch (error) { errors.push(error); }
        return { type: "cancelled" };
      };
      const pending = h.manager.runTurn(row.id, ctx, {});
      if (phase === "during preparation") {
        await entered.promise;
        interrupt();
        resume.resolve();
      }
      if (cause === "lease loss") await assert.rejects(pending, /lease_lost/);
      else assert.equal((await pending).type, "cancelled");
      // Keep observations outside the fake executor: cleanup errors must not
      // mask an assertion or make a rejected turn look like a passing guard.
      assert.equal(workspaceCalls, phase === "before preparation" ? 0 : 1,
        "no workspace callback may be dispatched after interruption");
      assert.equal(starts, 0, "no provider start may use a late workspace result");
      assert.equal(errors.length, 2, "initial preparation and retry must both be refused");
      for (const error of errors) {
        if (cause === "cancellation") assert.equal(error.name, "AbortError");
        else assert.match(error.message, /lease_lost/);
      }
    });
  }
}
