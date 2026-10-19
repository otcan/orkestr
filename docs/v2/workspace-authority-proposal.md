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
