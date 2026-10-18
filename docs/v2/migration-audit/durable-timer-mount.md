# Ordinary durable timer mount

This branch composes the schema-33 timer ledger and current-auth scheduler issuer
with the ordinary native server. Imported schedules remain paused. Owner enable
persists fresh instructions, exact provenance, generation and Stop watermark;
no browser or machine credential is stored in the timer ledger.

The owner HTTP routes and strict request shapes are unchanged from the timer
leaf. Enable retry returns the original transition outcome without creating a
new authority. Current detail reports `controller_armed` only when the joined
controller is available and the current durable grant matches the timer and Stop
watermark. `scheduler_unavailable` and `durable_owner_enable_required` are holds,
not instructions to replay an old Enable request.

The trusted server may select `ORKESTR_V2_TIMER_CONFIG`, a private, canonical,
owner-owned mode-0600 JSON file with exactly `schema_version: 1` and
`machine_token_file`. The latter names a separate private mode-0600 machine
credential file. No HTTP client supplies supervisor identity, clock or issuer.
The reserved timer supervisor cannot publish provider readiness. It renews its
still-current service session hourly, bounded to twelve hours per renewal;
revoked/expired credentials cannot be resurrected. An operator must provision
fresh authorization if downtime exceeds session expiry. See
[the Core lifecycle contract](../timer-supervisor-lifecycle.md).

SIGINT and SIGTERM stop HTTP admission and join scheduler/execution cleanup.
Graceful scheduler shutdown retires its exact supervisor incarnation. A killed
process leaves its live lease in place: successor bootstrap refuses until the
real lease deadline, then creates a fresh issuer context. This deliberate crash
recovery delay does not duplicate committed timer occurrences.

Canonical Store dependencies are Core `941c76ec860d9b1560eeec9231abe3059048bcc2`
(schema 32/33 and source matching) plus the narrow timer lifecycle slice
`b9aa92349429ab613badc3dc404d9672217e86ec`. Coordinator base is
`25b3bbb463bd1e71f7c9f2f8eb72e43348b64b4d`. Manifests and lockfile are unchanged.
Prior migrations are retained, not replaced.

## Verification boundary

The executable process oracle is `v2/tests/timer_lifecycle_http.py`, invoked by
`v2/apps/server/tests/timer_lifecycle.rs`. It uses fresh synthetic SQLite state,
actual cookie/Origin/CSRF HTTP and real elapsed time. It checks creator logout,
once admission, disabled occurrence exclusion, clean restart, stale Enable
replay, immutable authority rows across SIGKILL/re-exec, and machine revocation.
No provider is configured; pending ordinary input is not evidence of provider
execution. Weekly restart continuity is checked without waiting one week.

The first mounted process run at `3b09585cf` failed at restart because the then
available generic First bootstrap refused its persisted predecessor. Its
pre-restart assertions passed; that failure is preserved in private evidence.
Later source uses Core's explicit timer-only lifecycle instead. Final exact
source/binary test receipts are kept separately; this document does not transfer
Core-only test results into mounted-process qualification.

Unexecuted: real multi-day/week elapsed runtime, production migration, real
provider dispatch, installation qualification, browser-rendered UI acceptance,
and external connector parity. Independent review and same-source package
qualification remain required before release.
