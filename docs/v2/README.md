# Orkestr 2.0: Rust-first rewrite

Status: **active development design**, 2026-10-18. Branch: `v2/rust-rewrite`.
Decision owner: Orkestr project. This is an isolated experimental track, **not** a production release.

## Decision

Build a new Rust application around **one personal agent, durable projects, layered conversations, explicit task orchestration, contextual memory, and observable workers**. This is a full product rewrite, not a port of each old controller and screen.

Use the existing 1.x implementation as the compatibility and behavior reference, not as the new internal architecture. The Rust domain and services become the new source of truth once local acceptance and reversible migration pass. No functionality is removed from 1.x before demonstrated parity or an explicit product decision to retire it.

## Technology choices

| Boundary | V2 target | Decision |
|---|---|---|
| Domain, orchestration, policy, session lifecycle | Rust | Chosen |
| Async runtime and HTTP/WebSocket/SSE | Tokio + Axum | Chosen, version-pin at implementation |
| Local data and migrations | SQLite + SQLx | Chosen for single-user/self-hosted first; PostgreSQL is not required for initial launch |
| Durable events | transactional event journal + typed projections + outbox | Chosen: make transitions auditable, crash-recoverable, replayable |
| Rust web frontend | Dioxus + CSS, served by v2 API | Preferred, gated by PoC for accessibility, bundle size, long conversation virtualization, input/streaming reliability |
| Desktop | Web/PWA first; Tauri shell only if needed | Later |
| iOS | Responsive web/PWA first; native shell only after proven fit | Later; do not assume Dioxus mobile parity |
| Model routing | Local LLM for lightweight continuity and routing; remote models on demand | Decisioning cannot bypass user policy, budget, or approval |
| Executors | Process adapters for Codex, Claude Code, local OpenAI-compatible models | Existing subscriptions remain the user's own credentials |
| External integrations | 1.x adapters via versioned bridge initially; replace deliberately | WhatsApp and browser state must not be mutated by a prototype |

## Product model

1. **Personal agent**: primary conversational entrypoint with independent routing/planning and human-visible work decisions.
2. **Workspace/project**: long-lived context; optionally linked repository, virtual desk, connected apps, resource policy and budgets.
3. **Conversation**: a durable graph node, not just a list row. Parent-child and fork relationships are explicit, immutable events. Cross-links do not mean shared access.
4. **Task**: owner-approved or policy-permitted objective with immutable intent, lifecycle, timeouts, dependencies, origin, and traceable effects.
5. **Worker session**: ephemeral or persistent executor binding, model/provider, operating context, checkpoints, leases and bounded concurrency.
6. **Memory**: attributed, scoped, permissioned facts and project summaries. Explicit correction/deletion semantics, provenance and consent. Do not treat model summaries as the audit log.
7. **Effect / approval**: external side effects guarded by policies and idempotency/reconciliation. A text reply is not execution authorization.
8. **Event journal**: append-only ordered facts for transitions; derived views are rebuildable and carry a schema version.

### Required separation of concerns

```text
UI (Dioxus / PWA)
       |
API & real-time projections (Axum, typed contracts)
       |
Application services
  |       |         |          |
Project  Conversation Task       Memory
  \       |         |          /
        Domain + event journal
                  |
     Policy / approvals / outbox
                  |
    Runtime adapters and connectors
  (Codex, Claude, local, WhatsApp, browsers)
```

Avoid one central "god agent" that performs effects. The personal agent proposes and delegates; deterministic services enforce permissions, idempotency, resource scope, and replay.

## V2 UI: intentionally not a 1.x replica

- **Home**: ongoing personal conversation plus a short, ranked set of actual active projects, pending approvals, and important outcomes.
- **Project**: project conversation, child conversations/forks, tasks and workers, resources, Git context, memory and virtual desk.
- **Conversation**: streaming messages with nested context navigation and provenance; no raw agent logs mixed into user conversation.
- **Work**: queued/running/blocked/completed tasks with real state and actionable recovery.
- **Review**: approvals, external effects, audit evidence, and run comparisons.
- **Settings**: identities, providers, integrations, routing, resource and budget policies.
- Separate the **public marketing website** from the personal-agent application; do not rewrite unrelated public pages for the sake of language purity.

## Behavioral invariants

- Preserve original message, parent-child/fork links, worker/session IDs, timestamps, audit records, approvals and remote effect keys. Schema migrations must be idempotent.
- Every admitted task has an audit trail. Retry never silently repeats a non-idempotent external action.
- Distinguish queued vs running based on confirmed worker admission, not UI inference.
- External-channel delivery must use an outbox and idempotency keys. No accidental duplicate WhatsApp messages.
- A local model is a planner, not an authority to weaken access, approve effects or change budgets.
- Policies are least-privilege, default deny; inherited grants may only narrow unless expressly reauthorized.
- Memory has scope, provenance, correction/deletion paths, retention and tests; private records do not leak into other projects.
- Never render replayed provider messages as new user requests. Never silently revive cancelled campaigns.

## Definition of done

V2 must pass the offline and actual local acceptance matrix in [migration.md](migration.md), including real provider sessions, interrupted runs, approvals, restart recovery, user-level isolation, and duplicate suppression. It must boot from a clean install with a dedicated data directory; run with real credentials only after attended owner setup; import a copy of existing history without changing 1.x; present an accessible, usable UI; and support rollback. **Do not merge this branch to main merely because a prototype compiles.**

## Tracking

See [workstreams.md](workstreams.md) for the full rewrite plan. See [migration.md](migration.md) for local-first cutover/rollback. The starter workspace at [`v2/`](../../v2/) proves only domain transitions, not durable storage or production readiness.
