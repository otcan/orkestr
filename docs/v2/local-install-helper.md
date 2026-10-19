# Local installation and acceptance helper

For the newer directory package, persistent private launcher, upgrades and recovery
gates, see [product installation](local-install-product.md). This page describes
the original intake-only helper. Its capability table reflects that helper base,
not the newer combined server's optional static UI support.

This helper targets the combined v2 intake candidate. It is a local acceptance
harness for an **already-built** `orkestr-v2-server`, not an installer or proof
of complete product readiness. All examples use fresh synthetic state. It does
not run Cargo, install dependencies, invoke providers, or use existing sessions.

## Actual candidate capabilities

Source of truth: `v2/apps/server/src/{main,lib,auth,routes}.rs`,
`v2/crates/contracts/src/lib.rs`, and `v2/tests/intake_process.py`.

| Capability | Implemented behavior | Helper coverage |
| --- | --- | --- |
| Configuration | `ORKESTR_V2_HOME` absolute; `ORKESTR_V2_BIND` loopback; bootstrap token at least 32 characters | Fresh private home, explicit loopback port, generated token |
| Database | `core.sqlite3` under v2 home, SQLite migrations on open | Restart via same owned home; no direct DB edits |
| Health | `GET /api/v2/health` | Product/status/fixture identity check |
| Setup | `POST /api/v2/setup`, `x-orkestr-bootstrap` | Invalid bootstrap rejection, synthetic administrator |
| Login | `POST /api/v2/session`, bearer response | Synthetic session kept in process memory |
| Message | `POST /api/v2/conversations/{id}/messages` | Accepted receipt, duplicate idempotency |
| History | `GET /api/v2/conversations/{id}` | Matching message ID/text before and after restart |
| Projects and SSE | Project list/create, conversation cursor event stream | Only unauthenticated project rejection; fuller probes remain in existing intake tests |
| Stop/restart | Server handles Ctrl-C; no daemon CLI | Owned subprocess SIGINT, bounded wait, kill fallback; smoke restarts same child binary/home |
| Conversation to result | **PENDING:** server execution disabled; no connected execution loop/result HTTP route | No inferred success from admission |
| Run/cancel CLI/API | **PENDING:** no implemented server routes/commands | No invented commands |
| UI | **PENDING:** no UI/static route on this server | No browser readiness claim |
| Docker | **PENDING:** no v2 image, Dockerfile or Compose packaging supplied | No container invocation |

Runtime library code and DTOs alone do not establish a runnable end-to-end
execution path. A successful helper smoke means durable **intake**, not a model
answer, worker run, Git provisioning, connector setup or full M1 acceptance.

## Dependencies and build handoff

The helper requires POSIX `sh`, Python **3.11+** with its standard library, and a
compatible native executable with execute permission. It uses neither curl nor
third-party Python packages. Missing Python fails at the shell entry point;
Python version, executable, path and port errors fail in preflight.

The candidate's `v2/README.md` lists Rust **1.99.1** and a C compiler for bundled
SQLite. Producing the binary is a separate admitted build step. On the owner's
Mac, after installing those prerequisites and verifying the checkout/toolchain:

```sh
# UNEXECUTED here: native Mac compilation and dependency resolution.
cd v2
cargo build --locked -p orkestr-v2-server
cd ..
```

On a shared development host, follow its admitted build wrapper/lane policy
instead. The helper never starts a build itself. Do not copy a Linux executable
to macOS; use a compatible locally built or verified distributed binary.

## Non-destructive preflight

Run from the checkout root. Choose an unused loopback port and a nonexistent
absolute home under an existing writable private parent. The example derives a
random home name without creating it:

```sh
binary="$PWD/v2/target/debug/orkestr-v2-server"
trial_home="$(python3 -c 'import pathlib,secrets,tempfile; print(pathlib.Path(tempfile.gettempdir()).resolve() / ("orkestr-v2-local-" + secrets.token_hex(12)))')"
sh v2/local-install/preflight.sh --binary "$binary" --home "$trial_home" --port 48122
```

Preflight does not execute the binary, create directories, open a database,
contact HTTP services, read credentials, or stop port occupants. It transiently
binds loopback to check availability; it cannot reserve that port until launch.
A competing process can still take the port afterward, in which case startup
must fail. Use a private machine/port for acceptance.

An existing home (even empty), dangling symlink, home inside this checkout,
or overlap with an explicitly configured `ORKESTR_HOME` is refused. Symlinks
in parent paths are resolved. If `ORKESTR_HOME` is supplied, it must identify an
existing absolute directory. Preflight never discovers or scans legacy homes;
if relevant, explicitly configure their path before running. It does not provide
a filesystem sandbox against untrusted concurrent directory manipulation.

## Launch, health, stop and smoke

```sh
# UNEXECUTED here: creates only the fresh home; runs a real foreground server.
sh v2/local-install/launch.sh --binary "$binary" --home "$trial_home" --port 48122
# Ctrl-C stops the helper's child; data remains for inspection.
```

Launch creates the home atomically with mode 0700, generates a bootstrap token
in memory, and waits up to about ten seconds (plus bounded HTTP timeouts) for
health. Server stdout/stderr goes to private `server.log` inside that home.
The child receives a minimal environment with HOME set to the isolated home;
provider keys, legacy configuration, and inherited connector credentials are
not passed through. Local HTTP explicitly disables proxy use. A health response
is an identity check, not cryptographic process attestation.

Launch intentionally does not print or persist the generated bootstrap token.
Use smoke for synthetic authenticated acceptance; launch alone provides health
and lifecycle inspection. It is not an interactive setup credential workflow.

For smoke, select another fresh home (the launch home is intentionally refused):

```sh
trial_home="$(python3 -c 'import pathlib,secrets,tempfile; print(pathlib.Path(tempfile.gettempdir()).resolve() / ("orkestr-v2-local-" + secrets.token_hex(12)))')"
# UNEXECUTED here: real native acceptance, including one graceful restart.
sh v2/local-install/smoke.sh --binary "$binary" --home "$trial_home" --port 48122
```

Smoke checks unauthorized access, invalid bootstrap, setup/login, message
admission, duplicate receipt, history, graceful stop, restart, history recovery
and duplicate receipt recovery. The administrator password and bearer token are
synthetic, random, and memory-only; no owner credentials are requested. The
bootstrap token remains unchanged across the helper's single controlled restart.
The server's persisted session is used to verify post-restart authentication.
The helper stops only its own `Popen` child, including on failures/interruption;
there are no PID-file signals, background watchers or global process kills.
A force-killed helper/host crash cannot guarantee child cleanup.

The helper prints explicit pending feature lines even after intake passes.
Exit 0 means only the selected helper checks passed. Pending product features
are **not** satisfied gates. To repeat smoke, choose another fresh home. There
is no public resume command for arbitrary existing data; only the controlled
same-process smoke restart is supported. Crash recovery is a separate existing
intake process probe, not executed by this helper.

## Cleanup and evidence

No automatic deletion occurs, including after failed startup. Inspect only the
specific synthetic trial home and its `server.log`, then remove that exact home
manually when no child remains. Do not substitute an existing production or
session directory. Logs/database contain local paths and synthetic session
material: keep them private and do not commit them. No helper output includes
passwords, bootstrap values, bearer tokens or message bodies.

Offline verification, admitted and executed in this worker:

```sh
python3 -m unittest discover -s v2/local-install/tests -v
for script in v2/local-install/*.sh; do sh -n "$script"; done
```

These tests use temporary fixtures and mocks for sockets, subprocesses and HTTP;
they **do not** start servers or listeners. They check preflight refusal cases,
environment isolation, health identity, synthetic request ordering, lifecycle
cleanup, and restart orchestration. They do not prove real SQLite durability.

Explicit acceptance gates still **UNEXECUTED**: native macOS build, native
macOS launch/smoke, real server HTTP/SQLite/restart probes, Docker build/run,
container volume/port permissions, and live inference. Docker acceptance is
also **PENDING packaging**: the coordinator must first supply an actual v2
image/entrypoint, loopback port publication, private data volume mapping, and
health/stop contract. Do not substitute legacy Docker packaging or claim
Docker Desktop installation alone makes v2 ready. Real run/cancel, result and UI
gates require their owning lanes to implement and document those surfaces first.

Filesystem isolation now requires the included reviewed Linux
`v2/local-install/path_identity.py` guard. Preflight refuses missing guard code,
unsupported platforms (including macOS pending implementation), and ambiguous
filesystem identity. Consumer wiring tests mock that API; they do not establish
mount-alias correctness. No host mounts are modified by these tests.

### Populated schema 14 to 15 compatibility probe

`python3 -B v2/local-install/tests/cross_revision.py --help` describes the explicit
old/new binary hashes, source revisions, UI, private parent and assigned port.
The older executable must create exactly migrations 1–14; the successor must
migrate to exactly 1–15. This probe **passed** with pinned `31d8d039`/`c6eca93f` schema-14 and
`a30749e8`/`e94ddf3f` schema-15 binaries. Exact identities and checks are in
`v2/local-install/tests/schema14-to15-checkpoint.json`. Original session/history
and idempotency survived migration. The old binary refused only the disposable
schema-15 copy (`store startup failed`, exit 1) without changing its database
inventory. The preserved schema-14 rollback home reopened successfully with the
old binary. No downgrade of the migrated working database was attempted.
The first harness read incorrectly ignored WAL; a WAL-aware read and regression
fixed that harness error, then a fresh full probe passed.

The probe creates synthetic owner/message history under the old package, stops
it, preserves a verified SQLite backup and complete stopped rollback home, then
upgrades the working package and checks session/history/idempotency after genuine
migration. An older-server refusal is attempted only on a separate disposable
copy of the migrated database; the database inventory must remain unchanged.
Rollback starts the old executable against the untouched pre-migration full-home
copy and checks its original owner/history. It never downgrades the migrated
working database, activates a dormant import, or rebinds an owner. Private backup,
rollback state and evidence are intentionally retained under the supplied private
parent for review; they contain synthetic auth and must not be published. No
providers or production resources are used. Failed probes retain diagnostics.

### Workspace inventory and schema39 rehearsal preparation

`v2/local-install/workspace_inventory.py::inspect_workspace(workspace, protected_paths)`
inspects an explicitly selected, operator-owned canonical Git root without changing
its files, index, branch, or linked-worktree references. The result records HEAD,
common/per-worktree Git directories and inode anchors; it grants no authority.
Rejecting a symlink, nested root selection, world-writable root or protected-state
overlap is an installation precheck, not Runtime sandbox or mount-alias proof.
The caller must protect this inventory as private operational metadata.

The workflow-refresh local-project gate requires parent/worker worktrees to reopen
under allowed scope, cross-owner/path escape refusal and retained artifacts. Seven
new disposable-repository tests cover linked references and dirty source retention,
explicit root/canonical selection, protected path overlap, common Git metadata,
other-writable directories, synthetic owner mismatch and changed HEAD without invented generation binding.
They do not qualify the execution path. Current ordinary execution's canonical
`workspace` check is separate from a project-owner/allowlist/generation contract.
Runtime must define that contract before Installation can activate any reference;
imported or unresolved paths remain unavailable, and no repository is reset,
rebound, pushed or launched by this inspector.

`tests/schema39-fingerprints.json` pins all 39 SQL files from the recorded exact
source, with SHA256 and SQLx SHA384. `test_schema39_contract.py` requires those
exact supplied SQL bytes and rehearses a stopped copy from populated schema38,
retains attachment bytes/history, checks empty automatic-reply authority tables,
reopens with integrity/FK checks, and injects transactional DDL failure on the copy.
This is SQL-only preparation, not an approved historical package edge or actual
server migration. Core `991bbc122` now explicitly supports known-checksum exact populated
14/17/31/33/36/37/38 to39. The runner admits only those edges with the exact
pinned inventory and SQLx checksums; actual execution awaits the next immutable,
matching server/web receipt. Automatic-reply routes, permissions, inputs and sends
are included in the authority-ledger preservation audit. No old binary or mutable build is a substitute.

Remaining actual gate: verify the sealed pair's source/version/binary/UI inventory
and all SQLx checksums; for each Core-supported original package, take a stopped
locked backup, copy-upgrade before writable original migration, verify retained
history/attachment and dormant authority rows, reopen, exercise dormant restore
and rollback, measure backward refusal only on a disposable migrated copy, and
reopen the untouched predecessor rollback home using its original executable.
Preserve original backups and raw evidence. None of those schema39 package checks
has been executed by this preparation.
