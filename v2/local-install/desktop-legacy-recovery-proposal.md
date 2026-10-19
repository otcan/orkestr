# Legacy lease history recovery proposal

Status: design for independent review; no validator exception or live adoption
implemented. Expiry does not establish writer quiescence or authorize migration.
The existing offline restore helper intentionally refuses duplicate versions and
requires an old embedded lock identity; it cannot recover pre-gate legacy state.

## Proposed narrow format

Keep every historical record, ID, version, token and unknown field. Do not
renumber historical versions. A separate, explicit offline legacy preparation
mode would require the operator's exact source SHA256 and confirmation that all
writers have been fenced. It must refuse a source with an embedded lock identity;
that state belongs to the existing recovery protocol instead.

Preparation validates every existing structural rule except historical version
uniqueness, computes the maximum of the retained counter and every version, and
refuses safe-integer exhaustion. It revokes every unreleased record, regardless
of expiry. Existing released records stay identical. Original bytes remain in
private immutable evidence, alongside an explicit revocation diff and digests.
There is no live-source write and no automatic activation.

The proposed output additionally identifies a sealed retired cohort by exact
record IDs and a deterministic digest of its complete post-revocation JSON
records, including unknown fields, plus a generation floor. Canonicalization must
have a specified cross-language encoding and reject ambiguous/nonfinite JSON;
using an ad hoc Python/JavaScript serialization digest is insufficient. A trusted
operator adoption receipt binds the original bytes, retired cohort, floor and
prepared output. A marker in untrusted state alone must not enable this mode.

A reviewed validator extension would permit repeated versions ONLY inside this
exact digest-bound, entirely released, immutable cohort. All other structural
checks still apply. Cohort removal, mutation, unrelease, duplicate IDs, additions,
version changes and marker mismatch fail closed. New records must have globally
unique versions strictly above the floor; ordinary stores retain the existing
strict validator without this explicit adoption contract. The initial new
counter is strictly above every old version and the old counter, with the next
acquisition newer again. Counter regression and exhaustion remain refusals.

Action validation must reject every retired ID independently of timestamps,
including old exact bindings. Heartbeat, same-thread acquire and release must
never revive or modify the cohort. Existing released history remains readable.
This requires coordinated browser-store leaf validation and mutation changes;
Installation will not silently change those shared files or enable a generic
allow-duplicates switch.

## Required disposable qualification

- Exact original evidence and unrelated fields survive preparation; all old
  records remain present, versions unchanged, all unreleased records revoked.
- Duplicate new versions, duplicate IDs, altered or added retired records,
  cohort unrelease, marker forgery/mismatch and counter rollback refuse.
- Every old binding refuses action; heartbeat cannot revive a retired record;
  same-thread acquire creates fresh ID/token/version above the floor.
- Fresh adoption, reopen, next acquisition and backup/restore retain the cohort
  and its strict boundary; copied initialized lock evidence refuses rebind.
- No-source-identity, wrong digest, nonfinite/duplicate JSON, integer exhaustion,
  symlink/FIFO, source replacement, interruption and uncertain publication refuse
  with exact original preserved. Existing target is never overwritten.

## Writer and rollout boundary

Inventory must cover both deployed processes and source versions actually loaded
by each, not merely the current release symlink. The HTTP server, CLI-to-HTTP
writers, direct connector/runtime imports and diagnostics can target the same
file. A legacy normalize/write path drops unknown top-level fields; therefore an
old writer can erase a cohort marker. A new lock cannot fence an old mkdir-lock
writer. Every such writer must be drained/fenced before adoption.

Current server shutdown still calls stopCodexAppServerClients and
stopCodexJobClients. Owned stdio clients can be terminated by that shutdown;
external daemon clients lose their local transport. A restart is not a proven
session-preserving drain. The proposed Installation in-process lifecycle port is
not registered in deployed writers. Safe PID/start/unit/cwd metadata narrows the
inventory but does not prove which module is loaded, absence of future direct
writers, or executor preservation. Until those gaps are explicitly resolved,
keep the failing lease API visible and browser activation held. Browser process
health does not establish lease authority.

## Offline publication checkpoint

`desktop_legacy_io.py::prepare_bundle` provides the bounded nofollow source read,
exact original evidence, fresh-target atomic publication and interruption/unknown
publication handling. It requires a trusted reviewed `seal(raw, source_digest)`
callable returning `(prepared_state_bytes, external_adoption_receipt_bytes)`.
Neither callable selection nor receipt trust comes from the input state. It has
no command-line activation path and no permissive cohort implementation.

The public validator owner must supply the shared canonical cohort/receipt
contract and sealer before an operator-facing legacy preparation command is
wired. Current transport tests use an explicitly synthetic sealer; they do not
qualify retired-cohort validation, revocation or live adoption. Source evidence
with an embedded lock identity is refused rather than routed through this legacy
path. The existing nonlegacy `desktop_restore.py` behavior remains unchanged.
