# Fixture-only authorized handle prerequisite

Status: concrete implementation proposal against selected async v5 / redaction
`8acc370d0ced3c808d5af02c1b70ef95557b0a24`, reconciled in core
`851bd5b91ee4e41f611db9978155bb17074ea50f`. No new executable authority,
constructor, migration or provider dispatch is delivered by this document.
Existing RuntimeStore signatures and the sole append_provider_event stay unchanged.

## Missing authority and exact proposed interface

The current unrestricted Store implements bindings/claims, but has neither an
immutable supervisor context nor confirmed provider protocol readiness. Therefore
its admit_run/claim_provider_dispatch/consume_provider_dispatch must remain
Unavailable. Caller-supplied Binding/FreshCandidate is never authority.

Core will add a concrete store-sqlite `FixtureSupervisorStore` implementing the
existing application RuntimeStore. Its fields, grant and context constructors are
private, with no serde, Clone, public Default or secret-bearing Debug. Only a
separate explicit offline fixture bootstrap may obtain it; no HTTP route, browser
session, environment auto-selection or Codex/Claude provider can create a grant.
The ordinary server must not call this bootstrap. Proposed opt-in Rust interface:

```rust,ignore
// store-sqlite::fixture_runtime; not yet exported or implemented
pub async fn bootstrap_fixture_supervisor(
    store: &Store,
    owner: &OwnerId,
    config: ExplicitFixtureSupervisorConfig,
) -> runtime::Result<FixtureSupervisorStore>;
// ExplicitFixtureSupervisorConfig has validated namespace and supervisor_key,
// and takeover: First | ExpiredPredecessor { incarnation_id: Uuid }.
// FixtureSupervisorStore implements the selected RuntimeStore, not another port.
```

This fixture-only constructor intentionally requires a trusted in-process Store
reference. It is not an authentication API for callers or a production bootstrap
contract. Namespace/key are bounded 1..128 ASCII alphanumeric or `-_.:`; provider
kind is fixed internally to ExplicitFixture. Owner must exist. Store generates
context/incarnation UUIDs and all deadlines using its own clock; config cannot
supply a lease duration, credential, native session or arbitrary new incarnation.
The handle binds immutable owner/provider/namespace/key/incarnation/context ID.
Every operation compares supplied owner/scope against that context and rechecks
its durable live incarnation inside the same transaction as its write.

## First migration and transactions

Core owns the next migration; do not independently add runtime tables. Proposed
rows are supervisor contexts (unique owner/provider/namespace/key, incarnation,
lease deadline), fixture readiness (binding/context, protocol version, confirmed
native identity), runs (claim identity, scope/key semantic digest, binding/version,
attempt, lease/fence/deadline, Starting state) and dispatch attempts (run/context,
state, candidate/reservation verifiers and request-key digest). Native uniqueness
continues using session_bindings' provider/namespace/native unique index.

1. Bootstrap uses BEGIN IMMEDIATE. First fails Conflict if context already exists.
   Takeover requires the exact predecessor incarnation AND expired store-clock
   supervisor lease; active predecessor is Busy, changed predecessor Conflict.
   Concurrent contenders have one winner. Takeover increments the durable fence
   and quarantines predecessor candidates/reservations; DeliveryUnknown stays
   unknown. Different supervisor keys never fence each other. No force takeover.
2. Fixture readiness is a separate explicit synthetic confirmation, not Started.
   Only this fixture bootstrap may assign synthetic identities, protocol version
   and Ready to fixture bindings. Identity remains reserved across takeover/loss;
   missing identity never silently generates a replacement for an existing binding.
   Real provider identity/protocol confirmation remains unavailable.
3. admit_run begins IMMEDIATE, authenticates bound context/owner/scope, and looks
   up scope/request-key replay before validating a new claim. Identical semantic
   replay returns original authoritative binding/run snapshot with Replay and no
   candidate key; dispatched/uncertain replay returns ReconciliationRequired.
   Changed semantic input conflicts. New input requires earliest live deep claim,
   exact consumer/binding/generations, confirmed fixture readiness, live context,
   no active turn and bounded execution lease. Insert Starting + candidate verifier
   + mark precisely that inbox row handed off with durable run linkage in ONE
   transaction. Any error rolls all three back; follow-ups remain untouched.
4. claim_provider_dispatch verifies the issued candidate against the durable run,
   immutable context, lease/fence/readiness and exact envelope. Store consumes its
   verifier and CASes Candidate -> Reserved with a new unpredictable reservation
   verifier. Only one invocation receives the plaintext reservation. Identical
   replay returns Replay (no new locator); changed request payload conflicts.
5. consume_provider_dispatch verifies reservation plus current context/envelope/
   execution purpose/lease/fence, then CASes Reserved -> DeliveryUnknown and
   commits BEFORE returning DispatchNow. Only that invocation gets DispatchNow.
   Already consumed, lost ACK, expired predecessor or reopen cannot redispatch;
   uncertainty returns ReconciliationRequired or an explicit authority refusal.
   No provider I/O occurs in these transactions. Candidate and reservation values
   are redacted and stored as domain-separated SHA-256 verifiers, never plaintext.

Semantic admission identity is versioned, length-prefixed typed bytes containing
owner/scope/message/event/claim generation/consumer/binding/expected generation and
request key; no arbitrary JSON or caller digest. Persist the original claim
identity so committed replay survives its atomic acknowledgement. Store-clock
expiry is checked for NEW authority, not used to manufacture a replay candidate.

## Required executable gates before enabling starts

Core SQLite regressions must prove one concurrent admission/reservation/consume
winner, changed replay conflict, rollback leaves inbox recoverable, follow-up
order, reopen replay has no keys, and commit-before-ACK retry never DispatchNow.
Test owner/namespace/key isolation, forged locators/envelopes, expired predecessor
CAS, concurrent takeover, readiness/native alias refusal and stale consumption.
Crash checkpoints must distinguish before commit from committed lost receipt;
post-receipt SIGKILL alone does not prove lost-ACK behavior.

Runtime owns the fake-provider harness and must keep ALL high-level starts blocked
until those durable authorities and dispatch consumption are independently proved.
Renew/events/cancel/recovery and worker admission remain Unavailable. No external
effect, real provider process, credential, public endpoint or completion acceptance
is introduced. A failed interrupt or absent Started never establishes stop/success.
