# Synthetic dispatch harness

## Real SQLite fixture checkpoint

`tests/fixture_dispatch.rs` consumes Core's implemented adapter at `c51e5187`.
It uses the actual explicit fixture bootstrap, readiness protocol version 1,
authoritative returned binding generation, independent SQLite pools and live
handle reattachment. Four tests cover concurrent fresh/replay admission, one
reservation/consume winner and one FAKE start; pre-dispatch pool reopen replay
without new locators; discarded consume reply and reopen refusing redispatch;
and changed role/fence refusal before I/O. Before FAKE start, another consume
transaction must already return ReconciliationRequired.

These are fixture-table transaction checks. Deliberately discarding a successful
consume reply is not a transport lost-ACK injection. Pool reopen with the original
live handle is not process recovery. Core's private unit-test child executes the
SIGKILL checkpoints; runtime does not expose or recreate those hooks. Public
projection and deterministic expiry facilities are still pending. No production
start, provider observation journal, cancellation/recovery acceptance or verified
completion is enabled by this checkpoint.

## Earlier volatile protocol harness

`orkestr-runtime/tests/dispatch.rs` exercises the existing application dispatch
port using an explicitly enabled, mutex-backed test oracle and the FAKE provider.
It introduces no runtime dispatch path, schema, persistent store or authority.
Production `supervisor::start` remains `DispatchUnconfirmed` for every disposition.

The protocol checks cover concurrent fresh/replay admission, one reservation and
consumption winner, consumption before provider I/O, lost consume acknowledgement
followed by refusal to dispatch, and mismatched role/fence refusal. Recreating the
FAKE provider after a lost acknowledgement is deliberately not a database reopen
test. The oracle does not implement supervisor authorization, store clocks, real
candidate verification or crash durability.

Dependencies originally requested for durable acceptance (Core's adapter now
implements the admission/reservation/consume transactions; crash and expiry
coverage remains Core-owned):

- An authorized supervisor-bound SQLite test bootstrap with explicit owner,
  provider namespace, protocol readiness and authoritative clock configuration.
- Atomic admission and inbox consumption, a store-issued candidate verifier,
  one reservation winner, and consumption committing DeliveryUnknown before
  returning DispatchNow. Existing unavailable methods must stay unavailable until
  these invariants are implemented.
- Independent connections and a reopen handle for concurrent fresh/replay,
  reserve/consume races, and a failpoint after consume commit but before its reply.
  Reopen after that failpoint must preserve unknown state and never redispatch.
- Durable refusal tests for changed role, lease/fence, supervisor incarnation,
  namespace and cancellation. Unknown delivery must remain for reconciliation.

Runtime can connect the FAKE I/O boundary to that reviewed adapter without adding
an alternative store. Passing the volatile oracle tests grants no durable runtime
acceptance and does not authorize provider inference or production dispatch.
