# Host resource health

Authenticated `GET /api/v2/resources` returns `HostResourceHealth` schema 1.
The current setup has a single administrator; retain operator-only authorization
if additional tenants are introduced. Browser cookies and machine credentials use
the existing separate authentication paths. Responses use `Cache-Control: no-store`.

The scope is **host**, as visible through the server's Linux proc filesystem.
These values describe aggregate CPU time and RAM, not a run's resource budget or
the server process. A container may see host aggregates; never label this response
as container usage or combine it with per-run `ExecutionResources`.

Sampling is cached for one second, bounded and performed off the async request
workers. The first successful sample supplies RAM while CPU is `warming_up`.
A subsequent sample calculates busy CPU from counter deltas over 1–10 seconds.
Idle and I/O wait are excluded from busy time; guest time is not counted twice.
Backwards counters, a gap over ten seconds, or an unreadable sample reset the CPU
baseline. Unsupported platforms and failed reads return `unavailable` with no
old measurements carried forward. A missing measurement never means zero usage.

RAM uses `MemTotal - MemAvailable`, including the kernel's estimate of reclaimable
memory. It does not use `MemFree` or sum process memory. Counter definitions follow
the [Linux proc documentation](https://docs.kernel.org/filesystems/proc.html).

`instance_id` changes at server restart; `sample_sequence` increases on sampling
attempts. Cached reads retain both sequence and observation timestamp. UI consumers
must not refresh measurement age when the same sample is replayed, must use a
monotonic local clock for age, and must clear observations when authentication is
lost. Render unavailable/warming states explicitly, with the host label visible.

Validation commands:

```sh
cargo test --locked --offline -p orkestr-v2-server --lib resource_health
cargo test --locked --offline -p orkestr-v2-server --test resource_health
```

The HTTP test starts and cleans up its own server with synthetic credentials and
fresh state. It covers authenticated browser/machine access, revocation, Origin
refusal, ten concurrent cache reads and real Linux observations. It is a backend
checkpoint; browser screen wiring and candidate performance remain separate gates.
