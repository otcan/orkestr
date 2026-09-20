# Service-control and independent monitoring foundations

These are operator tools, not an automatically activated production policy.
They do not install units, change limits, stop processes, send alerts, or modify
the existing service-control watcher as part of a normal application release.
Python 3 with its standard SQLite library is required. All host names, unit
allowlists, paths, recipients and identities belong in private operator config.

## Exact attribution and durable obligations

`scripts/sre/service_control.py` is an explicitly invoked system-bus controller.
It requires root, `--apply`, a change reference and a protected private policy
containing `units` and `stateDirectory`. Policy files and ancestors must be
root-owned, not group/world writable, and not symlinks. No shell is used.
It durably records an intent before invoking a bounded systemd D-Bus call and
records the exact returned job ID afterward. Acceptance of a job is not service
health. A timeout or missing job receipt stays uncertain and is never retried
automatically. An unresolved intent after a process crash needs investigation.

`scripts/sre/service_watch.py` collects only PID-1 systemd metadata for explicit
units. Each batch is bounded to the first 1,000 records, with a ten-second
deadline and a 64-KiB record bound. Its journal cursor and pending alert records
commit in one SQLite transaction. Cursor loss/read errors fail closed; they
never silently skip to the latest record. Initial history defaults to ten
minutes; `--bootstrap-lookback-seconds` allows a reviewed interval up to one day.

```sh
python3 scripts/sre/service_watch.py \
  --state-directory /var/lib/example-service-audit \
  --unit example-api.service --unit example-proxy.service
```

Only a unique exact boot/job/unit/action receipt is attribution. Nearby
timestamps, deployment timestamps, free-text reasons and application-authored
journal records are not. Delayed receipts are reassessed on subsequent polls.
The database contains no journal MESSAGE, command arguments or environments.
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
cursor failures and pending age. An acknowledged off-host export/pruning
workflow remains required before sustained production use.

## Independent reachability

`scripts/sre/reachability.py` probes TCP/22 and HTTPS concurrently in deadline-
bounded child processes, including DNS resolution. It sends no credentials,
follows no redirects and verifies HTTPS certificates. Three consecutive failed
observations create an incident; two healthy observations create recovery.
Transitions and pending alerts persist together through restart. The same
receipt-bound spool is reused; a separate state directory is mandatory.

```sh
python3 scripts/sre/reachability.py \
  --ssh-host core.example.invalid --https-url https://app.example.invalid/ \
  --probe-id independent-example --state-directory /var/lib/example-reachability
```

Run it from an explicitly approved independent node, normally every minute.
Do not call an internal tunnel a public-path test. A failed port pair does not
prove power loss. The classification helper distinguishes a *fresh, trusted*
internal route/pressure signal, but the CLI does not yet ingest those signals.
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

Do not derive hard task limits from one idle snapshot. Measure representative
load, startup, browser processes and recovery peaks; reserve headroom; test each
candidate cgroup ceiling/backoff in isolation. Inventory writable paths/devices
and privileged helpers before changing runtime users, mount protections or
capabilities. Roll out one service at a time in an approved maintenance window,
with health/routing/connector checks and rollback of only the new drop-in.

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
