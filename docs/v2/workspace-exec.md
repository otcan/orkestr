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
