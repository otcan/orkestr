# Unprivileged V2 package and local launcher

This is the first bounded product installation increment. It assembles an
already-built native server and optional web dist into a verified directory
package, installs into an explicitly fresh private home, and provides version,
doctor, logs, foreground start, owned-child stop, stopped upgrade, database-aware
backup and gated restore preview. It never installs a service, invokes sudo,
builds Rust/Docker, downloads dependencies or restarts an existing installation.

The earlier [helper runbook](local-install-helper.md) documents intake smoke
only. Product installation uses the commands below. Full daily-use replacement,
provider setup, channel handoff, canonical migration and release gates are still
separate work. Web comes first; iOS is deferred.

## Package contract

Requires an unprivileged POSIX account, Python 3.11+, and an existing compatible
server executable. Linux is currently required by the fail-closed filesystem identity guard.
macOS filesystem identity support and acceptance are pending; other platforms
are unsupported by this launcher. The packaging tool records the host OS/CPU;
assemble natively, not around a cross-compiled executable. A directory package
is deliberately simple: no archive extraction, symlinks or root installation.

From the repository root, use private paths outside the checkout. These examples
are **unexecuted** and require locally chosen paths, full source commit, and an
assigned unused port. No shared-host port/home is authorized by this document.

```sh
python3 v2/packaging/package.py \
  --binary "$native_binary" --output "$fresh_package_directory" \
  --version 0.1.0-local --source-commit "$full_source_commit"
# Add --ui-dist "$built_web_dist" only when a real built UI bundle is available.
```

The server's combined candidate supports `ORKESTR_V2_UI_DIST` and
`ORKESTR_V2_ORIGIN`; the launcher sets these only when UI files are packaged.
The initial helper base predates that server support: coordinator must integrate
against the current combined candidate, not use the old server to claim web
installation passed. There are no new root Cargo/lock/schema edges.

Package layout: `server/orkestr-v2-server`, optional `ui/`, Python tools under
`tools/`, executable `bin/orkestr-v2`, and a versioned `manifest.json` with full
source commit, platform, and SHA-256 file inventory. Package checksums detect
changes relative to the supplied manifest; they are not a signature, provenance
attestation or proof the supplied source commit matches the binary. Accept only
a trusted package. Native/UI build and signed distribution are unexecuted gates.

## Clean install and explicit auth

```sh
"$fresh_package_directory/bin/orkestr-v2" install \
  --package "$fresh_package_directory" --home "$fresh_v2_home" --port "$assigned_port"
"$fresh_package_directory/bin/orkestr-v2" version --home "$fresh_v2_home"
"$fresh_package_directory/bin/orkestr-v2" doctor --home "$fresh_v2_home"
```

Installation refuses root, existing destinations, overlap with package/source,
checkout or an explicitly configured `ORKESTR_HOME`, and unavailable ports.
It does not discover private homes automatically. Explicitly configure legacy
home paths where relevant. Canonical paths resolve parent symlinks. Linux filesystem identity checks also
reject mount/device/root aliases against protected paths; unavailable, malformed
or ambiguous mount information refuses the operation. The reviewed
`path_identity.py` is included as a required package tool: missing guard code fails closed.
Existing private homes and their sibling data/control/log/provider/release
directories are rechecked when opened. Configured legacy roots remain necessary
to identify private paths the installer cannot discover automatically. This is a
local trusted-user tool, not a sandbox against malicious same-user filesystem
races. Failure retains the fresh diagnostic directory; it never deletes user
state to retry.

The home is mode 0700 and includes:

- `data/`: server SQLite data, passed as `ORKESTR_V2_HOME`.
- `control/`: private bootstrap file and launcher control socket.
- `logs/`: local server output.
- `provider-home/`: empty isolated HOME; no legacy credentials copied.
- `releases/`: verified copied packages, selected by `install.json`.

A fresh random bootstrap token is generated once at
`control/bootstrap.token` with mode 0600. It is not printed. Setup is still the
published `POST /api/v2/setup` with `x-orkestr-bootstrap`; pass the file privately
to a client that reads it without putting its value in command arguments or
chat. Do not paste it into a terminal command, transcript or issue. First-admin
setup/session flow remains server-owned; no launcher command automatically
creates a real owner or duplicates credentials. An integrated web bootstrap-file
handoff is pending and must not be claimed as a completed onboarding gate.

The child receives only PATH/system temp hints plus isolated HOME, V2 bind/home,
bootstrap and optional UI origin/dist. It does **not** inherit provider keys,
legacy state or a master key. If a later server requires additional explicit
secret handles, its owner must define that contract before launcher support is
added. No secret is copied out of the old instance.

## Lifecycle, doctor and logs

```sh
# Stays in foreground; the example paths are unexecuted.
"$fresh_package_directory/bin/orkestr-v2" start --home "$fresh_v2_home"
# In another terminal, stop only this launcher's child:
"$fresh_package_directory/bin/orkestr-v2" stop --home "$fresh_v2_home"
# Explicit HTTP probe (ordinary doctor does not contact services):
"$fresh_package_directory/bin/orkestr-v2" doctor --home "$fresh_v2_home" --health
"$fresh_package_directory/bin/orkestr-v2" logs --home "$fresh_v2_home" --lines 100
```

Start holds a nonblocking file lock, verifies the selected package and native
platform, checks loopback port availability and emits package/home/bind/schema
status before starting its child. It then checks v2 HTTP health. A transient port
probe cannot reserve the port: use an exclusive local lane; no occupant is killed.
Health is HTTP identity, not cryptographic process attestation. The server owns
database migrations; its current execution path remains disabled at intake.

Stop talks to a private Unix socket. The supervisor signals only its own `Popen`
child, waits for SIGINT, then kills that exact child on timeout. Stop acknowledges
the request; wait for foreground launcher exit before backup/upgrade. Ctrl-C and
SIGTERM also clean up the owned child. There is no PID-file kill, process-name
matching, systemd/launchd edit or production discovery. SIGKILL/host failure can
leave an orphan: the launcher does not guess its identity or kill it on restart.
A busy port fails safely. Choose a short home path: the control socket must fit
under 100 encoded bytes for portable macOS Unix socket limits.

Doctor validates private layout, auth file permissions, selected package hashes,
lock state and reports platform/restore gates. Taking the advisory lock can
create its lock file; it does not open/migrate SQLite or start a server. Logs
prints a bounded local tail; logs and databases are private operational material,
not public evidence attachments. Empty logs before first start fail clearly.

## Stopped upgrades and recovery gates

```sh
# Stop and wait first. Build a separate trusted package independently.
"$fresh_package_directory/bin/orkestr-v2" backup --home "$fresh_v2_home" --output "$fresh_snapshot_directory"
"$new_package_directory/bin/orkestr-v2" upgrade --home "$fresh_v2_home" --package "$new_package_directory"
"$new_package_directory/bin/orkestr-v2" doctor --home "$fresh_v2_home"
# Explicit start is separate; upgrade never restarts or runs DB migrations.
```

Upgrade copies and verifies a new release, then atomically selects its manifest
hash. Existing data, auth token, port and previous release remain. A running
launcher blocks upgrade and backup through its lock. There is no automatic
schema downgrade/rollback: retaining old package bytes does not make an old
binary compatible after newer migrations. Full clean upgrade with real server
schemas is unexecuted and must pass before replacement.

Backup uses Python SQLite's **backup API**, with a bounded progress deadline,
then closes/normalizes the destination journal, integrity-checks and hashes it.
It includes committed WAL content; it never copies only live main-file bytes.
The source is opened read-only. The private output directory must not exist and
must be outside the home. The snapshot contains only `core.sqlite3` plus a
manifest labelled `orkestr-v2-local-recovery-v1`; it is not a canonical Migration
export. `sqlite_user_version` is recorded without pretending it is the server's
SQLx migration version. The DB can contain password hashes/session rows: keep the
snapshot private/encrypted using owner-controlled storage, with a retention and
deletion policy. It excludes bootstrap/provider files, logs, packages and external
artifacts, so it is not a complete future multi-store backup.

```sh
# Validate only against an initialized target with an empty data directory:
"$fresh_package_directory/bin/orkestr-v2" restore-preview \
  --home "$fresh_empty_target_home" --snapshot "$fresh_snapshot_directory"
```

Restore preview checks inventory, integrity, schema marker, package, target lock,
empty data directory and non-overlap, then returns **PENDING apply**. It never
copies auth/session state or activates old inbox/outbox work. There is deliberately
no `restore` apply command until Migration supplies the canonical manifest,
instance binding, schema compatibility and dormant work/auth disposition. A
precise coordination request has been sent to that lane. Do not hand-copy the
snapshot into the target as a workaround. This is the next dependency, not a
claim that restore or migration is complete.

## Executed checks and pending acceptance

```sh
python3 -B -m unittest discover -s v2/local-install/tests -v
```

Tests exercise actual synthetic filesystem/package installs, upgrades and SQLite
WAL snapshots; process/HTTP/socket execution is mocked. They check preservation,
root/existing-home/tamper/symlink refusal, lifecycle ownership, environment
exclusion, health identity and gated restore. No server, listener, Docker,
provider, existing home or credentials are used. No heavy build was run.

The isolated Linux real-server checkpoint is recorded in
[installation HTTP evidence](local-install-http-checkpoint.md). It exercises a
historical mixed-revision binary/UI pair, not current candidate browser or
execution acceptance. Same-binary version-label upgrade tests package selection,
restart and history only; cross-version schema compatibility is unexecuted.

Pending/unexecuted: remote CI, macOS, cross-version schema upgrade, browser
bootstrap handoff/interaction, canonical restore apply, Docker packaging/run,
signed distribution, real providers and full workflow replacement. Independent
review of the preceding artifact passed; these subsequent changes require their
own review. The reviewed Linux path helper is integrated; its mount-topology/stat tests and
consumer wiring tests pass in the combined lightweight suite. Supported
filesystems are ext2/3/4, xfs, tmpfs and ramfs; layered/network/other filesystems
fail closed. The optional privileged private-mount probe was not rerun here.
Existing-home child checks protect the install/lock files and sibling
directories as well as configured external roots; a package copied into the
home is deliberately not treated as an external disjoint root. No production service, host privileges, cutover,
legacy credential migration, Main WhatsApp or personal-account changes occur.

Keep the trusted package entrypoint available, or invoke the copied package's
`releases/<release-hash>/bin/orkestr-v2` inside the home (the hash is returned by
version). This increment does not add a global PATH shim. For cleanup, stop and
wait for the managed child, retain/delete private snapshots according to the
owner's policy, then manually remove only the explicitly selected synthetic
home/package directories. There is no automatic uninstaller or retention daemon.

Path guard integration provenance: imported unchanged from reviewed commit
`faa82e23caaf556a2b55e00475659d3a613f050b`. Independent source inspection covered
mount parentage/visibility, filesystem-root mapping, inode anchors for absent
leaves, unsupported-filesystem refusal, and mount-topology change detection.
After canonical-return and packaged-home wiring fixes, the combined lightweight
suite passed **74/74** tests. This includes 27 helper tests and 16 consumer API
wiring tests. Restore-preview rejects aliases before opening the snapshot.
No host mounts or namespaces changed; optional private-mount and actual-server
probes were not rerun for this integration. The earlier HTTP checkpoint remains
evidence only for its recorded revision.
