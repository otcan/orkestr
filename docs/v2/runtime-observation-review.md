# Runtime review of fixture observation proposal

Reviewed Core `5e84dbff` proposal and actual-adapter test source. This is a
source-only semantic review; the six ignored acceptance cases remain pending.
No shared port, store, schema, replay DTO or production dispatch is selected here.

The proposed mapping fits the current runtime boundary:

- Provider Started means turn execution, not protocol readiness. ApprovalRequested
  is informational. CompletedProposal preserves synthetic evidence and reaches
  AwaitingAcceptance, never verified success. Failed/Lost must retain their truth;
  Stopped remains unavailable until reviewed cancellation authority exists.
- Runtime retains the exact original admission, event, sequence and bounded text
  across Busy/Unavailable, including a possible committed reply loss. Authenticated
  identical committed replay must precede current authority checks and return its
  historical receipt without another transition. Forged identity and changed input
  must not obtain that receipt. Runtime does not replace an expired envelope.
- New stale/fenced/expired evidence is retained in the bounded volatile rejection
  slot, without acknowledgement, repoll or fabricated stop. That slot is not
  durable reconciliation storage. Progress Unavailable intentionally leaves the
  original progress pending and blocks later events; runtime must not silently
  drop it to advance sequence. A metadata-only harness must explicitly emit no
  Progress rather than claim a full provider stream is persisted.
- Receipt sequence must equal the pending sequence before runtime clears it.
  Store-derived canonical event/outbox/scope sequence and digest remain Core-owned.

Two decisions need explicit Core clarification before adapter implementation:

1. The proposal says no session reuse is granted, but only Starting, Running and
   AwaitingAcceptance are listed for active-turn uniqueness. Failed must not
   accidentally free the session through that predicate. Specify the durable
   binding/uniqueness guard and test a second admission after Failed, Lost and
   proposal refusal, retaining the original session authority and receipt.
2. Starting + Failed is unspecified. A provider can fail before a Started event;
   do not synthesize Started or relabel Failed as Lost. Either accept this exact
   terminal evidence with a reviewed transition or explicitly conflict and retain
   it for reconciliation. Add the chosen case to actual-adapter tests. Current FAKE
   queues Started first, so its normal success path cannot decide this policy.

Before runtime fixture integration, publish the exact additive DTO/migration
handoff and actual append implementation. Runtime can then test fail-once retry,
committed reply loss plus reopen, concurrent identical input, and authenticated
replay after takeover using the existing append operation. Production starts and
ordinary Store append remain blocked. Pool reopen is not process recovery.

## Selected follow-up and prepared tests

The owner selected consumed Starting + Failed -> Failed without an invented
Started, retaining occupied/blocked session authority until a separate lifecycle
operation. `tests/fixture_dispatch/observations.rs` prepares two actual-store cases
using only existing v5 input types: first-event Failed with committed receipt
replay after pool reopen, changed replay conflict, and refusal of another turn
without increasing admitted/acknowledged scope counts. Both tests were initially explicitly ignored pending the exact Core handoff;
that historical preparation was not passing acceptance. They do not invoke provider I/O or define another durable store.

## Actual adapter execution checkpoint

Consumed Core `bf87414f`, `cff94b88` and replay correction `002270e0` with their
proposal prerequisite, retaining the existing v5 append port. The two prepared
tests are now active against actual fixture SQLite transactions. Starting + Failed
produces the first receipt without fabricated Started; reopen returns its original
receipt, changed input conflicts, and another admission on that occupied session
returns Busy without another admitted attempt or inbox acknowledgement.

An additional opt-in test commits Started, expires the context, then performs
exact-predecessor takeover. Original authenticated replay returns its historical
Running receipt before and after takeover. Changed committed events (including
unsupported Progress/Stopped) conflict; forged owner/envelope cannot obtain the
receipt; unseen evidence is Expired before takeover and Fenced afterward. Canonical
event bytes remain identical across these refusals/replays. The successor projects
blocked DeliveryUnknown without candidate/reservation verifiers. No FAKE I/O occurs.

These are fixture-store receipt/occupancy checks, not production lifecycle
acceptance, transport crash recovery or verified completion. Production starts
remain blocked; unsupported raw Progress/Stopped and ordinary Store append remain
unavailable. Independent full-table rollback/outbox checks remain Core/Verification
evidence rather than assertions made by this public-projection harness.
