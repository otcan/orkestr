# Offline Python delegation boundary

Implementation ownership: the delegated helper exclusively owns NEW
`store-sqlite/src/production_runtime/worker_tool/` and NEW tests under that
subtree or a uniquely named integration test, plus NEW server
`offline_python/` module/tests. Core owns module registration/reexports and
migration allocation **0017_worker_tool_delegations.sql**. Do not edit existing
admission, cancellation, provider transport, shared contracts, manifests or root
lock. Submit exact source for review before registration/activation.

This is one offline tool operation subordinate to an existing Deep execution.
It does not admit a SessionRole::Worker provider session, consume a second Deep
claim or enable the pending Fast/Worker session proposal. Provider dispatch is
not tool authority. The separate capability below is issued only after a trusted
server operation explicitly delegates this fixed offline tool. No public HTTP
route or provider-parsed text may call issuance without that trusted decision.

## Store-owned private types and methods

The helper may define these public types in its Store module, with private
fields/constructors, no Clone, Deserialize or secret/source Debug on grants:

- `OfflinePythonDelegation`: issued locator plus immutable parent snapshot;
  read-only `id() -> Uuid`, `source_digest() -> &str`, `expires_at_ms() -> i64`.
- `ConsumedOfflinePython`: single-use launch capability; getters `id()`,
  `source() -> &str`, `source_digest()`, `parent() -> &ProviderAdmission`.
  Runtime consumes it by value; getters are not replacement launch grants.
- `OfflinePythonAdmission::{Fresh(OfflinePythonDelegation), Existing(OfflinePythonReceipt)}`.
- `OfflinePythonConsumption::{Launch(ConsumedOfflinePython), ReconciliationRequired}`.
- `OfflinePythonReceipt`: public non-authority metadata: delegation UUID,
  owner/conversation/parent RunId, source digest, revision, state
  `Delegated | DeliveryUnknown | Completed | Failed | Cancelled | Blocked`.
  Completed means tool exit evidence only, never provider/task acceptance.
- `OfflinePythonOutcome::{Completed, Failed, Cancelled}`. Recording Cancelled
  requires actual owned-child termination and reaping, never parent Stop alone.

Methods on the AUTHORIZED supervisor-bound Store, using RuntimeStoreError:

```
async delegate_offline_python(&self, credential: &str,
    parent: &ConsumedProviderDispatch, request_key: &str,
    source: &str, lifetime_ms: u32) -> Result<OfflinePythonAdmission>
async consume_offline_python(&self, credential: &str,
    grant: OfflinePythonDelegation) -> Result<OfflinePythonConsumption>
with_offline_python_fence<T,E>(&self, credential: &str,
    launch: &ConsumedOfflinePython,
    action: impl FnOnce() -> Result<T,E>) -> RuntimeResult<Result<T,E>>
async finish_offline_python(&self, credential: &str,
    launch: &ConsumedOfflinePython, outcome: OfflinePythonOutcome,
    output_digest: &str) -> Result<OfflinePythonReceipt>
async acknowledge_offline_python_cancel(&self, credential: &str,
    launch: &ConsumedOfflinePython, control: &ProviderAdmission)
    -> Result<OfflinePythonReceipt>
```

`Result` in async signatures is application runtime Result. Credentials remain
separate trusted arguments, never serialized request/grant fields. Lifetime is
1..30000ms and cannot exceed parent lease/context deadline. Source is exact
UTF-8 <=65536 bytes; digest is lowercase SHA256 of exact source bytes, no JSON
or normalization. Request key uses existing production key restrictions.
Output digest is exact bounded combined-output encoding selected by helper and
pinned in tests/docs, not caller-supplied success authority. Do not persist raw
stdout/stderr in the delegation metadata ledger.

## Ledger reservation and required guards

Core reserves table `worker_tool_delegations`: UUID PK; owner/conversation,
parent_run/session/context/incarnation, parent_binding_generation,
parent_lease_generation, parent_dispatch_fence and parent_deadline_ms; operation
constant `python_offline_v1`; request_key; source_digest; source UTF-8;
expires_at_ms; state; revision; one-use grant_hash (not raw locator);
optional outcome_digest. Unique `(owner_id,parent_run_id,request_key)`.
All parent links reference existing production authority, not source claims.
No provider bindings, canonical events, inbox or admission acknowledgement writes.
Core will publish final SQL after reviewing the helper's minimal required columns;
no helper schema allocation or direct SQL clock edits.

Every operation authenticates the exact current credential inside its authority
transaction BEFORE replay lookup, verifies same bound owner/context, current
supervisor incarnation, exact full parent envelope, Execution purpose,
Starting/Running parent and consumed DeliveryUnknown. Use the existing canonical
parent validation helper rather than a weaker parallel checker. Parent lease
renewal invalidates old tool authority conservatively; no implicit rebasing.
Parent AwaitingAcceptance/terminal, expiry, cancellation, takeover or logout
fences new effects. A tool receipt replay is evidence only, not a fresh grant.

Issuance is atomic/idempotent: same semantic input returns Existing metadata,
never another grant. Changed input conflicts. Consume authenticates the private
locator and commits DeliveryUnknown, erases grant_hash and advances revision
BEFORE returning Launch. Lost consume ACK/reopen never yields Launch again.
The synchronous fence holds BEGIN IMMEDIATE around only bounded spawn/enqueue;
no queue wait, child wait, blocking pipe or async action inside it. After actual
I/O, a commit failure is unknown, never permission to repeat. Finishing checks
current parent authority before storing output success; after fencing retain
unknown/blocked evidence and quarantine output, never fabricate Cancelled.

The server uses bounded queue slots with an admission deadline BEFORE consuming
launch authority, then spawn_blocking for the blocking sandbox runner. Queue
expiry must not consume a grant. Recheck fence immediately around actual spawn;
monitor current authority while running, then kill/reap on refusal before any
result exposure. A process-local cancellation flag is transport, not durable
Stop. No permissive callback, private-context reconstruction or unsandboxed
fallback. Synthetic ordinary Store callsite/race/reopen/queue/kill tests precede
activation; keep provider/session Worker role gates unchanged.

Cancelled acknowledgement uses only the separate method above: require actual
owned-child kill/reap evidence from trusted composition and exact Core-issued
CancellationAcknowledgement for the same parent/owner/context, current new cancel
fence and issued lease. Authenticate both original launch lineage and current
control; do not pass control as Execution or accept arbitrary parent IDs. Normal
finish must refuse Cancelled and leave unknown after loss of execution authority.

The existing blocking `run_python` cannot simply be wrapped in a Store fence.
Its INTERNAL actual spawn needs an Isolation-owned bounded launch callback or
consumed-capability integration; waiting for child completion must occur outside
the transaction. Coordinate this API with the sandbox owner before claiming a
runnable fenced callsite. A fence around spawn_blocking scheduling is insufficient.

## Schema 0017 implementation handoff

`0017_worker_tool_delegations.sql` is the authoritative allocation. Exact column
names are `id`, `context_id`, `incarnation_id`, and `source_text`.
`requested_lifetime_ms` is immutable input (1..30000); replay compares it rather
than a recomputed expiry. State values are lowercase. Grant hashes exist only
in `delegated`; consuming or fencing erases them. Historical incarnation IDs
intentionally do not reference the mutable current incarnation. Parent lineage
and full envelope consistency remain mandatory transaction checks beyond FKs.

The helper exclusively owns the new `production_runtime/worker_tool` subtree,
its tests, server `offline_python` subtree/tests, and spawn-only sandbox refactor.
Core registers/reexports those implementations after their scoped source handoff;
no empty module or alternate implementation is registered ahead of that handoff.

The monitor API is approved as an additional Store-owned method:
`async check_offline_python(&self, credential: &str,
launch: &ConsumedOfflinePython) -> Result<()>`.
It authenticates the current credential and exact canonical parent/delegation
under one transaction. It returns no grant, receipt or permission to spawn.
Actual spawn still requires `with_offline_python_fence`; waiting stays outside.
Monitor refusal kills/reaps the owned child and quarantines output, without
inventing a Cancelled acknowledgement. No provider Worker role is enabled.
