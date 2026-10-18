# First-wave execution ledger

Snapshot: 2026-10-18. Plan baseline: `a7ba6d5999c570c21cc717d78c83cf53622c22c9`.
The [workstreams backlog](workstreams.md) remains authoritative until the dedicated
v2 epic and stable task-ID mapping are returned by the operator coordinator.
ORK-534 is reference context only. Jira availability does not gate implementation.

## Admission and evidence

| Lane | Branch | Admitted work | Reported PR / exact tested head | Tests / CI |
|---|---|---|---|---|
| Coordinator | `v2/s0-coordination` | Running light: dependency integration, backlog, review routing | This ledger; implementation head pending | No Rust tests run by coordinator; CI pending |
| Core | `v2/s0-core` | Running heavy: first shared contracts/build, then store/API | Awaiting first commit/PR; initial head is plan baseline | First build and test counts pending |
| Runtime | `v2/s0-runtime` | Running heavy: provider port, fake runtime, session supervision | Awaiting first commit/PR; initial head is plan baseline | Tests pending; live inference out of scope |
| UI | `v2/s0-ui` | Queued heavy; light contract and iOS feasibility work allowed | Awaiting first commit/PR; initial head is plan baseline | Web/native builds pending |
| Verification | `v2/s0-verification` | Running light: inventory, black-box specifications, independent reviews | Awaiting first commit/PR; initial head is plan baseline | No compile until core first build; acceptance pending |

Admission instructions were queued successfully through `orkestr send` to all
four existing lanes. Runtime inventory subsequently reported all four threads
working; this is activity evidence, not proof of a build or task completion.
UI's heavy work remains explicitly unadmitted despite that runtime status.
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
2. Coordinator reviews and integrates workspace membership and `v2/Cargo.lock`.
   Core's initial lockfile is the input; later dependency changes are serialized
   through coordinator. Runtime/UI must consume shared contracts rather than
   create competing DTOs, schemas, databases, or lockfile resolutions.
3. Verification independently reviews the implementation PR at its exact head.
   Coordinator reviews Verification's authored fixtures/tests. Any new revision
   needs checks and review for that revision.
4. Only independently reviewed, green PRs may integrate into
   `v2/rust-rewrite`. No main merge, release, tag, or deployment is authorized.
5. After core's first PR and release of its heavy slot, explicitly admit UI.
   Merely creating a PR does not free a slot if core continues heavy work.

## Outstanding gates

- First shared contract commit, root integration and reproducible clean build.
- Dedicated v2 epic/tasks: requested from the existing operator coordinator;
  issue mapping pending; existing 1.x issues remain unchanged.
- Every implementation PR: exact head, commands, test counts, independent review,
  exact-head CI URL and unresolved acceptance cases.
- Local OXRM implementation/readiness verification: pending; no ready claim.
- M1 server durability, nonblocking input, deterministic stop, restart, real UI,
  and iOS feasibility evidence: pending. No runnable demo is claimed.
- Real persistent subscription-backed fast/deep/worker verification belongs to
  the later provider gate; fake tests cannot satisfy it.

Update this snapshot when a lane supplies evidence; preserve the distinction
between admitted, running, committed, tested, reviewed and integrated work.
