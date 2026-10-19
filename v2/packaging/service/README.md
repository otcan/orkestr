# Persistent beta HTTP service package

This new leaf leaves bounded-v1 and the native installer unchanged. It prepares
an always-on Rust HTTP/API process independently of finite execution windows.
No service unit, provider, browser, account, grant, migration fixture or server
is started by preparation. Linux x86_64 only; other targets are unqualified.

## Frozen build handoff (not executed)

Installation is the single native/WASM build owner after the coordinator freezes
one clean integrated commit. The coordinator owns the workspace/lock version
`2.0.0-beta.1`. Before building, record the full commit, clean tracked/untracked
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
