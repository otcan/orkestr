# Runtime port v1: canonical shared handoff

The required V2-012/020 contract supersedes internal runtime port v0. HTTP intake
contract version 0, HTTP event schema 1, and migration `0001_intake.sql` remain
unchanged. Message/event/reasoning-inbox/outbox admission is untouched.

## Exact locations and dependencies

- Shared types: `v2/crates/contracts/src/runtime.rs`, Rust
  `orkestr_v2_contracts::runtime`, `RUNTIME_PORT_VERSION = 1`.
- Typed UUIDs: `orkestr_v2_contracts::{OwnerId, ConversationId, SessionId, RunId,
  MessageId, EventId}`; provider-native strings never replace these IDs.
- Async port: `v2/crates/application/src/runtime.rs`, Rust
  `orkestr_v2_application::runtime::{RuntimeStore, SessionStore}`. Both names
  refer to the same `async_trait`, Send + Sync trait, not competing stores.
- Application adds only `async-trait = "=0.1.89"`. Runtime protocol parsing may
  use existing `serde_json = "=1.0.145"`. Domain remains dependency-free.
  Core changes no root membership or lockfile after handoff; coordinator alone
  resolves the dependency lock and workspace integration.

Runtime owns provider adapters, supervisor scheduling, capability blockers,
bounded fake source and protocol parser. Core owns the application port, all
schema, durable state and verified acceptance. No runtime-owned persistent store.
The prior synchronous runtime `SessionStore` and string-ID admission are obsolete.

## Contract decisions

`Role` is Fast/Deep/Worker (`SessionRole` is an alias). `Binding` carries owner,
conversation, session, role, provider kind, optional native identity, optional
parent, u64 generation and lifecycle state. Unconfigured bindings have
`ProviderKind::Unconfigured`, no native identity, and Starting state. Lost native
identity is never silently replaced. Fast and deep require distinct Orkestr IDs
and distinct native IDs; worker identity and lineage are independent.

`RunAdmission` carries owner/conversation/run/session IDs, role, optional native
identity, u64 lease generation and dispatch fence, attempt, store-assigned
`lease_deadline_ms`, and `AdmissionPurpose`. The extra purpose distinguishes
execution authority from cancellation acknowledgement authority. Cancellation
must never turn the new fenced token into permission to start another turn.
Bindings, claims, admissions and recovery records deliberately have no serde
implementation: they carry internal authority or provider identity.

`ProviderObservation` has a stable source_event_key, typed run/session IDs,
lease generation and `ObservationKind`. The nested kind uses serde's internally
tagged `kind` representation; see fixtures below. Keys are 1..128 ASCII
alphanumeric or `-_.:`; Progress text is at most 8192 UTF-8 bytes. The
`payload_is_bounded` helper validates those bounds only. Store admission also
checks association, owner, lease expiry, cancellation fence and lifecycle in
one transaction. `record_observation` requires its event_key to equal the
observation's source_event_key. Same key/content retries return the original
evidence; changed content conflicts. No arbitrary provider JSON enters the port.

Started alone moves Starting to Running. CompletedProposal moves to
AwaitingAcceptance, including synthetic proposals. Providers cannot grant
approval, authorize effects or transition a task to Succeeded. Core's verified
acceptance gate is a separate, currently unimplemented operation. Only a current
cancellation-acknowledgement token may record Stopped as Cancelled; stale
completions fail. Failed interruption leaves CancelRequested with pending or
unknown inflight status, never falsely confirmed cancellation.

## Atomic operations

The Rust trait is the exact signature authority. Every operation is asynchronous,
short and provider-free within its database transaction:

1. `claim_next(owner, conversation, consumer, Duration)` claims the earliest
   eligible sequence for the deep consumer without deleting/dequeuing. Lease
   duration is 1..60 seconds by store clock. Expiry advances claim generation;
   new ingress is independently admitted while deep is busy.
2. `ensure_role_bindings(owner, conversation)` idempotently reserves distinct
   fast/deep identities. `create_worker_binding(owner, conversation, parent,
   request_key)` reserves independent same-scope worker lineage.
3. `admit_run(claim, binding_id, expected_generation, request_key)` verifies
   ownership, scope, claim, one active turn per native session and fence. Core
   assigns RunId and persists Starting evidence AND claim handoff/ack in the
   same transaction to close the admitted-run/ack crash gap. Identical replay
   returns the original admission; changed request content conflicts. Worker
   admission validates the deep claim and worker binding belong to the same
   authenticated owner/conversation; it never transfers a cross-scope claim.
4. `bind_native_session(admission, native_id, source_event_key)` confirms identity
   without aliasing or replacement. `renew_lease(admission, expected_generation)`
   extends by store-configured bounded duration only for current execution
   authority; expired/stale tokens fail.
5. `record_observation(admission, event_key, observation)` atomically deduplicates,
   checks authority and updates ordered journal/projection.
6. `request_cancel(owner, run, request_key)` idempotently persists CancelRequested,
   increments lease/dispatch generation and journals a durable control request
   before returning `CancelReceipt`. Not-dispatched attempts may cancel directly.
   Receipt includes actual state and NotDispatched/Pending/Unknown inflight status.
7. `acknowledge_inbox(claim, admitted_run)` confirms the atomic handoff
   idempotently with claim generation checking; expired/reclaimed claims cannot
   ack. Follow-ups retain separate inbox rows and original sequence.
8. `recover_runtime(owner, supervisor_instance, now_ms, after, limit)` fences
   prior-supervisor admissions and pages at most 100 records. Store clock is
   authoritative; trusted now_ms cannot extend authority. Cursor binds owner and
   supervisor pass. Preserve IDs/native references, mark Lost/Blocked or retain
   CancelRequested with unknown outcome, recover unacked claims in order, and
   never automatically replay provider start or external effects. Retry is an
   explicit new attempt. Unknown effects remain quarantined.

## Fixtures and explicit blockers

Synthetic serialization examples:
`v2/fixtures/provider-observation-started.json` and
`v2/fixtures/provider-observation-completed-proposal.json`. These are internal
protocol examples, not new HTTP endpoints. Existing seven intake fixtures remain
unchanged. No native references or secret material appear in fixtures.

All ten trait methods (counting binding creation/lease renewal separately) are
contract-only: SQLite runtime migration/adapter is NOT implemented. There is no
in-memory production fallback. Implementations must return
`RuntimeStoreError::Unavailable` for any unimplemented method; never fabricate
successful admissions, recovered state or readiness. Other store errors are
InvalidInput, NotFound, Unauthorized, Busy, StaleLease, Conflict and Expired.
Unsupported provider commands remain runtime capability blockers.

Pending acceptance: claim expiry/reclaim races, binding uniqueness, real native
identity confirmation, run dedup, generation/fence/expiry enforcement, cancellation
acknowledgements, crash-consistent recovery, verified acceptance and effect ledger.
No run, lease, effect or fixture-control HTTP routes are introduced. Passing
provider fake/parser tests does not satisfy these durable acceptance cases.
