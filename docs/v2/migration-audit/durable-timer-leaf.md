# Ordinary durable timer leaf handoff

The new `store-sqlite/src/history_import/timers/` subtree implements ordinary
Store import, explicit enable, control and due-occurrence claims. It contains
all timer DTOs and an **unnumbered proposal**, `schema-proposal.sql`. Core has
reserved migration 0027; only Core may install the authoritative migration.
The required shared registration is one line in `history_import/mod.rs`:

```rust
pub mod timers;
```

No manifest, lock, root schema or shared source edits are included. The leaf
requires the existing `Store::history_transaction(credential, owner, write)`
ancestor helper. Core confirmed this private-descendant seam: issuer-bound Store
handles are refused, and ordinary writes authenticate current owner credentials
inside `BEGIN IMMEDIATE` before ledger/old-receipt lookup. Current target
conversation ownership is checked in that same transaction.

## API and persisted behavior

- `import_dormant_timer(credential, owner, &TimerImportRequest)` copies bounded
  source namespace, opaque timer identity, source-enabled provenance and schedule
  metadata into a fresh target namespace. It always starts paused, without next
  due time or target conversation. The source fingerprint has its own explicit
  domain and covers source identity/enabled metadata/schedule; target namespace
  is separately deduplicated. Exact replay returns the **current**, inert ledger
  receipt, never re-enables; changed source or duplicate remapping conflicts.
- `enable_dormant_timer(..., &TimerEnableRequest, now_ms)` requires explicit
  expected revision/request key and an owner-owned target conversation. A new
  generation and first due timestamp are committed with the semantic receipt.
  Clock time is excluded from semantic key identity; identical replay returns
  the original committed due timestamp while that revision/generation is still
  enabled. Changed semantics or a subsequently controlled timer conflict.
- `claim_dormant_timer(..., &TimerClaimRequest, now_ms)` atomically writes the
  occurrence UUID, source fingerprint, target scope, due timestamp and generation
  before advancing the schedule. Unique generation/due and request keys prevent
  duplicate occurrence creation, including races between Store pools. An exact
  claim retry returns the original receipt only while its generation is current
  and uncancelled. Once schedules become exhausted after one occurrence.
- `control_dormant_timer(..., &TimerControlRequest)` supports Disable, Stop and
  Rollback. Revision/generation advance, next due clears and every old claim is
  cancelled atomically. Stop/rollback are tombstones, not deletion. Disable may
  be followed only by a new explicit enable key/current revision. Prior enable
  and claim receipts cannot be replayed into the new generation. Rollback keeps
  all provenance and affects no native conversation/history delta.
- `dormant_timer_receipt` is current-auth readback, never dispatch authority.

All `now_ms` inputs are **trusted server clock injection points**, not values to
accept from an unauthenticated HTTP caller. The fake-clock schedule set is once,
whole-minute m/h/d intervals, and explicit UTC daily/weekly clocks. Interval
claims skip missed periods by scheduling from claim time; there is no burst
catch-up. Once enables refuse due-at-or-before-now. UTC weekly semantics retain
V1's same-day-future-clock/otherwise-seven-days behavior, without inventing a
weekday field. Interval bounds are one minute through 366 days; clock instants
are bounded to 1970–2100.

Non-UTC zones, implicit legacy host time, ambiguous cadence and uncertain effects
can be retained using `TimerSchedule::Dormant` with bounded schedule-only strings
and an explicit reason. They **cannot enable**. This avoids silently translating
DST or legacy defaults. Prompts, promptFile, connector routes, native provider
sessions, source auth and credentials do not appear in these DTOs or tables.
Preserving schedule alone does not establish executable workload parity.

## Dispatch and Stop boundary

The durable claim receipt is deliberately **not** an application/runtime/provider
admission and has no token, input event or executable payload. The leaf writes no
native messages, inbox, outbox or production run. No external effects can be
dispatched by it. This delivers the requested durable import/enable/claim seam,
not a running timer worker or connector capability grant.

Timer Stop/disable/rollback fence all timer generations. Existing native run
Stop remains owned by Core's runtime and is not reimplemented here. A future
native timer-to-runtime adapter must consume/validate the current timer generation
inside the **same** authenticated native admission transaction and preserve Core
run-control revision/Stop fences. Merely replaying a claim receipt or checking a
boolean before a separate admission would be unsafe; no such adapter is included.
Core must select that tiny transaction-local bridge before actual due dispatch.
Main WA routing holds, muted bindings and personal skill exclusions are not
relaxed by timer enable or claim.

## Validation and build handoff

The isolated Store-facing tests cover paused import, source conflicts, exact
replay/reopen, no native-table effects, trusted fake-clock cadence, current-auth
revocation, owner target/revision/key refusal, cancelled-generation replay,
terminal tombstones, explicit dormant reasons, two-pool occurrence races and a
transaction abort after claim insertion. The test-only leaf harness creates the
proposal tables only in a synthetic temporary Store if Core migration 0027 is
not yet registered. No production initializer exists.

Executed at initial source checkpoint: rustfmt on owned Rust, synthetic SQLite
proposal syntax validation (three tables), diff whitespace check. Rust compilation,
Store tests, strict clippy and process-kill acceptance are **unexecuted** until
bounded build admission/independent verification. No live timers or messages were
read or modified.

Subsequent compilation and Core registration results are recorded separately in
[durable-timer-build-evidence.md](durable-timer-build-evidence.md).
