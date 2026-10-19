# Orkestr 2.0: full Rust application rewrite

Status: implementation plan authorized for an isolated development track, 2026-10-18. Integration branch: `v2/rust-rewrite`. This is not a production release or a declaration that the application already exists.

## 1. Decision and precedence

Build a new first-party Orkestr application in Rust: domain, durable orchestration, HTTP API, CLI, and shared Dioxus user interface. This is a replacement application, not an indefinitely dependent Rust facade around NestJS. Deliver it incrementally on its own branch and test it beside the existing installation before any cutover. Preserve 1.x source, data and running work.

Product requirements follow [ADR 0003 at commit 2d48f841](https://github.com/otcan/orkestr/blob/2d48f841fea794c494b93c14db2d549c5eab9c89/docs/adr/0003-opinionated-personal-agent.md), including its latest self-hosted-baseline correction. The owner's subsequent instruction explicitly authorizes a full rewrite and NEW implementation threads. That changes the implementation strategy, not the product's permission, consent or durability requirements.

This revision replaces the initial v2 draft's incompatible assumptions:

- A small local model is NOT the mandatory router or the authoritative assistant. Fast and deep roles use distinct persistent supported Codex/Claude Code sessions; explicitly selected model/API/local alternatives remain possible.
- iOS is a first-class client, with feasibility and build work starting in the first implementation wave. It is not deferred behind an indefinite PWA-only phase.
- The ordinary UI is one global main conversation plus one main conversation per project, not a mandatory tree of worker chats.
- Local Git/workspaces form the project baseline. Local OXRM integration must be verified. External GitHub, Jira and WhatsApp are optional plugins, not prerequisites for creating a shopping list.
- There is no verified Rust demo at the plan baseline. A README containing cargo commands is not implementation evidence.

Existing ADR 0001/0002 and runtime specifications remain behavioral/security references. Their no-rewrite/in-place-storage implementation constraints still apply to 1.x but do not prohibit a separate v2 database and application. No existing worker is retasked, retired or merged by this plan.

## 2. Technology decisions

| Boundary | Decision | Reason / constraint |
|---|---|---|
| Application/domain | Rust, pinned stable toolchain | Explicit types and state machines; no claim that compilation proves business correctness |
| API and async runtime | Axum + Tokio | One modular server, no microservice fleet or message broker in the initial deployment |
| Persistence | SQLite + SQLx | Single-instance local-first store; short transactions, WAL, migration checks and durable outbox; no simultaneous PostgreSQL implementation |
| Frontend | Dioxus 0.7 family + CSS, exact compatible versions pinned in implementation | Shared Rust components and API models for web and iOS; own API remains independent of Dioxus server-function internals |
| Native clients | Dioxus mobile for iOS, desktop target as a packaging option; Android after iOS | Use supported WebView rendering, not an experimental custom renderer. A native bundle does not imply SwiftUI/UIKit widgets |
| Provider execution | Isolated process adapters, Codex app-server stdio and Claude structured protocol | Feature-detect installed capabilities; explicit account selection and bounded sessions; never expose provider control sockets to the network |
| Public client protocol | Versioned JSON HTTP + cursor-based SSE; WebSocket only when needed | Reconnect, backpressure and compatibility testable without a particular UI framework |
| Packaging | Separate Docker Compose project and local CLI | Runs on the owner's computer or self-owned VPS. iOS is a client, not a CLI/agent host |
| Integrations | Versioned capability/plugin protocol | Rust first-party adapters. Existing specialist services may remain isolated external processes; no rewrite of Chromium, Git, Codex, Claude or OXRM for language purity |

Dioxus is the selected implementation path, not an invitation for parallel frontend-framework experiments. Its first milestone must prove input, streaming, accessibility and iOS build behavior. A failed gate requires a documented architectural correction, not silently replacing Rust with a TypeScript UI or claiming mobile readiness from a web screenshot. Small platform bindings and browser interop are permitted and inventoried.

Rust's compiler prevents important memory/data-race errors; it does not prevent duplicated effects, faulty authorization, deadlocks or incorrect workflow design. Tests and deterministic control are the basis of trust. Abundant inference capacity is a development resource, not a correctness argument.

## 3. Product structure

The owner enters a global Assistant and can open Projects. Each project has exactly one default visible conversation. Fast conversation and deep reasoning have separate persistent native sessions behind that transcript. Long work uses independently supervised worker runs. The owner can continue speaking while reasoning or execution is busy.

Resources belong to projects: repository/worktrees, structured data, task presentation, plugin bindings and scoped desktop leases. Worker reuse, fork or fresh creation records lineage and the pinned context used. A provider session ID never becomes the canonical project or conversation ID.

Navigation: **Assistant, Projects, Attention, History, Settings/Integration Hub**. Within a project: **Conversation, Work, Files, Data, Activity**. Worker/process details are inspectable under Work, not competing top-level chats. Replace old interaction structure; preserve useful outcomes and historical records.

Local onboarding is installation, first-admin creation, one verified provider connection, then the global conversation. Missing optional integrations must not block the first project. The task/run/effect/approval records in v2 are the execution authority. OXRM is an intended unified user-facing project/data surface only after its actual API and synchronization model have been established; it is not a second execution authority.

## 4. Architecture and dependency boundaries

Start with a modest Cargo workspace under `v2/`:

```text
crates/contracts       typed public IDs, DTOs, event envelopes; web-safe
crates/domain          pure decisions, validation and transition rules
crates/application     use cases and storage/runtime/capability ports
crates/store-sqlite     transactions, migrations, outbox, snapshots
crates/runtime         provider adapters, supervision and scheduling
crates/plugins         manifests, connection/binding registry and brokers
apps/server            Axum composition root and authenticated API
apps/cli               local start/doctor/export/import commands
apps/ui                shared Dioxus UI; web and mobile feature targets
```

The domain does not import SQLx, Axum, Dioxus or connector implementations. Application code depends on domain and abstract ports; adapters implement those ports. Server composes implementations. UI imports contracts, not the database or privileged runtime. Avoid creating a crate for every noun; add boundaries only where tests and ownership justify them.

A message transaction stores the authenticated input, ordered event and reasoning-inbox item before returning acceptance. An unavailable model cannot block this transaction. Fast rendering and deep reasoning are independently scheduled. No database transaction is held while waiting for a model, subprocess, network call or UI client.

Use transactional current-state tables plus an append-only metadata event journal and outbox, not a distributed event-sourcing platform. Replay reconstructs state/projections and never re-executes tools. Tokens are streamed in bounded batches; every token need not become a database transaction.

A task progresses to running only with supervisor admission evidence; completion requires acceptance evidence. Models propose state changes. Deterministic services authorize and apply them. Resource grants may narrow from instance to project to run, never widen implicitly.

## 5. Reliability, privacy and external effects

Per-scope inbox order, session leases and resource fences prevent concurrent mutation of the same work. Separate sessions permit concurrency across independent work; one native session has at most one active turn unless an installed protocol proves otherwise. Stale workers cannot publish canonical completion or dispatch new effects.

Cancellation and deployment holds act in the control plane before waiting for reasoning. A clear Stop control is always available. Conservative handling of recognized owner stop instructions may establish a hold immediately; ambiguous wording must not be represented as a guaranteed stop. Already-dispatched external actions remain in-flight/uncertain until reconciled, not falsely rolled back.

Approvals bind the exact effect, target, argument digest, scope, expiry and one-time consumption. Unknown external outcomes are quarantined, not retried blindly. Remote idempotency/reconciliation is required before claiming duplicate prevention across a network failure; no general exactly-once promise.

Raw messages, artifacts, short-lived model context, curated memory and audit metadata are separate data classes. Personal memory requires explicit owner consent, provenance, correction, forget and export. Replay must respect deletions. Keep removable sensitive payloads out of immutable journal metadata and explain backup retention. A successful task does not automatically authorize a new personal memory.

The API checks actor and scope on every operation. Provider credentials stay server-side, out of UI/WASM, logs and repo. Worker worktrees are not sandboxes: untrusted execution additionally needs OS/container containment, restricted mounts and egress, no host Docker socket, and a capability broker. A separate plugin process is not by itself a security boundary. Third-party executable plugins stay disabled until containment is verified.

## 6. Scope of a full rewrite

Reimplement core conversations, project/resource model, tasks, session/worker management, scheduling, evidence/approvals, consented memory, settings, auth, API, UI, local installation and import/export. Rebuild selected connector functionality behind the plugin contract, with a parity ledger for everything used today.

Preserve behavior where essential, not old screens or implementation accidents. Every existing capability is marked: replace, bridge temporarily, retain as an external service, intentionally defer, or propose retirement. A used capability cannot disappear silently. The public marketing site and unrelated applications remain outside this rewrite.

A legacy bridge is temporary, separately deployable and versioned. It can expose a snapshot/read-only projection first. No core v2 launch may require a running NestJS server. End-to-end parity means running on a fresh installation without 1.x, apart from explicitly retained external services. See [workstreams.md](workstreams.md).

## 7. Delivery and actual status

The first deliverable is a locally runnable Rust server and Rust UI, with durable messages, a fake busy reasoning session, a separate worker, reliable Stop, evidence-backed results and restart recovery. Fake adapters prove software behavior, not real provider support. A second acceptance step uses a separately configured real local subscription session.

The first-wave contracts and tests are in [first-implementation.md](first-implementation.md); complete migration gates are in [migration.md](migration.md). NEW development threads implement this track. The owner tests the candidate locally before deciding to replace the old installation. Mainline merge, production deployment, channel takeover, credential reuse and destructive migration remain separate approval gates.

The plan baseline was unverified. The initial offline journal and fixture UI implementation now has concrete build/test evidence in [the implementation README](../../v2/README.md). This does not satisfy the integrated M1 server/UI, provider, iOS or migration gates. Implementation reports must continue to cite actual commits, tests and artifacts.

## Primary technical references

Checked 2026-10-18. These establish framework/protocol capabilities, not Orkestr implementation status:

- [Dioxus current guide](https://dioxuslabs.com/learn/0.7/) and [crate documentation](https://docs.rs/dioxus/latest/dioxus/).
- [Axum](https://docs.rs/axum/latest/axum/) and [SQLx](https://docs.rs/sqlx/latest/sqlx/).
- [Rust concurrency limitations](https://doc.rust-lang.org/nomicon/races.html).
- [Codex app-server protocol](https://developers.openai.com/codex/app-server/).
- [Claude programmatic execution](https://code.claude.com/docs/en/headless). Do not assume a mode recommended for API automation supports subscription credentials; verify the installed mode and permissions.
- [SQLite consistent backup](https://sqlite.org/backup.html).
