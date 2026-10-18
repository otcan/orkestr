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
