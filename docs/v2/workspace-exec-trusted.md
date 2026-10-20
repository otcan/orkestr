# Trusted owner workspace commands

The restricted profile in `workspace-exec.md` cannot build, fetch or publish.
An operator may add an optional `trusted` object to the same
`workspace_exec` profile. It is still bound to exactly one owner, conversation
and project, still installed only from the root-managed beta config, and still
uses the same Core delegation, single consumption, spawn fence, revocation and
exactly-once result delivery. Nothing in it is reachable from HTTP, browser
fields or model arguments. Absent `trusted`, the restricted beta.3 profile keeps
its supervisor argv, limits, cgroup values and advertisement. Two small changes
apply to both: rendered results keep the first 1 KiB and last 2 KiB of a long
stream (build errors are at the end), and a command may not begin with the
reserved `#!orkestr-job ` line.

## What changes

| Setting | Restricted | Trusted (defaults) |
| --- | --- | --- |
| Root filesystem | immutable image | image, or host `/usr` + fixed `/etc` subset (`host_toolchain`) |
| Network | none (`--unshare-net`, socket syscalls refused) | `network: false`; when true, host network namespace and `socket`/`socketpair` allowed |
| Short command | 30 s, 128 KiB (over-limit fails) | `command_timeout_ms` ≤ 30 s, `command_output_bytes` ≤ 128 KiB, truncated head+tail |
| Background jobs | none | `max_jobs` 1 (≤ 4), `job_timeout_ms` 30 min (≤ 30 min) |
| cgroup per command | 2 GiB, 64 tasks, 2 CPUs | 8 GiB, 1024 tasks, 4 CPUs (configurable, bounded) |
| Toolchain / cache mounts | none | `toolchain_mounts` (read-only), `cache_mounts` (read-write) |
| Credentials, skills | none | `credential_mounts`, `credential_env_files`, `skill_mounts`: **empty by default** |
| Worker run budget | 5 min | `worker_run_ms` 30 min (≤ 60 min, owner budget can narrow) |

Mounts are bound at the same absolute path. Startup refuses any mount that
equals, contains or enters the Orkestr home, provider workspaces, the project,
the cgroup root, the command image, `/proc`, `/sys`, `/dev`, `/run`, `/boot` or
`/etc`, or that contains `/usr`, `/bin`, `/lib` or `/tmp`. The host root is
remounted read-only after mounts are created; only the project, caches and the
bounded `/tmp` and `$HOME` tmpfs are writable.

Credential env files are parsed (`KEY=VALUE`, optional `export`, quotes) at
every command start, so rotation applies to the next command and nothing is
cached in server memory. Their values reach the command through the process
environment only, never through any argv. Names that would alter the host-side
supervisor or fixed layout (`LD_*`, `PYTHON*`, `PATH`, `HOME`, ...) are refused.
A command that can read a credential can also print or send it when network is
enabled; enable credentials only for an owner who accepts that.

Commands keep: user/pid/ipc/uts/cgroup namespaces, `--disable-userns`, all
capabilities dropped, the sealed seccomp policy (mount, ptrace, io_uring, bpf,
keyring, module and namespace syscalls refused), a fresh job cgroup with
`cgroup.kill`, the outside subreaper and its reap witness.

## Host-privileged mode

`"host_privileged": true` (with instance-level `host_full_access`) replaces the
sandbox with direct host execution as the service user; see "Host full access"
in `workspace-exec.md`. It is equivalent to host root, and the mount and
credential rules below do not apply as boundaries in that mode.

## Long-running work: detached jobs

A Worker's run lease is about 30 seconds and is never renewed while a tool call
is pending, so no single call can block on a 20-minute build. The trusted tool
schema therefore accepts:

- `{command}`: short command, output returned directly.
- `{command, background: true}`: starts a job and returns `job=<uuid>`
  immediately.
- `{job, action: "wait" | "status" | "cancel"}`: `wait` blocks up to 20 seconds
  (inside the call's lease), then returns state, exit status and the last
  output. A finished job's exit status becomes the tool result's status.

Runtime turns these into one canonical source text (`#!orkestr-job ...` first
line, which a plain command can never use), so Core's audited delegation is the
only input to the operation. Jobs run with the same containment in their own
cgroup and slot pool, stream output into a bounded head+tail buffer, and are
recorded (state, command digest, exit, last 4 KiB) in a private
`workspace-jobs-<project>` directory under the server home.

A job ends on its timeout, explicit cancel, profile revocation (checked every
2 seconds, fail closed), or server exit: the supervisor carries a parent-death
signal and bwrap `--die-with-parent`, so the whole namespace dies with the
server. Records left `running` by a previous process become `lost`. Jobs
deliberately outlive the Worker run that started them, so a later Worker can
poll; Worker Stop does not cancel them.

## Supervisor compatibility

The trusted profile passes the computed bwrap argv and environment to the
supervisor through a sealed memfd (`ORKESTR_SUPERVISOR_LAYOUT_V1`). The helper
still accepts the restricted fixed argv unchanged. Startup refuses a trusted
profile whose image supervisor lacks the layout marker, so an image built with
the new helper is required before enabling it.

## Validation

Pure tests cover layout ordering, network/seccomp differences, credential
parsing, overlap refusal, canonical operations, job records and rendering.
Ignored real tests (`tests_trusted.rs`) run against a disposable delegated
cgroup and an image containing the new supervisor: host root without network
or credentials, network plus cache plus an explicit synthetic credential that
never appears in argv, truncation, job streaming, the job slot limit, and reap
after timeout.
