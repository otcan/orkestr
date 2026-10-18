# First implementation: a durable, nonblocking local assistant

Status: implementation specification, 2026-10-18. This starts M0/M1 of the full rewrite; it is not the full rewrite's definition of done. Follow [architecture](README.md) and [workstreams](workstreams.md).

## 1. Deliverable

A real Rust server and Dioxus UI that boot beside 1.x with a fresh home. Create a local project, open its canonical conversation, submit a request, observe separate fast/deep/worker activity, send a follow-up while deep work is busy, stop a run, restart the server, and inspect preserved history and evidence. Use an explicit fake provider initially; no real credentials or integrations are needed.

This is more than a reducer library, empty crate tree or attractive mockup. The UI must connect to the actual v2 API and state must survive a process restart. Conversely, passing fake-provider tests is not proof of Codex/Claude compatibility. Real providers are the next gate, not a fabricated M1 claim.

## 2. First-wave boundaries

**Core** implements workspace foundations, the contracts/domain/application/store crates, database migrations, first-admin/auth boundary and the Axum API. It owns authoritative schema changes.

**Runtime** implements the provider port, controllable fake runtime, distinct session-role registry, supervision and offline protocol fixtures. It starts Codex/Claude capability research and adapters but does not need live inference to make progress. It sends required store changes to Core; no competing SQLite file or global JSON state.

**UI** builds shared Dioxus components against the published DTOs, with a fake API only until the real server is available. It creates the early iOS simulator/build and platform-capability report alongside web work. It may use CSS and minimal audited platform interop, not rewrite the client in TypeScript without a recorded architecture decision.

**Verification** writes independent black-box/process-failure tests and the legacy parity inventory. Core/Coordinator reviews Verification's own PRs. It checks both successful and malicious/conflicting requests rather than merely asserting response shapes.

**Coordinator** manages dependency changes and the root lockfile, new-thread assignments, independent review and integration. It must launch bounded coding, not produce another plan as the only result. Use the already completed plan; additional inventory can proceed in parallel with the slice.

## 3. Canonical records and invariants

Separate typed IDs: OwnerId, ProjectId, ConversationId, MessageId, TaskId, RunId, SessionId, EventId, EffectId, ApprovalId and ResourceId. Provider-native IDs are opaque server-side fields, not interchangeable with Orkestr IDs. UUID format is acceptable; storage order comes from a monotonic sequence, not wall-clock sorting.

Conversation scope is global or project. A unique constraint gives each scope exactly one default main conversation. Internal session and worker lineage is a separate graph and does not create user-visible main chats automatically. Project membership and owner identity are validated before accessing IDs supplied by a client.

Minimum store tables: owners/auth sessions, projects, conversations, messages, session bindings, tasks, runs/attempts, per-scope reasoning inbox, events, effects, approvals, holds, resource bindings and outbox. Do not create all speculative future tables before they serve a tested use case. Schema migrations are forward-versioned and transactions own invariants.

Message admission atomically writes message + event + inbox. Unique `(owner, conversation, request_key)` detects repeated requests, with a digest of the semantically relevant payload. Same key/same payload returns the original IDs; same key/different payload is a conflict. Actor kind is assigned by trusted ingress, never accepted from a worker or arbitrary JSON field.

Task state: queued, running, awaiting_approval, blocked, succeeded, failed or cancelled. Run/attempt state also represents starting and cancel_requested. A terminal task may be retried only as an explicit new run/attempt according to policy, preserving history. Running needs admitted run/session evidence. Succeeded needs verified acceptance evidence. Cancel_requested is not falsely displayed as already cancelled.

Session state: starting, ready, busy, blocked, lost or retired. Roles: fast, deep, worker. A scope has distinct fast/deep bindings, native sessions materialized on first use when supported. At most one active turn per native session by default. Initial sessions that cannot yet be durably resumed remain starting; losing one is an explicit condition, not a silent replacement.

## 4. Public API v0 contract

All project/conversation/run endpoints require authenticated scope authorization. First-admin bootstrap and sign-in are separately guarded; health must not leak account, path or transcript data.

| Endpoint | Contract |
|---|---|
| `GET /api/v2/health` | Liveness, product/contract version and fixture-mode flag only; dependency readiness is a separate authenticated projection |
| `POST /api/v2/setup` | One-time local first-admin creation; reject rebootstrap; no default shared password |
| `POST /api/v2/session` | Authenticate, return a v2-scoped browser session with origin/CSRF protections and rate limits |
| `GET /api/v2/projects` | Authorized local projects, cursor pagination |
| `POST /api/v2/projects` | Create idempotently with name and client request key; return project and canonical conversation IDs plus real resource-readiness states |
| `GET /api/v2/conversations/{id}` | Authorized snapshot and paginated ordered messages, last sequence, role/run status projections |
| `POST /api/v2/conversations/{id}/messages` | Body `{client_message_id, text}`; client_message_id is the request key. Return 202 for newly persisted input and 200 for an identical duplicate, with `{message_id, event_id, sequence, status: "accepted"}`; mismatched replay returns 409 |
| `GET /api/v2/conversations/{id}/events` | Authenticated SSE with sequence cursor/Last-Event-ID, bounded buffering and reconnect; stale cursor triggers explicit snapshot resync, not silent loss |
| `GET /api/v2/runs/{id}` | Run state, admitted session/attempt projection, progress, evidence references, cancellation and blockers |
| `POST /api/v2/runs/{id}/cancel` | Persist cancel request and dispatch fence before model communication; return actual state and in-flight caveats |
| `POST /api/v2/projects/{id}/holds` | Owner/policy-authorized hold such as deployment; exact scope and durable generation, no model approval bypass |
| `POST /api/v2/approvals/{id}/decision` | Authorized approve/deny of exact pending effect digest, expected version and expiry; concurrent decisions consume at most once |

Domain errors expose `{code, message, request_id, retryable}` without stack traces or secrets. Enforce text/body limits and conservative timeouts. Rate-limit rejection is not an acknowledgement of persistence. In the first implementation use HTTP JSON for commands and SSE for changes; do not add a second WebSocket command protocol without a need.

Event envelope: `event_id, schema_version, owner_id, scope, aggregate_id, aggregate_version, sequence, correlation_id, causation_id, actor_kind, source, occurred_at, payload_ref_or_safe_payload`. Client projections must omit private IDs, tokens and provider credentials. History payloads are bounded and independently deletable where required; do not duplicate raw secrets/private text into immutable metadata.

## 5. Runtime and safety behavior

Application ports cover transactional admission, ordered inbox claim, session lease/renewal, canonical event append, run admission, capability authorization, effect dispatch/reconcile and evidence submission. Runtime commands are start/resume/fork/steer/interrupt with an explicit capability result. Unsupported operations return a typed blocker.

The fake adapter exposes controllable started, progress, approval_requested, completed, failed and stopped events. Tests can pause the deep turn for 30 seconds, lose a session, redeliver completion, inject a stale lease or crash after an effect intent. It must be impossible to select the fake adapter silently as a production fallback.

Never hold a database write lock while awaiting a provider. Per-scope sequencing, optimistic versions and lease generations resolve competing results. No actor retains valid effect authority after a revocation/hold generation invalidates it. Check the current fence at the dispatch gate; an action already dispatched before the hold may still complete, and must be reported/reconciled as such.

The UI Stop button invokes the deterministic API directly. Model prose cannot remove holds, impersonate an owner, grant new resources or mark work complete. Read-only fake result evidence is clearly labeled as synthetic. Auto-saving long-term memory is not part of this slice.

Codex uses a version-checked stdio protocol client, not terminal scraping. Claude uses an installed supported structured protocol with explicit auth mode. New docs may describe flags absent from installed binaries; record both. Do not run a production wrapper that changes ownership/ACLs just to probe help. No real inference, account copying or live route modification is required for this wave.

## 6. Acceptance scenarios

1. Fresh home starts, first-admin setup succeeds once, unauthenticated project/message/effect calls fail.
2. Create a project without GitHub/Jira/WhatsApp. Exactly one main conversation exists; local resource status is truthful. A claimed OXRM workspace requires an actual verified provisioner, not a placeholder.
3. Submit identical requests concurrently. One message/event/inbox item is admitted. Reuse the same key for changed text and receive conflict.
4. Hold deep work busy for 30 seconds. New messages still persist and the composer remains editable; deterministic acceptance does not await either model.
5. Fast and deep have different session IDs; worker execution has independent lifecycle. New input does not create another mandatory visible chat.
6. Stop a run while deep work is hung. New effects are fenced before model interruption; UI distinguishes requested, confirmed and uncertain/in-flight outcomes.
7. Try owner-role spoofing, cross-project access, stale lease completion, unauthorized success and reused/expired/mutated approvals. All are refused before effects.
8. Kill the server after successful message receipt, restart with the same isolated home, and recover exactly that message/inbox order. Kill around effect dispatch and quarantine unknown outcomes.
9. Reconnect SSE after receiving sequence N and recover subsequent events without duplicate message presentation. Slow clients do not grow an unbounded queue or stall admission.
10. Reopen the UI/server and inspect messages, result evidence and cancellation history. A run is not succeeded because a worker emitted the word done.
11. Run web build and an early iOS simulator build/probe. Record exact host/toolchain, keyboard/streaming/navigation results and genuine blockers; native acceptance cannot be replaced by a mobile screenshot.
12. Inspect test process/service/file changes: 1.x homes, workers, channels, credentials and deployment configuration are unchanged.

Target receipt/hold latency and hardware conditions are specified in migration.md. CI has distinct test and acceptance status: unimplemented scenarios remain pending and make the M1 milestone fail even if the scaffold's unit tests are green.

## 7. First PRs and completion report

Expected initial PR groups: foundation/contracts/store/API; fake session/runtime supervision; Dioxus shell and early iOS feasibility; independent acceptance/import inventory. Each targets `v2/rust-rewrite`, includes exact-head tests and is independently reviewed. Shared-schema changes are coordinated through Core; do not solve dependencies with duplicate models.

CI should include formatting, clippy, locked build/tests, architecture boundaries, API/fixture tests, crash/restart probes, web/WASM build, secret/dependency/license checks and a narrowly scoped macOS iOS build when policy permits. Workflow changes require existing policy checks, least permissions, pinned actions, no production secrets, no image publication or deploy step. Build-script/dependency execution is confined to the development environment.

A report must distinguish: plan committed; new threads created; work queued/running; code committed; tests passed; local app runnable; live provider verified. Supply the actual branch/commit/PR, test evidence and local run steps at the appropriate stage. Do not collapse those into one claim of completion.
