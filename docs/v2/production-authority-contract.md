# Production authority checkpoint

Application-only inputs are in `application/src/runtime/production.rs`. These
are trusted server composition inputs, not HTTP DTOs. Existing runtime port
signatures, dispatch dispositions and immutable issued-token semantics remain.

The SQLite adapter will expose `Store::authorize_supervisor(machine_token,
ProductionSupervisorConfig) -> Result<ProductionSupervisorStore>`. The token
must be an existing unexpired 64-hex machine session. Owner comes exclusively
from authentication, never from config. Each operation rechecks revocation and
store-clock expiry. The returned nonserializable handle binds owner, selected
Codex/Claude provider kind, namespace, supervisor key and unique incarnation.
Fixture provider configuration is rejected. Namespace identifies the already
configured subscription identity, not a newly purchased API identity.

`ProductionSupervisorStore::confirm_native_session(NativeSessionConfirmation)`
returns the authoritative Binding after the trusted protocol adapter completes
session readiness. It checks owner, Starting state, expected generation and
native identity uniqueness. Identical evidence is idempotent; changed evidence
conflicts. Lost identity is never silently replaced. Fast and Deep are distinct
canonical bindings; Deep alone consumes the ordered reasoning inbox under the
existing port. Worker execution admission remains unavailable pending its own
scoped authority contract.

The handle implements RuntimeStore. Admission atomically records Starting and
consumes exactly its claim. Only the inserting call returns a fresh candidate;
replay never reissues a locator. Reservation and consumption are separate CAS
transactions; DeliveryUnknown commits before permission for provider I/O.
Crash/lost reply never means safe redispatch. Reattach requires a live handle;
new-process takeover needs exact expired predecessor CAS and retains unknown
in-flight evidence. Ordinary unbound Store must not manufacture context.

This checkpoint specifies the API, not an implemented production adapter or a
server route. Runtime owns protocol/provider composition and server routes.
Progress payloads, observation replay, cancellation, recovery and execution
status routes are not activated by this checkpoint. UI must advertise their
capabilities as unavailable until the concrete adapters/routes are reviewed.
CompletedProposal remains awaiting acceptance, never completed/succeeded.
No CPU/RAM telemetry or steering acknowledgement is inferred from activity.

Read-only execution presentation is additive `contracts/src/execution.rs`,
`ExecutionStatus` schema1. Server/store supply monotonic per-conversation revision
and observation time. AwaitingAcceptance and Blocked are explicit; Completed
requires verified acceptance, never a provider completion proposal. Progress and
resource samples are optional timestamped evidence, not activity inference.
CPU convention is permille of allocated capacity. A consumer must validate the
snapshot and reject regressing revisions. Stop/steer remain false until reviewed
routes and durable authority exist. No route path or control request shape is
approved by this DTO; Runtime owns the route proposal with existing browser
CSRF/Origin/Host guards and idempotency. This does not expand fixture schemas.

## Ordinary Store implementation checkpoint

Migration 0008 introduces production supervisor/readiness/run authority, separate
from fixture authority. `Store::authorize_supervisor` validates an existing
machine session and trusted provider namespace; each bound operation checks the
session and store-clock context lease again. `confirm_native_session` accepts
trusted protocol readiness evidence only. Native protocol persistence and
canonical workspace validation remain adapter obligations.

Bound admission atomically creates Starting evidence and acknowledges its inbox
claim. Reserve and consume are single-winner transactions. `consume_execution`
returns a non-Clone, non-serializable `ConsumedProviderDispatch` with private
fields only after DeliveryUnknown commits. The contained message text comes
from the admitted durable message. An executor must consume this capability by
value; the legacy dispatch disposition alone grants no process authority.

The initial schema deliberately permits one admitted run per binding. Terminal
lifecycle work must replace this restriction with active exclusivity and an
explicit safe reuse gate; takeover must then fence only active runs and preserve
terminal outcomes. Production renewal, observations, cancellation and recovery
are still unavailable. No provider process is activated by this checkpoint.

Author validation: feature-enabled store library tests passed 56, with three
owned-child entry points ignored by discovery and invoked by their parents.
The production parent covers seven actual SIGKILL windows and fresh-process
expiry/takeover, without private authority reconstruction. Strict feature-enabled
all-target store clippy passed. These results establish the bounded storage
slice, not full provider or release acceptance.

`Store::execution_status(owner, conversation)` now returns an optional canonical
read snapshot. The server must derive owner from its authenticated session, never
request JSON. No queued input and no admitted run yields None. Migration 0009
maintains a durable conversation revision transactionally with inbox and production
run changes, independently of event replay cursors. An identical admission replay
does not advance it. Queue age uses the accepted event timestamp and store clock;
progress/resources remain absent, and Stop/steer capabilities remain false.
No routes or control receipts are activated by this read method.

## Production renewal and containment fence

Migration 0010 preserves every exact issued execution lease token. The existing
`RuntimeStore::renew_lease` now works only on an authenticated live production
handle, exact current execution token, readiness and generation. It extends by
at most sixty store-clock seconds, bounded by the supervisor deadline. It never
renews cancellation-purpose authority or spends a generation without extension.
`heartbeat_supervisor` extends only its already-live immutable context; expired
contexts require exact-predecessor takeover. Admission inserts its initial
issued token in the same admission/ack transaction.

`with_execution_fence(admission, action)` is a trusted synchronous containment
bridge. It holds SQLite's immediate transaction across full current authority
validation and one bounded synchronous action, serializing that action against
durable fencing. Only DeliveryUnknown may pass. The action must be bounded
nonblocking transport/spawn work, never provider response waits, network calls
or blocking pipes. A consumed inference capability is independently required;
this method grants freshness only. Current-thread Tokio fails Unavailable;
multithread Tokio uses block_in_place. Any unknown result must not trigger
inference retry. This new boundary requires independent review before adoption.

## Independent ordinary-process oracle

Feature `fixture-test-controls` also exposes opt-in `ProductionCheckpoint` and
`production_arm_checkpoint` on an already authenticated production handle. Seven
variants cover admission before ack/before commit/after commit, reservation
before/after commit and consume before/after commit. The caller supplies a fresh
marker in its controlled directory; exact stage bytes are written and synced,
then a bounded thirty-second pause returns Unavailable. No normal bootstrap arms
this hook. Reattachment clears the hook; no arbitrary SQL, callbacks, identity
reconstruction or clock setters are exposed. Production author process tests use
these public hooks when the feature is enabled.

`inspect_production_attempt(conversation, request_key)` and
`inspect_production_scope(conversation)` return context-scoped counts and states,
acknowledgement and verifier-presence booleans, never native IDs or locator/hash
values. Successors may inspect predecessor quarantine in the same context.
Full-row read-only crash snapshots must include production_supervisors,
production_readiness, production_runs, production_run_leases,
execution_revisions, reasoning_inbox, session_bindings, owners, auth_sessions,
conversations, messages, events and outbox. New-process authorization uses only
the machine session and exact public predecessor after its real deadline;
there is no private-context reconstruction API.

## Read sampling and next canonical observation compatibility gate

At equal execution revision, `ExecutionStatus::same_revision_state` excludes
ONLY observed_at_ms and derived queue_age_ms. They are read-time samples; GET
never writes merely to change time. Identity, phase, capabilities, progress and
resources (including sample timestamps) must match. Consumers still validate
structure, authentication, scope and selection generation before comparison.

Production observation writes require a new public replay variant, not a
fixture event. `ProviderObservedEnvelope` and
`v2/fixtures/provider-observed-proposal.json` propose schema 5, SSE name
provider_observed, with explicit source message/event linkage and typed
Started/ApprovalRequested/CompletedProposal/Failed/Lost metadata. No native ID,
lease/fence, locator, raw progress or synthetic provider-success flag appears.
The production adapter will reject synthetic completion; CompletedProposal
remains AwaitingAcceptance. Starting+Failed is permitted after consumed dispatch.
Terminal failure alone does not authorize session reuse. Progress and Stopped
remain unavailable until their payload/control authority is implemented.

This DTO is deliberately NOT yet in ConversationEvent and no production event
is written. Independent DTO and UI consumer compatibility review must precede
adding the replay union variant and production observation transactions. Legacy
schema 1-4 serializers and fixtures remain byte-for-byte unchanged.

ExecutionControlRequest and ExecutionSteerRequest establish input-only shapes:
required nonnil run_id, per-conversation expected_revision, bounded request_key,
and bounded nonempty steering text. They are not authority or a success receipt.
Runtime owns cookie/CSRF relative /api/v2/conversations/:id/execution routes;
Stop/steer remain unavailable until owner/run/revision/idempotency/fence checks
and durable result receipts are implemented. Do not manufacture a success DTO.

### Pre-run metadata authority and readiness transition

`Store::authorize_session_metadata(&Binding)` issues a non-Clone, nonserializable
`BoundSessionMetadata` only for the exact current owner-scoped Starting binding
under the authenticated supervisor. It contains no run ID or inference grant.
`with_metadata_fence(&grant, action)` holds an immediate SQLite transaction while
checking current context, token, expiry and exact binding, then invoking one
bounded synchronous setup action. Metadata transport must whitelist initialization,
account and persistent-thread setup only; it must never accept inference commands.

After validating correlated persistence/workspace/native readiness, the trusted
adapter consumes the grant through `confirm_metadata_session(grant, evidence)`.
The resulting private `ReadySessionTransition` explicitly links Starting and Ready;
consumers must not assume generation equality or arithmetic. The old metadata
fence refuses further setup after readiness. Isolation copies the original scope
into its owned metadata child, while the trusted adapter retains the Core grant.

One-way attachment consumes both transition and `ConsumedProviderDispatch` through
`ReadySessionTransition::attach_execution`. It checks the exact immutable Ready admission identity
(the live binding row is Busy), namespace and incarnation. The executor must compare the child's
original metadata scope to `transition.metadata()` before consuming the link,
require empty pending setup writes, and use the execution fence around transfer
and enqueue. Execution scope carries binding generation separately from lease and
dispatch fence. Any failed transfer quarantines the child; no returned/recreated
inference grant or reverse transition is permitted. This source boundary requires
independent review before containment adoption; no real provider is activated.

Current public revocation is `Store::revoke_session(machine_token)`: subsequent
metadata/execution fences authenticate inside their immediate transaction. Natural
expiry is the store's 60-second supervisor deadline; heartbeat extends only a live
context. No public production clock setter or cancellation authority exists yet.

### Ordinary observations, schema 5

Ordinary `RuntimeStore::append_provider_event` now persists Started,
ApprovalRequested, non-synthetic CompletedProposal, Failed and Lost metadata.
`0011_production_observations.sql` preserves prior event bytes and issued lease
history, rebuilds the state CHECK constraints with foreign-key validation, and
adds `production_observations` to canonical event/outbox/sequence transactions.
Full-row rollback oracles must include this table in addition to the previously
listed thirteen tables. Production evidence uses `provider_observed`, schema 5;
fixture variants 1–4 are unchanged and cannot stand in for production evidence.

Authentication and exact issued historical envelope verification precede duplicate
lookup. Identical committed semantic input returns the original receipt even after
expiry/takeover, with no new transition. Changed input conflicts; unseen input
requires the current authenticated context, consumed dispatch, live lease/fence,
ready native association, and contiguous run-local sequence. The semantic digest
uses a versioned length-prefixed typed encoding, never arbitrary JSON ordering.

Starting+Failed is valid without synthesizing Started. Started moves to Running;
completion moves Running only to AwaitingAcceptance, never Succeeded. Failed and
AwaitingAcceptance evidence survives supervisor takeover unchanged. Binding reuse
is still refused until a separately implemented terminal authority transition;
this slice does not remove the session occupancy guard. Raw Progress and Stopped
are unavailable; no transcript is written into replay metadata. Synthetic
completion is invalid for ordinary execution. New typed observation before/after
COMMIT checkpoints are available only with opt-in test controls. Ordinary server
activation still requires matching UI/Runtime compatibility review and containment.
