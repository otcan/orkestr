# Ordinary Worker tasks

An authenticated owner can create a bounded subtask for an exact, currently
running Deep parent. The task records immutable parent identity, source message
and event, control revision, request digest, lifetime and creation receipt. Raw
title and instructions live in a separate removable payload table. Tasks do not
write the Deep inbox and do not grant provider or tool authority.

The request uses the current parent's stable control revision. Provider progress
does not invalidate this token. A stopped, terminal, revoked, expired or replaced
parent cannot create, claim or delegate new work. A current browser session may
still read history or replay an identical creation receipt after parent authority
ends; this returns historical evidence only. Changed request content conflicts.

The trusted supervisor claims the next queued task with a private, non-cloneable
handle. It creates a distinct Worker binding and native metadata session through
the existing parent-fenced metadata ports. `delegate_worker_task` consumes the
claim and links one standard Worker delegation in a single SQLite transaction.
The existing `admit_worker`, reservation and dispatch consumption path remains
responsible for execution authority. Dispatch reads the exact subtask instructions
and validates their digest before committing its delivery fence. Task-tagged
delegations with missing mappings or missing/altered payloads are refused; they
never substitute the parent's message text.

Limits are 32 tasks per parent, 160 UTF-8 bytes per title, 16 KiB of instructions,
and the existing Worker execution lifetime of 1–30,000 ms. Tasks have no automatic
retry or cross-parent carry-forward. The parent count includes held and completed
tasks. Claims with a lost reply remain `claimed`; this state records issuance and
does not assert a live executor. Reopening or replaying the creation request never
reissues a claim. The owner can hold an unissued task. A delegated run uses the
existing exact-run Stop path; holding a task cannot masquerade as native Stop.

Task history maps actual linked run state to preparing, running, awaiting owner
acceptance, completed, cancellation requested, cancelled, failed or held. Only
the ordinary owner acceptance transaction produces completed state. Without a
live parent, uncompleted unissued work is held. Raw payload deletion preserves
receipts and metadata and prevents future consumption. It cannot retract input
already delivered to a provider; an existing run remains subject to normal Stop.

The Store API requires trusted composition with a supervisor-bound handle.
`create_worker_task_authenticated`, `worker_tasks_authenticated`,
`hold_worker_task_authenticated` and `delete_worker_task_payload_authenticated`
recheck current browser credentials and owner/conversation scope in their own
transaction. HTTP composition must additionally enforce Origin, CSRF, request
body limits and current availability. `claim_worker_task` and
`delegate_worker_task` require the private supervisor credential. Provider output,
browser task IDs and creation receipts cannot manufacture either handle.

Integration requires the shared Core migration and module registrations, the
transaction-local `delegate_worker_in` helper, and a crate-private read-only
`WorkerDelegation::id` accessor. The consume hook is localized in `dispatch.rs`.
The implementation does not change Worker discovery, native protocol handling,
Stop semantics, or tool permissions. A server scheduler and owner-facing routes
must compose these ports before ordinary HTTP task execution can be qualified.
Store tests use synthetic isolated SQLite state; they are not proof of real
Codex/Claude execution, a browser workflow, project tool containment or release
readiness.

The Store checkpoint was verified against Core commit `8bc9bb6ca`, including its
`0026_worker_tasks.sql` migration and shared transaction helper. Fifteen new task
tests, nine existing Worker tests and one contract test passed, with no ignored
tests. Strict Clippy and formatting checks passed for the composed Store and
contracts. The composition adds only the three mechanical module/type exports
besides this module and its consume hook. Ordinary HTTP task execution remains a
separate acceptance checkpoint.
