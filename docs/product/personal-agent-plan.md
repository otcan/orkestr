# Orkestr Personal Agent: plan, audit and backlog

Status: active program, 2026-10-18. Owner-approved direction. The structured backlog is in
[personal-agent-backlog.json](personal-agent-backlog.json). The tracker is the private Jira project ORK
(epic ORK-534). OP ids are stable cross-references.

## Charter (OP-01)

**Promise:** one assistant that remembers what matters, organizes ongoing work, delegates to the right
agents, and follows through.

Orkestr becomes an opinionated, persistent personal agent. It is not an orchestration UI with a renamed
sidebar.
- One conversational identity across the built-in web app and the existing messaging interfaces.
- Ordinary conversation and personal continuity work without a project. Not every chat becomes a project.
- Substantial delegated work gets durable projects and tasks, with attached threads/subthreads, git
  repos/worktrees and virtual desks.
- Orchestration is the engine underneath.

**Audience:** technical founders and independent professionals managing several ongoing projects. The
maintainer is the first dogfood user.

**Local-first:**
- The top-level conversation runs on a locally served model by default.
- Facts, scheduling, permissions and recovery live in deterministic services, not in model recollection.
- Stronger remote reasoning or execution is optional, explicit and policy-controlled. It is never a silent
  upload.
- Local-only mode is real and states its capability limits.
- No model is called sufficient without measurement (OP-11).

**Non-goals for this program:**
- A rewrite, or a second incompatible task database.
- Enterprise/team features.
- Mandatory root or runtime isolation.
- Public launch claims or outreach.
- Changes to live channel routes, timers or campaigns.
- Switching existing agents' models.
- New paid infrastructure or large unapproved downloads.

## Audit: what exists (source-backed, origin/main 2026-10-18)

| Capability | Status | Where | Reuse decision |
|---|---|---|---|
| Threads, workers (`parentThreadId`), task agents | Exists | `packages/core/src/threads.js`, `thread-workers.js`, `task-agents.js`, `task-agent-state.js` | Subthreads are existing threads/task agents. A Task references them; it does not replace them. |
| Durable runs, idempotency, effects, approvals | Exists | `agent-job-store.js` (SQLite: jobs, runs, attempts, checkpoints, effects, approvals, notifications), `agent-job-admission.js`, `agent-job-ledger.js`, `agent-job-runner.js` | Project/Task tables are added **in the same store** with additive migrations. Task execution maps onto runs, effects and approvals. |
| Timers, watches (worker DONE to parent) | Exists | `timers.js`, `thread-watches.js`, `thread-watch-pump.js` | The supervisor (OP-13) builds on watches and timers. Existing timers are unchanged. |
| Event log and typed events | Partial | `packages/storage/src/store.js` (`events.jsonl`, no cursor), `orkestr-events.js`, connector outbox, effect ledger, `thread-stream.ts` (WebSocket), `mcp-events.js` (cursor webhooks) | OP-05 adds one correlated envelope and a cursor feed on top of these; no new bus. |
| Authorization and approvals | Exists (fragmented) | `policy.js`, `desktop-access.js`, `agentJobToolDecision`, vault approvals, outbound message approval | OP-14 binds task scope to these models. OP-20 shows them in one inbox. |
| Memory | Absent in product | Only per-thread mission text and onboarding preferences. A private appendable "open topics" ledger is used in dogfooding. | OP-07 adds a scoped, provenance-carrying memory store, following the ledger semantics. |
| Project/Task entity | Absent | `project-inquiries.js` is the public intake form only | OP-03. |
| Local model adapter | Partial | `openai-compatible` passes job-spec validation but has no registered adapter (`agent-job-adapters.js`). A local Ollama-style server is common on dev hosts. | OP-09 fills that adapter slot. |
| Feature flags | Ad hoc | About 34 `ORKESTR_*_ENABLED` variables, server `features.*` capabilities | OP-02 defines one `personalAgent` capability flag. New UI is hidden behind it. |
| Web app | Exists | Angular standalone app, `app.component.*`, manual path routing, `stores/thread.store.ts` | OP-18 adds a flagged home view; legacy thread views stay. |
| Desk leases, password handoff | Exists / in review | `desktop-leases.js`, `password-handoff.js` (app-level, owner-accepted single-user trust model) | OP-16 reuses them. App-level controls do not isolate root-capable runtimes; this stays stated. |

Prior direction ([positioning.md](positioning.md), [roadmap-12-weeks.md](roadmap-12-weeks.md)) made Agent
Jobs the core unit. This program keeps that engine and puts the personal agent on top of it.

**Tracker dedupe:**
- No open ORK issue covers any OP item in full, so all 24 are new.
- Partial overlaps are linked as "relates":
  - ORK-527 (thread watches) → OP-12 and OP-13;
  - ORK-363 (liveness-first runtime control) → OP-13;
  - ORK-358 and ORK-499 (desktop sharing) → OP-16;
  - ORK-528 (ChatGPT remote MCP) → OP-17.

## Delivery rules

- At most three implementation lanes at once (A, B, C), plus an independent reviewer. Dependency-blocked
  items are marked `blocked` with their prerequisite.
- **Core contracts first.** Lane A owns the schema and event envelope (OP-02 ADR). Lanes B and C consume
  that contract and do not create competing schemas.
- **Small reviewable PRs** with tests, source-backed status and rollback/migration evidence. Existing
  merge/deploy gates ([release-train.md](../release-train.md)) apply. Nothing here is bundled into other
  pending releases.
- **Live setup preserved.** Channel behaviour is tested with fixtures and private canaries only. No
  messages go to third parties.

## First milestone: vertical slice

Flagged and additive; existing threads keep working. From the built-in app, the local main assistant:
1. reads durable project state;
2. creates one bounded child task on the existing runtime;
3. survives a service restart;
4. detects a seeded stall;
5. reports a verified result or blocker with evidence.

Critical path: OP-02 → OP-03 → OP-04/OP-05 → OP-06, with OP-09 → OP-08, OP-14 → OP-12 → OP-13, then
OP-18. OP-22 runs alongside.

## Backlog

| OP | Tracker | P | Item | Owner | Depends on | State | Next action |
|---|---|---|---|---|---|---|---|
| OP-01 | ORK-535 | P0 | Product charter, repo audit and deduplicated delivery map | Coordinator | - | active | Commit this plan and backlog; create the tracker epic and items; dispatch lanes A, B, C and the reviewer. |
| OP-02 | ORK-536 | P0 | Shared architecture and UX contract (ADR) | Lane A | OP-01 | active | Draft docs/adr/0002-personal-agent-contract.md from the audit; lanes B and C comment before freeze. |
| OP-03 | ORK-537 | P0 | Durable project/task/resource entities and additive migration | Lane A | OP-02 | blocked | Blocked on OP-02 contract freeze. |
| OP-04 | ORK-538 | P0 | Explicit task contracts and lifecycle | Lane A | OP-03 | blocked | Blocked on OP-03. |
| OP-05 | ORK-539 | P0 | Unified event journal and reliable dispatch | Lane A | OP-03 | blocked | Blocked on OP-03; event envelope is specified in OP-02. |
| OP-06 | ORK-540 | P0 | Project/task projections and evidence-backed status API | Lane A | OP-04, OP-05 | blocked | Blocked on OP-04 and OP-05. |
| OP-07 | ORK-541 | P0 | Persistent assistant memory and context assembly | Lane B | OP-02, OP-03 | blocked | Blocked on OP-02 memory contract and OP-03 storage. |
| OP-08 | ORK-542 | P0 | Single top-level conversational agent | Lane B | OP-06, OP-07, OP-09 | blocked | Blocked on OP-06, OP-07 and OP-09. |
| OP-09 | ORK-543 | P0 | Local inference adapter and health/configuration | Lane B | OP-02 | active | Discovery: inventory installed local models and endpoints, measure a baseline, propose the adapter interface for OP-02. |
| OP-10 | ORK-544 | P1 | Explicit escalation, privacy and resource policies | Lane B | OP-09, OP-14 | blocked | Policy contract drafted inside OP-02; implementation blocked on OP-09 and OP-14. |
| OP-11 | ORK-545 | P1 | Local-model and orchestration evaluation harness | Lane B | OP-08, OP-09, OP-10 | blocked | Harness design starts with OP-09 discovery; final run blocked on OP-08..10. |
| OP-12 | ORK-546 | P0 | Delegation lifecycle and bounded subthreads | Lane A | OP-04, OP-05, OP-14 | blocked | Blocked on OP-04, OP-05 and OP-14. |
| OP-13 | ORK-547 | P0 | Supervisor and event-driven follow-through | Lane A | OP-06, OP-12 | blocked | Blocked on OP-06 and OP-12. |
| OP-14 | ORK-548 | P0 | Task-scoped permissions and approval evidence | Lane A | OP-02, OP-04 | blocked | Contract within OP-02; implementation blocked on OP-04. |
| OP-15 | ORK-549 | P1 | Git workspace integration | Coordinator | OP-12, OP-14 | blocked | Blocked on OP-12 and OP-14. |
| OP-16 | ORK-550 | P1 | Virtual desk integration | Coordinator | OP-12, OP-14 | blocked | Blocked on OP-12 and OP-14; reuses the reviewed password-handoff work, no duplicate. |
| OP-17 | ORK-551 | P1 | Channel parity and identity continuity | Coordinator | OP-05, OP-08, OP-14 | blocked | Blocked on OP-05, OP-08 and OP-14. |
| OP-18 | ORK-552 | P0 | Personal-agent home in the existing web app | Lane C | OP-02, OP-06, OP-08 | active | Shell discovery and flagged layout against the OP-02 draft; integration blocked on OP-06 and OP-08. |
| OP-19 | ORK-553 | P1 | Project/work detail view | Lane C | OP-12, OP-15, OP-16, OP-18 | blocked | Blocked on OP-12, OP-15, OP-16 and OP-18. |
| OP-20 | ORK-554 | P1 | Approval inbox and inspectable memory/settings | Lane C | OP-07, OP-14, OP-18 | blocked | Blocked on OP-07, OP-14 and OP-18. |
| OP-21 | ORK-555 | P1 | Opinionated first-run onboarding | Lane C | OP-09, OP-18, OP-20 | blocked | Blocked on OP-09, OP-18 and OP-20. |
| OP-22 | ORK-556 | P0 | Independent acceptance and regression suite | Reviewer | - | active | Write the acceptance test plan and the first failing vertical-slice fixtures; integrate incrementally across OP-03..21. |
| OP-23 | ORK-557 | P1 | Five-project dogfood pilot and honest positioning | Coordinator | OP-11, OP-13, OP-17, OP-19, OP-20, OP-22 | blocked | Blocked on OP-11, OP-13, OP-17, OP-19, OP-20 and OP-22. |
| OP-24 | ORK-558 | P1 | Packaging, release candidate and rollback runbook | Coordinator | OP-21, OP-22, OP-23 | blocked | Blocked on OP-21..23. |

## Dependency map

```
OP-01 ─▶ OP-02 ─▶ OP-03 ─┬▶ OP-04 ─┬▶ OP-06 ─┬▶ OP-08 ─▶ OP-17
                          │         │         └▶ OP-13
                          ├▶ OP-05 ─┘
                          └▶ OP-07 ──────────▶ OP-08, OP-20
         OP-02 ─▶ OP-09 ─▶ OP-08, OP-10 ─▶ OP-11
  OP-02, OP-04 ─▶ OP-14 ─▶ OP-10, OP-12, OP-15, OP-16, OP-17, OP-20
  OP-04, OP-05, OP-14 ─▶ OP-12 ─▶ OP-13, OP-15, OP-16 ─▶ OP-19
  OP-02, OP-06, OP-08 ─▶ OP-18 ─▶ OP-19, OP-20 ─▶ OP-21 ─▶ OP-24
  OP-22 (from now, across OP-03..21) ─▶ OP-23 ─▶ OP-24
```
