# Synthetic fixture dispatch adapter

Implemented on the selected async v5 application contract (`8acc370d`); no shared
signature or production dispatch change. Store-sqlite owns migrations 0003/0004.
The ordinary Store still returns Unavailable for admission/reserve/consume and
all runtime lifecycle operations. Only explicitly bootstrapped
`FixtureSupervisorStore` implements these three operations. The server neither
bootstraps nor dispatches fixtures. Runtime high-level starts remain blocked.

## Exact setup and authority

Use `store_sqlite::fixture_runtime::bootstrap_fixture_supervisor` with the
existing config, synthetic owner, namespace and supervisor key. Set up messages,
canonical bindings and non-destructive deep claims through ordinary Store's
existing IntakeStore/RuntimeStore operations. Call:

```rust,ignore
let binding = fixture_handle.confirm_fixture_readiness(&deep.session_id, 1).await?;
let admitted = fixture_handle.admit_run(&claim, &binding.session_id,
    binding.generation, "synthetic-run-1").await?;
let reserved = fixture_handle.claim_provider_dispatch(&admitted, "dispatch-1").await?;
// Only Reserved yields a claim, and only consume's per-call DispatchNow could
// precede explicit FAKE I/O. Neither FreshCandidate nor Reserved permits I/O.
```

Protocol version is exactly 1. Confirmation allocates a synthetic native identity
from the typed session, never accepts caller native/provider credentials, and
returns the authoritative updated binding/generation. Fast/worker confirmation is
rejected. Repeated Ready confirmation is idempotent; Busy, Lost and another
context/incarnation cannot silently recreate readiness. No real-provider readiness
or native binding is implemented.

Use the original live handle's `reattach(&independently_opened_store)` for another
pool or reopen. Incarnation ID alone cannot attach. After process loss there is
no ID-only production reattachment constructor: expiry plus exact-predecessor CAS
is required. Takeover atomically marks predecessor bindings Lost and runs Blocked,
quarantines Candidate/Reserved and clears locators, while retaining DeliveryUnknown
as unknown. It never fences another supervisor key/namespace or replays a provider.

Admission authenticates context/owner/scope, deduplicates versioned length-prefixed
semantic input and atomically inserts Starting plus candidate verifier, acknowledges
only its exact live earliest deep claim with durable run linkage, and marks the
session Busy. Replay returns the original authoritative envelope and no candidate
locator. Changed input conflicts; failed admission rolls everything back.

Reservation/consumption compare the entire authoritative execution envelope, live
context, readiness, store-clock lease/fence, role and native identity. Candidate and
reservation values are unpredictable and only their domain-separated verifiers are
stored. One reservation locator is returned once; repeated reservation returns Replay
without a new locator. Consume commits Reserved -> DeliveryUnknown before returning
DispatchNow; lost reply/reopen/repeated consume yields ReconciliationRequired, never
new I/O permission. No API grants a retry after uncertain delivery.

Renew, provider observations, cancellation, standalone ack, recovery, worker admission
and fixture-handle claim/binding allocation remain explicitly Unavailable. Use the
ordinary non-execution store for binding creation and claims. Admission/dispatch
state is synthetic evidence in fixture tables, not a lifecycle event journal or
verified completion. No runtime Succeeded state is assigned.

## Executable oracles and limitations

Core's store tests use independent SQLx pools, competing calls, fresh/replay identity,
changed body, follow-up retention, injected ack rollback, role/owner/fence/namespace
refusal and reopen. The test-binary-only checkpoint child is ignored as a standalone
scenario and launched by three parent tests. Seven owned-child SIGKILL cases cover:
admit before/after commit, reserve before/after commit, consume before/after commit,
and consume after reply/before fake I/O. Parents assert durable state and no fake-I/O
marker; normal builds contain no checkpoint module, env hook or fault endpoint.
The child privately reconstructs fixture handles ONLY in the unit-test binary;
this is not production recovery or a public attachment capability.

Expiry tests shorten only synthetic deadlines through private Core test code; no
public clock setter or arbitrary extension exists. Shared event digest codec,
lease renewal, effect authority and production recovery remain unimplemented.
Independent verification and Runtime's real-store harness must review these
transactions before any start path is enabled. Volatile fake tests are separate
from durable acceptance, and pool reopen is separate from process recovery.

### External harness inspection and opt-in controls

`inspect_fixture_attempt(conversation, request_key)` returns one read-only,
owner/context-scoped snapshot: run ID, blocked flag, dispatch phase,
atomic inbox acknowledgement, and verifier-presence booleans. It returns no native
identity, key, verifier or digest, and grants no dispatch permission. A different
context cannot inspect the attempt. Expired/fenced handles are refused.

The store-only `fixture-test-controls` feature adds two explicit fixture-handle
methods; it adds no dependency or default feature and is not enabled by server
bootstrap. `fixture_expire_context()` only shortens the bound live incarnation's
lease to store time; it cannot extend authority or expire another context.
`fixture_consume_without_reply(claim)` invokes the real consume transaction,
discards the result and returns `Unavailable`. A committed consume therefore
reopens as `DeliveryUnknown`; retry cannot return `DispatchNow`. This is a
deliberately discarded reply, **not** a subprocess/transport-crash claim. Core's
seven SIGKILL checkpoints remain test-binary-only. External harnesses should
separately identify pool reopen, discarded reply and actual process recovery.

`inspect_fixture_scope(conversation)` returns exact counts of attempts,
acknowledged run links, reservations, unknown deliveries and quarantined attempts
in the handle's owner/conversation/context. Both inspectors include predecessor
attempts in that same context: a valid successor can inspect quarantine, while an
expired/fenced predecessor cannot inspect or act. Other keys/namespaces remain
invisible.

With `fixture-test-controls`, an owned child may call
`fixture_arm_checkpoint(FixtureCheckpoint, fresh_marker_path)` on its own mutable
live handle. Typed stages are AdmitBeforeAck (after run insertion),
AdmitBeforeCommit, AdmitAfterCommit, ReserveBeforeCommit, ReserveAfterCommit,
ConsumeBeforeCommit and ConsumeAfterCommit. At the selected boundary the child
creates a new private marker containing only the exact stage name, then waits up
to 30 seconds before returning Unavailable. Parent must bound its wait, verify
marker bytes, and kill/reap **its owned child**. Before-commit kill rolls back;
after-commit kill loses the reply. Reattached handles never inherit checkpoints.
The marker directory must be caller-controlled and stable. No production endpoint,
SQL setter, clock setter, native identity or locator is exposed.

Independent reproduction: run the store test suite with
`--locked --offline --features fixture-test-controls`. The three crash parent
tests launch the ignored owned-child entry themselves and exercise eight SIGKILL
windows (including run-insert-before-ack). Their child-only private context
reconstruction remains a test oracle, not a public restart attachment contract.
The public hook does not authorize transferring a live handle across processes;
a harness needing that must use the provided owned-child tests rather than invent
an ID-only attachment API. Post-reply/pre-I/O remains a harness-side checkpoint.
