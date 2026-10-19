# Schema 36 upgrade and Claude Stop port review

## Supported copy-first edges

Known-checksum, exact-schema contiguous prefixes **14, 17, 31 and 33 -> 36**
are supported by the ordinary Store preflight/migrator. Preserve the stopped
original DB and any WAL as a consistent backup; upgrade a working copy. Never
run an older binary on the migrated copy. Rollback means restoring the untouched
old database with its matching old binary, not downgrading schema 36.

Preflight identifies every recorded checksum and the exact schema on an
expendable DB/WAL copy, rehearses all pending migrations with foreign-key checks,
and only then permits writable source migration. Unknown checksums, future
versions, altered schemas, invalid migrated constraints and orphan sidecars
refuse. This is not a concurrent live-backup facility or package acceptance.

The populated edge matrix captures every existing table, column and row at each
prefix, upgrades a separate candidate, compares every original column/row and
prefix migration checksum, checks FK/integrity, reopens schema 36, and verifies
both original and rollback-copy bytes remain unchanged. Fixtures retain inbound
message/event/outbox/inbox links, production completion history and removable
payloads. They do not claim populated timer/native-steering/task execution for
every historical package. Existing task-hold and native-result upgrade tests
separately cover their populated historical ledgers.

Ordering is canonical: 33 durable timer authority; 34 steering/actual native-turn
mapping; 35 opt-in host budget ledger; 36 explicit immutable owner budget. New
ledgers stay empty on older fixtures: no result-delivery rights, timer enable,
steering turn or extended Worker budget is invented. Legacy task owner budget is
NULL; host configuration alone cannot extend it. Schema 31 pending tasks already
have issuer-lineage hold handling. Schema 36 rebuild preserves budget evidence
while requiring explicit owner opt-in at issuance. Initial owner-task delegation
is clipped to task creation plus owner budget, and current execution/spawn/result
checks enforce the effective owner/host bound before first renewal (724c2f275).

`schema36-migration-fingerprints.json` pins migration SQL SHA-256 and SQLx SHA-384
checksum bytes for Installation's independent artifact/SQL verification.

## Claude Stop reuse, no new authority

Use the existing bound Store
`stop_execution_control_authenticated(browser_credential, conversation, request)`
returning `(ExecutionStopReceipt, CancelReceipt)` from one authenticated write
transaction. Serialize only the first value. HTTP independently checks current
Origin/CSRF. Exact run/control revision, future projection refusal, original key
replay and durable Stop-held inbox boundary remain unchanged.

Runtime retains the exact cancellation admission from that receipt and applies
`with_cancellation_fence` to every actual nonblocking interrupt suffix. An ACK is
only correlated transport evidence. Only the exact interrupted terminal plus
original owned native-tree reap may cause Runtime to append `ProviderEvent::Stopped`
using the original cancellation-purpose admission and next observation sequence.
The append validates current machine/context/lease/fence, changes CancelRequested
to Cancelled, acknowledges the control outbox and releases only the exact binding.
It neither accepts a completion nor releases held input.

Broker-local retirement/reap does not retire the Store context. Keep the original
bound Store and control envelope alive through Stopped persistence; do not call
supervisor retirement first. Expiry, revocation, ACK-only, EOF, forced death or
missing correlated terminal leave unknown. Preserve a pending exact Stopped input
for transient persistence failure; committed exact replay returns its receipt,
never another interrupt. ReapedBroker is Runtime/Isolation evidence, not a browser
boolean or a new Core authority constructor.

`held_owner_inputs_authenticated` remains read-only; held pre-Stop inputs never
auto-release. `authorize_stopped_session_metadata` requires genuine durable Stopped
and exact current binding; it does not authorize ACK-only recovery. Fresh post-Stop
input is independently admitted/claimed, skipping held rows. Configured clean
restart retains the separate graceful-retirement provenance/exact predecessor
requirements; broker reap alone cannot manufacture restart authority.

The private v4 plan path was unreadable from this worker. This review covers the
explicit supplied plan and current Store source, not uninspected private bytes or
Claude native protocol qualification. No schema or cancellation API change is
needed for that supplied flow.

Validation on this source: required locked/offline wrapper preflight suite 10/10
passed (including all four copy-first edges); cancellation-filter suite 17/17
passed; feature-enabled all-target Store Clippy with warnings denied, workspace
formatting and diff checks passed. These are Store tests, not old-package binary,
Claude native protocol or deployed upgrade qualification.
