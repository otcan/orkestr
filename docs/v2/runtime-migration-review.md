# Runtime source migration review

This proposal follows the explicit source-only v0 handoff from core commit
e2de7312093fdffcd7a8b6111efa546af89bf929. Only contracts/application crate paths
were restored from that origin, including their crate-local manifests. This
supersedes the prior runtime proposal against port v2; it does not supersede core's
other branches or claim that v0 implements later contracts.

Runtime imports application ProviderAdmission, ProviderEvent and RuntimeStore,
contracts UUID newtypes and SessionRole. Provider/Blocker/fake/parser remain in
runtime. There is no runtime-owned shared port, persistent store, schema or SQL
adapter. Crate-local path dependencies remain; no root manifest, lockfile,
toolchain, domain/demo or CI changes are included.

## Safety and outstanding shared guarantees

High-level start calls admit_run but never provider.start: port v0 lacks a
store-returned authoritative role and a fresh-versus-replay dispatch disposition.
Caller role is ignored, and DispatchUnconfirmed blocks all dispatch until core
provides these guarantees. Tests cover mismatched roles and identical replay.
Direct fake provider calls are explicitly selected fixture behavior only.

A pending observation retains its original owner, admission, sequence and body
through Unavailable, including a write committed before its acknowledgement was
lost. The identical retry must return the original event receipt; changed payload
at that sequence must conflict. No repoll or sequence increment happens until
acknowledgement. StaleLease/Fenced latch quarantine and retain original evidence
for reconciliation. A new process cannot recover this volatile cursor by creating
a default one; durable reconciliation remains unavailable.

The lost-ACK spy regression records a terminal event, returns Unavailable, then
returns the same receipt for the identical retry without another accepted event.
It is an authored protocol test, not evidence of SQLite durability or recovery.
The completion-before-stop terminal preservation and fail-before-record retries
remain covered by separate authored regressions.

Cancellation awaits the durable request_cancel receipt before provider interrupt;
its new fence is an InterruptControl, never renewed execution authority. Unknown
in-flight effects remain unknown. Atomic inbox admit/ack, single metadata journal,
provider namespace/supervisor context and durable restart recovery still require
core agreement and implementation. No live inference or task acceptance is implied.

## Evidence

19 Rust tests authored: 10 offline, 5 ordering, 4 retry. None executed at this
migration head. No cargo, compilation, formatting or downloads run under the heavy
hold. git diff --check passes. Root/lock integration remains coordinator-owned
and gated on independent source review. Previous green CI does not transfer.
