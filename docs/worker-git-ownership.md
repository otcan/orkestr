# Worker synchronization ownership boundary

The release deployer's `sync_safe_workers_after_deploy` invokes
`syncSafeThreadWorkersWithParents` in `packages/core/src/thread-workers.js`.
That coordinator refreshes state, invokes `syncThreadWorkerWithParent` for a
fast-forward, and optionally pushes the worker branch. Direct worker sync uses
the same merge path.

A privileged service must not execute these mutations in a checkout owned by
another OS user. Git replaces index and ref files using the executing process's
identity and umask; readable directories alone do not make a root-run merge safe.
Git status may also refresh an index, so thread-worker Git commands disable
optional locks and the coordinator checks ownership before refreshing state.

`worker-git-ownership.js` requires the effective process UID to match filesystem
ownership of the checkout, Git entry, worktree Git directory, common Git
directory, existing index/HEAD/packed refs and key metadata directories, and the
current branch's existing ref/reflog paths. This supports ordinary standalone
clones and linked worktrees. Direct sync checks before state inspection and again
immediately before merging; push checks again before executing Git.

A mismatch throws HTTP 409 `worker_git_owner_mismatch`. Missing or unsupported
ownership evidence throws `worker_git_ownership_unavailable`. Coordinated sync
returns `ok: false`, increments `blocked`, and includes an exact per-worker
`blocker` with checkout, effective UID, and available path/role/owner UID or
inspection failure detail. A skipped worker remains untouched. If ownership
changes after a merge but before push, the result records that synchronization
succeeded and pushing was blocked. Deployment logs include the structured
blocker; the existing post-deploy best-effort pass does not roll back deployment.
An ownership-blocked worker must be resolved before declaring branch alignment
complete.

## Owner-aware execution

A common topology runs the control plane (API/UI, deployer, runtime sync) as
root while agent executors run as a dedicated non-root user (for example
`orkestr`) that owns managed repositories, worktrees and worker checkouts.
`packages/core/src/git-owner-exec.js` supports this without sudo or runuser:

- It applies only when the effective UID is 0, the checkout is owned by a
  non-root UID whose passwd name is in the allowlist, and the full ownership
  inspection above shows that the checkout and every inspected Git path belong
  to that single UID.
- Git then runs through Node `execFile` with the owner's `uid` and primary
  `gid`, and `HOME`, `USER`, `LOGNAME`, `XDG_CONFIG_HOME` and
  `GIT_TERMINAL_PROMPT=0` set for that user (home from the passwd database).
  Node clears supplementary groups, so repositories must be accessible to the
  owner through its own UID or primary group.
- Allowlist: `ORKESTR_GIT_OWNER_ALLOWLIST` (comma-separated user names),
  defaulting to `ORKESTR_EXECUTOR_RUN_USER`, then `ORKESTR_RUN_USER`, then
  `orkestr`. Root is never a target.
- Kill switch: `ORKESTR_GIT_OWNER_EXEC=0` restores same-UID-only behaviour.
- Non-root services are unchanged: Git runs as the service UID.

Direct sync, coordinated sync and worker branch push resolve the identity
again immediately before each merge or push. Thread Git state refresh
(`detectThreadGitState`, `detectThreadRepo`, `refreshThreadGitState`) runs its
read probes as the owner too, so cached dirty/changed counts and parent
ahead/behind stay fresh; if owner resolution fails, reads fall back to the
service UID. Sync and push results, the `thread_worker_synced_with_parent` and
`worker_own_branch_pushed` events, and deploy log lines include
`executedAsUid`. The admin branch push keeps privileged staging only as a
fallback when owner execution is disabled or not applicable.

Still fail-closed: owners outside the allowlist and checkouts where owner
execution is disabled keep `worker_git_owner_mismatch`; mixed-owner metadata
still throws `worker_git_owner_mismatch` or `worker_git_ownership_unavailable`.
There is no account inference from application principals, recursive ownership
repair, permission widening, or safe.directory change. Do not repair
unrelated/shared repositories.

This is a preflight guard, not a filesystem lock or full recursive ownership/ACL
audit. Concurrent ownership replacement after inspection remains outside its
atomicity guarantees. Concurrent writers must still be coordinated operationally.
Mixed-owner metadata and platforms without an effective UID fail closed. UID-change
tests use only disposable fixtures and require root (the owner-aware
integration test also needs a real allowlisted account and is skipped
otherwise); ordinary same-owner and injected-fake tests run without root. No real release, remote push, or service mutation is required
for the ownership regressions.
