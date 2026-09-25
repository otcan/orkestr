# Reviewed SRE policies and qualification artifacts

These tools prepare or observe controls. No tool here installs a timer, changes
systemd configuration, starts a service, sends a message or modifies networking.
Use collector-private protected directories such as `/var/lib/example-audit`.
A root collector must not keep authoritative inputs below a user-owned home.
All real units, routes, operators, approvals and evidence references are private.

## Read-only internal signal collector

`internal_signals.py --policy <protected-json>` reads explicitly scoped source
routes/rules, link metadata, the three NordVPN unit mask/inactive states, memory,
swap, memory PSI, host task count, file handles and explicit per-unit task counts.
It never reads service environments, command lines, message bodies, credentials
or browser state. Each command has a deadline; errors become missing telemetry,
never a fabricated healthy zero. An intentional `tun0` or tailnet link is not
mistaken for the prohibited `nordlynx` interface.
Malformed route/rule/link record lists and empty or unnamed link inventories
are missing telemetry. A feed claiming healthy routing while reporting the
prohibited VPN present is rejected as inconsistent.

The private policy shape is:

```json
{
  "source_id": "example-core",
  "routes": [{
    "source": "192.0.2.2", "destination": "198.51.100.1",
    "gateway": "192.0.2.1", "device": "eth0", "table": 1001, "priority": 100
  }],
  "task_budgets": {"example.service": 200},
  "thresholds": {
    "memory_available_fraction": 0.1,
    "swap_used_fraction": 0.8,
    "memory_psi_avg10": 10,
    "file_used_fraction": 0.8,
    "host_tasks": 5000
  }
}
```

These are documentation values, not recommended host budgets. Include separate
IPv4 and IPv6 routes when both are exposed. Route lookup uses `ip route get` and
sends no packet. Policy checks require the exact physical gateway/device/table
and exact source-address rule/priority. They do not enumerate firewall state or
prove that all VPN firewall residue is absent. Independent external probing is
still required to test the public return path.

Table normalization recognizes numeric IDs and the built-in `main` (254),
`default` (253), and `local` (255) names. iproute2 omits the main table from a
normal unfiltered route-get record, so an omitted route table means 254 only;
it never matches an arbitrary reviewed table such as 1001. Missing rule tables,
explicit nulls and unknown administrator aliases are not guessed. This follows
the [iproute2 route printer](https://github.com/iproute2/iproute2/blob/main/ip/iproute.c),
which suppresses the main-table field unless detailed output is requested.

Collector stdout is minimized JSON including its canonical SHA-256 policy
digest. An approved authenticated transport must write it atomically into a
protected file on the independent monitoring node. Configure that exact source
and digest on `reachability.py`; never allow the monitored application to write
the file. A local root-writable file is not proof against compromised root, and
Unix mode checks do not constitute an ACL or remote authentication guarantee.
No feed transport or monitoring node is provisioned by this release.

## Compile a reviewed service profile

`hardening_plan.py --profile <protected-json> --baseline-report <protected-json>`
prints a JSON artifact containing the candidate drop-in, its SHA-256, a read-only
posture profile, required health checks and exact-path rollback condition. It
never installs the candidate. The target filename must be absent before the
reviewed installation; do not overwrite an existing operator drop-in.

The profile includes:

- `unit`, `owner`, `approved_by`, `change_ref`, `inventory_ref`, `review_until`
  (Unix timestamp): exact service identity and reviewed evidence references.
- `properties`: the explicit confinement set. Required boolean fields are
  `NoNewPrivileges`, `PrivateTmp`, `PrivateDevices`, `ProtectKernelTunables`,
  `ProtectKernelModules`, `ProtectControlGroups`, `RestrictSUIDSGID`, and
  `LockPersonality`. Other required fields are `User`, `Group`, `ProtectSystem`
  (`strict`), `ProtectHome` (`yes`, `read-only` or `tmpfs`), `UMask` (`0077`),
  `RestrictNamespaces`, `CapabilityBoundingSet`, `AmbientCapabilities`,
  `RestrictAddressFamilies`, and `ReadWritePaths`.
- Lists are explicit arrays. Empty capability lists remove all capabilities.
  Ambient capabilities must be within the bounding set; each bounding capability
  needs a corresponding `capability_reasons` inventory reference. Address
  families are explicitly selected from UNIX, INET, INET6 and NETLINK. Writable
  paths must be narrow absolute literals, without systemd expansion or traversal.
- `root_exception` and `property_exceptions`: each exception has `owner`,
  `change_ref`, `reason_ref` and `review_until`. Root identity and disabled
  baseline confinement require an unexpired exception. A browser's necessary
  namespace list (for example `user`, `pid`, `net`) requires an explicit
  `RestrictNamespaces` exception. Do not disable browser sandboxing to make an
  overly restrictive systemd profile pass.
- `persistence_paths`: reviewed unit/drop-in/executable paths. `health_checks`:
  identifiers covering service health, routing, connectors, workers and other
  dependencies appropriate to that service.
- `task_budget`: `max`, `headroom_fraction` (at least 0.25) and `basis_ref`.
  `restart`: integer `delay_seconds` (at least 5), `interval_seconds` and `burst`
  (1–10). These are per-unit values; no host-global task ceiling is generated.

The baseline must match the unit, have no failed observations, cover startup,
normal, peak and recovery with at least three valid samples per phase, and span
at least five minutes. The selected task limit must exceed the sampled peak by
the explicitly reviewed headroom. These minimum mechanical checks do not prove
representative workload coverage; the approving operator must review workload,
browser/process peaks, gaps, sustained pressure and recovery behavior.

Additive systemd lists are reset before exact reviewed values are written.
The generated posture profile normalizes capability case, set ordering and
systemd duration output; its expiry includes the earliest exception expiry.
Operator references are declarations in protected configuration, not signatures
or evidence of consent supplied by this tool. Profile compilation does not
verify that a new Unix identity already exists or can read application data.

Stage one service at a time in an isolated environment with equivalent runtime
dependencies. Verify the generated unit with `systemd-analyze verify`, then test
real worker, connector, browser, routing and recovery behavior. Only after that
review may it be installed during the separately approved maintenance window.

Rollback compares the current bytes of the exact new drop-in with
`rollback.only_remove_if_sha256`. If they differ, stop and reconcile the operator
change. If they match, remove only that new drop-in, preserve all other unit
settings, then perform the approved daemon reload/service restart and health
checks. The compiler never executes this rollback. Unit removal/restart must not
occur during a protected observation window.

## Dependency exceptions and uninterrupted windows

`qualification_window.check_dependency(actual, policy, now)` compares an exact
unit's active/enabled state and exact Funnel route identifiers with an unexpired
owned exception. The input comes from an approved status wrapper. Unknown or
extra public exposure fails the check. A necessary mail-ingestion service and
its approved pubsub route are preserved: neither stopping the service nor
emptying Funnel is treated as an automatic remediation. An exception still
requires the accountable owner's review; this function cannot grant one.

`qualification_window.py --policy <protected-json> --state-directory <private-dir>
--sample <protected-json>` records a fresh minimized observation and prints the
current report. Omit `--sample` for a report only. A policy contains `window_id`,
`owner`, `change_ref`, `duration_seconds` (at least 86400), `max_gap_seconds`
(10–300), and an exact list of `checks` identifiers. Every observation includes:

- `observed_at`, `release_id`, `boot_id` (32 hexadecimal characters), and a
  monotonically maintained `service_generation` from the trusted cycle collector.
- `checks`: literal booleans for exactly the configured checks.
- `evidence_refs`: one retained evidence identifier for each check.

The trusted collector must derive checks from bounded live observations, not
operator-entered guesses. Include transport listener/health, live readiness,
disk below the reviewed threshold, no new exact-route failures, service-cycle
attribution, owner-visible alert receipt, and current dependency exceptions.
Do not use synthetic customer messages or replay dead letters to produce a pass.

Tenant route configuration responses report `forwardingReady: false` and
`targetReachability: not_checked` until a health-checked route listing establishes
reachability. Configured endpoint/token presence alone is not readiness evidence.
This status correction does not send customer traffic or establish delivery.

Any failed check, release/boot/service-cycle change or excessive sampling gap
resets the clean span; previous observations and break reasons remain queryable.
The recorder can restart without losing evidence. A stale last observation
cannot pass even if the prior span reached 24 hours. Capacity exhaustion stops
collection rather than deleting evidence. A report's `complete` means the
configured trusted observations satisfy the window policy; operator review must
still establish collector coverage and the underlying acceptance criteria.

Schedule this window after the release and approved hardening. Do not count
time spent implementing, deploying, rebooting or repairing as uninterrupted
qualification. A maintenance exception interrupts the window and starts a new
clean span after successful checks; it never erases the earlier break.

## Public-route reboot qualification

Before the separate approved reboot, retain current package/pin/mask state,
physical IPv4/IPv6 source routes, intended tunnel/tailnet/Docker health, and the
guard's successful result. Retain SSH and HTTPS results from two independently
approved external networks, with vantage identities, timestamps and boot ID.
Repeat after the changed boot ID and verify the same routing/masks plus normal
service and mail-ingestion readiness. An intentionally denied vantage must stay
denied; do not change firewall policy to make that source pass.

Controlled route-failure injection belongs in an isolated equivalent setup or
the explicitly approved maintenance procedure, with console access and a
reviewed private backup. Verify the owner alert's exact broker delivery receipt
while public replies are unavailable, then verify recovery. A host-local HTTP
success, a retained timer definition or a simulated test does not prove reboot,
dual-vantage public availability or external alert delivery.
