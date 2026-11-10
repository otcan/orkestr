# Source-bound Native Worker tools

The managed MCP bridge lets a current Codex primary create and observe bounded
Core Worker tasks. It uses the existing Worker task queue, scheduler, slots,
provider admission and acceptance records. A provider's own agent-spawning tool
is a different mechanism and is not evidence of a Core Worker run.

This increment is gated by the sealed service setting `managed_workers: true`.
It requires identity splitting and `managed_operations: true`; absence leaves
creation disabled. The capability observation remains discoverable. Selecting
the setting belongs to the qualified release configuration, after source and
boundary review. Building or registering the tools alone does not establish
production readiness. No deployment or real-provider acceptance is implied by
source tests.

## Tools and limits

| Tool | Behavior |
| --- | --- |
| `orkestr_worker_capability` | Observe this actual primary's provider, current scheduler availability and limits. |
| `orkestr_worker_submit` | Create one bounded task and observe it for up to 25 seconds. A queued receipt has no run/provider identity yet. |
| `orkestr_worker_status` | Read an existing task belonging to this exact primary, owner and context. |
| `orkestr_worker_wait` | Observe an existing task for up to 25 seconds; it never creates or re-executes one. If observation capacity or the scheduler is unavailable, return a snapshot. |

The capability states are `ready`, `setup_required`, `denied`, `unhealthy` and
`not_supported`. Readiness requires both sealed configuration and the actual
parent's live scheduler registration. Claude primaries report `not_supported`
because their current lifecycle does not compose a Worker schedule. There is no
silent provider fallback.

The existing limits remain four active scheduler slots and 32 tasks per primary.
Four simultaneous Native waits are permitted. Task title and instructions are
data only; the complete arguments are capped at 4 KiB. Initial task lifetime is
30 seconds. An explicit sealed `managed_worker_execution_budget_ms` selection
(30,000 through 3,600,000) authorizes same-child renewal within the existing
Worker policy ceiling. Core clamps that owner selection to the host policy.
The model cannot supply a budget. Omitting the selection preserves the 30-second
hard lifetime; a host ceiling alone is not owner authorization. Existing control/MCP frame and connection bounds remain.

## Authority and persistence

The tool caller cannot supply an owner, conversation, parent run, provider,
session, workspace, lease, dispatch fence or execution budget. Root observes the
original Native actor through its managed transport. Core matches that evidence
to the current non-deserializable primary parent, execution window, supervisor
context, incarnation and credential before creation, replay and observation.
Stop, expiry, changed authority and foreign task IDs fail closed.

Native RPC correlation becomes a server-derived operation ID. Core inserts the
task and its `native-worker:<operation-id>` request key atomically in the existing
Worker task table. The existing request digest rejects changed input and its
unique constraint returns the original receipt on an exact current-authority
retry. No migration or fake Desk/Root operation tag is used. Root retains the
corresponding original source/request journal. Lost replies and restart-unknown
requests must be reconciled rather than submitted as new tasks.

After creation, the protected `managed_worker_bind` control operation durably
associates the original call with its task and removes it from the pending
submission queue. This permits four genuine concurrent waits. Ordinary parent
ticks continue advancing the existing Worker schedule. No handler awaits a child
terminal result while borrowing the parent's controller. A bounded round-robin
observer returns the real phase at completion or deadline. Parent shutdown uses
the existing schedule cleanup and closes the original Native result channel.

`managed_worker_reply` returns a result only under the current Core writer fence,
matching the original source, request digest, run and bound task. Root persists
the result before delivery, rechecks the original Native actor and refuses a
changed result or closed run. The existing Desk and Root packet formats and
operation IDs are unchanged.

A result is `completed` only after the real Worker proposal is accepted. Before
acceptance it remains `awaiting_acceptance`, with no accepted answer attached.
Completed results include the immutable acceptance/completion/payload references
and a bounded text preview. Removed payloads and truncation are explicit. The existing window system principal auto-accepts Worker proposals first when
the persisted owner setting `review_before_accepting` is false, with an audit
receipt and no browser decision. If that setting is true, results remain
`awaiting_acceptance`. The bridge preserves this configured policy.

## Remaining rollout acceptance

Source/fixture checks must exercise idempotent create, actual Worker input
consumption, current authority, all five capability states, scope/refusal cases,
parallel observer binding and accepted-result linkage. Linux actor/HTTP tests
must preserve original RPC correlation and actual Root custody. They complement
the Core Store tests; neither is a real provider-client deployment proof.

Before advertising production availability, the release owner must qualify the
exact source/package, select the gate in the reviewed configuration, and verify
both a fresh and resumed real Codex primary: tool discovery, one or more actual
Core Worker task/run/provider records, bounded result delivery to the same
primary, and cancellation/unknown behavior without duplicate creation. Claude
parity remains separate acceptance work.
