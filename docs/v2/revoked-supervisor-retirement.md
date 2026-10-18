# Revoked supervisor retirement

Ordinary authorized supervisor handles expose:

```rust,ignore
async fn retire_revoked_supervisor(&self) -> RuntimeResult<u64>;
```

This is a sealed negative-authority teardown operation, not cancellation or a
replacement authentication path. Invoke it on the original bound handle after
its machine credential has been deleted/expired and the transport is being
quarantined. It accepts no owner, context, token, incarnation, run or timestamp
from callers. An unbound Store refuses Unavailable.

One BEGIN IMMEDIATE transaction proves that the exact original token hash/owner
has no current session, and that the stored supervisor still matches the handle's
full owner/provider/namespace/key/context/incarnation/generation. A live session
refuses Busy; a replaced context refuses Fenced. It then marks only that exact
incarnation's Starting/Running/CancelRequested runs Blocked, keeps DeliveryUnknown
unknown, quarantines undispatched candidates/reservations and erases all dispatch
locators. Their bindings become Lost. The supervisor deadline becomes zero, so
old metadata/setup authority cannot resume. No issued lease/control is created.

The returned count is newly blocked runs, not confirmed stopped processes.
Repeating the same sealed retirement returns zero without ledger changes. Queued
messages/inbox rows, observations, cancellation requests and terminal history
remain intact. AwaitingAcceptance is preserved as committed completion evidence;
retirement does not accept it, release its binding, or fabricate Failed/Stopped/
Cancelled/Succeeded. Process kill/reap and output quarantine remain transport
responsibilities. A successor still needs fresh authentication and exact
predecessor takeover; retirement never manufactures another session.

Author tests cover live/unbound refusal; candidate/reserved/consumed retirement;
queue retention and erased locators; idempotence; completion preservation and
obsolete-context refusal after fresh authenticated takeover. They are ordinary
SQLite tests, not HTTP/provider/process acceptance. Worker lineage propagation
remains gated by the separate Worker admission proposal.
