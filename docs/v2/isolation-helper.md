# Startup storage isolation probe and patch proposal

Status: authored probes and fixture/mocked checks only. Actual candidate failure
and patched-candidate pass are **unexecuted**, pending coordinator admission.
No Rust build, dependency download, server execution, live inference or real home
was used by this helper. This is a proposal, not an implemented security fix.

## Evidence provenance

Read with `git show` from verification commit
`c42b88eed8894430d9cfb6f2be8bda29ec0e800f`:
`docs/v2/intake-independent-evidence.md` and
`v2/acceptance/intake_blackbox.py`. Verification reports that a synthetic legacy
DB symlink target grew from zero to 4096 bytes while startup remained running.
That observation belongs to verification's tested intake head
`28c4779346a2d6e46abed5305cd4b6ee7deac060`; it is not a new execution here.

Source inspection here is at combined candidate
`76f9c6cd91e094329ae5c29c7e95f301366ed02a`:

- `v2/apps/server/src/main.rs`: creates the home before overlap validation,
  canonicalizes homes, compares directory ancestry, then calls `Store::open`.
- `v2/crates/store-sqlite/src/lib.rs`: opens a writable, create-if-missing WAL
  pool before migrations; it does not validate database or sidecar aliases.

Directory separation alone does not establish storage separation. A candidate
DB or sidecar can physically alias another home's files.

## Proposed physical alias policy

Refuse symlink components in the supplied candidate home and its ancestors,
including dangling links; refuse symlink DB, WAL and SHM entries. Refuse existing
nonregular DB/sidecar entries and regular files with link count other than one.
This deliberately rejects hardlinks even when the other name is unknown or
outside the declared legacy home. Never unlink, repair, truncate or migrate an
unsafe entry. Refusal must leave existing bytes, link identities and directory
entries unchanged and create no candidate database/sidecars.

Resolve/check existing legacy and candidate ancestors before creating candidate
subdirectories. Refuse canonical ancestry overlap in either direction. Preserve
valid separated-home startup and allow ordinary single-link existing databases
subject to the core owner's separate schema compatibility policy.

Symlink and inode/link-count checks do not prove separation across bind mounts,
network filesystems, reflinks or hostile mount-namespace changes. Define the
initial supported environment as a local filesystem under a trusted mount
namespace; do not claim sandbox isolation against privileged mount changes.
Compare device/inode identity for known candidate/legacy paths as defense in
depth. Bind-mount alias reproduction is unexecuted and outside these unprivileged
fixtures. Reflinks sharing physical blocks are independent logical files and
are acceptable when writes cannot mutate the original.

## Exact proposed source ownership request

Core owns these changes; this helper has not changed shared source. Delegate
exact files before any implementation by this helper:

1. NEW `v2/crates/store-sqlite/src/path_isolation.rs`: narrow filesystem admission
   helper, no schema or second store. Validate candidate ancestry and the main,
   `-wal`, `-shm` paths using no-follow metadata and link-count policy before any
   SQLite connection or migration. Keep the validation reusable by direct store
   callers, so server-only guards cannot be bypassed through `Store::open`.
2. `v2/crates/store-sqlite/src/lib.rs`: declare/call that helper at the start of
   `Store::open`; preserve a distinguishable isolation refusal for diagnostics.
   Core decides error mapping with the existing application error boundary.
3. `v2/apps/server/src/main.rs`: perform legacy/home overlap and existing-ancestor
   validation before `create_dir_all`; propagate a safe isolation diagnostic.

A metadata-check-then-open sequence alone has a replacement race. The core fix
must state its concurrent filesystem writer threat model. For a hostile writer,
use anchored directory descriptors/no-follow creation and an SQLite opening
strategy that preserves the validated identity for DB and sidecars, or isolate
startup in a directory that writer cannot modify. A second metadata check is
not a complete race fix. Do not add unsafe ad hoc SQLite opening or silently
claim race resistance from canonicalization. Dependency/manifests and any error
contract change remain coordinator-owned. No such dependency is required by
these Python probes.

## Probe contract and admitted execution

`v2/acceptance/isolation/probe.py` allocates and removes its own temporary homes;
it accepts no home argument and inherits only PATH/LANG. HOME, TMPDIR and both
Orkestr homes point inside the disposable fixture. Each subprocess is bounded
and reaped. No credentials or connector configuration is passed. These are
cooperative synthetic filesystem cases, not a process sandbox for untrusted code.

Ten negative cases cover empty/populated/dangling DB symlinks, an ancestor home
symlink, a home symlink, DB hardlinks, WAL/SHM symlinks and WAL/SHM hardlinks.
Refusal requires a nonzero nonsignal exit, a recognizable isolation diagnostic,
and an unchanged snapshot of both homes and aliases (names, bytes, link targets,
file device/inode/link count). File timestamps are intentionally excluded since
reading can change access time. Directory inode identity is not asserted.
An eleventh positive case requires HTTP health, a created DB, and unchanged
legacy entries with separate homes. It catches blanket-refusal implementations.
A free loopback port is selected; the bind reservation is released before launch,
so an unrelated port race fails the control rather than providing pass evidence.

After explicit build/binary execution admission, run against each exact binary:

```sh
python3 -B v2/acceptance/isolation/probe.py --binary /absolute/synthetic-build/orkestr-v2-server
```

Expected baseline: negative cases expose acceptance/mutation or an unrelated
SQLite error; suite fails. Expected patched result: all eleven cases pass under
the declared strict alias policy. These are expectations, **unexecuted** here.
Record exact source commit, binary identity, command, JSON and exit code for
each run. Preserve distinction between source inspection and observed behavior.
Timeouts fail negative probes; elapsed time never implies successful refusal.
The suite does not verify WAL effective-schema compatibility, crash durability,
startup permission policy or concurrent symlink replacement resistance.

Executed lightweight check:

```sh
python3 -B -m unittest discover -s v2/acceptance/isolation -p 'test_*.py' -v
```

Result: five fixture/mocked tests passed. They check all negative fixture shapes,
mutation detection, unrelated-error rejection, no symlink traversal in snapshots,
and actual synthetic hardlink identity. They do not establish a server pass.
