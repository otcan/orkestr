# Operator workspace authority (Linux64)

Migration `0040_workspace_authority.sql` adds projects, immutable session-generation
associations and one-use launch receipts. This is trusted operator bootstrap, not
an HTTP/imported path API. The implementation assumes a stable local filesystem
and mount namespace; device/inode checks do not prove hostile mount or inode-reuse
safety. HEAD changes confer no authority. Inventory alone confers no grant.

## Core call sequence

1. Construct `WorkspaceOperatorAllowlist::new(roots, protected, operator_uid)` from
   closed local configuration, then `installation(selected_path)`. All path
   components refuse symlinks. Workspace, Git directory and common directory are
   separately opened and checked for UID, world-write and protected-state overlap.
   The Store additionally excludes its database directory. Linked worktrees may
   share a common directory. Nested allowlist roots refuse.
2. On a current machine/supervisor-bound Store call
   `register_workspace(credential, &conversation, project_uuid, installation)`.
   Exact existing identity reopens a grant; different identity conflicts. First
   registration refuses established native readiness or live runs. After a new
   Store pool opens, explicit trusted reinstallation is required before effects.
3. `bind_workspace_session(credential, &grant, &binding)` associates an exact
   Starting/Ready session before using its existing metadata issuer. Worker
   metadata still requires the canonical live parent issuer. Accepted/Stopped
   metadata still requires existing sealed terminal provenance.
4. `reserve_workspace_launch(credential, &grant, &metadata, request_key)` returns
   `WorkspaceLaunchReservationResult::Reserved(reservation)` once. Identical
   replay returns `ReconciliationRequired`; changed semantic input conflicts.
5. `consume_workspace_launch(credential, reservation)` commits `delivery_unknown`
   before returning `WorkspaceLaunchConsumption::Launch(launch)`. Lost replies,
   restart and repeat consumption never reissue launch permission.
6. `with_workspace_metadata_fence(credential, &mut launch, &metadata, callback)`
   validates original metadata identity, machine/context, project generation and
   held filesystem identities in ONE immediate transaction. No nested metadata
   writer. The callback is synchronous, short, bounded spawn only, with no waits.
   The token is locally spent before validation/callback and never retried after
   callback failure or COMMIT uncertainty. Capture any created owned child outside
   the callback so outer failure can quarantine/reap it.

`WorkspaceDescriptors` borrows three descriptors for the callback only:
`workspace()`, `git_directory()`, `git_common_directory()` return `BorrowedFd`;
corresponding `*_identity()` getters return Copy/Eq `WorkspaceDirectoryIdentity`,
whose `device()`, `inode()`, `uid()` are respectively `u64`, `u64`, `u32`.
There are no public raw-descriptor constructors or mutable identities.

Runtime duplicates all source descriptors at FD >=6 before destination dup2;
workspace destination is FD5, with fchdir on the same open description. FD3/4 are
preserved. Isolation must explicitly forward/validate FD5 and use that SAME FD for
read-only mount and chdir, with no config-path reopen/fallback. These consumer and
actual subprocess qualifications belong to Runtime/Isolation, not this Store test
claim.

`replace_workspace(credential, &grant, installation)` increments generation and
fences existing sessions; it does not rebind them. `revoke_workspace` increments
and deactivates even if the original path was replaced. Current project identity
and generation are checked at metadata issuance/confirm/action and shared
execution authorization (including result/steering suffixes). Cancellation
issuance and exact cancellation-purpose suffixes retain negative cleanup
authority after project revocation; current machine auth and every other existing
cancellation guard remain mandatory. No revocation recalls already-written bytes.

Existing conversations without an installed project retain their prior behavior;
this checkpoint alone does not activate descriptor launch in any server factory.

Validation: required-wrapper locked/offline Store lib regression passed 309 tests
with four owned-child helper entries ignored (their process parents execute them).
This includes the schema-40 copy-first prefix preservation oracle and nine new
workspace tests. Strict feature-enabled Store all-target Clippy passed. A final
focused workspace rerun covers the lint-only internal boxing change; the public
ABI is unchanged. Upgrade fixtures alone permit pre-40 historical handles while
populating their old schemas; ordinary Store::open fully migrates before use and
production workspace validation has no missing-schema exemption.

Core does not claim actual descriptor spawn/mount, native process cleanup,
factory activation, hostile mount protection, or a live installation change.
