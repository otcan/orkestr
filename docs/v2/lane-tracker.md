# First-wave execution ledger

Snapshot: 2026-10-18. Plan baseline: `a7ba6d5999c570c21cc717d78c83cf53622c22c9`.
The [workstreams backlog](workstreams.md) remains authoritative. The operator
coordinator reports dedicated epic ORK-569, **[V2] Orkestr 2.0 Rust rewrite**,
materialized with 32 tasks from the pinned plan; first-wave items are In Progress.
ORK-534 is linked as reference only; no 1.x issue was changed. These are reported
tracker facts, not implementation or acceptance evidence.

| Backlog ID | Issue | Backlog ID | Issue |
|---|---|---|---|
| V2-001 | ORK-570 | V2-002 | ORK-571 |
| V2-003 | ORK-572 | V2-010 | ORK-573 |
| V2-040 | ORK-574 | V2-011 | ORK-575 |
| V2-012 | ORK-576 | V2-013 | ORK-577 |
| V2-014 | ORK-578 | V2-015 | ORK-579 |
| V2-030 | ORK-580 | V2-020 | ORK-581 |
| V2-041 | ORK-582 | V2-022 | ORK-583 |
| V2-023 | ORK-584 | V2-021 | ORK-585 |
| V2-024 | ORK-586 | V2-025 | ORK-587 |
| V2-045 | ORK-588 | V2-042 | ORK-589 |
| V2-035 | ORK-590 | V2-031 | ORK-591 |
| V2-032 | ORK-592 | V2-033 | ORK-593 |
| V2-043 | ORK-594 | V2-044 | ORK-595 |
| V2-034 | ORK-596 | V2-050 | ORK-597 |
| V2-051 | ORK-598 | V2-052 | ORK-599 |
| V2-053 | ORK-600 | V2-054 | ORK-601 |

## Admission and evidence

| Lane | Branch | Admitted work | Reported PR / exact tested head | Tests / CI |
|---|---|---|---|---|
| Coordinator | `v2/s0-coordination` | Running light: dependency integration, backlog, review routing | This ledger; implementation head pending | No Rust tests run by coordinator; CI pending |
| Core | `v2/s0-core` | Intake increment committed; independent review pending; heavy-slot yield requested | [PR #78](https://github.com/otcan/orkestr/pull/78), `28c4779346a2d6e46abed5305cd4b6ee7deac060` | Reports 4 Rust tests plus 7 HTTP/process scenarios; [exact-head v2 CI](https://github.com/otcan/orkestr/actions/runs/39132698484) reported green; full acceptance pending |
| Runtime | `v2/s0-runtime` | Running heavy: offline adapter/supervisor; migration to core-owned ports pending, no own store | [PR #76](https://github.com/otcan/orkestr/pull/76), observed `81607879ea0b84f9ed37d74064d36267763a77cd` | Reported 9-test checkpoint versus earlier PR 12-test count needs exact-head reconciliation; earlier v2 CI failed; Codex initialize only, Claude version/help only |
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

- Core contracts/fixtures published at `afcb14ac412e31c362b120bd02d8353dc0e09314`:
  `v2/fixtures/*.json`, `v2/crates/contracts/src/lib.rs`,
  `docs/v2/api-v0-intake.md`. Root integration and independent review pending.
- Archive handoff: reviewed SQLite commit `ef759a48` (25 tests reported) and
  isolated UI spike `dcf099b1` (6 tests/WASM reported) remain read-only references.
  Reuse applicable tests/components after contract comparison. PR #77 proposes
  a separate store/root lock; integration must reconcile with core's authoritative
  intake schema first, rather than introduce competing execution authorities.
- Dedicated v2 epic/tasks: materialized per operator report above; coordinator
  supplies exact-head evidence for the operator to mirror to those issues.
- Every implementation PR: exact head, commands, test counts, independent review,
  exact-head CI URL and unresolved acceptance cases.
- Local OXRM implementation/readiness verification: pending; no ready claim.
- M1 server durability, nonblocking input, deterministic stop, restart, real UI,
  and iOS feasibility evidence: pending. No runnable demo is claimed.
- Real persistent subscription-backed fast/deep/worker verification belongs to
  the later provider gate; fake tests cannot satisfy it.

Update this snapshot when a lane supplies evidence; preserve the distinction
between admitted, running, committed, tested, reviewed and integrated work.
