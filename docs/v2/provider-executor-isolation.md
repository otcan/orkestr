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
