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

There is no account inference from application principals, automatic privilege
drop, recursive ownership repair, permission widening, or safe.directory change.
Run synchronization through a separately authorized process under the verified
filesystem owner when needed. Do not repair unrelated/shared repositories.

This is a preflight guard, not a filesystem lock or full recursive ownership/ACL
audit. Concurrent ownership replacement after inspection remains outside its
atomicity guarantees. Concurrent writers must still be coordinated operationally.
Mixed-owner metadata and platforms without an effective UID fail closed; a
supported owner-aware execution path can be added separately. UID-change tests
use only disposable fixtures and require root; ordinary same-owner tests also
run without root. No real release, remote push, or service mutation is required
for the ownership regressions.
