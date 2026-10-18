# Runtime store contract proposal: follow-up to intake

Status: proposed port only. The intake SQLite adapter does **not** implement
these methods yet. No runtime durability, cancellation or effect fence has been
verified by the intake PR. Runtime can implement offline adapters against this
port while Core adds tested migrations and SQLite transactions.

Locations:

- `v2/crates/contracts/src/runtime.rs`: client-safe role/session/run state enums.
- `v2/crates/application/src/runtime.rs`: `RuntimeStore` and server-side receipts.
- `v2/crates/store-sqlite/src/runtime.rs`: reserved future SQLite implementation.
- `v2/crates/store-sqlite/migrations/0002_runtime.sql`: reserved future migration;
  do not create/apply until transaction invariants have tests and independent review.

Use the `orkestr-v2-application` and `orkestr-v2-contracts` crate names. Native
Rust future-returning trait methods require Send; implementations can use async
methods. No object-safe trait or async-trait macro is required. No alternate
persistent state file is allowed. Runtime owns process supervision/provider
protocols; Core owns authoritative state transitions and the store adapter.

## Proposed additive tables

| Table | Proposed columns and constraints |
|---|---|
| session_bindings | id, owner_id, conversation_id, role, state, provider_kind, native_session_ref, protocol_version, supervisor_receipt_ref, version, lease_generation, lease_expires_at_ms; unique conversation/role for fast and deep only; native provider reference uniqueness within provider kind; worker rows separate |
| scope_fences | conversation_id PK, owner_id, generation >= 0; monotonic across cancellations/holds/recovery |
| tasks | id PK, owner_id, conversation_id, state, version; queued before run admission; no success without separately verified evidence |
| runs | id PK, task_id FK, session_id FK, owner_id, conversation_id, request_key, payload_digest, state, version, lease_generation, fence_generation, supervisor_receipt_ref; unique owner/conversation/request_key |
| runtime_controls | id PK, run_id FK, kind, fence_generation, state; durable interrupt/reconcile commands; unique run/kind/generation; no raw transcript or provider credentials |

Add claim_session_id, claim_generation and claim_expires_at_ms to the existing
`reasoning_inbox`. Its current `queued/claimed/consumed` state belongs to **deep
reasoning**. Fast presentation cannot consume that queue. A future fast delivery
cursor must be defined explicitly; do not invent a second reasoning queue.
Canonical fast/deep rows start as Starting, with no invented provider session.
Native provider identifiers remain server-side and must not appear in web DTOs.

`ensure_role_bindings` creates exactly two distinct canonical IDs transactionally.
`confirm_session` consumes a version-matched supervisor receipt; fixtures require
explicit fixture selection at the composition root. A native reference alone is
not proof of supported durable resume. `allocate_worker` creates an independent
idempotent binding; no worker is forced into the visible conversation list.

Lease duration is bounded by store policy (proposed 1..60 seconds). SQLite assigns
current time/expiry, increments generation on each new lease and renews only a
matching live generation. One live turn per session. Expiry does not silently
transfer a native session to another process; recovery marks it lost and its
nonterminal run blocked/reconciliation-required, invalidates scope fences and
quarantines unknown effects. A process restart cannot merely trust the old PID.

`claim_inbox` requires the active deep lease and chooses the smallest unconsumed
sequence under one transaction. `admit_run` checks owner/conversation/task/session,
claim generation, supervisor receipt and current fence; then appends run admission
and state changes atomically. A request key replay returns the original run for
the same semantic body; changed content conflicts. Task creation and acceptance
evidence submission remain separate ports to specify before adapter integration.

`request_cancel` compare-and-swaps run version, persists CancelRequested, increments
the scope fence and queues the control command before Runtime sends interrupt.
Already-dispatched effects remain uncertain/in flight. Repeated cancellation of
the same pending request is idempotent; stale competing updates must fail.
`check_run_fence` supports scheduling/reconciliation only: it never authorizes an
effect, and a preflight read cannot replace the atomic effect-dispatch gate.
Cancellation of one run conservatively invalidates other old fence snapshots in
the scope until explicitly re-admitted. Terminal cancellation confirmation needs
actual supervisor evidence and is not inferred from dispatching an interrupt.

Recovery is owner-scoped, bounded and idempotent. It records lost/blocked state,
invalidates stale claims and creates reconciliation work without calling providers,
replaying effects or marking work successful. Exact run/session event payloads,
task admission/evidence, fast presentation cursors and expired-claim requeue policy
remain explicit integration decisions; they are not covered by passing intake tests.
