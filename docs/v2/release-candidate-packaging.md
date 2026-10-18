# Linux x86_64 paired release candidate

This automation prepares `2.0.0-rc.1` from one exact clean source revision. It does
not publish, deploy, configure providers or read existing application homes.
Supported scope is Linux x86_64 with the existing native host path checks and
Linux amd64 Docker base. macOS, ARM and executor isolation are not implied.
The same-source aa8 checkpoint has completed bounded native and Docker acceptance,
schema14→17 upgrade/refusal/rollback, and a finite attended probe. Its committed
checkpoint records pin the artifacts and limitations. This is historical schema17
evidence; final Core24 package acceptance and the production 72-hour window remain
**unexecuted**. Earlier mixed-source checkpoints do not satisfy the same-source gate.

The coordinator/build owner owns the admitted build slot and workflow registration.
Do not start a duplicate build. All commands below are explicit owner/CI invocations,
not work performed by package verification. The workflow insertion fragment is
`v2/packaging/candidate/ci-steps.example.yml`; it is not an installed workflow.

## Build-owner contract

Use a clean checkout at the exact integration commit, an authorized `V2_CARGO`
wrapper, preinstalled toolchain/offline caches, and a fresh output outside the
checkout. The script sequentially builds the default-feature release server and
calls the canonical `v2/apps/ui/scripts/bundle.sh`. That script pins
wasm-bindgen 0.2.129 and release/offline/locked wasm32 web features. This helper
installs nothing and makes no build-capacity/admission decision.

```sh
python3 -B v2/packaging/candidate/build_pair.py \
  --checkout "$CLEAN_CHECKOUT" --source "$EXACT_COMMIT" \
  --version 2.0.0-rc.1 --output "$FRESH_PAIR_DIR" \
  --wrapper "$AUTHORIZED_CARGO_WRAPPER" \
  --cargo-home "$OFFLINE_CARGO_CACHE" --rustup-home "$INSTALLED_RUSTUP_HOME" \
  --required-glibc "$VERIFIED_REQUIRED_GLIBC"
```

The producer defaults to the web-only bundle. To explicitly include execution
controls, add `--execution-controls` to `build_pair.py`. This supplies
`UI_EXECUTION_CONTROLS=1` and `UI_SERVER_CANDIDATE` equal to the exact source
revision to the canonical bundle command. The receipt then declares web features
`[web, execution-controls]` and `web.server_candidate` equal to that source;
verification rejects a missing or different binding. The standalone receipt
sealer accepts the same explicit flag as a producer declaration, not proof that
controls were exercised. This flag does not activate providers or execution.

Both build children receive a minimal environment, fresh HOME, explicit offline
caches and unique target/output directories. The declared Cargo cache bin directory
is prepended to PATH so the canonical bundle can find its pinned wasm-bindgen.
For a separately installed tool, pass `--bindgen-bin "$INSTALLED_BINDGEN_BIN"`;
this executable directory takes precedence over the Cargo bin and inherited PATH.
The canonical bundle still enforces version 0.2.129. No tool directory path is
written into the receipt.
An admission wrapper may enforce its own Cargo/Rustup cache paths; the build owner
must supply matching installed caches for both wrapper and direct bundle tools. Provider and application environment
variables are excluded. Cache paths and host environment values are never written
into receipts. Authorized wrappers requiring additional operator environment must
be adapted by their owner; do not bypass their admission controls. Required glibc
is an explicit inspected producer input, not inferred or certified by this helper.
The base must be separately inspected for compatible architecture/glibc and pinned
by immutable digest; assembly does not pull or inspect a daemon.

`paired-artifacts.json` records exact source, version, server size/hash/profile/
features, complete sorted web relative-file size/SHA inventory and its canonical
JSON digest, committed migration SQL hashes, toolchain-file hash and wrapper/tool
pins. Clean checkout is checked again after both builds. Untracked source files
are refused. These are producer declarations and hash integrity, not signed build
attestation, a trusted compiler claim or proof against source mutation during a
build. Retain build logs and receipt alongside the candidate. Bit-for-bit compiler
reproducibility is unverified.

## Assemble and verify without launching

```sh
python3 -B v2/packaging/candidate/package_candidate.py assemble \
  --binary "$PAIR_DIR/server" --ui "$PAIR_DIR/ui" \
  --paired "$PAIR_DIR/paired-artifacts.json" --output "$FRESH_CANDIDATE_DIR" \
  --base "$INSPECTED_BASE_REPO_DIGEST" --port "$ASSIGNED_PORT"
sh v2/packaging/candidate/ci-verify.sh "$FRESH_CANDIDATE_DIR"
python3 -B v2/packaging/candidate/archive.py \
  --candidate "$FRESH_CANDIDATE_DIR" --output "$NEW_ARCHIVE_PATH"
```

Assembly requires a release/default-feature server, rejects fixture-test features,
and puts matching version/source/schema/receipt-hash metadata in the native and
container manifests. `candidate.json` inventories every distribution file, including
the paired receipt, both web manifests and Docker build inputs. Verification
refuses mixed-source metadata, modified or additional files and symlinks. The
archive normalizes gzip/tar timestamps, ownership and ordering; repeated archives
of the same verified directory have identical hashes. Fresh Docker project names
are intentionally unique, so independently assembled context bytes differ. Retain
the emitted archive SHA and candidate-manifest SHA; manifests are not signatures.

Packaging and verification never open an application database or run migrations.
Only an explicit server start may initialize/migrate state. The migration inventory
is product schema metadata; HTTP `schema_version` is a different contract.

## Explicit isolated acceptance

After source review and build-owner artifact admission, use a fresh private parent
and assigned unoccupied loopback port. The native runner checks all generated web
asset bytes, synthetic auth/history/idempotency, running backup refusal, stopped
SQLite backup, exact initialized migration inventory, dormant apply/start-refusal/
rollback, restart/history and five health samples. It creates only new homes.

```sh
python3 -B v2/packaging/candidate/accept_native.py \
  --candidate "$CANDIDATE_DIR" --parent "$PRIVATE_PARENT" \
  --port "$ASSIGNED_PORT" --output "$NEW_NATIVE_EVIDENCE"
```

Native success removes its synthetic state; failures stop the owned launcher and
retain private diagnostics. For a genuine cross-version upgrade, separately run
`v2/local-install/tests/cross_revision.py` with pinned supported old/new executables.
That probe preserves a pre-upgrade SQLite backup and untouched full-home rollback
copy. Never run an old executable on a migrated working database; compatibility
refusal uses a separate disposable copy. See `local-install-helper.md` for the
executed 14-to-15 checkpoint. Dormant imports have no activation/rebinding API.

For Docker, inspect the candidate's fresh project/tag and Compose digest before
building. The build owner builds only that context with the admitted local base:

```sh
sudo -n docker build --pull=false --network=none \
  --build-arg "BASE_IMAGE=$INSPECTED_BASE_REPO_DIGEST" \
  --tag "$OWNED_CANDIDATE_TAG" "$CANDIDATE_DIR/docker"
python3 -B v2/packaging/candidate/accept_docker.py --sudo \
  --candidate "$CANDIDATE_DIR" --reviewed-image-id "$REVIEWED_IMAGE_ID" \
  --reviewed-compose-sha256 "$REVIEWED_COMPOSE_SHA256" \
  --output "$NEW_DOCKER_EVIDENCE"
```

The Docker runner preserves the existing preflight/cleanup authority: exact image,
Compose digest, fresh project/volume and loopback-only publication. It adds all-asset
verification, synthetic intake, exact initialized schema, health samples and
stopped same-image dormant backup/apply/refusal/rollback. The outer probe removes
the owned project/volume/image even if added acceptance fails. Cleanup failure is
an error requiring inspection. No host mounts, Docker socket or credentials are
copied; nonroot/read-only/cap-drop/no-new-privileges remain mandatory. The trusted
control plane has allowed bridge egress; untrusted executor containment is separate.

## Bounded health recording

```sh
python3 -B v2/packaging/candidate/soak.py \
  --origin "$EXPLICIT_LOOPBACK_ORIGIN" --samples 60 --interval 1 \
  --timeout 2 --max-latency-ms 1000 --output "$NEW_SOAK_EVIDENCE"
```

This finite command never launches a server, opens a database, sends auth or
registers a recurring job. It disables proxies and records sample latency/success,
UTC timestamps, monotonic offsets/duration, error type, consecutive failure count,
health recovery transitions and p50/p95/max, without response bodies or credentials. Any failed
sample or exceeded explicit latency threshold exits nonzero. Output is reserved
before requests so an existing evidence file prevents any sampling. A recovered
health endpoint does not prove a process restart. Crash, restart and revocation
coverage are explicitly unexecuted in this read-only recorder; owned lifecycle
acceptance and authenticated revocation checks require separate evidence. Results are health latency, not load capacity, browser,
provider reliability or a production acceptance claim. Choose the duration and
latency thresholds explicitly in the release gate; this helper supplies evidence,
not an implicit passing threshold.

## Finite attended native supervisor

`attended.py` owns a fresh synthetic home and foreground launcher, validates the
candidate before install, and reserves a new evidence file before starting.
It never attaches to existing state. Example (after independent source review):

```sh
python3 -B v2/packaging/candidate/attended.py \
  --candidate "$FRESH_CANDIDATE_DIR" --parent "$PRIVATE_PROBE_PARENT" \
  --port "$ASSIGNED_PORT" --samples 60 --interval 1 --restart \
  --max-latency-ms 1000 --max-rss-bytes 1073741824 \
  --output "$NEW_ATTENDED_EVIDENCE"
```

The optional single graceful restart verifies original synthetic history. Each
sample checks health, explicit latency and aggregate RSS for the launcher's
private process group using read-only Linux `/proc`. RSS can double-count shared
pages; it excludes external services and does not certify leak freedom or load
capacity. Spacing is limited to 600 seconds total; per-request deadlines and
bounded startup/stop add overhead. Failures exit nonzero, attempt exact-child
cleanup and retain the private diagnostic home. Success removes that home.
SIGINT/SIGTERM trigger cleanup; SIGKILL/power loss cannot guarantee cleanup.
Crash recovery, revocation, browser/provider behavior and a production soak window
remain unexecuted. This is an attended, finite nonprovider probe, not a completed
unattended or production soak. Actual supervisor execution requires a separate
checkpoint; synthetic unit tests alone do not qualify it.

The cross-revision native harness accepts `--new-schema 17` for the pinned
schema14-to-current17 checkpoint. Its rollback starts the untouched stopped
schema14 home with the original executable. Only a disposable migrated copy is
opened by the old executable to verify refusal; the working migrated database is
never downgraded. The old package uses the supplied UI solely as static packaging
input; this does not claim historical old-server/old-UI browser compatibility.

## Segmented monitor preparation (no production window started)

The release-evidence contract requires actual daily-use production, at least 72
hours after the candidate build, zero incidents/material fixes, and contiguous
segments no longer than one hour. It rejects gaps, overlaps, changed revision,
artifact/configuration, fixture-only observation and invented elapsed time. The
release validator remains authoritative; this monitor does not issue a release
approval or change the existing release contract.

The existing `attended.py` supervisor now accepts `--journal-dir` (fresh, disjoint
absolute directory) and `--segment-seconds` (1–3500, default 300). This is the same
supervisor and owned child, not another service or scheduler. The optional mode
supports a finite maximum of 259200 observations/spacing seconds. Do not launch a
72-hour invocation before candidate gates and explicit daily-use authorization.
No timer, service, automatic retry or recurring job is installed.

The durable journal contains fsynced JSONL observations and an atomically replaced
`window.json`. Samples carry actual UTC time, monotonic offsets, health/latency
and owned-process RSS. Segment boundaries use actual observation times, with the
previous end exactly equal to the next start; final cleanup time is excluded.
Identity includes exact source, candidate inventory hash, and a digest of the
installed configuration plus monitor limits/port/provider policy. Configuration
contents and secrets are never exported. Artifact inventory is reverified and
configuration rehashed on each observation. Sampling gaps beyond the declared
10-second-or-interval-plus-five limit and wall-clock drift over two seconds
invalidate the window. Segments have a 100-second safety margin below one hour;
a suspended monitor is an incident, not missing time filled afterward.

Any failure, interruption, hash change, graceful restart, or cleanup failure
writes a reset-required incident. A material identity change also increments the
material-fix count. Restart evidence remains useful diagnostically but cannot be
concatenated into an uninterrupted passing window. Resuming an existing journal
is refused. SIGKILL/power loss may leave `observing` rather than a final incident;
that unfinished journal is invalid and must never be resumed or promoted.
`segments.validate` rejects incomplete, invalidated, discontinuous or changed
identity records; release evidence additionally requires its own duration,
environment and freshness gates plus independent inspection of the raw logs.

The currently implemented supervisor adapter owns **fresh synthetic native
state** and deliberately emits `environment: synthetic_owned`. It does not attach
to or restart an existing daily-use service and cannot satisfy the production
soak gate. The persistent foreground adapter below supplies isolated lifecycle and
monitor attachment commands. Candidate gates, exact configuration identity
and owner-approved daily-use routing remain prerequisites
before that environment can honestly be recorded. Do not relabel synthetic
records or concatenate separate successful runs. No production monitor or
72-hour window has been started by this implementation.

## Final Core24 rerun checklist (build owner coordinates exact pins)

Once Core24 and the final reviewed runtime/UI are integrated, freeze one clean
commit and obtain the coordinator's **single** qualified release server + matching
controls-enabled web pair. Record source, profile/default features, web features
and exact server binding, artifact hashes, migrations through 0020 and compatible
glibc base. Do not rebuild or relabel stale aa8 as Core24.

1. Coordinator reruns the repository's locked/offline fmt, strict all-target
   Clippy, server/store/runtime/UI tests, UI scenario/Node checks and canonical
   WASM bundle. Core independently verifies populated migration inventories,
   checksums, foreign keys, reopen and current execution/Stop fencing. Exact final
   source/test commands belong to those owners; no schema logic is inferred here.
2. Run candidate receipt verification, candidate synthetic tests, Docker
   packaging tests, assembly verification and deterministic archive checks against
   the new pinned pair. Reinspect architecture/required ELF glibc vs pinned base.
3. Run `accept_native.py` and `accept_docker.py` on newly assigned private
   state/port/image/project. Require actual migrations 1–20, all served UI hashes,
   synthetic auth/history/idempotency, stopped consistent backup, dormant
   apply/refusal/rollback, loopback publication, restrictions and owned cleanup.
4. Run `cross_revision.py --new-schema 24` with retained schema14 source31d8 and
   new Core24 artifacts; then separately extend/use the harness for a pinned
   populated schema17 aa8→24 case after Core confirms supported migration edges.
   The harness now supports explicit `--old-schema 17 --new-schema 24`; its synthetic
   inventory/edge tests pass, but the actual17→24 run remains unexecuted. Preserve
   complete stopped pre-upgrade homes/backups; use only disposable migrated
   copies for old-binary refusal. Never downgrade a migrated live database.
5. After review of segmented monitoring, run a short fresh owned segmented probe
   and finite graceful-restart diagnostic separately (restart invalidates a
   continuous journal). Verify incidents/gaps/hash-change refusals and cleanup.
   Existing aa8 evidence is historical; none of these Core24 runs is executed yet.
6. Release owner validates all full-candidate gates before authorizing any real
   persistent daily-use adapter/window. Production soak, crash/revocation,
   providers, executor containment and production deployment remain separate
   unpassed gates unless supported by new exact evidence.


## Persistent isolated lifecycle adapter (opt-in, source preparation)

`v2/packaging/candidate/persistent.py` reuses the native launcher and segmented
journal. It creates a fresh persistent V2 home and private plan; it does not
install a service, change V1, copy credentials, or configure providers/routing.
The foreground adapter owns its child process group. SIGINT/SIGTERM attempts a
bounded graceful stop, retaining home and logs. Unexpected exit, hash changes,
health/resource failure or interrupted monitoring invalidates the window.
Cleanup failure cannot finalize a passing window. A hung child is reported;
there is no unconditional kill-tree guarantee.

Example template (all paths and port are explicitly assigned by the operator):

```sh
python3 -B v2/packaging/candidate/persistent.py --plan "$PRIVATE_PLAN" prepare \
  --candidate "$VERIFIED_CANDIDATE" --home "$FRESH_V2_HOME" --port "$V2_PORT"
python3 -B v2/packaging/candidate/persistent.py --plan "$PRIVATE_PLAN" start \
  --validator "$RELEASE_VALIDATOR" --evidence "$CANDIDATE_EVIDENCE" \
  --scope "$RELEASE_SCOPE" --artifact-root "$RELEASE_ARTIFACTS" \
  --max-latency-ms 1000 --max-rss-bytes 1073741824
```

Start runs the canonical validator at `candidate` stage for the pinned revision
before spawning. Missing/failed gates refuse start. Plan, installed config,
candidate and installed release inventories are checked. Provider environment
is excluded by the native launcher. No schema upgrade command is implicit in
this adapter; prepare always requires a fresh home. A newly built server can
still initialize its declared schema in that fresh home.

For a bounded attached monitor, add `--journal-dir "$FRESH_WINDOW" --samples 60
--interval 1` to start. This attaches only to the adapter's exact newly launched
child, reusing the existing journal, `/proc` resource collector and proxy-free
health sampler. It records gate-input hashes and exact source/artifact/config
hashes. The monitored child stops at the sample limit; the home persists.
Without a journal the foreground launcher continues until explicit stop or an
incident. Existing arbitrary processes and old windows cannot be attached or
resumed. Each start is a new observation window; restart invalidates continuity.

These windows are explicitly `controlled_project_owned`, **not**
`daily_use_production`. The release validator therefore cannot accept these as
72-hour production evidence. Preparing this adapter starts no service/window;
actual daily-use qualification remains gated on the complete candidate plan,
review and real monitored use. Disposable tests do not execute those gates.

In another shell, use the same private plan:

```sh
python3 -B v2/packaging/candidate/persistent.py --plan "$PRIVATE_PLAN" health
python3 -B v2/packaging/candidate/persistent.py --plan "$PRIVATE_PLAN" logs
python3 -B v2/packaging/candidate/persistent.py --plan "$PRIVATE_PLAN" stop
# Wait for the foreground adapter to exit; live backup refuses its inherited lock.
python3 -B v2/packaging/candidate/persistent.py --plan "$PRIVATE_PLAN" backup \
  --output "$FRESH_STOPPED_BACKUP"
```

Logs remain under the isolated home's `logs` directory. Backup uses the native
exclusive stopped-state SQLite snapshot implementation; never copy a live DB.
Restore/apply and schema changes remain separate reviewed operations. Retain the
pre-upgrade backup and untouched old-schema rollback home when running
`cross_revision.py --old-schema 17 --new-schema 20`; never start the schema17
binary against migrated live20 state. Only its disposable refusal copy is opened
by the old binary. Same-binary rollback is not cross-version compatibility.


### Historical persistent adapter acceptance

`persistent-aa8-checkpoint.json` records the actual reviewed4950 adapter run
against the retained aa8 `2.0.0-rc.1` fixture: 39 samples in 65.462 seconds.
The first uninterrupted30-sample journal passed. The same isolated home was
then restarted and explicitly stopped after nine separate samples; that journal
correctly invalidated and is never joined to the first window. The committed
sample streams retain proxy-free health latency and owned process-group RSS.
All four owned launcher/server PIDs exited, the control socket disappeared and
loopback port19842 was released. Private home, logs and verified stopped backup
were retained for inspection. A synthetic noncredential marker survived restart;
all schema1..17 migration records still carry the original initialization time.
Snapshot schema/rows matched the stopped database; binary hashes differ because
the SQLite snapshot uses DELETE journal mode while the source uses WAL.

This exercised `prepare`, `load`, `serve` under the explicit historical fixture
execution authorization, and CLI `stop`/`backup`. The actual gated `start` CLI
refused invalid evidence before launch. A successful candidate-gated CLI start
was **unexecuted**; no passing gate receipt was fabricated for this old fixture.
No authenticated workflow, Core24 qualification or72-hour window is claimed.


## Current integrated schema24 acceptance preparation

`accept_upgrade.py` verifies two exact already-packaged candidates and emits
`prepared_only_unexecuted` by default. It checks full source/server pins,
contiguous source migration inventories and unchanged historical migration
checksums. Explicit `--execute --parent ... --port ...` invokes the existing
populated upgrade/refusal/rollback harness with the original native packages.
It does not rebuild or relabel either package. The supported harness edges now
include17→24 and14→24; actual supported application behavior remains a Core and
real-binary gate. Schema17→20 remains available for its separately pinned pair.

```sh
python3 -B v2/packaging/candidate/accept_upgrade.py \
  --old "$PINNED_SCHEMA17_CANDIDATE" --new "$NEW_SCHEMA24_CANDIDATE" \
  --old-source "$OLD_EXACT_SOURCE" --old-sha "$OLD_SERVER_SHA256" \
  --new-source "$NEW_EXACT_SOURCE" --new-sha "$NEW_SERVER_SHA256" \
  --new-schema 24
# After exact artifact/source review and assigned disposable resources:
# append --execute --parent "$PRIVATE_PARENT" --port "$ASSIGNED_PORT"
```

The real probe retains a pre-upgrade snapshot and untouched stopped old-schema
home. Only a disposable copy of the migrated DB is opened by the old executable
for intentional refusal. A failed backward refusal or changed inventory fails
acceptance; it does not downgrade the working DB. Schema24's control revision
backfill and schema22's production-run rebuild require Core's populated run
migration tests in addition to Installation's synthetic message history smoke.
The optional SQL-source test uses `ORKESTR_V2_MIGRATIONS_DIR` to read current
migration files, checks history/FKs/reopen, and skips explicitly without schema24.
It is neither SQLx checksum validation nor a real server upgrade receipt.

For the new qualified same-source pin, run candidate verification, fresh native
acceptance, reviewed owned Docker acceptance, then exact17→24 upgrade/refusal/
rollback. Record each result independently. Native and Docker target qualification
must verify Linux x86_64/amd64, actual ELF architecture, required symbol GLIBC
versions versus the host/base, package version/source/schema alignment, and
actual origin/health/static behavior. Verification now independently checks ELF
architecture as well as the paired/candidate/native target and source fields;
those integrity checks do not prove a producer's build claims or compatibility
on untested distributions. macOS, ARM and other Linux targets remain unqualified.
No new build or actual schema24 server run is performed by these preparation
commands; old aa8 receipts cannot be transferred to the new revision.

### Why successful gated CLI start is still pending

The historical fixture was authorized only for bounded `serve` API testing.
There is no supplied current, passing canonical candidate evidence packet bound
to that exact artifact/configuration. No placeholder packet can substitute for
real qualifications. The canonical candidate stage requires the development
fixture/recovery and current CI baseline plus production runtime, both real
provider paths, inventoried workflow parity, migration, security, installation,
web and performance evidence. Each needs exact revision/artifact/configuration,
required cases, retained hash-verified artifacts and freshness. The validator
owns these requirements; Installation must not mark them passed on its behalf.
72-hour soak and cutover are later full-release gates, not prerequisites invented
by the launcher. Building the new ordinary server alone does not pass these gates.

A real launcher defect is now corrected: a passing validator report for the same
revision must also name the selected candidate artifact hash, exact configuration
hash and package version. `prepare` writes a private adjacent
`PLAN.configuration.json` containing the canonical configuration bytes; its file
SHA equals the plan's `configuration_sha256`. Place those exact bytes in the
private evidence artifact root and reference their SHA, together with the exact
candidate manifest, when the canonical evidence packet is legitimately assembled.
This exports no provider credentials. The paths in this file are private runtime
configuration; do not commit it. Validator selection remains trusted operator
input and is not cryptographic canonical-provenance attestation.
