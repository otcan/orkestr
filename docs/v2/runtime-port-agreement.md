# Runtime port v4: canonical shared handoff

The required V2-012/020 contract supersedes internal runtime ports v0, v1 and v2. HTTP intake
contract version 0, HTTP event schema 1, and migration `0001_intake.sql` remain
unchanged. Message/event/reasoning-inbox/outbox admission is untouched.

## Exact locations and dependencies

- Shared types: `v2/crates/contracts/src/runtime.rs`, Rust
  `orkestr_v2_contracts::runtime`, `RUNTIME_PORT_VERSION = 4`.
- Typed UUIDs: `orkestr_v2_contracts::{OwnerId, ConversationId, SessionId, RunId,
  MessageId, EventId}`; provider-native strings never replace these IDs.
- Async port: `v2/crates/application/src/runtime.rs`, Rust
  `orkestr_v2_application::runtime::{RuntimeStore, SessionStore}`. Both names
  refer to the same Send + Sync trait. Each method returns
  `impl Future<Output = Result<T>> + Send`; no boxed future or macro is required.
- Application depends only on contracts. Runtime protocol parsing may
  use existing `serde_json = "=1.0.145"`. Domain has no storage, HTTP or provider dependencies.
  Core changes no root membership or lockfile after handoff; coordinator alone
  owns subsequent dependency lock and workspace integration. This revision removes
  the unintegrated async-trait dependency and requires no root lockfile change.

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
lease generation, dispatch fence and `ObservationKind` (`ProviderObservationKind` alias). The nested kind uses serde's internally
tagged `kind` representation; see fixtures below. Keys are 1..128 ASCII
alphanumeric or `-_.:`. ProgressRef carries a typed PayloadId referencing separately
removable evidence, never raw provider text, a filesystem path or a native ID. The
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

SQLite migration 0002 and its adapter implement role bindings, worker bindings
and ordered leased inbox claims. The remaining seven methods explicitly return
Unavailable; run admission and durable runtime lifecycle are NOT implemented. There is no
in-memory production fallback. Implementations must return
`RuntimeStoreError::Unavailable` for any unimplemented method; never fabricate
successful admissions, recovered state or readiness. Other store errors are
InvalidInput, NotFound, Unauthorized, Busy, StaleLease, Fenced, Conflict and Expired.
Unsupported provider commands remain runtime capability blockers.

Pending acceptance: claim expiry/reclaim races, binding uniqueness, real native
identity confirmation, run dedup, generation/fence/expiry enforcement, cancellation
acknowledgements, crash-consistent recovery, verified acceptance and effect ledger.
No run, lease, effect or fixture-control HTTP routes are introduced. Passing
provider fake/parser tests does not satisfy these durable acceptance cases.

## Required next schema migration

The current `0001_intake.sql` cannot represent runtime events: its unique,
non-null `events.message_id` permits only one event per source message. Do not
edit this applied migration. Core must introduce a subsequent migration for
versioned event kind and aggregate identity, nullable source-message linkage,
and partial uniqueness restricted to message-accepted events. Message-accepted
events must still require a source message. Runtime events must share the
conversation sequence and transactional outbox, with owner/scope association
validated; no second journal is authorized.

Core also owns session_bindings, tasks, runs, runtime_observations and inbox
claimant/generation/expiry/durable run linkage. Admission and inbox handoff must
commit together. Migration 0002 adds bindings and inbox lease fields only. Tasks, runs, runtime
observations and durable run linkage remain unimplemented.

The current HTTP event envelope assumes MessageAccepted and concrete MessageId
correlation. A versioned event DTO and replay compatibility decision are required
before publishing other event kinds. The owner-only messages constraint remains
until core implements a distinct, server-authorized provider-message path; HTTP
callers must never gain permission to spoof provider actors. This document freezes
the ten shared port signatures, not an implemented migration or acceptance result.

## Review of runtime proposal 42a0dce6

The exact proposal agrees with atomic admit/ack, metadata-only observations,
removable provider text, partial message-accepted uniqueness, and a single
conversation ordering authority. Two authority gaps must be resolved before run
admission: v2 lacks a provider/profile namespace in the native-binding operation,
and it lacks the supervisor identity needed to recover only a lost supervisor.
Migration 0002 reserves a private nullable provider namespace and does not expose
a native-binding write path. Recovery must not fence unrelated live supervisors.
No task policy is invented by the foundation adapter.

Authored store tests cover concurrent idempotent bindings, reopen persistence,
worker replay conflicts, competing claims, generation advance on deterministic
expiry, retained follow-up order, owner/scope and role rejection, and fail-closed
run admission. They require execution before acceptance; they are not crash tests.

## Provider delivery acknowledgement and retry

`record_observation(admission, event_key, observation)` is the sole durable
provider-observation acknowledgement operation, exposed through
`orkestr_v2_application::runtime::RuntimeStore`. Both application and contracts
export `pub mod runtime`. The signature originated in the native-Future port
commit `93460326`; the older f8e1af18 proposal is superseded.

The event key must equal observation.source_event_key. The store derives a
semantic payload digest from the typed observation; callers do not supply a
trusted digest. The current lease generation, dispatch fence, expiry and state
are checked in the same transaction as deduplication and the ordered event,
outbox and projection update. A success receipt contains EventId, scope sequence,
state and duplicate status and is returned only after commit. Identical replay
returns the original durable receipt; changed content under the same key conflicts.

On Unavailable or Busy, runtime retains the exact pending observation and event
key, applies bounded backoff and retries without polling past that pending event.
StaleLease, Fenced or Expired means deliberate refusal: remove it from the delivery queue
and do not restart a provider or mint a replacement admission. Conflict or an
authorization/input error is a visible protocol blocker, not a receipt; runtime
must not silently count it as persisted or spin retrying unchanged invalid input.
No additional provider-ack port or competing queue/store is required. The SQLite
implementation still returns Unavailable for this method; no observation has
therefore been durably acknowledged by the current adapter.

## Observation authority revision v3 (source handoff)

The existing record_observation signature is retained; RunAdmission supplies
trusted owner/scope and cancellation purpose rather than adding a second port.
ProviderObservation now also binds dispatch_fence explicitly. Generations remain
u64 in Rust; SQLite conversion must be checked against i64, never cast/truncated.
The store derives the semantic digest from the canonical typed input, compares
key and content, and rejects changed replay. No caller-provided hash is trusted.

ProgressRef contains a typed PayloadId, and raw Progress text is removed from
this metadata input. The referenced payload must exist in the same owned scope
and have passed the removable payload store's size policy before acknowledgement;
that payload store is not yet implemented, so no ProgressRef may be fabricated
as durable evidence. The new synthetic progress-ref fixture is serialization
only and refers to no existing content.

Authority is checked before returning a duplicate receipt as well as before a
new write. A revoked dispatch fence returns Fenced; obsolete lease returns
StaleLease; expired authority returns Expired. This version chooses explicit
refusal with no transition/journal insertion for rejected stale evidence. It
does not offer a rejected-evidence preservation endpoint. In particular stale
Stopped/CompletedProposal cannot become cancellation confirmation or success.
Only a current CancellationAcknowledgement admission may confirm Stopped.
Runtime retains pending input for Unavailable/Busy and surfaces protocol blockers;
explicit authority refusal drops delivery without pretending it persisted.

The message-specific HTTP EventEnvelope remains unchanged. A separate reviewed,
versioned event DTO/migration must add runtime kinds to the same conversation
sequence/outbox before observations become available. Native IDs, payload text
and unscoped JournalRecord data cannot be passed off as owner message input.

## Source migration handoff boundary

Port version 4 supersedes v3 and is frozen for runtime source migration and independent review.
This additive handoff changes no root manifest, lockfile, CI or SQL migration.
It is based on core head a89392c5, not the older intake-only review head.
New v3 serialization tests have not yet executed at publication; prior green
checks do not certify this revision. Runtime owns adapters and supervisor source
migration. Core retains every SQLite operation and the durable acceptance tests.
The method is named record_observation; record_provider_observation is not a
second method. Provider adapter traits remain runtime-owned. Missing provider
namespace/supervisor authority must be resolved in a reviewed port revision
before implementing native binding or recovery; those methods remain Unavailable.

## Role and privacy clarification (v4)

Native ProviderKind, Binding, RunAdmission, cancellation/recovery authority and
InboxClaim now live only in application::runtime (private authority module,
public reexports). They are absent from web-safe contracts::runtime. Runtime
imports authority types from application, not contracts. No native turn reference
is added. Observation metadata and receipt remain in contracts.

Only deep consumes the ordered reasoning inbox. admit_run must match the claim
consumer session, owner, scope, claim generation and current session authority;
claim consumption and Starting admission commit together, or neither does. Fast
cannot consume this queue. Worker binding allocation is independent, but worker
run admission has no authorized port yet and must remain blocked; it must never
consume another deep claim as a workaround. A subsequent reviewed independent
worker-admission operation is required. renew_lease already carries owner and
session via RunAdmission plus expected_generation. validate_dispatch is not an
admission or persistence acknowledgement. Existing CompletedProposal/Failed/Lost
evidence must survive cancellation races unchanged; Stopped cannot overwrite it.

## Adapter mapping and metadata-only slice

Runtime owns its ProviderEvent parser enum and Provider trait. No shared Provider
trait is required. Map Started, ApprovalRequested, Failed, Stopped and Lost to
identically named ObservationKind variants; Completed { synthetic } maps only to
CompletedProposal { synthetic }. ApprovalRequested is informational evidence,
never an approval grant or effect authority. A cancellation race must not rewrite
a pending CompletedProposal, Failed or Lost into Stopped.

Use source_event_key `run:<run-uuid>:<decimal-sequence>` for a stable run-local
observation sequence. Allocate it once and retain the exact key and typed body
across persistence retries; never allocate a new key for the same pending input.
The current DTO has no numeric sequence field, so this convention does not claim
store-enforced monotonic run-local ordering. Durable scope ordering is assigned
by the store. Core computes the semantic digest, not the adapter. RunAdmission
and ProviderObservation carry matching run/session IDs, lease_generation and
dispatch_fence. Binding.generation is not an execution lease or dispatch fence.

Progress(String) must not enter the metadata journal. The first metadata-only
slice may explicitly skip progress persistence and report that limitation. It
must not fabricate a PayloadId. ProgressRef is usable only after a core-owned,
scoped removable payload write produces a valid reference; that port/store is
not implemented. Frame and progress size limits are adapter responsibilities on
all provider paths, not just the fake. No parser bounds are certified here.

An explicit StaleLease/Fenced/Expired refusal stops retrying that delivery. It is
not an acknowledgement and does not authorize deleting or changing the original
terminal evidence: retain its identity/kind for explicit reconciliation policy.
This handoff offers no durable rejected-evidence storage API; runtime must report
that limitation rather than claim evidence was persisted. Unavailable/Busy keeps
the identical pending delivery for bounded retry. No automatic provider restart
or effect replay is authorized by either outcome.
