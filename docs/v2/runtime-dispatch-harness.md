# Synthetic dispatch harness

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

Core dependencies for durable acceptance:

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
