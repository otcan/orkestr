# Orkestr 2.0 execution program

Status: plan ready for first implementation, 2026-10-18. Canonical integration branch: `v2/rust-rewrite`. Follow [architecture](README.md), [first implementation](first-implementation.md), and [migration](migration.md). All task IDs below are backlog IDs, not claims that Jira issues or code already exist.

## Delivery model

Build a replacement in successive end-to-end increments, not a file-by-file translation. Keep 1.x available as the behavioral reference. Do not wait for a complete inventory of every optional integration before starting an isolated core. Freeze the first-slice contracts first; extend them through reviewed changes.

Use five NEW threads. Existing features workers, their branches and pending PRs retain their assignments.

| New thread | Initial ownership | Branch |
|---|---|---|
| `orkestr-v2-coordinator` | Architecture, contracts, dependency integration, backlog/evidence map | `v2/s0-coordination` |
| `orkestr-v2-core` | Domain, SQLite, ingress/auth/API, authoritative schema | `v2/s0-core` |
| `orkestr-v2-runtime` | Session/supervision interfaces, fake runtime, real-provider capability adapters | `v2/s0-runtime` |
| `orkestr-v2-ui` | Dioxus web UI and early iOS feasibility/build | `v2/s0-ui` |
| `orkestr-v2-verification` | Independent acceptance, security/failure probes, migration inventory | `v2/s0-verification` |

Each uses an isolated worktree based on the finalized plan commit. Do not check out a new branch in a live worker's worktree. No shared build target directory with concurrent writers. Coordinator owns the root workspace membership, lockfile resolution and contract-change integration; Core owns the first database schema. Other workers propose schema changes rather than creating parallel databases.

Provision only the development permissions needed for this repo. No new WhatsApp chats, inherited live channel routes, desktops, production credentials or external service projects just to create these threads. Use configured subscription runtimes; no API overflow or paid compute purchase. Read host capacity and existing load before admitting work. Initially allow at most two new implementation model turns concurrently and one heavy build on the shared host; review/coordination is brief and scheduled. Increase only with measured headroom, not because the token allowance is large. Do not stop old workers to make space.

Thread creation and start must return actual IDs, delivered message IDs, runtime/account-route metadata without credentials, branch/worktree and running/queued status. Reuse an exact named v2 thread if bootstrap is retried; do not create duplicates. Record private runtime IDs in private tracking, never in this public repo.

## M0: foundations and first-wave contracts

| ID | Owner | Work and acceptance | Dependencies |
|---|---|---|---|
| V2-001 | Verification | Inventory endpoints, UI workflows, jobs, channels, storage, auth, secrets, timers, Git/desktops, public/managed boundary. Each capability has evidence, keep/replace/bridge/defer decision and a parity test. Inventory gaps are visible, not guessed. | None |
| V2-002 | Verification | Create synthetic black-box fixtures from documented behavior and discovered regressions; preserve task admission, request replay, early-stop/process-exit and permission cases. Label observed versus specified behavior. No private fixtures in repo. | V2-001, can proceed incrementally |
| V2-003 | Coordinator + Core | Publish typed IDs, API/event/error schemas, transition tables, actor trust, inbox ordering, store/runtime ports and migration compatibility policy. Freeze the slice in first-implementation.md; version subsequent changes. | Plan |
| V2-010 | Core + Coordinator | Actual Cargo workspace, stable rust-toolchain, lockfile, minimal server/CLI, deterministic tests and v2-only CI. Clean-checkout build; CI cannot publish a production image or trigger release. | V2-003 |
| V2-040 | UI | Dioxus spike against the shared contracts: editable composer while streaming, cursor reconnect, long history, keyboard/IME, screen-reader semantics, iOS simulator build feasibility. Document render model and actual limitations. | V2-003; fake API permitted |

M0 gate: shared contracts and a real build/test artifact, not empty crates or unchecked README commands. Dioxus is the chosen frontend; failure of a measured gate is an architecture issue to resolve, not a reason to hide the failure. iOS investigation runs now, not after backend completion.

## M1: local offline vertical slice

| ID | Owner | Work and acceptance | Dependencies |
|---|---|---|---|
| V2-011 | Core | Local project and canonical global/project conversations, stable identities, explicit lineage, project resources. Creating a project does not require external accounts. | V2-010 |
| V2-012 | Core + Runtime | Typed task/run/session transitions and supervisor admission evidence, session role separation, versioned leases/fences, timeout/cancel/recovery states. Stale admissions and completions fail. | V2-011 |
| V2-013 | Core | SQLite schema/migrations, atomic message + journal + inbox write, transactional outbox, durable replay and boot reconciliation. Process kill/reopen tests; no in-memory-only durability claim. | V2-011 |
| V2-014 | Core | First-admin/auth boundary, actor/scope authorization, default-deny capabilities and exact single-use approvals. Negative tests for worker impersonation and approval reuse. | V2-012/013 |
| V2-015 | Core + Runtime | Effect ledger, dispatch fencing, remote-idempotency/reconciliation contract, unknown outcome quarantine. Crash around dispatch cannot cause blind retry. | V2-014 |
| V2-030 | Core | Axum v2 API and resumable SSE, body limits, same-origin browser auth, consistent errors, request-key/body conflict detection and truthful health/readiness. | V2-013/014 |
| V2-020 | Runtime | Nonblocking orchestrator: separate fast/deep roles, durable ordered reasoning inbox, direct answer versus bounded task/run, accepted input while busy. Start against a clearly test-only fake runtime. | V2-012/013 |
| V2-041 | UI | Assistant/Projects/Attention/History shell with one visible conversation per scope; live server input, real state, result evidence, busy/retry/blocker rendering. | V2-030/040 |

M1 gate: the executable scenario and acceptance cases in first-implementation.md pass from a clean local installation. It must be possible to send a follow-up, stop a fake worker, restart the server and inspect the surviving messages/result without any external provider account. The fixture mode is explicit and cannot masquerade as production inference.

## M2: real personal-agent execution and first iOS client

| ID | Owner | Work and acceptance | Dependencies |
|---|---|---|---|
| V2-022 | Runtime | Codex and Claude adapters with pinned/probed capabilities, streaming, distinct fast/deep session identities, resume/fork/fresh, auth and quota classification. Check installed behavior, not just CLI help. Never silently switch account/model/billing route. | V2-020, metadata/fixture work starts in M0 |
| V2-023 | Runtime | Separately supervised execution runs, scoped worktrees, structured progress, OS containment, recovery, bounded retries and resource locks. A working directory is not a sandbox. | V2-015/022 |
| V2-021 | Core | Opt-in memory provenance, consent records, bounded retrieval, scope isolation, correction/forget/export, deletion-aware replay. No automatic permanent memory after a successful run. | V2-013/014 |
| V2-024 | Runtime | Durable timer/schedule triggers, missed-fire policy, deduplication, budget/admission limits, stall diagnostics. No imported timer activates itself. | V2-015/023 |
| V2-025 | Runtime | Global-to-project fan-out/fan-in with permission checks, partial responses, causal reconciliation and worker reuse/fork/fresh lineage. | V2-022/023 |
| V2-045 | UI | iOS native bundle using shared Dioxus UI: safe auth/device storage, connect to local/VPS host, conversation/work/approval navigation, suspend/reconnect. Unsigned simulator build first; signing/TestFlight are separate gates. | V2-040/041/030 |
| V2-042 | UI | Work view, workers/lineage, exact approval preview, hold/cancel, acceptance evidence, files/artifacts and resource status. | V2-015/023/041 |

M2 gate: owner-configured test profile completes a harmless real subscription-backed flow with different fast/deep native session IDs, an independent worker, mid-run follow-up and restart/cancel evidence. Fake CI results, login metadata and CLI help do not satisfy real execution acceptance. Native iOS navigation must run in a simulator; public native release also requires on-device checks. Report each provider separately.

## M3: complete product surfaces and optional integrations

| ID | Owner | Work and acceptance | Dependencies |
|---|---|---|---|
| V2-035 | Coordinator + Runtime | Installable plugin contract: package, connections, capabilities, project bindings, actual resources; narrowing-only inheritance, health/provisioning, safe disable/update/uninstall. Isolated, policy-mediated tools; unverified third-party code is not enabled. | V2-014/015; contract work can start early |
| V2-031 | Runtime | Optional legacy bridge, snapshot/read-only first. Inventory temporary dependencies and removal tests. The new core boots without NestJS; no shared live database/credential directories. | V2-035 |
| V2-032 | Runtime | Optional WhatsApp adapter and multi-identity routing, owner/automation attribution, durable delivery, uncertain-send reconciliation and loop suppression. Fake tests first, channel ownership handoff only by approval. | V2-015/035 |
| V2-033 | Runtime + Core | Local Git/worktree service, verified local OXRM workspace contract, pooled desktop isolation/leases; then optional GitHub/Jira/mail/calendar connectors. Each gets own parity/health/permission tests and explicit blockers. | V2-035/023 |
| V2-043 | UI | Integration Hub, multiple identities, global/project settings, providers/quotas, search/history and memory controls; user-facing task/data projection without duplicate authorities. | V2-021/035/041 |
| V2-044 | UI + Verification | Input/draft preservation, large histories, reconnect, attachments, dark/light contrast, accessibility and localized text. Real iPhone Safari plus native iOS acceptance. | V2-042/043/045 |
| V2-034 | Coordinator | Clean Docker Compose distribution, safe local bind, versioned images/artifacts, backups/doctor, OSS/managed separation and dependency/license inventory. External runtimes/services are explicit dependencies. | V2-010, packaging starts in M1 |

M3 gate: a fresh v2 installation works without 1.x. Required first-party functionality is Rust; every retained non-Rust service or temporary bridge is disclosed. Optional integration absence cannot disable core chat, work or local projects. Android follows the proven iOS client contract and is tracked separately, not a precondition for local evaluation.

## M4/M5: migration, local daily use and release readiness

| ID | Owner | Work and acceptance | Dependencies |
|---|---|---|---|
| V2-050 | Verification + Core | Versioned importer from consistent legacy snapshots; validate/mapping/quarantine/report, stable import IDs, history/artifact checksums, dormant timers/runs/routes and excluded secrets. Rerun produces no duplicates. | V2-001/013 |
| V2-051 | Coordinator + Verification | Side-by-side installer and launcher with separate ports, home, volumes, environment, cookies, subprocess profiles and no production service changes. | V2-034 |
| V2-052 | Verification | Parity matrix, read-only shadow comparison, controlled local test account and observable regression/performance report. No duplicated live external effects during comparison. | V2-002/044/050/051 |
| V2-053 | Verification + Coordinator | Rehearse snapshot-only rollback and post-write cutover/rollback including dispatch fences, reconciliation, export of new v2-only work and explicit unsupported cases. | V2-052 |
| V2-054 | Coordinator + Verification | Security and recovery review, signed local-candidate evidence, clean install on supported host architectures, usage/resource measurements, docs and release proposal. Owner local acceptance before mainline/production/1.x removal. | V2-053 |

The full program is complete only when retained functionality has evidence-backed parity and the owner has tested local usage. Completing M1 is not completing the rewrite.

## Work already in 1.x

Read current task/memory/ingress/session/acceptance PRs as reference, including their new regressions, but do not merge unreviewed TypeScript feature branches into v2 wholesale. Pin the baseline and record later important fixes in the parity ledger. Existing ORK-534 tasks remain attached to their existing work; the v2 program links to them instead of quietly replacing their scope.

Coordinator creates one dedicated v2 tracking epic and maps the stable backlog IDs to issues, checking for an existing exact-title epic first. This development tracking is authorized; it does not make Jira a runtime requirement. Failure to reach Jira must not block coding: keep repo backlog state and reconcile issue IDs when available. Public docs contain no private workspace IDs or credentials.

## Review, integration and reporting

The owner has authorized planning and the first implementation: do not request another architecture approval before writing code. For the first wave, create reviewable PRs targeting `v2/rust-rewrite`, never `main`. Coordinator may integrate independently reviewed, passing changes into the v2 branch under existing repository rules. This is not release approval.

Every milestone requires exact commit, actual test commands/results, known skipped/pending cases, provider evidence level and reproducible local instructions. Test authors do not self-approve their own PR; coordinator or another lane reviews the Verification lane's changes. Do not weaken policy, remove tests, change security settings or force-push to obtain green CI. Any exception is reported, not hidden.

Reserve implementation capacity for failure testing, independent review and integration rather than generating maximum code in parallel. Estimate later milestones only after measuring the first end-to-end build and provider test. No completion date follows from available tokens alone.
