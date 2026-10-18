import assert from "node:assert/strict";
import test from "node:test";
import { sessionHarness, sessionInput, supervisor } from "./fixtures/personal-agent-session-fixtures.js";

for (const failure of ["identity_event", "identity_rejection", "outcome_invalid", "native_session_missing", "persistence_failed"]) {
  test(`${failure} cannot be masked by concurrent caller cancellation`, async () => {
    const h = sessionHarness();
    let row = h.manager.ensure(sessionInput);
    if (failure.startsWith("identity")) row = await h.manager.startOrResume(row.id);
    const caller = new AbortController(), ctx = supervisor(caller.signal);
    const reason = failure.startsWith("identity") ? "native_identity_changed" : failure;
    const update = h.store.update;
    h.store.update = (id, input) => {
      if (failure === "persistence_failed" && input.patch.nativeSessionId) throw new Error("synthetic persistence failure");
      return update(id, input);
    };
    h.adapter.run = async (_row, managed) => {
      if (failure === "identity_event" || failure === "persistence_failed") {
        managed.emit({ type: "session.started", sessionRef: "synthetic-other-native" });
        caller.abort();
        if (failure === "identity_event") throw new DOMException("synthetic native abort", "AbortError");
        return { type: "final" };
      }
      if (failure === "identity_rejection") {
        caller.abort();
        throw Object.assign(new Error("synthetic identity failure"), { code: "agent_session_native_identity_changed" });
      }
      // Inject cancellation at terminal-result inspection, after the native
      // await has resolved. This deterministically exercises the escaping error.
      return { get type() { caller.abort(); return failure === "outcome_invalid" ? "invented" : "final"; } };
    };
    const outcome = await h.manager.runTurn(row.id, ctx, {}).catch(error => ({ type: "rejected", code: error.code }));
    assert.equal(outcome.type, "rejected", "caller cancellation must not mask an integrity failure");
    assert.equal(outcome.code, `agent_session_${reason}`);
    const current = h.store.get(row.id);
    assert.equal(current.lifecycle, "blocked");
    assert.equal(current.blockedReason, reason, "the integrity diagnosis must survive cancellation");
    assert.equal(current.nativeSessionId, row.nativeSessionId);
    assert.equal(current.leaseToken, null);
    assert.deepEqual(ctx.events, []);
  });
}

for (const initial of ["starting", "ready"]) {
  test(`post-busy non-integrity failure plus cancellation restores ${initial} and permits another turn`, async () => {
    const h = sessionHarness();
    let row = h.manager.ensure(sessionInput);
    if (initial === "ready") row = await h.manager.startOrResume(row.id);
    const caller = new AbortController();
    h.adapter.run = async () => ({ get type() {
      caller.abort();
      throw new Error("synthetic terminal inspection failure");
    } });
    const outcome = await h.manager.runTurn(row.id, supervisor(caller.signal), {});
    assert.equal(outcome.type, "cancelled");
    const current = h.store.get(row.id);
    assert.equal(current.lifecycle, initial, "cancel cleanup must never release a session still marked busy");
    assert.equal(current.blockedReason, row.blockedReason);
    assert.equal(current.leaseToken, null);
    h.adapter.run = async (_row, managed) => {
      managed.emit({ type: "session.started", sessionRef: row.nativeSessionId || "synthetic-recovered-native" });
      return { type: "final" };
    };
    assert.equal((await h.manager.runTurn(row.id, supervisor(), {})).type, "final");
  });
}

test("a true native persistence CAS loss wins over concurrent cancellation and retains its fence", async () => {
  const h = sessionHarness(), row = h.manager.ensure(sessionInput), caller = new AbortController();
  const update = h.store.update;
  h.store.update = (id, input) => input.patch.nativeSessionId ? null : update(id, input);
  h.adapter.run = async (_row, managed) => {
    managed.emit({ type: "session.started", sessionRef: "synthetic-uncommitted-native" });
    caller.abort();
    return { type: "final" };
  };
  await assert.rejects(h.manager.runTurn(row.id, supervisor(caller.signal), {}), /agent_session_lease_lost/);
  const current = h.store.get(row.id);
  assert.equal(current.lifecycle, "busy");
  assert.equal(current.nativeSessionId, null);
  assert.ok(current.leaseToken, "an uncertain CAS fence remains for explicit reconciliation");
});
