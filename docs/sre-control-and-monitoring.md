# Service-control and independent monitoring foundations

These are operator tools, not an automatically activated production policy.
They do not install units, change limits, stop processes, send alerts, or modify
the existing service-control watcher as part of a normal application release.
Python 3 with its standard SQLite library is required. All host names, unit
allowlists, paths, recipients and identities belong in private operator config.

## Exact attribution and durable obligations

`scripts/sre/service_control.py` is an explicitly invoked system-bus controller.
It requires root, `--apply`, a change reference, stable `--operation-id` and a protected private policy
containing `units` and `stateDirectory`. Policy files and ancestors must be
root-owned, not group/world writable, and not symlinks. No shell is used.
It durably records an intent before invoking a bounded systemd D-Bus call and
records the exact returned job ID afterward. Acceptance of a job is not service
health. A timeout or missing job receipt stays uncertain and is never retried
automatically. An unresolved intent after a process crash needs investigation.
The operation identity is durably bound to the UID, boot, unit, action and change
reference before any bus call. Retrying that identity only reads its recorded
outcome; it does not issue a second action, including while the first controller
is running or its result is uncertain. Rebinding an identity is refused. Do not
invent a fresh operation ID to bypass uncertainty; reconcile the original first.
At the control ledger's capacity, new actions are blocked before invocation.

`scripts/sre/service_watch.py` collects only PID-1 systemd metadata for explicit
units. Each batch is bounded to the first 1,000 records, with a ten-second
deadline and a 64-KiB record bound. Its journal cursor and pending alert records
commit in one SQLite transaction. Cursor loss/read errors fail closed; they
never silently skip to the latest record. Initial history defaults to ten
minutes; `--bootstrap-lookback-seconds` allows a reviewed interval up to one day.
The watched-unit set is durably bound to its cursor; changing scope requires a
new reviewed state directory. A known action without a job ID remains
unattributed instead of being silently discarded.

```sh
python3 scripts/sre/service_watch.py \
  --state-directory /var/lib/example-service-audit \
  --unit example-api.service --unit example-proxy.service
```

Only a unique exact boot/job/unit/action receipt is attribution. Nearby
timestamps, deployment timestamps, free-text reasons and application-authored
journal records are not. Delayed receipts are reassessed on subsequent polls.
The database contains no journal MESSAGE, command arguments or environments.
The private directory and every ancestor must be owned by root or the collector
and not writable by another identity. Symlink ancestors are rejected; root-owned
sticky ancestors such as `/tmp` are allowed. A root collector must not place
evidence beneath an unprivileged user's home. Existing database hard links and
unsafe SQLite WAL/SHM/journal sidecars are rejected before SQLite opens them.
These are Unix-mode checks, not an ACL or compromised-collector defense.
The controller records its numeric UID; binding an originating authenticated
operator/session and change approval is still an integration requirement, not
something the wrapper infers from spoofable environment variables.

The shared `AuditStore.dispatch` adapter contract requires stable event IDs
as broker idempotency keys. Only a matching `delivered` receipt with a receipt
ID completes an alert. Exit zero, `sent`, timeout and unknown acknowledgement
remain pending. Attempts commit before I/O and retry with bounded backoff.
The broker must independently enforce idempotency and recipient authorization;
the local spool alone cannot guarantee exactly-once external delivery after a
crash. An approved adapter must bound each call to less than the claim delay.
The provided watcher CLI deliberately has no live dispatch adapter.

Use a root/protected collector identity and export minimized evidence to a
separately controlled sink. Local root-writable SQLite is not tamper-proof
against a compromised root service. Retention stops collection at 10,000
records rather than silently deleting unresolved evidence; alarm on capacity,
cursor failures and pending age. `evidence_archive.Archive` now provides the
receipt-bound export and explicit pruning workflow below. An approved independent
sink adapter and verified off-host retention remain activation requirements.

## Independent reachability

`scripts/sre/reachability.py` probes TCP/22 and HTTPS concurrently in deadline-
bounded child processes, including DNS resolution. It sends no credentials,
follows no redirects and verifies HTTPS certificates. Three consecutive failed
observations create an incident; two healthy observations create recovery.
Transitions and pending alerts persist together through restart. The same
receipt-bound spool is reused; a separate state directory is mandatory.
Consecutive failures count across changing failure classes, so alternating
SSH/HTTPS outages cannot indefinitely suppress the initial incident. Changing
an already-active incident's classification still requires a stable failure
streak. Gaps over 180 seconds reset evidence streaks without recovering an active
incident. Recovery therefore requires two fresh consecutive healthy samples.
The exact targets and threshold/gap policy are durably bound before probing;
changing them requires a new reviewed probe identity. Existing unbound legacy
state is refused, not silently reassigned. Reconcile any existing pending
incidents before replacing identities; monitoring its own scheduling gaps still
requires the independent supervisor/dead-man check.

```sh
python3 scripts/sre/reachability.py \
  --ssh-host core.example.invalid --https-url https://app.example.invalid/ \
  --probe-id independent-example --state-directory /var/lib/example-reachability
```

Run it from an explicitly approved independent node, normally every minute.
Do not call an internal tunnel a public-path test. A failed port pair does not
prove power loss. The classification helper distinguishes a *fresh, trusted*
internal route/pressure signal. The CLI accepts `--internal-signal`,
`--signal-source` and `--signal-policy-digest` together, from a protected file
delivered by an approved authenticated collector. The source/policy binding is
durable; it cannot be changed under the same probe identity. Bad ownership,
symlinks, hardlinks, writable files, oversized data, expired samples and source
drift are rejected. Public probing continues when internal telemetry is missing,
and the invocation reports failure so the supervisor can detect the feed outage.
Configured telemetry loss becomes `internal_signal_unavailable` when public
probes succeed; it cannot falsely recover an existing internal-pressure incident.
Fresh resource pressure or route drift is classified even while both public
probes succeed, permitting early warning before loss of availability.
HTTP failure remains `https_unreachable`, not a guessed application root cause.
The node, cadence, idempotent alert adapter, destination, signed/internal health
feed, evidence retention and isolated failure drill must be qualified before
claiming external monitoring active. No firewall exception is added by this tool.

## Service posture and task pressure

`scripts/sre/systemd_posture.py --profiles <private-json>` reads only allowlisted
systemd properties and reviewed persistence-path ownership/modes. It never reads
Environment, ExecStart arguments, credentials or application data. Profiles
contain `unit`, `properties`, reviewed `paths`, an optional documented
`rootException`, and a `taskBudget` with `max`, `warningFraction` and `basis`.
Missing budgets and persistence inventories are failures, not implicit passes.
Unix ownership/mode checks are not an ACL or root-compromise guarantee.

`scripts/sre/task_baseline.py` records one bounded, metadata-only observation per
invocation for up to 32 explicitly scoped units. Use a separate private state
directory and `--phase normal|startup|peak|recovery`; omit phase for a report.
The service scope is bound to the durable evidence window. Reports show sampled
peak/p95, failed observations, gaps and missing workload phases. They never
recommend or apply a limit. Samples are not continuous peak tracking, and operator
phase labels do not prove representative load. Read failures remain missing
evidence rather than zero usage. At 10,000 observations collection stops without
deleting evidence. No timer, restart, alert, load generator or limit is installed.

```sh
python3 scripts/sre/task_baseline.py --state-directory /var/lib/example-task-baseline --unit example-api.service --phase normal
```

Do not derive hard task limits from one idle snapshot. Measure representative
load, startup, browser processes and recovery peaks; reserve headroom; test each
candidate cgroup ceiling/backoff in isolation. Inventory writable paths/devices
and privileged helpers before changing runtime users, mount protections or
capabilities. Roll out one service at a time in an approved maintenance window,
with health/routing/connector checks and rollback of only the new drop-in.

## Export and retention

`evidence_archive.Archive(store, sink_id, retention_seconds)` binds an explicit
sink identity and at least one day of local retention to the ledger. `prepare`
durably snapshots a bounded batch before I/O, including unresolved incidents.
Changed versions are selected fairly so old pending obligations cannot starve
new evidence. `deliver(bundle_id, sink)` retries the exact digest and bytes after
receipt loss. The authenticated sink must return the matching `bundle_id`,
`sink_id`, literal `immutable: true`, `state: retained`, `receipt_id`, and
`retained_until`. The sink must independently enforce the claimed retention and
idempotency; untrusted JSON alone proves neither.

Only explicit `prune(bundle_id, now)` removes local rows. It requires an
unexpired receipt and exact unchanged row content; it retains recent rows and
unresolved alerts. Tombstones prevent replayed journal records from recreating
pruned events. Control operation identities, monitor sequences, export receipts
and journal cursor are retained. Rollback/crash during deletion rolls back the
tombstone and row mutation together. Pending-age/queue-capacity alerts remain
necessary: exporting an unresolved alert does not settle it.

Pruning recent or unresolved rows finalizes the batch without deleting those
rows. Changed rows and settled rows reaching their retention age become eligible
for a new export. The compact receipt/tombstone indexes grow with history; they
are intentionally not silently vacuumed or truncated. Expired sink receipts
block pruning and require operator reconciliation. Baseline/qualification
stores and control-operation ledgers are not pruned by this event-only workflow.
No host sink, transport credential, recipient or direct-mail fallback is included.

## Reviewed rollout and observation artifacts

See [reviewed profiles and qualification](sre-policy-and-qualification.md) for
the internal collector policy, hardening compiler, exact rollback artifacts,
Gmail dependency exception checks and durable clean-window recorder. Generated
artifacts require operator review and isolated compatibility testing before
the separate staged maintenance activation.

## Qualification

Run `python3 -m unittest discover -s test -p 'sre_*_test.py'` or
`node --test test/sre-operations.test.js`. Tests use temporary private databases
and mocked process/transport boundaries: they perform no real control or send.
They cover exact attribution, late/ambiguous evidence, atomic cursor/queue state,
crash and receipt loss, duplicate claims, mode/symlink rejection, scoped control,
task-budget drift, probe hysteresis and restart-safe incident transitions.

Before activation: approve the independent node/recipient and maintenance
window; integrate every authorized control path and broker receipt adapter;
qualify operator identity and off-host evidence; run an isolated delivery/failure
drill; then complete the protected observation window. Do not mark the operating
controls complete merely because these local tests pass.
