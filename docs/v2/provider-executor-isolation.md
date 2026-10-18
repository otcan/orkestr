# Provider executor OS separation proposal

Environment filtering and disabled provider tools do not isolate same-UID file
or process access. The trusted subscription connector holds account access and
must stay separate from untrusted worker execution. The existing offline worker
sandbox is independently owned; this proposal does not replace or modify it.

A future opt-in trusted launcher should create private mount, PID, IPC and UTS
namespaces without changing the managed service UID or V1 runtime. Mount only
the pinned native executable/runtime dependencies, server-selected account
access needed by the trusted connector, and that newly owned session's writable
state. Use a private proc view, private temporary storage and no host home,
project checkout, V1 process namespace or unrelated account mounts. Inherited FDs
are only the fixed stdio and one private writer-handoff socket. Do not mount the
broker's credential locations into a worker sandbox.

The trusted connector needs provider network access; an untrusted worker does
not. An enforceable network policy needs a server-owned namespace/egress proxy
with explicit provider endpoints and controlled DNS, not a caller hostname
allowlist or environment proxy variable. Filesystem and process isolation should
first be tested with synthetic credential sentinels, foreign PID probes and
owned cleanup. Do not claim full containment while host networking or same-UID
host proc/files remain reachable.

Activation requires root-owned immutable launcher/config review and an explicit
opt-in new-child route. No changes to global services, production launchers,
managed account state, UID mapping or V1 are part of this proposal. The current
broker remains trusted host code; actual OS separation is open. Runtime owns the
spawn integration; the root sandbox owner owns worker namespace implementation.

## Executable opt-in checkpoint

`v2/provider-broker/isolation` implements `ProviderSandbox` and `OwnedProvider`.
It runs under the existing service UID, creates private user/mount/PID/network/
IPC/UTS/cgroup namespaces, disables further user namespaces, drops capabilities,
sets no-new-privileges through bubblewrap's seccomp path, and clears environment
and inherited descriptors. Only pinned root-owned runtime executable/library
paths are mounted. Host account/home/project paths are absent; account, workspace
and temporary storage are fresh bounded tmpfs mounts. A private proc mount shows
only that namespace. Runtime mounts and the namespace root are read-only.

The sealed x86-64 seccomp program rejects sockets, fork/vfork, namespace/mount,
ptrace/process-memory/pidfd access and dangerous kernel APIs. Classic clone is
allowed only with VM/SIGHAND/THREAD bits; clone3 reports ENOSYS for libc fallback.
This permits native runtime threads without independent child processes. Fixed
root-owned prlimit imposes three CPU seconds, 1 GiB virtual address space, 8 MiB
file size, 64 descriptors and zero core dump size. These bounds are deliberately
small for the initial offline profile, not claims of native inference sizing.

`start_python(source)` exercises an owned synthetic stdio provider.
`start_codex_offline(root_owned_native)` and
`start_claude_offline(root_owned_native, generated_uuid)` prepare fixed native
options under the same isolation; there is no arbitrary argv, mount, account,
environment, inherited FD or network override. These methods are trusted server
APIs, not HTTP/client operations and not Core inference authority. `exchange`
is a bounded synthetic I/O helper, explicitly not a fenced inference pump. A
production adapter must keep each actual provider write inside the exact Core
purpose fence; never place a blocking exchange inside SQLite.

Actual subprocess tests run as the current managed UID and prove synthetic
broker input/output works, canonical-account/project sentinels remain unreadable
and unchanged, sibling proc environ/FD/root paths and inherited sentinel FD are
unavailable, host environment is absent, socket/fork fail, threads work, and
private workspace writes do not reach host projects. Timeout, cancellation and
output-limit paths kill and reap only owned children. Service-writable native
executables refuse before launch. No root provisioning was needed on the test
host; missing namespace/seccomp/runtime support must fail, with no host fallback.

This is an offline executable boundary, not activation of the authenticated
connector. No real provider was started. Network egress/auth mediation and a
persistent session-only state mount are still required for authenticated native
inference/resume. Canonical auth must remain outside this profile. Exposing a
whole account directory, host HOME, inherited token or host network to make the
CLI work would weaken the implemented boundary and requires a separately
reviewed designated broker authority. Root owns that provisioning. Existing V1
units, launchers and UID mapping are unchanged; the existing offline worker-tool
sandbox remains independently owned and distinct.
