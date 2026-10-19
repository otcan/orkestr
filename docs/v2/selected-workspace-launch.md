# Selected Codex descriptor workspace entry

This additive opt-in uses the reviewed selected Codex package. Legacy entries
retain their existing path-based behavior. No account refresh or provider run is
part of this change.

Fixed trusted launcher argv:

- `open-owned-workspace-session --protocol orkestr-v2-provider-broker-v1`
- `resume-owned-workspace-session --protocol orkestr-v2-provider-broker-v1`

Both require inherited FD3 (owned writer handoff socket) and FD5 (directory from
the Core workspace launch callback). Resume additionally consumes the existing
one-use FD4 native-identity bootstrap. No argv workspace path, environment mode,
missing-FD fallback, or client JSON authority exists. These strings select a
transport; they do not substitute for the private Core grant or current fences.

Runtime duplicates all sources above5 before mapping3/4/5, performs fchdir on
the retained workspace description, and owns cleanup on callback/commit failure.
The selected broker validates FD5 as a directory, retains its dev/inode/uid,
and rechecks before constructing the command. Popen does not reopen a cwd path.
Package and profile validate the configured host workspace as lexical metadata
only in this mode; other credential/state/package validations remain unchanged.
They do not stat, resolve or open that workspace name. Host metadata still has
to match the private execution configuration and remain disjoint from state.

The pinned bubblewrap must advertise `--ro-bind-fd FD DEST`; otherwise launch
refuses. The SAME FD5 mounts read-only at fixed `/workspace`, becomes cwd there,
and is consumed/closed by bubblewrap before payload execution. The broker closes
its FD5 copy after spawn. Native protocol and Channel use only `/workspace`.
FD3/FD4 stay broker-side and are not forwarded into the native namespace. The
seccomp descriptor is the only other explicitly preserved sandbox descriptor.
No `/proc` path re-opening, host workspace mount or string-cwd fallback is used.

The package inventory adds only `isolation/workspace_fd.py`; the existing exact
source packager automatically copies and hashes that dependency. Packaging and
controller preparation still validate their configured host workspace as before;
this change does not alter their authority or introduce a workspace registry.
Ordinary server factory/Core registration and restart issuance remain Runtime
and Core integration responsibilities.

Validation is synthetic: actual selected namespace command after renaming the
host path away sees retained bytes, refuses writes and closes FD5; separate
protected disposable package construction under a permanently dropped UID works
with that host name absent. Fixed fresh/resume entry tests check Channel cwd and
FD4 consumption; missing FD5 refuses. Existing protected package/lifecycle tests
remain passing. No actual authenticated provider, ordinary workspace HTTP flow,
Core spawn/commit-failure replay, or selected-profile resume inference is claimed
by these tests. Those are independent composition gates.
