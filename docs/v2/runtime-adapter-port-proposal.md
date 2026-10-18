# Runtime store extension proposal for core

Status: proposal against core's draft `0001_intake.sql`, 2026-10-18.
Core owns the migration, shared contracts/application ports and SQLite adapter.
This file implements no schema or store. Runtime consumes the exact core commit
only after agreement; its current `ports.rs` remains provisional.

## Existing intake remains authoritative

Keep atomic message + event + reasoning-inbox admission unchanged. Raw input
stays removable in `messages.text`; runtime metadata must not copy it into an
immutable observation or event. All runtime calls take a trusted owner context
and typed conversation/session/run IDs. Owner and conversation membership are
checked inside each mutation, not inferred from caller-supplied native IDs.
Use native async `impl Future<Output = Result<T>> + Send`, matching `IntakeStore`;
no async-trait dependency is needed for this port style.

## Minimum additions (core chooses final names)

| Record | Required fields and constraints |
|---|---|
| `session_bindings` | SessionId, owner/conversation, role fast/deep/worker, provider kind, private optional native ID, state starting/ready/busy/blocked/lost/retired, optional parent SessionId. Partial uniqueness gives one nonretired fast and one deep binding per owner/conversation; no such singleton for workers. Composite scope constraints prevent a cross-owner/conversation parent. Unique provider/profile/native-ID binding prevents aliasing one native session across roles/scopes; profile is an opaque namespace, never a credential. |
| `tasks` | TaskId, owner/conversation, source MessageId, state, acceptance-policy reference and version. No raw prompt copy. Task creation is bounded, idempotent and policy-mediated; ordinary replies need not create workers. |
| `runs` | RunId, TaskId, SessionId, owner/conversation, attempt, request key + semantic digest, starting/running/cancel_requested/cancelled/blocked/failed/awaiting_acceptance/succeeded state, supervisor identity, lease generation + expiry, dispatch fence, optional recovery blocker. Unique task/attempt and owner/conversation/request key. One active run per binding/native session including cancel_requested; explicit retry creates a new attempt. Scope constraints bind run, task and session to the same owner/conversation. |
| `runtime_observations` | RunId, source event key, payload digest, kind, admitted generation, canonical EventId/sequence or journal reference, removable evidence reference and synthetic flag. Unique run/source-event key; changed replay conflicts. Metadata only; provider text goes to bounded removable payload storage, never the immutable journal. |
| `reasoning_inbox` additions | Claimant/supervisor identity, claim generation, claim expiry and durable admitted RunId or handoff reference. Keep queued/claimed/consumed and existing message/event/sequence keys. Claim is a lease, never deletion. |

Native IDs are materialized after provider acknowledgement. A missing native
session remains starting/lost; recovery cannot invent a replacement ID. Binding
identity is stable while a run lease changes. Preserve native IDs privately for
resume research; never send them in public role/status DTOs.

Two existing schema constraints need explicit core decisions: `events.message_id`
is currently NOT NULL UNIQUE, and `messages.actor_kind` allows only owner.
Consequently runtime events cannot be inserted there as extra events for the
same message, and provider output cannot be inserted as owner messages. Propose
a versioned event-kind/aggregate extension with nullable source-message linkage
and safe payload references, retaining existing message-admission uniqueness
through a partial unique constraint for message-accepted events. Runtime events
use the same conversation sequence allocator and transactional outbox; sequence
gaps between owner messages are valid. Core must version DTOs/SSE accordingly.
Until that is implemented, runtime event projection is explicitly unavailable;
do not force provider data through intake or create a second ordering authority.

## Shared types and transaction-sized operations

Proposed shared types: `SessionRole`, `SessionBinding`, `InboxClaim`,
`RunAdmission`, `ProviderObservation`, `CancelReceipt`, `RecoveryPage` and typed
errors `Busy`, `StaleLease`, `Conflict`, `Expired`, `Unavailable` plus the
existing nonleaking authorization/not-found behavior. `RunAdmission` carries
OwnerId, ConversationId, RunId, SessionId, role, optional private native ID,
lease generation, dispatch fence, attempt and expiry. `InboxClaim` carries the
existing typed MessageId/EventId and scope sequence plus claim generation.
Lease/expiry time and identities come from trusted services, not client JSON.

1. `ensure_roles(owner, conversation)`: authorize and atomically create/reuse
   distinct fast/deep bindings. No provider call in transaction.
   `create_worker(owner, conversation, parent?, request_key)` records separate
   worker lineage without creating another visible conversation.
2. `claim_next(owner, conversation, supervisor, duration)`: atomically claim
   earliest eligible sequence with bounded lease; refuse a second outstanding
   claim for that deep consumer. Reclaim expiry with a new generation. This is
   a deep inbox, not a single consumable queue shared by fast and deep; fast
   rendering reads canonical accepted messages independently.
3. `admit_run(claim, binding, request_key, expected_versions)`: validate scope,
   claim, session exclusivity and lease; persist starting evidence. Atomically
   consume/link the inbox claim to that durable admission so a crash cannot
   create a second run or lose the handoff. No provider work before commit.
   Same-key/same-digest returns original admission; changed digest conflicts.
   The earlier separate inbox acknowledgement proposal can be folded here.
4. `bind_native(admission, native_id, event_key)` and `renew(admission)`:
   conditionally check current generation, expiry and state. Reject identity
   aliasing/replacement and expired renewals. Idempotent identical replay only.
5. `record_observation(admission, event_key, observation)`: in one transaction
   check current generation, expiry, run/session state and fence, deduplicate,
   append canonical metadata/outbox and update projection. Started evidence
   moves starting to running. Completed is a proposal awaiting acceptance;
   neither prose nor a synthetic provider event directly grants success.
6. `request_cancel(owner, run, request_key)`: persist cancel_requested and
   advance the lease/dispatch fence before provider interruption. Return the
   new token, actual state and any in-flight/unknown caveat. Repeated cancellation
   must return the same fence while pending. Stop acknowledgement uses that
   current token; late old-generation completions fail. Queued work may cancel
   directly; interruption failure never confirms cancellation.
7. `recover(supervisor, cursor, limit)`: bounded restart reconciliation fences
   admissions belonging to the lost supervisor, retains run/session/native IDs,
   marks unconfirmed active work blocked/lost, preserves cancellation requests,
   and releases expired unadmitted claims in original inbox order. Consumed
   inbox entries retain their durable run linkage. No automatic provider-start
   replay or unknown-effect retry. A live unrelated supervisor is not fenced.

Provider commands run strictly outside these transactions. A store error cannot
fall back to an in-memory run. Runtime has no effect dispatcher: the run fence
alone is not effect authority. When effects are implemented, core's dispatch gate
must atomically check current run/hold generations and exact approval binding;
already-dispatched effects require reconciliation and unknown outcomes stay
quarantined. Verified acceptance remains a separate deterministic application
operation, with synthetic evidence clearly identified.

## Independent tests required before integration acceptance

Core/store tests must cover atomic admission/claim linkage, competing claims,
expired claim acknowledgement, distinct role/native identity, one active turn,
scope/owner mismatch, same-key conflicting replay, stale lease completion,
cancel-before-interrupt, idempotent repeated cancel, duplicate/mutated observation,
and restart with preserved order and fenced old attempts. Runtime's fake and
spy tests do not substitute for those durable process-failure tests.
