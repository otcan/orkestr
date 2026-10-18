import assert from "node:assert/strict";
import test from "node:test";
import { sessionHarness, sessionInput, supervisor } from "./fixtures/personal-agent-session-fixtures.js";

for (const cause of ["cancellation", "lease loss"]) {
  test(`manager refuses synchronous policy callbacks after ${cause}`, async () => {
    const h = sessionHarness();
    const row = await h.manager.startOrResume(h.manager.ensure(sessionInput).id);
    const cancelled = new AbortController();
    const ctx = supervisor(cancelled.signal);
    let decisions = 0, decisionError;
    ctx.toolDecision = () => { decisions++; return "allow"; };
    h.adapter.run = async (_row, managed) => {
      if (cause === "cancellation") cancelled.abort();
      else h.store.tamper(row.id, { leaseToken: "replacement-fence" });
      try { managed.toolDecision("synthetic.tool"); }
      catch (error) { decisionError = error; }
      return { type: "cancelled" };
    };
    const pending = h.manager.runTurn(row.id, ctx, {});
    if (cause === "lease loss") await assert.rejects(pending, /lease_lost/);
    else assert.equal((await pending).type, "cancelled");
    assert.equal(decisions, 0, "no policy callback may run after interruption");
    if (cause === "cancellation") assert.equal(decisionError?.name, "AbortError");
    else assert.match(decisionError?.message || "", /lease_lost/);
  });
}

test("manager preserves the synchronous policy decision contract", async () => {
  const h = sessionHarness();
  const row = await h.manager.startOrResume(h.manager.ensure(sessionInput).id);
  const ctx = supervisor();
  const decisions = [];
  ctx.toolDecision = tool => tool === "synthetic.allowed" ? "allow" : "deny";
  h.adapter.run = async (_row, managed) => {
    decisions.push(managed.toolDecision("synthetic.allowed"), managed.toolDecision("synthetic.denied"));
    return { type: "final", output: { text: "synthetic" } };
  };
  await h.manager.runTurn(row.id, ctx, {});
  assert.deepEqual(decisions, ["allow", "deny"]);
});
