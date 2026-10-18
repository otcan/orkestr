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
projections and opt-in deterministic expiry controls are covered below. No production
start, provider observation journal, cancellation/recovery acceptance or verified
completion is enabled by this checkpoint.

## Opt-in real-store controls

Core successor `44ecdb30` supplies read-only attempt/scope projections and the
`fixture-test-controls` feature. Runtime forwards that feature only for explicit
offline tests; default and server builds do not enable it.

Three additional tests check committed DeliveryUnknown after Core deliberately
returns Unavailable instead of the consume reply, live-handle pool reattachment
without FAKE I/O, and exact-predecessor takeover after deterministic expiry.
Snapshots check acknowledged inboxes, absent candidate/reservation verifiers,
quarantined reservations, preserved unknown delivery and isolation from another
supervisor key. A fenced predecessor cannot inspect or dispatch. The dropped reply
is a controlled application result, not a process or transport crash.

Core guard-test successor `df911ff7` is included without implementation changes.
Two further real-store cases independently expire Candidate and DeliveryUnknown
contexts before exact-predecessor takeover. Candidate becomes Quarantined;
DeliveryUnknown remains unknown. Both retain consumed inbox evidence, remove
verifiers and refuse old dispatch envelopes. Another namespace with the same
supervisor key retains identical attempt/scope snapshots and can still consume
its own reservation exactly once. These tests use public controls/projections,
without SQL access or a process-recovery claim.

## Earlier volatile protocol harness

On Runtime branch checkpoint `8e8a83c5`,
`orkestr-runtime/tests/dispatch.rs` exercises the existing application dispatch
port using an explicitly enabled, mutex-backed test oracle and the FAKE provider.
That earlier volatile test/support patch is not included in this integration
checkpoint; its reported results remain separate historical evidence.
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
