# Runtime review of fixture authority prerequisite

Reviewed core prerequisite `2137e98a298df13a75526e31c97698db66fc6ea2` against
the synthetic runtime harness at `8e8a83c581af76d090dcf21739dac2f2eeeb6d63`.
This is a source/document review, not executable or durable acceptance.

The proposed concrete fixture-only handle fits the existing RuntimeStore and
consume-before-FAKE-I/O boundary. No new port or runtime-owned store is needed.
Fresh/replay handling, immutable supervisor context, readiness distinct from
Started, one-use reservation and DeliveryUnknown before I/O match the harness.
No blocking contradiction was found in the proposed sequencing.

Core's executable handoff still needs these concrete test facilities:

- The explicit fixture configuration/bootstrap API and a separate fixture-only
  readiness operation, with the exact supported synthetic protocol version.
  Readiness must return authoritative binding data; runtime must not construct
  authority or mark a binding Ready itself.
- Independent SQLite connections to one temporary database, each with a handle
  authorized for the same live context, for admission/reservation/consume races.
  Reopening after process loss must have a documented authorized reattachment or
  expired-predecessor takeover path. Reopening alone cannot renew authority.
- A bounded test-only failure checkpoint after consume commit and before its
  reply. The test must observe Unavailable/no provider call, reopen using Core's
  authorized path, and observe unknown/refusal with zero redispatch. Also cover
  a crash after a successful consume reply but before FAKE I/O. Neither case may
  reconstruct a DispatchNow receipt.
- Core-owned deterministic expiry control in tests, or a bounded documented
  expiry probe, to exercise predecessor CAS and fence changes without runtime
  supplying execution deadlines or bypassing the authoritative clock.
- Stable error expectations for role/envelope/fence/namespace mismatches and
  consumed replay. Refusal or ReconciliationRequired must never invoke the FAKE
  provider. Lost reservation replies similarly require reconciliation, not a
  replacement locator.

The existing test oracle cannot establish any of those durable properties. Its
mutex concurrency and recreated-provider tests remain protocol checks only.
Core retains schema, fixture authorization and durable acceptance ownership.
All production high-level starts stay blocked pending implemented authorities,
independent review and exact-head acceptance evidence.
