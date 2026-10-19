# Workspace descriptor launch primitive

This Runtime leaf is unregistered. It supplies no operator, workspace, metadata,
account or inference authority. Core schema40 and the closed profile forwarder
must be composed before using it in an ordinary launch.

The frozen Core callback supplies `WorkspaceDescriptors<'_>`. Its workspace,
Git-directory and common-directory getters return borrowed descriptors, with
`WorkspaceDirectoryIdentity` getters `device`, `inode`, and `uid`. Runtime copies
the workspace identity into its private primitive and duplicates the descriptor
with `F_DUPFD_CLOEXEC` at or above6 during that callback. No path constructor is
provided. Core separately validates the Git association and current generation.

`WorkspaceDescriptor::configure` consumes that duplicate into the command's
pre-exec closure. After existing close-range setup, it performs `fchdir`, maps the
same open description to5 and clears only5's close-on-exec flag. Source descriptors
must all be duplicated before mapping destinations3/4/5. Do not set string cwd on
this command: the standard library would resolve it before the descriptor hook.

Isolation owns validation and explicit forwarding of5 through the fixed broker
and profile wrapper. Bubblewrap must use `--ro-bind-fd 5` to its fixed trusted
project target, change cwd to that target, and close the source before native
execution. An unavailable descriptor-mount primitive refuses launch. Neither
configured paths nor `/proc` path reconstruction are fallback authority.

Core consumes the reservation and commits launch-unknown before any spawn. The
subsequent metadata/workspace fence validates current authority and invokes the
callback once. An externally retained child must be quarantined/reaped if spawn
succeeds but the callback/fence fails. This leaf does not implement that Store
composition or claim one-use semantics for a bare `Command`.

Initial support is Linux64 with a stable filesystem/mount namespace. Device/inode
checks do not claim protection from hostile mounts or inode reuse. Exact owned
cleanup remains possible after workspace revocation; new effects must fail their
Core transaction-local workspace generation checks.

The synthetic tests prove descriptor cwd and5 retain the original directory after
pathname replacement, and that foreign device/inode/owner or a regular file is
refused. They do not qualify Core issuance, sandbox mounting, provider execution,
reopen, or revocation fencing.

The local Core composition uses exact `31ddc9039` (attributed `84dff64b3`).
`MetadataExecutor::spawn_workspace(credential, &mut WorkspaceLaunch)` consumes
only the previously committed launch through the combined Core fence. It skips
string cwd, duplicates the borrowed workspace descriptor, and retains the exact
spawned Process across outer failure before quarantining it. Existing FD3/FD4
sources now duplicate above slot 5 before any destination mapping. This is a
library port; no factory selects it yet. Python descriptor forwarding and the
same-descriptor read-only mount remain separate qualification prerequisites.
