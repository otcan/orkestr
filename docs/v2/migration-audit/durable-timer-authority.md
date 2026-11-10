# Durable timer authority proposal

Core reserves schema 0033. New leaf:
`v2/crates/store-sqlite/src/history_import/timers/authority/`.
Authoritative SQL registration and trusted issuer construction remain Core-owned.
No shared server registration or production timer is changed.

An imported schedule remains paused and has no durable instruction/authority row.
Only a fresh target-owner authenticated `enable_durable_timer` creates immutable
instructions with a domain-separated SHA256 digest, authority UUID, owner,
namespace, generation, conversation, original enable key/revision and Stop
watermark. Authority UUID is provenance, never a bearer capability. No browser,
Bearer or machine credential/hash is persisted in this ledger. Fresh instructions
are intentionally private owner data, not source migration content or HTTP read
metadata. SQL triggers reject updates/deletes; disable/revoke retains provenance.

`DurableTimerEnable` contains the existing `TimerEnableRequest` and fresh
`instruction` (nonblank, <=32768 UTF-8 bytes). Return `DurableTimerAuthority`
contains authority UUID, namespace, generation, conversation, instruction digest
and duplicate flag, never instruction text or credentials. Same semantic retry
returns the original authority even after revoke, without changing schedule or
execution authority. Changed instruction/conversation/expected revision under
that key conflicts. Fresh enable requires paused/disabled state and a new key.
Unknown timezone/cadence stays dormant under existing Core validation.

Owner logout does not revoke an explicitly durable grant. Revocation uses
`revoke_durable_timer`, a canonical disable: current owner auth, revision and
request key; cancels claims and advances generation in the existing transaction.
Stop, rollback and disable also invalidate authority through current timer state
and generation. Existing ordinary-input holds fence already admitted occurrences.
Historical retry never resurrects authority. Deep Stop watermark is rechecked by
the existing input guard before each admission. An instruction change requires a
new enable generation; old instruction provenance stays immutable.

Core accepted this exact issuer seam:

```rust
// Core owns this non-Clone, non-Deserialize private-field capability.
crate::TimerSchedulerIssuer
Store::authorize_timer_scheduler(namespace: Uuid) -> TimerSchedulerIssuer
// crate-private, returning BEGIN IMMEDIATE only after fresh issuer validation:
Store::timer_scheduler_transaction(&self, issuer: &TimerSchedulerIssuer,
    namespace: Uuid) -> history_import::Result<(Transaction<Sqlite>, OwnerId)>
```

Constructor is available only on the current authenticated bound production
supervisor. Every transaction revalidates the same live context, incarnation,
generation, owner, namespace and current machine authorization before ledger
lookup. Worker/ordinary Store, stale issuer, wrong namespace or revoked machine
must refuse. Core owns those tests and registration. A restarted scheduler must
bootstrap a fresh local issuer; a persisted authority UUID cannot bootstrap one.

Leaf `admit_authorized_timer(issuer, namespace)` accepts no caller time, text,
due or claim. SQLite transaction clock supplies actual due time. The leaf loads
current generation and immutable instructions, then delegates the same sole
transaction-local timer claim/intake writer as the existing authenticated port.
Claim/cadence, instruction provenance, ordinary input and dedupe commit together.
The two existing input implementations are extracted into crate-internal helpers;
public credential APIs retain their authentication/commit behavior. No parallel
ordinary writer or auth policy is introduced. Future controller discovery must
be bounded and owner/issuer scoped; this patch does not register a controller.

Daily/weekly authority has no hourly TTL. Store reopen retains the grant and
instructions, but does not bypass fresh scheduler bootstrap. Durability is
independent of creator browser session lifetime. The one-hour HTTP controller
remains unchanged until Deep composes this new path; no unattended product
completion is claimed from an unregistered leaf.

Verification status: six ordinary Store tests authored for weekly reopen,
non-authoritative import, early due, exact replay, immutable instructions,
logout/refusal, revoke/held inputs, fresh enable, terminal Stop, two-pool revoke
race, and failure rollback. These Rust tests and strict lint are **unexecuted**
pending exact Core issuer source and bounded build admission. No live reads,
timers, credentials, provider or dispatch effects were used.

Executed lightweight check:
`PYTHONDONTWRITEBYTECODE=1 python3 v2/migration/test_durable_timer_schema.py`:
4/4 PASS (SQL immutability, reopen, FK refusal and exact credential-free columns).
These minimal synthetic SQL parents do not qualify schema upgrades, Store
behavior or issuer authorization. Owned Rust format and diff checks PASS.

Published issuer compatibility: exact Core
`256449100fbb4882bb9a6675a3c9714310183fb7`,
`production_runtime/timer_issuer.rs`, implements the accepted type and transaction
signature unchanged. Source inspection confirms namespace and exact current
context/incarnation/generation/owner/machine-hash comparison followed by context
validation inside BEGIN IMMEDIATE before grant lookup. Core's focused issuer
execution is separately attributed; Migration has not rerun it. That candidate
has authoritative migrations through 0030 only. Requested isolated leaf build
must use the unnumbered proposal inside synthetic test fixtures; it cannot claim
a contiguous 0033 upgrade until Core integrates real 0031/0032 predecessors.
