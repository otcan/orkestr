# Admission and dispatch revision against application port v4

Status: source proposal, not an automatically selected canonical successor.
Exact base: 7d3c8695e4db2bca3f39c3e4a922086239e10852. Native Future+Send
is retained; no async-trait/dependency transition is implied by this revision.
Core owns all authority; runtime must not implement a substitute persistent store.

admit_run atomically creates the run and acknowledges the deep inbox. Its result
carries core-validated admission plus FreshCandidate, Replay or
ReconciliationRequired. FreshCandidate describes DB insertion only, never actual
provider delivery or permission to start. At most one concurrent inserting call
returns it; replay never returns it, including terminal replay or Execution purpose.

claim_provider_dispatch atomically reserves this attempt under a core-authorized
supervisor context. Caller-created structs cannot grant authority: validate against
bound context, durable identity/state, role, store clock, lease/fence and request
semantics. Same attempt has at most one reservation; replay cannot mint another.
A crash/lost response after reservation is quarantined, not reacquired on retry.
Without the reviewed supervisor handle and durable validation this method remains
Unavailable. Existing role/native readiness rules remain mandatory.

consume_provider_dispatch atomically checks that reservation and commits
DeliveryUnknown BEFORE any provider call. Only the unique CAS-winning invocation
returns DispatchNow. Repeated calls/lost ACK/restart require reconciliation, not
replay of DispatchNow. Keep any transaction short; provider I/O occurs outside it.
Cancellation/recovery fencing races must prevent consumption when they win first.
If consumption wins first, cancellation retains actual unknown in-flight status.
This cannot make DB commit and provider delivery atomic; it deliberately quarantines
the unavoidable gap, including a crash before the command was actually sent.
Provider Started is evidence, not retrospective permission to retry a start.
No automatic retry is authorized even after a local write error. A new attempt
requires explicit reconciliation/authorization, not another admission request key.

Runtime must validate returned owner/scope/session/authoritative role and Execution
purpose. Replay/ReconciliationRequired never start; FreshCandidate alone never
starts. Keep ALL high-level starts DispatchUnconfirmed until store enforcement and
independent acceptance tests exist. Workers have no admission path in this proposal.

The two dispatch methods default to Unavailable; SQLite admission retains its
Unavailable stub with only its return type changed. No dispatch rows/migration,
provider acknowledgement gate or durable implementation is supplied. No contracts,
HTTP fixtures, root manifests/lock, CI or dependencies change.

Required unexecuted acceptance: concurrent admission/reservation/consumption single
winner; changed-body conflict; replay of active/terminal run no start; forged role,
scope, supervisor incarnation and reservation refused; cancel-before-consume fenced;
consume-before-cancel unknown; lost ACK at each boundary; crashes before/after DB
commit and provider command; restart never automatically dispatches. Signature and
source review precede coordinator-owned lock work. No Cargo/downloads/tests run.
