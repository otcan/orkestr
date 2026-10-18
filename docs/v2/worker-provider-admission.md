# Worker provider admission boundary

Status: durable Store adapter implemented for bounded independent review. This
refines `role-admission-proposal.md`; no server scheduling or real provider
activation is inferred from Store tests. Fast remains a separate authority.
Offline Python delegation is a separate tool authority and is not accepted here.

## Store-owned typed boundary

Public types live in a new `production_runtime::worker` module in
store-sqlite. Issued handles have private fields, no public constructor, Clone,
Deserialize or secret-bearing Debug implementation. Browser JSON and provider
output cannot construct them. The bound supervisor supplies owner, namespace,
incarnation and provider kind; they are not input fields.

```rust,ignore
pub struct WorkerDelegation; // opaque, one-use admission locator
pub struct WorkerDelegationReceipt; // evidence only, never a locator
pub enum WorkerDelegationResult {
    Fresh(WorkerDelegation),
    Existing(WorkerDelegationReceipt),
}
pub struct WorkerAdmissionInput {
    pub worker_binding_id: SessionId,
    pub expected_binding_generation: u64,
    pub source_message_id: MessageId,
    pub source_event_id: EventId,
    pub request_key: String,
    pub lifetime_ms: u32,
}
// Methods on the already authenticated, bound ordinary Store:
async fn delegate_worker(
    &self, credential: &str, parent_run_id: &RunId,
    input: &WorkerAdmissionInput,
) -> Result<WorkerDelegationResult>;
async fn admit_worker(
    &self, credential: &str, delegation: WorkerDelegation,
) -> Result<RunAdmissionResult>;
```

`delegate_worker` authenticates the current exact credential inside BEGIN
IMMEDIATE, then loads the exact durable parent run under the sealed supervisor context.
RunId is a locator, not a grant: owner/conversation/provider/namespace/incarnation,
current issued lease/fence, readiness and binding are read and validated from
storage in that transaction. No consumed inference capability is retained, cloned
or reconstructed. The parent
must be Deep, Running, DeliveryUnknown, currently leased and unfenced. Starting,
AwaitingAcceptance and terminal parents refuse. Nested delegation is initially
unsupported. This is a server-supervisor scheduling method, not a provider tool
or browser route. It grants no filesystem, network or other effect permissions.

Source MessageId/EventId must be the exact stored parent task input and its
message-accepted event in the same owner/conversation. The original parent task
identity is its immutable RunId plus those source IDs; no caller-created TaskId
or arbitrary prompt is introduced. The Worker has a distinct Ready binding,
confirmed persistent native identity, role Worker and parent_session_id equal to
the parent's session. It must belong to the same bound supervisor namespace and
incarnation. A binding/native ID cannot alias Fast, Deep or another Worker.
Missing Worker binding/readiness is Unavailable, not permission to fabricate one.

Lifetime is 1..30000 ms and clipped to parent lease and supervisor deadline.
The request digest includes the exact input fields, parent run/session/attempt,
issued lease/fence and binding generation. A matching request-key replay returns
only the original receipt; changed input conflicts. Lost delegation reply cannot
mint a replacement locator. Receipt fields are delegation ID, owner/conversation,
parent RunId, Worker SessionId, source IDs, deadline and state; no native identity,
locator, verifier or raw prompt is serialized.

## Admission and dispatch

`admit_worker` revalidates current credential, supervisor, parent and binding in
one write transaction, consumes the delegation locator and persists Starting plus
its issued lease history. It never reads, claims, acknowledges or changes the
Deep reasoning inbox. The immutable source text is loaded from the stored parent
input. Only the inserting call receives FreshCandidate and a candidate locator;
replay/uncertain delivery returns evidence without a new locator.

Existing reserve/consume and ConsumedProviderDispatch may be reused ONLY after
Core adds a durable Worker lineage reference and validates it in admission,
reserve, consume, metadata attachment, execution fences, lease renewal, payload
writes and every unseen observation. Runtime must not adopt this proposal as
permission to use the current Deep-only implementation. The consumed capability
continues to carry authoritative Worker role, independent session/native identity
and immutable source text. No role rewrite or separate permissive Worker fence.

## Parent lifecycle and schema gate

Parent cancellation, recovery, credential revocation and expiry must make every
new descendant callback/dispatch fail. Parent cancellation/recovery also updates
live delegation/child authority and erases candidate/reservation locators in the
same transaction before returning control. DeliveryUnknown remains unknown;
there is no synthetic child Stopped or success. Already committed authenticated
observation replay stays historical evidence only. Genuine parent Failed/Lost and CompletedProposal evidence is never refused Busy
merely because a child is active. The observation and descendant fencing commit
atomically: preserve the parent terminal/proposal truth, erase descendant locators
and mark unresolved descendants Blocked/unknown without fabricating Stopped.
Owner acceptance must not silently release unresolved descendant effects; its
separate reviewed policy may refuse Busy until reconciliation. Child Failed/Blocked
remains occupied until a separately reviewed recovery policy resolves it.

Core owns migration allocation and registration. Required additive ledger:
Worker delegations with exact parent authority snapshot, semantic request digest,
expiry, locator verifier and state; production run lineage reference and explicit
role. Replace conversation/source-sequence uniqueness with Deep-only claim
uniqueness while retaining all source links and foreign keys. Preserve existing
Deep rows, issued tokens, historical receipts and event bytes in populated
upgrade tests. Migrations 0018/0019 install these constraints and copy existing Deep rows.

Independent Runtime/Verification review remains required for activation. Required executable
oracles: independent Worker/native binding; no inbox delta; owner/source/role/
namespace/parent forgery; simultaneous issuance/admission/consume; changed replay;
parent cancel/recovery versus child callback; expiry/revoke; lost reply and fresh
process reopen with no locator reissue; complete no-write refusal snapshots.

## Runtime compatibility correction

The parent inference capability is consumed by value at transport attachment and
may be gone before Running. Delegation therefore uses the already bound Store's
authenticated durable RunId lookup above, not `&ConsumedProviderDispatch`. This
method remains server-supervisor-only; no JSON route or provider self-grant is
introduced. Request replay compares the original stored semantic parent snapshot,
then returns evidence only; fresh issuance requires current parent authority.
Parent terminal observation persistence and descendant fencing must share a
transaction, including Failed before/after Started and Lost. This corrects the
earlier proposal's overly broad parent-terminal Busy rule before implementation.

## Exported checkpoint

The types and methods above are exported from store-sqlite. The exact parent
lookup authenticates the current credential and full bound context, resolves the
canonical consumed Running Deep run inside BEGIN IMMEDIATE, and checks the live
issued lease, fence and native binding. Fresh issuance persists a one-use delegation verifier; admission atomically
consumes it and creates the Worker run without reading or acknowledging Deep inbox.
The server helper owns only `server/src/worker_execution/` and its integration
test; it can implement against these symbols against this durable ledger.
The exported receipt includes typed IDs, deadline and Delegated/Admitted/Blocked
state, and contains no native identity or dispatch authority.

## Implemented adapter handoff

`delegate_worker` returns an opaque locator only on the inserting call. Same-key
replay returns evidence, including optional `admitted_run_id`, never replacement
locators. `admit_worker` consumes the locator by value and returns the existing
`RunAdmissionResult`/FreshCandidate shape. Standard reserve/consume yields the
same private `ConsumedProviderDispatch`, now with validated Worker lineage and
immutable parent source text. Lost admission replies reconcile by receipt; they
do not authorize another start.

Every unseen observation, renewal and execution-fenced callback checks the exact
parent authority captured at delegation. Parent lease/generation changes currently
fence descendants conservatively; no delegation extension is inferred. Parent
terminal/cancel/recovery changes atomically erase child locators and retain unknown
delivery. Child cancellation uses its own issued control; it never cancels parent.
The Deep conversation status filters Deep runs; helper-owned Worker presentation
must not replace that projection.

Feature-gated existing admission pre/post-commit checkpoints also cover Worker
admission. Standard reserve/consume checkpoints remain available. Actual Worker
SIGKILL/new-process acceptance is pending independent execution; separate-pool
races/reopen are not process-crash evidence. No paid inference or native process
was used for the authored Store tests.
