# Orkestr 2.0 execution program

Scope: an independently testable Rust-first replacement. Work in `v2/rust-rewrite` and feature branches based on it. Each change needs a focused test, a reviewer, and written migration/rollback impact. Existing 1.x operations, pending personal-agent PRs and production release flow are **out of scope** unless specifically approved.

## Stage 0: Baseline and freeze contracts

- V2-001 Inventory 1.x endpoints/screens/processes, state stores, migration scripts, connectors, timers, authorization and release assumptions. Identify used, duplicated, legacy, and removable capabilities with evidence.
- V2-002 Capture 1.x behavior as golden fixtures: hierarchical threads, turn stream, prompt routing, workers, approvals, crash recovery, WhatsApp outbox, timers, Git, browsers, files and OAuth.
- V2-003 Freeze versioned event envelopes, stable IDs, time semantics, schema evolution, capability/permission policy, idempotency and API/stream contracts.
- Gate: inventory signed off; no undocumented data destructive migrations.

## Stage 1: Rust core

- V2-010 Rust workspace, formatting, clippy, offline unit tests, CI and local dev CLI. Initial domain prototype is under `v2/`.
- V2-011 Conversation/project graph: roots, children, forks, links, immutable origin, visibility, thread-scoped context.
- V2-012 Task and worker/session FSM with verified admission, cancellation, timeouts, restarts and resource leases.
- V2-013 Durable SQLite journal, atomic projections, migration versioning, transactions and outbox (SQLx). Current in-memory starter is **not** durable.
- V2-014 Approval and policy engine: default deny, owner attribution, narrowing grants, signed decisions and explicit effect bounds.
- V2-015 Effect ledger and retry/reconciliation semantics equivalent to 1.x guarantees, tested with crash faults.
- Gate: process SIGKILL/restart tests plus full event replay preserve graph, task state and effects.

## Stage 2: Intelligence, memory, execution

- V2-020 Personal-agent orchestrator: classify intent, discover current project/thread, decide direct response vs delegated work, ask approval when needed.
- V2-021 Memory store: sources, scopes, provenance, retention, owner-controlled correction/delete, retrieval tests and isolation.
- V2-022 Provider protocol: Codex app-server, Claude Code, local compatible models; fork/resume/stop with hard capability checks and token/cost limits.
- V2-023 Worker execution: per-task repo/worktree/virtual desk, lifecycle telemetry, checkpoint/retry and no sandbox claims beyond adapter evidence.
- V2-024 Scheduling and automation: durable triggers, missed fires, rate limits and dedupe.
- Gate: golden request -> plan -> delegated run -> effect approval -> completion -> memory update -> answer; simulated and one live local subscription test.

## Stage 3: External boundaries

- V2-030 HTTP, WebSocket/SSE gateway and typed contracts, auth, secure-input, audit, admin vs tenant scoping.
- V2-031 Bridge 1.x integrations read-only first; implement owner-selected, independent credentials and side-effect outbox before enabling any connector writes.
- V2-032 WhatsApp inbound/outbound duplicate suppression and identity/routing semantics; prove zero double delivery before enabling.
- V2-033 GitHub, browsers, desktop, Gmail and calendar; register capabilities, consent and per-provider rate/cost limits.
- V2-034 OSS vs managed boundary and release packaging; no operator secrets in public repo.
- Gate: every external effect guarded, observable and fault-tested; no prototype writes to live 1.x state.

## Stage 4: UI rewrite

- V2-040 Dioxus technical spike: navigation, chat virtualization, streaming, accessibility, forms, keyboard, responsive mobile layout, artifact rendering. Measure against existing Angular.
- V2-041 New shell: personal-agent home, project tree, conversations and forks, important events.
- V2-042 Workbench: task state, workers, approvals, trace/provenance, Git and virtual desks.
- V2-043 History/search/memory controls, settings, integrations, provider billing/budget, multilingual experience.
- V2-044 User acceptance and performance: long sessions, reconnect, degraded/offline mode, dark/light, screen readers, iPhone Safari.
- Gate: use Dioxus only if its spike passes. If not, preserve the Rust backend plan and use a TS frontend: product quality beats one-language purity.

## Stage 5: local migration and replacement

- V2-050 Snapshot importer for legacy JSON/SQLite/metadata into v2 schema with dry-run, mapping report and reconciliation; never read/write live secrets automatically.
- V2-051 Side-by-side launch: different ports, process names and data dirs; turn off v2 external outbound by default.
- V2-052 Local parity matrix, shadow comparisons and explicit user-controlled v2 connector enablement.
- V2-053 Reversible local cutover and export/rollback, clear dual-write prohibition.
- V2-054 Hardening, security review, resource benchmarks, clean install, docs and release candidate.
- Gate: owner signs off local usage before any production migration, mainline merge or hosted rollout.

## Work allocation / dependency order

Parallelize **after V2-003**: (A) Rust event/domain/state, (B) provider/connector adapter specifications and fixture harness, (C) Dioxus UI spike and UX, (D) legacy inventory/export and local test harness. These must share contracts rather than independently invent state formats.

Critical path: V2-003 -> V2-011/012 -> V2-013 -> V2-014/015 -> V2-020/022 -> V2-030/040 -> V2-050/052.

Owner checkpoints: domain contract, actual outbound connector enablement, production credentials reuse, production deploy, data cutover and final removal of 1.x all require separate explicit decisions. Starting a rewrite does **not** authorize production actions.

## Engineering rules

- No force push, reset or wholesale revert of live worktrees. No editing 1.x files for cosmetic parity.
- No dependencies on private environment variables or production-only host paths for the OSS path.
- No TODO being reported as a passing acceptance test.
- Pin dependencies, generate SBOM/license checks in a follow-up, run cargo fmt, clippy and tests in CI.
- Report each PR with exact commit SHA, tests actually run, remaining blockers, and side effects explicitly stated.
