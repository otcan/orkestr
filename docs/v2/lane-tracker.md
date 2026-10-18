# First-wave execution ledger

Snapshot: 2026-10-18. Plan baseline: `a7ba6d5999c570c21cc717d78c83cf53622c22c9`.
The [workstreams backlog](workstreams.md) remains authoritative. The operator
coordinator reports one dedicated epic and 32 mapped tasks. The issue mapping and
runtime identities are retained in private operator tracking, outside this public
repository. No existing 1.x issue was changed. Tracker state is not implementation
or acceptance evidence.

## Admission and evidence

| Lane | Branch | Admitted work | Reported PR / exact tested head | Tests / CI |
|---|---|---|---|---|
| Coordinator | `v2/s0-contract-integration` | Additive integration candidate; held for isolation fix and review | [PR #80](https://github.com/otcan/orkestr/pull/80), `76f9c6cd91e094329ae5c29c7e95f301366ed02a` | Local locked workspace: 27 Rust tests, including a runner with 7 nested Python scenarios; 4 separate mocked Python tests; fmt/clippy/boundaries passed. CI at earlier `aec7475b` passed; latest-head CI requires query |
| Core | `v2/s0-core` | LIGHT contract/review support and bounded isolation fix | [PR #78](https://github.com/otcan/orkestr/pull/78), `f8e1af18b5c88df753623e3a69f7240f56080a0e` | Reported 4 Rust tests including a runner with 7 nested Python scenarios; [exact-head CI](https://github.com/otcan/orkestr/actions/runs/39132972264) passed. Database-alias failure blocks integration |
| Runtime | `v2/s0-runtime` | Admitted heavy: offline adapter; shared typed-port migration pending; no own store | [PR #76](https://github.com/otcan/orkestr/pull/76), `5481e6b0b7c9cc932d23fccb95bd6eea43221551` | Candidate P2 fixes included in PR #80; combined locked runtime tests: 16 passed. Independent fix review pending; volatile retry is not crash durability |
| UI | `v2/s0-ui` | Explicitly admitted heavy after core cycle completed; implementation pending | [PR #73](https://github.com/otcan/orkestr/pull/73), `be36a064443f562329da80468713663d5f805801` | Independent docs review found no blocker. Fixture JSON syntax only; no UI build/native acceptance. macOS simulator path pending |
| Verification | `v2/s0-verification` | Light independent implementation review and executable probes | [PR #75](https://github.com/otcan/orkestr/pull/75), `c42b88eed8894430d9cfb6f2be8bda29ec0e800f` | Independently built core `28c47793`; 4 black-box probes: 3 passed, 1 failed (database symlink isolation). Coordinator source-reviewed probes and evidence. Broader inventory: 0 passed/17 pending |

Current admission: runtime and UI are the two heavy implementation lanes; core
provides light contract/review support and the bounded isolation correction.
Verification reviews implementation; coordinator reviews verification artifacts.
No additional workers were created.

Host observation at admission: load averages 10.51 / 6.94 / 5.05, approximately
41 GB available memory. Retain at most two heavy implementation lanes and one
heavy compile. Existing 1.x work keeps priority. All Rust builds/tests use the
operator-provided `v2-cargo` wrapper with separate lane target/home directories;
private host paths and runtime identities stay outside this repository.

## Shared commit sequence

1. Core publishes a small authoritative contracts/build commit, pins Rust
   1.99.1, and supplies the intended workspace members/dependencies and first
   locked build/test evidence. Core owns schema and migration changes.
   Core has confirmed it will commit the initial toolchain and lockfile;
   coordinator has acknowledged this as the serialized integration input.
2. Coordinator reviews and integrates workspace membership and `v2/Cargo.lock`.
   Core's initial lockfile is the input; later dependency changes are serialized
   through coordinator. Runtime/UI must consume shared contracts rather than
   create competing DTOs, schemas, databases, or lockfile resolutions.
   Core also publishes fixture paths, contract/schema version and pinned commit
   for UI consumption. UI has received this handoff and explicit heavy admission.
3. Verification independently reviews the implementation PR at its exact head.
   Coordinator reviews Verification's authored fixtures/tests. Any new revision
   needs checks and review for that revision.
4. Only independently reviewed, green PRs may integrate into
   `v2/rust-rewrite`. No main merge, release, tag, or deployment is authorized.
5. After core's first PR and release of its heavy slot, explicitly admit UI.
   Merely creating a PR does not free a slot if core continues heavy work.

## Outstanding gates

- Reproduced P1: database symlink escapes isolated home and mutates its target.
  Refusal before mutation is required; foreign/future schema and live WAL/SHM
  preservation remain pending. The claimed header deadline also needs evidence
  or narrower documentation. Green CI does not waive these findings.
- Core contracts/fixtures published at `afcb14ac412e31c362b120bd02d8353dc0e09314`:
  `v2/fixtures/*.json`, `v2/crates/contracts/src/lib.rs`,
  `docs/v2/api-v0-intake.md`. Root integration and independent review pending.
- Archive handoff: reviewed SQLite commit `ef759a48` (25 tests reported) and
  isolated UI spike `dcf099b1` (6 tests/WASM reported) remain read-only references.
  Reuse applicable tests/components after contract comparison. Unmanaged PR #77
  is held as reference-only: do not merge its store, manifests or lockfiles.
- The integration base advanced five commits from the plan to `2c9e1001`.
  Its journal format, domain/demo, lockfile, toolchain, CI and parity inventory
  must be preserved or explicitly reconciled through review; no base reset.
  Private source snapshots captured all four preserved archive worktrees,
  including staged/working patches and nonignored untracked files. Source
  statuses were unchanged; ignored build/cache files were excluded.
- Dedicated v2 epic/tasks: materialized per operator report; mapping retained privately; coordinator
  supplies exact-head evidence for the operator to mirror to those issues.
- Every implementation PR: exact head, commands, test counts, independent review,
  exact-head CI URL and unresolved acceptance cases.
- Local OXRM implementation/readiness verification: pending; no ready claim.
- M1 server durability, nonblocking input, deterministic stop, restart, real UI,
  and iOS feasibility evidence: pending. No runnable demo is claimed.
- Prepare narrowly scoped unsigned macOS simulator CI under existing workflow
  policy, with pinned tooling and no signing, secrets, publication or paid-service
  changes. Linux is the current native environment blocker, not a permanent waiver.
- Real persistent subscription-backed fast/deep/worker verification belongs to
  the later provider gate; fake tests cannot satisfy it.

Update this snapshot when a lane supplies evidence; preserve the distinction
between admitted, running, committed, tested, reviewed and integrated work.
