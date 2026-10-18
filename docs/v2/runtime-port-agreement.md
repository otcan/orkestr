# Runtime port agreement proposal

Status: proposed against the published application ports; no runtime store adapter
is implemented. This document fixes names for cross-lane review, not acceptance.

Dependency: `orkestr-v2-application` (Rust `orkestr_v2_application`, path
`v2/crates/application`) depends only on `orkestr-v2-contracts` (Rust
`orkestr_v2_contracts`, path `v2/crates/contracts`). Runtime may use the existing
workspace `serde_json = "=1.0.145"` for its offline protocol parser. Application
ports must not acquire that dependency. Coordinator owns workspace/lock updates.

## Existing types to reuse

Use root contracts UUID newtypes `OwnerId`, `ConversationId`, `TaskId`, `RunId`,
`SessionId`, `EventId`. Use `contracts::runtime::SessionRole` (`Fast`, `Deep`,
`Worker`), `SessionState`, `RunState`. Do not introduce string ID or Role aliases.
`ConversationId` resolves the canonical scope under authenticated `OwnerId`;
caller-supplied scope strings cannot authorize admission.

Retain `application::runtime::RuntimeStore` as the sole durable runtime port and
its existing `RunAdmission`, `RunRecord`, `Lease`, `SupervisorAdmission`,
`CancelReceipt`, `RecoveryRecord`, `RuntimeStoreError`. `SessionBinding.version`
is a CAS version; `Lease.generation` and `RunRecord.fence_generation` represent
separate authorities. Do not collapse them into one generation.

## Proposed additions to application::runtime

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderAdmission {
    pub run_id: RunId,
    pub session_id: SessionId,
    pub native_session_ref: String,
    pub lease_generation: i64,
    pub fence_generation: i64,
    pub role: SessionRole,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderEvent {
    Started,
    Progress(String),
    ApprovalRequested,
    Completed { synthetic: bool },
    Failed,
    Stopped,
    Lost,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderEventInput {
    pub run_id: RunId,
    pub session_id: SessionId,
    pub lease_generation: i64,
    pub fence_generation: i64,
    pub provider_sequence: i64,
    pub event: ProviderEvent,
}

#[derive(Debug, Clone)]
pub struct ProviderEventReceipt {
    pub event_id: EventId,
    pub run: RunRecord,
}
```

`ProviderAdmission` is server-side only: no Serialize/Deserialize derivation,
no native reference in client DTOs. Admission cannot fabricate native identity;
construct it only from core-validated supervisor evidence plus an admitted run.

Add this native asynchronous method to `RuntimeStore` (imports as in runtime.rs):

```rust
fn append_provider_event(
    &self,
    owner: &OwnerId,
    input: &ProviderEventInput,
) -> impl Future<Output = Result<ProviderEventReceipt>> + Send;
```

The transaction checks ownership, session/run association, live lease expiry,
lease generation, scope fence and allowed lifecycle transition, then appends
journal/outbox and changes projections atomically. Provider sequence starts at 1,
is contiguous per run, and is unique per run. Identical sequence/payload retry
returns the original receipt; changed payload conflicts. No progress entry over
8192 UTF-8 bytes; no unbounded provider JSON. `ApprovalRequested` is a signal,
not an approval grant or effect authorization. `Completed` is provider evidence,
not task acceptance; synthetic completion stays explicitly synthetic. A stale
post-cancel event cannot commit a success transition. Recovery handles uncertain
terminal evidence through reconciliation rather than weakening the fence.

## Provider-only code remains in runtime

Keep `Provider`, `Blocker`, fake source, protocol parser and orchestration helpers
in `orkestr-runtime`; import the proposed application data types. Nonblocking
`start`, `poll`, `interrupt` and default `Unsupported` for `resume`, `fork`,
`steer` are accepted. Runtime bounds its queue; core enforces storage bounds.

Do not move the provisional synchronous `SessionStore` into application. SQLx
ports are asynchronous and need explicit owner, expected version, lease expiry,
claim/task evidence and bounded recovery. Reuse existing `admit_run`,
`request_cancel(owner, run_id, expected_version)` and
`recover_expired(owner, limit)` signatures. Cancellation persists the scope fence
and control outbox before provider interruption. The returned `CancelReceipt`
is evidence of a request, not a renewed execution admission. An interruption
helper may carry the new fence in a server-side control envelope but must never
start/poll a new turn with it. Failed interruption leaves cancellation requested
and effects uncertain; recovery must not restart blindly.

## Pending implementation

Core migration/adapter, provider-event mapping and tests, control-envelope shape,
task creation/evidence ports, and provider identity confirmation remain pending.
No HTTP run/lease/effect/fixture-control endpoints are implied by this proposal.
