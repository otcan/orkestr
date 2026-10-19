# Workspace authority proposal — not an implemented issuer

Core owns the new contract, durable Store issuance and shared registration. Runtime
owns consuming it at actual spawn/resume; Installation owns read-only inventory.
No migration is allocated: schema39 remains latest pending coordinator collision check.
No configuration, inventory entry, browser path or selected-profile handle grants access.

## Scope and opaque handoff

Proposed private, non-Clone/non-Deserialize types:

- `WorkspaceInstallation`: trusted local operator validation result with retained
  directory handles for canonical workspace, Git directory and common Git directory.
  Its constructor accepts operator-selected paths through trusted bootstrap only,
  never HTTP JSON. Installation's inventory is evidence to revalidate, not this handle.
- `WorkspaceGrant`: owner, conversation, opaque project UUID and exact generation,
  immutable filesystem anchors and local handle membership. No inference authority.
- `WorkspaceLaunch`: one-use launch/resume reservation bound to an existing exact
  `BoundSessionMetadata` identity. A distinct consumed execution capability remains
  mandatory before inference; parent-scoped Worker setup restrictions still apply.

Proposed Store seams (names provisional until Runtime agreement):

```
register_workspace(machine_credential, owner, conversation, installation)
    -> WorkspaceGrant
replace_workspace(machine_credential, old_grant, new_installation)
    -> WorkspaceGrant
revoke_workspace(machine_credential, grant) -> ()
authorize_workspace_metadata(machine_credential, grant, metadata)
    -> WorkspaceLaunch
with_workspace_launch_fence(machine_credential, launch, nonblocking_spawn)
    -> actual_owned_child
```

Machine credential must be current and authorized by the bound supervisor for that
owner/conversation. Registration is trusted configuration, not arbitrary machine-token
path authorization. Bootstrap must receive a closed operator project allowlist;
no wildcard or current-directory fallback. Project selection resolves a persisted
allowlist entry, never a caller-selected absolute path. Replacement increments the
project generation and refuses old grants/resume; revocation is durable. Reopen
reconstructs local handles only by revalidating the registered identity and current
supervisor; serialized UUIDs/anchors alone never recreate authority.

## Filesystem and concurrency boundary

Validate canonical absolute directories, expected operator UID, protected-state
nonoverlap in both directions, and Git/worktree/common-directory association.
Reject symlink traversal, world-writable roots and overlapping protected metadata.
Pin device/inode plus canonical association for all three directories. Linked
worktrees may share an explicitly allowed common directory but retain distinct
workspace and Git-directory identity. HEAD is observed metadata; changing HEAD is
not by itself a new authority generation or revocation.

An inode comparison followed by spawning with a string cwd has a replacement race.
Runtime must launch using the retained directory descriptor (fchdir or equivalent
reviewed launcher primitive), with descriptor identity checked inside the short
current-generation launch fence. The callback cannot wait for protocol/network I/O.
A launch reservation is spent before effects; uncertain spawn cannot be retried.
Path reassociation, directory replacement or unavailable descriptors refuse resume.
Mount aliases and hostile concurrent mount changes require a reviewed OS boundary;
canonicalization alone is insufficient and this proposal does not claim containment.

Metadata setup and execution retain the workspace generation. Current workspace
validation must compose with metadata, execution, cancellation and tool/result fences,
using one transaction/lock ordering, never nested SQLite writers. Revoke/replace
must fence subsequent inference/result suffixes as well as future process creation.
Already written effects stay unknown; no recall or automatic replacement process.

## Proposed storage and negative vectors

A future migration would store owner/conversation/project, generation, canonical
anchors, active/revoked state and immutable registration provenance; no credentials,
profile paths or browser authority. Exact binding-to-project generation must be
persisted so restart cannot silently choose another project. Core will allocate only
after Runtime agrees descriptor consumption and coordinator reserves a slot.

Required tests: foreign owner/conversation; stale generation; machine revoke/expiry;
replacement between issuance and spawn/resume; symlink/nested/protected overlap;
linked-worktree common metadata mismatch; changed inode at same path; forged UUID;
reopen with changed identity; concurrent replace versus actual launch; failed spawn
no grant reissue; HEAD-only change does not invent a generation; Worker parent Stop
still refuses setup; workspace revoke blocks an already-owned child's later suffix.
Installation inventory tests remain separate from these authority/process tests.

## Runtime review: descriptor ABI prerequisite

The current string-cwd launcher is insufficient; no storage or schema allocation
follows from this proposal. Initial scope is Linux64 on a stable filesystem and
mount namespace, not protection against hostile mounts or inode reuse.

Proposed retained handle is a Core-validated directory `OwnedFd`, opened without
symlink traversal and checked by `fstat` against its pinned identity. Runtime receives
only a borrowed descriptor during the bounded launch callback; it must not reopen
any configured path. A reviewed launcher transfers that exact descriptor through
its closed FD allowlist and performs `fchdir` from it. The sandbox's read-only project
mount must resolve the same retained descriptor, not a second pathname lookup.
FD duplication preserves the open file description; serializing a descriptor number
or passing a path does not preserve authority. Exact transfer FD/ownership and
sandbox mount primitive remain to be agreed with Runtime/Isolation before coding.
The current launcher preserves only descriptors3/4 and has no such project transfer.

Metadata and workspace validation must execute in the **same existing immediate
transaction** immediately around actual spawn. A transaction-local private validator
must compose both checks; do not call `with_metadata_fence` inside a second workspace
writer. The exact project generation must then be carried into setup confirmation,
execution, renewal, steering, tool launch and result/output-write validation.
Workspace revocation fences new effects but must not prevent exact issued cancellation,
owned-child kill/reap or negative retirement cleanup. Cleanup cannot grant inference,
reopen a project, or relabel unknown effects as confirmed cancellation.

Selected-profile authority stays separately owned and separately checked. No profile
path, account handle or descriptor grants project access; no project grant grants
profile/account access. Runtime/root must agree the combined closed launcher argument
and FD ownership contract with the selected-profile owner. Core will consume only
that reviewed handoff, not introduce a second profile manager or raw profile field.

## Concrete launch handoff offered for ABI review

```
authorize_workspace_metadata(...) -> WorkspaceLaunchReservation
consume_workspace_launch(credential, reservation)
    -> Launch(WorkspaceLaunch) | ReconciliationRequired
with_workspace_metadata_fence(
    credential, &mut WorkspaceLaunch, &BoundSessionMetadata,
    action: FnOnce(WorkspaceDescriptors<'_>) -> Result<T, E>
) -> Result<Result<T, E>>
```

`WorkspaceDescriptors` offers only borrowed workspace/Git/common-directory FDs.
Runtime duplicates the workspace descriptor into its closed transfer mechanism;
no raw path override. All three identities stay independently pinned and checked.
Runtime/Isolation must still freeze the exact launcher primitive and FD ownership.

Consumption must **commit delivery_unknown before spawn**, in a separate short
transaction. A subsequent fence revalidates exact metadata, workspace generation,
current machine/supervisor and descriptor identity together before the callback.
The callback can execute only once locally, even when it returns an error or COMMIT
fails afterward. Historical consume replay/reopen cannot return another launch cap.
Uncertain creation remains reconciliation-required rather than a fresh process retry.
The existing consumed inference grant is still independently required afterward.

Shared source integration points are `validate_metadata` (including its resume path)
and `production_authorized_run` for execution-purpose effects. The latter already
serves inference, steering and subordinate tool/result authorization. Review must
verify all result paths actually reach it; cancellation-purpose checks deliberately
retain cleanup eligibility. Binding-to-project generation and descriptors must survive
same-child renewal without granting a fresh launch. Restart rehydrates local descriptors
only through trusted allowlist validation; missing local handles fail closed.

No implementation is claimed by these signatures. Slot40 collision confirmation,
Runtime descriptor consumer agreement and ownership of its closed launcher changes
remain prerequisites for publishing the first storage/consumer checkpoint.
