# Selected reconciled async v5 adaptation

Current selected shared origin: 8acc370d0ced3c808d5af02c1b70ef95557b0a24,
including reconciled core 9c0725c5 and boxed reservation successor. Application
and contracts paths match that origin exactly. Selection was explicitly batched;
older alternatives and their test counts below are historical provenance only.

Runtime now reads RunAdmissionResult.provider, run_state and disposition. It
validates run owner/scope/session/role/Execution plus returned binding association.
Replay/ReconciliationRequired return DispatchUnconfirmed, including active and
terminal snapshots. FreshCandidate requires Starting and a nonempty candidate
locator but also returns DispatchUnconfirmed: runtime never invokes claim/consume
or provider start. The locator is never logged or serialized. Only core may
establish namespace/supervisor/protocol readiness and durable one-use authority.
Default claim/consume remain Unavailable. No local authority/store is introduced.

31 authored runtime tests: 13 offline, 10 ordering, 8 retry. New source tests cover
active/terminal replay and uncertain dispositions, and mismatched provider binding.
All 31 remain unexecuted at this adaptation; earlier 19/21/29 results do not transfer.
Wrapper package fmt and diff check passed. Shared path comparison to selected core
is empty. Coordinator combines the matching store adapter, boundary rule and lock;
this change imports no store/schema/root/lock or CI. Independent exact-head source
review precedes integration/build evidence. Main dispatch holds remain in force.

---

# Runtime v5 source migration review

Canonical origin: core 9880a53e01a964d85c4c94ee5308bb7a8236ab14, port version 5,
PR #82. Immediate migration base: 80446d375896b9f4cc559855892b288b170d799e.
Contracts/application paths match that origin exactly, including crate-local
manifests. Root manifest/lock, toolchain, schema/store, domain/demo and CI are
outside this migration. Coordinator owns their final integration.

## Shared authority and append

Runtime imports ProviderAdmission, ProviderEvent/Input/Receipt and RuntimeStore
from application::runtime. Native authority remains application-only. The sole
append operation is append_provider_event(owner, admission, input), native
Future + Send; record_observation is removed. Runtime owns Provider/Blocker,
fake, parser and supervision, with no persistent store or parallel port.

The cursor retains the complete provider admission and numeric sequence starting
at 1. Input carries original run/session IDs, lease generation and dispatch
fence. Busy/Unavailable retries preserve identical input and admission. Only a
matching receipt sequence clears pending input and advances the cursor. A fresh
cursor after restart is not permission to resume delivery or dispatch.

Canonical v5 authenticates owner/run/session first, then returns the original
receipt for identical committed input even after expiry or fence advancement,
without another transition. Changed replay conflicts. New input requires current
authority and contiguous sequence. This supersedes v3/v4 authority-before-dedup
for already committed evidence. The volatile spy models this distinction; it does
not implement or prove durable dedupe, store-derived digest or clock enforcement.

New stale/fenced/expired input is refused, never acknowledged. The cursor latches
refusal without repoll/readmission and retains exact evidence in one bounded
volatile reconciliation slot. Conflict retains pending evidence and blocks.
Completed maps only to CompletedProposal, never success; approval requests grant
nothing. Core acceptance and durable append remain unavailable.

## Dispatch, cancellation and progress

High-level start checks deep claim consumer before admission, validates returned
owner/scope/session/role/Execution purpose, then always returns
DispatchUnconfirmed. Replay is not fresh dispatch authority. Independent worker
admission, provider namespace/supervisor ownership and readiness confirmation
remain unresolved core contracts. Native ID alone establishes no readiness.

Cancellation is persisted before interrupt control. CancellationAcknowledgement
tokens cannot start or poll a turn. Fake interruption retains original execution
identity; a stale stop requires reconciliation, not invented authority. Queued
CompletedProposal/Failed/Lost evidence survives a racing interrupt.

Progress(String) is application-only and bounded to 8192 UTF-8 bytes. Fake queues
are bounded, including multibyte inputs. Progress storage returns Unavailable in
the spy and retains exact pending input; no raw text journal or invented PayloadId
is introduced. Codex raw deltas still return PayloadUnavailable. Frame and 8 KiB
candidate progress/result bounds remain in both offline parsers.

## Evidence and gates

28 authored runtime tests: 13 offline, 7 ordering, 8 retry. They are unexecuted and
uncompiled at this revision. New cases cover committed replay after revocation,
changed replay and wrong owner, and retained bounded progress. These are volatile
protocol tests, not durability/restart acceptance. Wrapper package fmt and
source diff checks are the only local validation. Independent exact-head source
review precedes coordinator root/lock integration and exact-head build/tests.
Historical aec7475b 16/16 results and inherited PR #80 CI do not transfer here.

## Comment-only replay clarification

The application append comments incorporate the semantic clarification from core
PR #91, d0e0d8e0062e609e0c9494e8440b08d6c08d9074, without its historical e2de
ancestry or signature. The v5 owner/admission/input signature and types remain
unchanged. Authentication must prevent receipt disclosure across principals;
cancellation fences remain control-only. New append input requires execution
authority. Cancellation confirmation/reconciliation has no implemented substitute.
This comment-only adaptation supersedes the earlier ambiguous reference to new
cancellation authority; core owns the eventual durable enforcement.

## Application-owned async-trait requirement

Adapted core cfa503e83acc3470c8844ae8d5c86d820a2c3f19 onto the reviewed v5
shape, without restoring its historical record_observation or contracts layout.
All ten current v5 argument/result types, including append_provider_event, remain
unchanged. RuntimeStore now uses async_trait with Send + Sync and default Send
futures. Application alone pins =0.1.89 and reexports the attribute; the runtime
spy uses that reexport without a direct dependency. IntakeStore is unchanged.
This supersedes native runtime signatures only. Coordinator owns lock integration
after independent source review. No Cargo/download/fmt/test run accompanies this
source-light adaptation. Historical isolated v1 clippy failed double_must_use in
async-trait expansion; that concrete risk remains unresolved, not waived here.

## Per-call admission result

Adapted core d06eae164a3c20310b9dd6fc22247b95f0c53fa8 (PR #92 checkpoint
76d8caaf) onto current async v5. Application RunAdmissionResult wraps the
application-only RunAdmission and is_new. No historical contracts authority types
are restored. Validate returned identity/role/Execution before checking freshness;
false never dispatches. True also remains DispatchUnconfirmed pending durable
store/readiness evidence. Spy models fresh then replay and replay-only paths;
it cannot prove concurrent single insertion or active/terminal durable replay.
29 runtime tests are now authored, unexecuted. No Cargo/download/fmt/CI run.

Comment-only association clarification from aecb1b46c2d357a4f314635296298633666eb27d
is adapted to v5 append: authenticate immutable owner/conversation/run/session/attempt
against durable records before receipt retrieval. Existing committed receipt creates
no authority, lease extension or cancellation acknowledgement. No historical
record_observation signature, new endpoint or field is introduced.

## Candidate selection correction

Core identifies b8b72af94c2baa8c98db3688782c32ab2056c869, PR #88, parent
d4cf6934, as the minimal d4-based admission-result proposal. Its result fields
and admit_run arguments match the bounded result adaptation above. This does
not select PR #92/93460326 as the canonical successor, nor automatically select
PR #88 over the coordinator's chosen integration base. The current runtime
branch remains a source-review candidate with all dispatch blocked; coordinator
must explicitly reconcile the base before lock/build/integration. No raw d4
contracts, historical roots or additional port are imported by this comparison.

## Frozen read-only dispatch analysis: PR #95

Inspected ee1750cba1c222989e05e00b87f713d5d4caab7a, parent chain
7d3c8695 -> a05eab4d -> ee1750cb. No shared-path import is selected here.
This is a native Future+Send v4 proposal, not an implicit reversal of the current
branch's pending async adaptation or an observation-policy selection.

Runtime mapping after canonical reconciliation would validate returned admission
identity/role/Execution, refuse Replay/ReconciliationRequired, and treat
FreshCandidate as insertion evidence only. The store-issued candidate key must
never be logged/serialized; only core may validate/consume it and reserve once.
A claim response is still not permission to call Provider::start. Only a unique
consume result DispatchNow follows a durable DeliveryUnknown CAS before I/O;
repeat/lost ACK/restart requires reconciliation without retrying provider I/O.
Until independent durable enforcement exists, current high-level starts remain
DispatchUnconfirmed and neither new operation is called by runtime.

Required adapter cases include forged/missing candidate and reservation, replay
and terminal admission, lost ACK at each boundary, cancellation-before-consume
refusal, consume-before-cancel unknown status and no retry after local write error.
These need core transactions and acceptance tests; spies cannot prove single-winner
or restart behavior. No reusable runtime token/store is introduced.

Reconciliation blockers: PR #95 retains v4 record_observation and its old
current-authority-before-duplicate policy, whereas this branch has v5 append and
committed replay retrieval. Core/coordinator must explicitly choose one newest
contract SHA and delta, including async convention and observation policy, before
shared-path migration. Native readiness, bound supervisor enforcement and worker
admission remain unavailable; the proposal implements none of them.
