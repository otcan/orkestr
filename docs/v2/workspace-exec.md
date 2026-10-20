# Worker workspace commands

This optional beta.3 profile lets explicitly configured Workers edit a project
and run shell commands through `orkestr_workspace_exec`. It uses the existing
Deep/Fast/Worker structure. Deep and Fast keep their current read-only provider
profiles. Unconfigured conversations have no workspace command tool.

The trusted operator profile selects one conversation, project installation,
protected-root list, immutable command image and delegated cgroup subtree. None
of those paths or permissions comes from browser fields or model arguments.
The tool accepts exactly one bounded `command` string; cwd is always
`/workspace`, with fixed environment and no network access.

Core persists an explicit workspace-execution opt-in, separate from both
provider dispatch and offline Python. A read-only workspace grant alone cannot
launch a command. Every delegation and consumed launch retains the exact Worker,
owner, conversation, incarnation, project generation and native call identity.
The spawn callback receives the same retained directory descriptor after
current-authentication and filesystem-identity checks. Uncertain consumption or
spawn never grants an automatic retry.

The authenticated provider remains in its existing namespace. A separate
command-only namespace mounts the immutable tool image read-only and the
selected workspace read-write. Provider accounts, credential homes and cgroup
control files are absent from that namespace. The initial deployment uses a
full checkout whose Git metadata is inside the selected workspace; external
Git-common directories are not mounted.

Each command has a finite timeout capped at its consumed lease and 30 seconds,
128 KiB output, 2 GiB memory, 64 processes, no swap, and at most two CPUs. A
separate fixed subreaper retains original wait ownership. Cancellation, timeout
and abandonment retain capacity until original-child and descendant cleanup are
proven. The existing window budget and owner task budget remain aggregate
limits; starting a command does not renew them.

Command output has its own persisted result and one-use native delivery fence.
It does not become an assistant proposal, owner acceptance, or WhatsApp send.
A failed shell command returns a failed tool result; it cannot fabricate a
successful Worker completion.

Initial composition registers and binds the project before native readiness for
all three roles. Restart uses the exact retired workspace handoff. Fast's Lost
companion can rebind only inside the transaction proving its closed predecessor;
the ordinary workspace binder does not accept arbitrary Lost sessions.

Validation includes Core scope/revocation/replay tests, schema-44 copy-first
upgrade preservation, and companion restart checks. Physical command isolation,
descendant cleanup and real provider tool use require separate qualification;
passing Core tests alone is not evidence of an operational coding Worker.

The optional trusted owner profile (toolchains, network, detached jobs,
explicit credential allowlists) is described in `workspace-exec-trusted.md`.

## Several conversations

`workspace_exec` names one conversation and project. Further conversations are
listed in `additional_workspace_exec` (up to 8), each with the same closed
fields: its own `conversation_id`, `project_id` and `workspace` (a Git checkout
owned by the service user), its protected roots, cgroup root and image. Profiles
never share a conversation or project and no workspace contains another. All
profiles are of one kind, trusted or restricted, because every Worker broker
advertises one tool schema. A conversation without a profile keeps the
read-only Worker profile. Detached job records stay per project
(`workspace-jobs-<project>`). Profiles may share the job cgroup root: one server
only reclaims job cgroups of a previous process.

## Host full access (operator opt-in, equivalent to host root)

An operator may opt an instance into V1-equivalent "full access". It is off by
default and only settable in the root-managed beta config, never from HTTP,
browser or model input. **When enabled it is equivalent to giving the model
host root** (the service user has passwordless sudo on typical hosts). Mount
lists, credential allowlists and path exclusions are **not a security
boundary** in this mode: everything the service user can reach is reachable.

Instance level, every conversation served by the instance:

```json
"host_full_access": {
  "providers": true,
  "environment": {"HOME": "/home/<service-user>", "PATH": "/usr/local/bin:/usr/bin:/bin"}
}
```

- Codex Deep, Fast and Worker sessions start with sandbox
  `danger-full-access` and approval `never`, and the pinned native runs
  directly on the host (`env -i` with exactly `environment`, cwd = role
  workspace): no provider namespace, seccomp filter, egress proxy or account
  mounts. Runtime and the provider broker both require the provider to report
  `dangerFullAccess`; without the opt-in they still require `readOnly`.
- The root manager starts the server with the service user's real
  supplementary groups instead of none.
- The release pins Codex's `codex-code-mode-host` beside the native
  (selected plan fields `code_mode_host` and `code_mode_host_sha256`, required
  exactly when providers use host access). Codex starts it from the native's
  own directory for every dynamic tool call, including
  `orkestr_workspace_exec`; without it each call fails with
  `failed to spawn code-mode host: No such file or directory`.
- The native reads threads from the real `CODEX_HOME` (default
  `$HOME/.codex`), not from the role's private native state. When Core resumes
  a Deep or Fast thread that the sandboxed provider created earlier, the broker
  first copies that one rollout file from the role's private state into the
  host `CODEX_HOME` (never overwriting). Without it, Codex refuses the resume
  with `no rollout found` and the window open fails.
- The root manager follows the native's descendants as host commands: a
  descendant may run as another uid (`sudo`), reaped descendants no longer
  count against the per-window bound, and a tree that cannot be followed
  closes only that window instead of stopping the shared manager.
- Claude sessions are not used by beta windows and keep their restricted flags.

Per project, a trusted workspace profile may add `"host_privileged": true`
(requires `host_full_access`). Commands then run as the service user directly
on the host: no bwrap, namespaces, seccomp or `no_new_privs`, so setuid `sudo`
works; the environment is `host_full_access.environment` plus operator and
credential-file additions; cwd starts at the real project path and any path is
reachable. Kept for operability: a fresh job cgroup per command with generous
configurable limits (default 32 GiB, 4096 tasks, 8 CPUs), `cgroup.kill` and
reaping on timeout/cancel/revocation (root descendants included, unless a
root process deliberately leaves the cgroup), detached jobs, Core delegation
with exactly-once result delivery, and the audited command text. Because there
is no PID namespace, a crashed server can leave commands behind; the next
host-privileged startup kills and removes every foreign job cgroup.
