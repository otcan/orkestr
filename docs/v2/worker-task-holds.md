# Durable holds for pending Worker tasks

An owner task in `queued` or `claimed` becomes durably `held`, with `claim_hash`
cleared, in the same SQLite transaction that stops or terminates its parent or
revokes its issuing authority. A computed history label is insufficient: a raw
ledger read immediately after that transaction must see the hold. A failed hold
also rolls back the parent transaction.

Each fresh task records the sealed supervisor's machine-token digest internally.
It is absent from browser DTOs and does not grant execution. This exact linkage
allows revocation to fence the issuing machine without treating an unrelated
browser logout or another machine session as that revocation. Parent control,
binding, readiness, and supervisor-incarnation changes also fence pending work.
Normal progress, supervisor heartbeats, and valid same-process lease extension
preserve pending tasks.

Existing pending tasks lack independently verifiable issuer linkage. The upgrade
holds those tasks and clears their old claims instead of guessing an issuer.
Receipts, removable payloads, and delegated-task evidence remain intact. A held
task is never automatically resumed or reissued after credential restoration.
Already delegated Workers retain their separate run history and existing Stop
and owner-acceptance rules.

Elapsed time does not execute a SQLite trigger. The bound supervisor can call
`reconcile_worker_task_holds(parent)` after a scheduling refusal to persist
clock-expiry holds. This operation checks at most 32 pending tasks belonging to
that handle's exact owner, context, incarnation, and parent. It can only remove
authority. The ordinary Worker task scheduler invokes it before abandoning a
failed queue. An inactive process cannot write a hold at the instant time expires;
current admission and dispatch fencing still refuse expired authority.

Tests inspect raw rows before any status read or scheduler call. They cover
actual parent Stop, completion proposal, failure, machine revocation, unrelated
session revocation, progress, transaction rollback, claim-versus-Stop concurrency,
delegated history preservation, and scoped clock-expiry reconciliation. These
synthetic Store checks supplement the independently executed HTTP scenarios;
they are not real-provider or full-release qualification.

Core registration checkpoint
----------------------------

The canonical Core successor registers the task DTO and Store leaf from
`2b9fbe589f779ef2ae183dec516f156859b97ba8` (including its baseline task modules),
with migration 0031 contiguous after the existing 0026–0030 migrations. It does
not import the helper's older shared migration dependencies or server wiring.
The consumed-input hook uses the exact immutable task instructions and refuses
missing or altered task payloads instead of substituting parent input.

On this registered source, the required locked/offline wrapper passed all 26
task Store tests and all nine preflight tests, including populated-prefix row/FK
preservation and the actual old-task upgrade. Explicit parent/auth fences hold
pending tasks in the originating transaction; elapsed clock expiry uses scoped
negative reconciliation. Delegated historical evidence is retained. These are
Store checks, not HTTP, native-provider or process acceptance.
