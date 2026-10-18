# First-wave execution ledger

Snapshot: 2026-10-18. Plan baseline: `a7ba6d5999c570c21cc717d78c83cf53622c22c9`.
The [workstreams backlog](workstreams.md) remains authoritative until the dedicated
v2 epic and stable task-ID mapping are returned by the operator coordinator.
ORK-534 is reference context only. Jira availability does not gate implementation.

## Admission and evidence

| Lane | Branch | Admitted work | Reported PR / exact tested head | Tests / CI |
|---|---|---|---|---|
| Coordinator | `v2/s0-coordination` | Running light: dependency integration, backlog, review routing | This ledger; implementation head pending | No Rust tests run by coordinator; CI pending |
| Core | `v2/s0-core` | Running heavy: confirms contracts/application/store-sqlite/Axum durable intake on pinned baseline; API fixtures forthcoming | Awaiting first commit/PR; initial head is plan baseline | First build and test counts pending |
| Runtime | `v2/s0-runtime` | Running heavy: offline provider/runtime slice; proposed `orkestr-runtime` implements core-owned application runtime ports, no own store | Confirmed clean at `a7ba6d59`; first PR pending | Tests pending; Codex 0.163.0 / Claude 2.1.295 version/help only, no live inference |
| UI | `v2/s0-ui` | Queued heavy; light feasibility checkpoint committed; no Cargo/downloads | [PR #73](https://github.com/otcan/orkestr/pull/73), observed head `66965cdbb6a43df72ced848a22f7a9a7c179ee64`; reported checkpoint `28b7194e` | Web pending; iOS simulator blocked by Linux/missing Apple tools; independent review routed |
| Verification | `v2/s0-verification` | Light inventory/spec checkpoint committed; endpoint probes blocked on core build/fixtures | [PR #75](https://github.com/otcan/orkestr/pull/75), coordinator reviewed `0fa321a291f9d3e29d92b2554068b51405f18d2d` | Reporter: 0 passed/17 pending, exit 1; false-pass mutation rejected; no compile; CI build/tests failed, integration blocked |

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
   Core has confirmed it will commit the initial toolchain and lockfile;
   coordinator has acknowledged this as the serialized integration input.
2. Coordinator reviews and integrates workspace membership and `v2/Cargo.lock`.
   Core's initial lockfile is the input; later dependency changes are serialized
   through coordinator. Runtime/UI must consume shared contracts rather than
   create competing DTOs, schemas, databases, or lockfile resolutions.
   Core also publishes fixture paths, contract/schema version and pinned commit
   for UI consumption. UI has requested this handoff and awaits explicit heavy
   admission.
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
