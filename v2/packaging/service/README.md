# Persistent beta HTTP service package

This new leaf leaves bounded-v1 and the native installer unchanged. It prepares
an always-on Rust HTTP/API process independently of finite execution windows.
No service unit, provider, browser, account, grant, migration fixture or server
is started by preparation. Linux x86_64 only; other targets are unqualified.

## Frozen build handoff (not executed)

Installation is the single native/WASM build owner after the coordinator freezes
one clean integrated commit. The coordinator owns the workspace/lock version
`2.0.0-beta.2`. Before building, record the full commit, clean tracked/untracked
status, wrapper/toolchain/lock digests, complete explicit allowlisted build env,
exact argv and isolated target paths. Do not relabel previous artifacts.

Use the admitted `V2_CARGO` wrapper, offline/locked default-feature **release**
server, then the canonical UI `v2/apps/ui/scripts/bundle.sh` with
`UI_EXECUTION_CONTROLS=1`, `UI_SERVER_CANDIDATE=<same-full-commit>` and fresh
`UI_BUNDLE_DIR`. Set `ORKESTR_V2_BUILD_IDENTITY` separately to the exact server
and web component records for that commit/version. Record native profile
release/default features and web profile release/features web+execution-controls.
The candidate receipt owner supplies beta-aware sealing/verification; this leaf
consumes the paired inventory rather than promoting RC receipts to beta.

Required actual gates remain unexecuted: clean frozen pair, embedded records,
real native dependency inspection, independently reviewed manager/private IPC
composition, process startup/health/shutdown/restart, browser/provider checks,
release-train deployment. No release readiness is implied by synthetic tests.

## Preparation and root-manager boundary

The operator/root manager chooses a **fresh** isolated home, unprivileged UID and
matching service GID, loopback port, exact HTTPS origin and private beta config.
No host values belong in this repository. Example command (placeholders only):

```sh
/usr/bin/python3 -I -S -B v2/packaging/service/prepare.py \
  --pair /private/pair.json --pair-sha256 SHA256 \
  --binary /private/artifacts/server --ui /private/artifacts/web \
  --output /private/packages/beta1 --home /private/state/beta1 \
  --origin https://beta.example.invalid --port 19822 --uid 995 \
  --beta-config /private/config/beta.json
```

Preparation never creates the home. It refuses existing output, inconsistent
source/version/profile, source/UI tampering and partial copy. `service.json` is
written last; retain its externally trusted SHA256 outside the package. Root
preparation sets package group to the service GID, directories 0750, server 0550
and data/tools 0440. Private beta config must be root-owned, service-group-readable
0640, single-link, with its bytes pinned. Its field grammar/manager IPC is owned
by Runtime and the persistent manager; this leaf deliberately does not guess it.
Omitting beta config produces execution-disabled HTTP packaging only.

The root manager owns unit lifetime, exact child UID/GID drop, creation of the
fresh 0700 home, private IPC/credential state and cancellation/reaping policy.
The dropped child refuses root or wrong UID and validates the home, package,
private beta config and runtime pins before reading the bootstrap token. Invoke:

```sh
/usr/bin/python3 -I -S -B /private/packages/beta1/tools/start.py \
  --plan /private/packages/beta1/service.json --sha256 SHA256 --bootstrap-fd 3
```

FD3 here is an anonymous bootstrap-only pipe, **not** a broker protocol FD.
The manager writes a bounded token then closes its end. The child enforces a
two-second read deadline, never records token bytes/digest, closes that FD and
unrelated inherited FDs, retains only a private exclusive service lock through
exec, and replaces itself with Rust. The lock prevents concurrent service
startup into this home. Root must verify the package/startup script hash before
launching Python: code cannot attest itself retroactively. Restart retains the
same home; root must not regenerate window budget, authority or state.

Rust receives a new environment containing only PATH, LANG, HOME,
ORKESTR_V2_HOME/BIND/ORIGIN/UI_DIST, the transient BOOTSTRAP_TOKEN, and optionally
ORKESTR_V2_BETA_CONFIG. EXECUTION_CONFIG/SET, timers, catalog and arbitrary inherited
provider/credential variables are absent. No secret/profile is read/copied here.
The server remains loopback-only; protected ingress is separate private config.

## Startup closure and limits

The manifest inventories copied server/web/tools/receipt, interpreter, complete
stdlib/cache/extension bytes, currently mapped Python native libraries, trusted
readelf tool and recursive server ELF DT_NEEDED/interpreter files. Dependencies
resolve through fixed root-owned nonwritable system directories; custom ELF
RPATH/RUNPATH, ambiguous/missing libraries and changed bytes/UID/mode fail closed.
No supplied executable is run during this inspection. Package/hash verification
assumes a stable operator-controlled namespace; it cannot prevent a hostile
post-check replacement. Dynamic provider plugins, future dlopen and a whole-host
runtime attestation are not covered. Root manager/isolation dependencies need
separate exact closure evidence before execution-enabled acceptance.

Tests use fake identities/artifacts and private disposable state. The subprocess
startup test verifies the pipe/env/identity path without executing its synthetic
server. Root package ownership application, actual ELF/runtime closure and actual
persistent Rust/manager startup remain unexecuted. No installed services changed.

The persistent manager integration must supply the package-inventoried executable
`start-service` at the package root for a root-managed service unit. It must enter
`codex_service`, never the finite bounded controller. This leaf intentionally
cannot produce that deployable entrypoint until the manager's committed startup
ABI and dependency inventory are supplied. `tools/start.py` is the dropped HTTP
child, not a root service entrypoint; do not point a root unit directly at it.

Use explicit `--uid 995 --gid 986` for installations with distinct service user
and group. The root preparer assigns package group and private config readability
to the configured GID; the child checks both effective IDs before startup.
Root manager ownership of restart reconciliation and the durable unfinished-window
ledger remains mandatory: restarting the HTTP child must never reset a budget.
Private service units, origin, socket locations and host configuration are supplied
by the operator outside this repository. No unit or proxy installation is performed.

Optional HTTP beta configuration now receives closed-field grammar validation
against Runtime checkpoint `1b2dc432b` before packaging, with a 16384-byte operator
file cap and duplicate-key refusal. This cap is a packaging restriction. All nine
fields are required; account/token/role/limits additions refuse. The file remains
externally root-managed and byte-pinned. Shape validation alone authenticates no
launcher, workspace or manager peer; manager process composition and those
qualification gates remain pending the manager-owned implementation.

### Outer release composition

The agreed layout separates the immutable selected package from its unit entry:

```text
release/
  start-service
  release.json
  package/
    manifest.json
    codex_service/entry.py
    ... exact codex_service.package.FILES and UI inventory ...
```

`release.prepare_release` copies a prepared inner package without modifying its
closed inventory, emits a fixed shell wrapper invoking the canonical trusted
Python with `-I -S -B`, and embeds the inner manifest hash in that wrapper.
`release.json` inventories wrapper and inner bytes and pins shell/interpreter.
Its own digest must be retained externally by the root release operator. There
is no circular hash and no relaxation of unexpected-inner-file rejection.
This outer layout supersedes the earlier request to place `start-service` in
`Package.FILES`. The existing dropped-child prototype is not the manager entry.

This is a composition primitive, not complete private package preparation:
inner configuration must already bind the final absolute `release/package`
location, selected account reference and operator paths. Copying a package with
configuration bound to another location cannot qualify startup. Manager `Package`
validation and independent source review remain mandatory. The final package
must use the reviewed successor fixing stopped-child shell-to-Python validation;
`d137e7a7` is a source interface checkpoint only. No actual manager/native/server
startup or installed symlink publication is performed by this module.

### Attended fresh-owner setup

Root may run the exact sealed ordinary server provider-disabled on loopback to
perform existing setup, privately retain generated credentials/owner/conversation
IDs, and stop/reap that exact setup child before beta composition. Packaging does
not implement this private operator sequence or write database rows.

`prepare.py --provisioned-home` explicitly accepts the resulting existing isolated
0700 UID/GID-owned directory without requiring an empty database, reading rows,
changing bytes or copying credentials. Without that option existing homes still
refuse. Custody checks do not prove quiescence or freshness: root must retain the
setup process custody/reap and home provenance evidence. Dedicated native state
and workspace remain separately fresh; bootstrap does not grant provider authority.
The manager-selected package's final home/data layout remains authoritative.

Manager composition source now targets the `d137e7a7` → `89f68` → `0dbb4226`
chain, subject to final independent review. Its authoritative `FILES` and
`MODULES_SERVICE` remain owned by the manager; no inventory is inferred here.
Outer preparation now rejects staging-location launcher/native/supervisor bindings
and mismatched owner/conversation/workspace scope before making the release.
These checks complement, and do not replace, the complete manager `Package`
validator. The 30 nonroot and six explicitly privileged manager checks require
separate CI registration by the workflow owner; prior CI is not their evidence.

### Per-conversation shared workspaces

In a host-full-access plan, `conversation_workspaces` pins each conversation's
Codex or Claude Deep/Fast working directory. A string path retains the ordinary
service-UID ownership requirement. A foreign-owned directory needs an explicit
closed entry such as `{"path":"/srv/shared-project","shared":true}`. Runtime
requires a named POSIX access ACL entry for the service UID granting `rwx`, an
ACL mask granting `rwx`, and no world-write bit. Group permissions alone do not
qualify. The directory must remain canonical, existing, and outside Core home;
symlinks and path aliases refuse. Custody is checked again after configuration
loading. The product never changes directory ownership or ACLs.

The packager and both provider launchers recognize the same closed shape. This
opt-in affects only the pinned conversation directory; Worker directories and
the private service home, account, executable, and configuration custody rules
retain their existing checks.

Outer release preparation now requires root and explicit `service_gid`, matching
inner `service.json.gid`. It creates root:service-group mode0750 outer traversal,
assigns the copied protected tree to that group without changing its bytes/modes,
and records UID/GID/mode for every directory/file plus receipt custody. The wrapper
is root:service-group0550 and receipt0440. No operator permission repair is needed.
The explicit privileged synthetic suite probes the generated layout as UID995:
GID986 before any test mutation, then demonstrates the original0700 refusal.
It only reads a synthetic text file; it never executes the packaged entry/native.
Run `test_release.py` explicitly as root; run `test_service.py` unprivileged.

### Full selected persistent service preparation

`selected.py` is the root-only preparation entry for the complete new persistent
manager package. Run with an explicit private operator plan:

```
sudo /usr/bin/python3 -I -S -B v2/packaging/service/selected.py --plan /operator/private/plan.json
```

The closed plan has format `orkestr-v2-selected-service-plan-v1` and fields:
`output`, `source_repository`, `pair`, `pair_sha256`, `server`, `ui`, `native`,
`native_sha256`, `uid`, `gid`, `home`, `workspace`, `state_root`, `auth_file`,
`bootstrap_file`, `ledger_directory`, `endpoint_directory`, `owner_id`,
`conversation_id`, `namespace`, `supervisor_key`, `origin`, `port`.
Paths and bindings are explicit; there are no deployment defaults. The existing
home must contain private service-owned `data` and `provider-home` directories.
Normal API provisioning may already have populated `data`; preparation leaves
it untouched. Workspace/native state must be empty. Root-owned manager and
endpoint directories may be absent or pre-reserved empty with configured group
and modes 0700/0750 respectively. Existing nonempty state is refused.

The exact clean paired Git source must descend from qualified persistent Deep
beta `f6fb00a461d792af22ec15c80d089c266081ca3b`, including the reviewed
paused-launch and retirement corrections. Source is exported from Git blobs;
mutable checkout modules are never imported. Its authoritative `FILES` and
`MODULES_SERVICE` define the closed inner package. Pair version must be
`2.0.0-beta.1` through `2.0.0-beta.6`, with matching embedded native/web identities and release profiles.
Synthetic ELF fixtures only exercise packaging; they are never launched.

Output is final-path-bound `start-service`, `release.json`, and `package/`.
The wrapper pins the inner manifest; the outer receipt binds wrapper, inventory,
custody, pair/native digests and shell/Python startup pins. Package dependencies
are the manager's exact authoritative fixed dependency set. Manager/launcher
entries use pinned Python `-I -S -B`; the inner protected entry validates its
manifest before importing package modules. Canonical auth and bootstrap references
are checked by metadata only, never read, hashed, or copied. The full authoritative
Package validator runs before publishing the outer entry/receipt.

Run preparation only in a stable trusted root-managed namespace. This is not an
atomic service activation protocol: interruption may leave unpublished staging,
and must be inspected explicitly before choosing another fresh release path.
No source directory, state directory, existing release, or credential is repaired.
No service, native binary, provider, setup API or account is invoked. Real paired
artifact qualification and manager lifecycle acceptance remain separate gates;
the old bounded-v1 installer is unchanged.

The runtime beta configuration is root:configured-service-group **0640**; other
immutable JSON/module files remain 0440. The selected release receipt pins only
the manager's fixed four dependencies plus the outer shell/Python startup files.
It does **not** qualify the complete transitive interpreter/stdlib/cache/native
ELF closure. An external complete startup-closure receipt must be captured and
reverified before actual execution. `transitive_startup_closure_qualified` remains
false in this preparation receipt.

Before any pair/server/native/UI read or hash, a metadata-only boundary verifies
canonical regular inputs, single-link credential and artifact files, disjoint
credential/artifact inode identities, and the complete UI tree without following
symlinks. Credentials inside the UI tree are refused. This requires the same
stable trusted namespace as preparation; subsequent hostile path replacement is
not prevented by this preflight.

### Beta.2 companion and Worker profiles

An optional `roles` plan field enables the existing Fast companion and exactly
four bounded Worker slots. Its shape is `{"fast":{"workspace":"/private/fast",
"state_root":"/private/fast-state"},"workers":[...]}`, with four analogous
Worker entries. Every path is operator supplied. Each generated launcher pins
one literal role; HTTP inputs cannot select its executable, profile or account.
All six native homes are disjoint; read-only workspaces may be shared. A native
home can contain separately bound sessions from different conversations; this
is role/slot separation, not per-conversation filesystem isolation. Worker
launchers accept fresh sessions only, and slot reuse requires original cleanup.
The one outer manager/window retains aggregate limits across these roles.

An explicit `preserve_state: true` plan permits preparing a new immutable package
against existing private application/native state and protected manager roots.
Preparation leaves those contents untouched and does not stop the old service.
The release operator must stop and join the old manager before activation and
retain a rollback snapshot. The new manager's ordinary transactional ledger
migration preserves historical windows, generations and consumed budgets;
unfinished work remains subject to reconciliation. This flag supplies no proof
of quiescence and grants no permission to replay an unfinished window.

### Beta.3 opt-in project commands

The optional `workspace_exec` field requires `roles` and is copied into the
protected beta configuration. Its closed fields are `conversation_id`,
`project_id`, `workspace`, `allowed_roots`, `protected_roots`, `cgroup_root`, and
`toolchain_root`. Use one explicitly selected conversation and one registered
project: `allowed_roots` must equal `[workspace]`. All values are trusted operator
configuration; no browser or native tool argument supplies a path or profile.

Provision a private service-owned full Git clone with its Git/common directory
inside that workspace, separate from Core, native account, credential and provider
scratch roots. Include all private credential/account locations in
`protected_roots`. Provision the Runtime's root-owned immutable command image and
an empty delegated cgroup2 subtree with memory, pids and cpu controllers. Startup
performs read-only readiness checks; packaging does not create those resources.

Only Workers for the exact conversation expose `orkestr_workspace_exec`, whose
only argument is a bounded `command` string. The provider retains its read-only
mounts and subprocess prohibition. The separate command sandbox receives only
the retained project descriptor as writable `/workspace`, the immutable image,
private temporary storage, and no network or provider credentials. Core checks
the current project, Worker, parent, lease and control revision at delegation,
single consumption, actual spawn and result delivery.

This opt-in uses the existing renewable Worker budget with a five-minute host
ceiling, further narrowed by the owner's task budget and the shared window.
Each command is at most 30 seconds and is clipped to its original consumed lease;
output is at most 128 KiB. Pending commands are never renewed or retried. Stop
waits for the retained original command cleanup before confirming native Stopped.
Native result delivery remains separate from assistant progress and acceptance.
Real command execution, cancellation, restart and preserved-history qualification
are required separately from this inert packaging step.

An optional `workspace_exec.trusted` object selects the trusted owner profile
described in `docs/v2/workspace-exec.md` (host toolchains, optional network,
longer limits, detached jobs, explicit credential/skill allowlists that default
to empty). Packaging checks only its closed shape; Runtime validates limits,
overlaps and credential defaults at startup. It requires a command image whose
supervisor supports the sealed layout mode.

The optional plan field `host_full_access` (instance-level, equivalent to host
root; see `docs/v2/workspace-exec.md`) is validated with the same closed shape
and copied into the protected beta configuration. A trusted profile with
`host_privileged` requires it. The release receipt records
`host_full_access_enabled`. When `host_full_access.providers` is true, the plan
must also pin `code_mode_host` and `code_mode_host_sha256` (the same Codex
release's `codex-code-mode-host`), which is packaged beside `native`. No other
package may carry it.
