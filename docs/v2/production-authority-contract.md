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
