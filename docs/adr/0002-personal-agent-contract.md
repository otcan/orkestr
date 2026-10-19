# ADR 0002: Personal Agent Core Contract

- Status: Proposed; Lane A contract for OP-02 / ORK-536
- Date: 2026-10-18
- Scope: Shared backend and UX vocabulary for the Personal Agent vertical slice
- Reviewers: Lanes B and C should comment before this contract is frozen

## Context

Orkestr is adding a persistent personal-agent experience without replacing its
thread runtime or Agent Job engine. The product must distinguish ordinary
conversation from durable work, report evidence-backed task state, and allow
other lanes to build against one entity and event contract. This is an
application-level single-user trust model. It does not isolate root-capable
runtimes or turn application permissions into an operating-system security
boundary.

## Decisions

### Assistant identity and conversation boundary

There is one assistant identity per configured Orkestr owner, continuous across
the built-in web app and already-connected messaging surfaces. The identity is
not a model or a thread ID. Channel-specific threads remain transport and
context surfaces; changing a model or channel does not create a new assistant.

Ordinary chat is a conversation, not a project. Questions, planning, drafting,
and personal continuity do not implicitly create durable work. A Project is
created only when the owner explicitly starts or accepts substantial ongoing
work, or an explicit product action creates one. Project state is durable and
structured; chat text is evidence/context, not its source of truth.

### Entities and existing storage ownership

| Contract entity | Meaning | Canonical representation / owner |
|---|---|---|
| Assistant | Owner-scoped conversational identity and policy context | Existing owner/user identity and configuration; no new assistant table |
| Project | Durable grouping, goal, and lifecycle for related work | New `personal_agent_projects` table in the existing `agent-jobs.sqlite` Agent Job store (OP-03) |
| Task | A bounded outcome, criteria, lifecycle, and execution/resource references | New `personal_agent_tasks` table in that same store (OP-03); it is not an Agent Job run |
| Thread / Subthread | Conversation and execution context | Existing thread records; workers and child threads retain `parentThreadId`; task-agent threads use `threadKind` and parent binding |
| Workspace | Repository, branch/worktree, or virtual desk attachment | Existing worker/worktree and desktop lease/resource systems; task stores references, not copied workspace state |
| Memory | Owner-approved, provenance-bearing durable personal/project memory | `personal_agent_memories` in the existing `agent-jobs.sqlite` Agent Job store; Lane A owns its schema and additive migration, Lane B owns memory services/retrieval/context assembly |
| Decision | Owner instruction, delegated context, automation, or untrusted input with provenance | Existing messages/runtime context plus correlated events; preserve source and trust class, never promote arbitrary agent/web text to owner instruction |
| Event | Append-only fact about a message, task, run, tool/effect, approval, or artifact | Existing `events.jsonl`, `orkestr-events`, Agent Job checkpoints/effects and connector outbox; OP-05 adds the common envelope and cursor feed, not another event bus |
| Action | Proposed or performed tool/external effect | Existing Agent Job `effects` ledger and policy decision path |
| Approval | Owner decision bound to one proposed action | Existing Agent Job `approvals` / effect binding and approval services; OP-14 adds task-scoped evidence and UI, not a competing approval store |

Agent Job `runs`, `attempts`, `checkpoints`, `effects`, and `approvals` remain
the execution/audit primitives. A Task may reference a run; it does not
duplicate run state or effects. Existing `task-agents.js` and thread workers
create and supervise child threads. A Task references those thread IDs and may
also reference an Agent Job run. `thread-watches` remain subscriptions between
threads, not task records or a task event journal.

The initial schema is single-owner as the rest of this product is. It does not
add organization, tenant, or plugin abstractions. IDs are opaque stable strings.
Project and task records carry timestamps and a JSON payload for additive
contract evolution, while identity, status, relation, and idempotency fields
used for constraints and queries are first-class columns.

### OP-07 memory record and storage contract

Memory is opt-in durable product state, not transcript retention. The only
persisted content is content the owner explicitly asks to remember or approves
as a proposed memory. Neither Lane B nor the migration scans private threads,
copies message bodies, or promotes worker, connector, or web content into owner
memory without explicit owner confirmation.

The canonical categories are `preference`, `fact`, `decision`, `commitment`,
`open_loop`, and `project_summary`. `content_json` is category-validated
structured content owned by the memory service. The table contract is:

```sql
create table if not exists personal_agent_memories (
  id text primary key,
  idempotency_key text unique,
  category text not null check (category in
    ('preference', 'fact', 'decision', 'commitment', 'open_loop', 'project_summary')),
  scope_kind text not null check (scope_kind in ('owner', 'project')),
  scope_id text,
  content_json text not null,
  provenance_json text not null,
  source_event_id text,
  source_cursor text,
  consented_by text not null,
  consented_at text not null,
  created_at text not null,
  updated_at text not null,
  check ((scope_kind = 'owner' and scope_id is null) or
         (scope_kind = 'project' and scope_id is not null)),
  check (category <> 'project_summary' or scope_kind = 'project'),
  foreign key (scope_id) references personal_agent_projects(id) on delete restrict
);
create index if not exists personal_agent_memories_scope_category
  on personal_agent_memories(scope_kind, scope_id, category, updated_at);
```

Owner scope uses `scope_kind='owner'` and a null `scope_id`; project scope uses
the existing Project ID. A `project_summary` must be project-scoped. Other
categories may use owner or project scope. Task-scoped commitments/open loops
use their owning project scope and carry the Task ID in structured content;
they do not create a second task store. Retrieval for a project may combine
owner-scoped records and records for that exact project only. It must never
include records belonging to another project, and it must not infer permission
to read source threads from a memory reference.

`provenance_json` records the source kind and actor, origin/channel, capture
time, and whether the content was directly owner-authored or owner-confirmed.
It may include opaque task/project references, but never source message text,
credentials, or copied thread content. `source_event_id` and `source_cursor`
reference the canonical OP-05 event envelope when available; until then they
may be null. These are references to that envelope, not a second event schema.
Only consented records are stored or returned by retrieval. A pending memory
suggestion is transient until the owner accepts it. Arbitrary assistant,
worker, connector, and web text is untrusted evidence, not consent.

The provenance value is versioned JSON with `sourceKind`, `actorId`, `origin`,
`capturedAt`, and `trust` (`owner_authored` or `owner_confirmed`); an optional
opaque `taskId` may scope commitments/open loops. It is descriptive provenance,
not an authorization grant. Consent columns identify the owner and the time of
the current content's explicit approval.

The memory service must provide these owner operations:

- **Create/consent:** require an explicit owner save instruction or approval;
  record `consented_by` and `consented_at`; deduplicate retries with the
  idempotency key. Do not persist declined suggestions.
- **Correct:** replace `content_json` and provenance atomically on the same
  record, refresh consent actor/time and `updated_at`, and reference the
  correction event when available. Do not retain the superseded value in the
  memory table or in correction metadata.
- **Forget:** delete the memory row and its searchable content. Any OP-05 audit
  event may retain only the opaque memory ID and operation metadata, never its
  content or provenance payload. Do not keep a hidden tombstone containing the
  forgotten value.
- **Export:** return a deterministic owner-scoped JSON export of current
  consented records, including category, scope, content, provenance, consent
  time, timestamps, and opaque event references. Do not export source thread
  messages or forgotten values.

Lane A owns this record contract and the idempotent additive migration in the
existing Agent Job store. It runs only when `personalAgentFeature(env)` is on;
there is no new database, feature flag, event envelope, or production
migration. Lane B owns capture/consent orchestration, validation, retrieval,
correction/forget/export services, and bounded context assembly against this
contract. Tests must use synthetic fixtures and prove scope isolation,
provenance retention, explicit consent, correction/forget/export behavior,
restart durability, and that untrusted source text is never promoted.

### Task lifecycle and truth boundary

Allowed states are `queued`, `running`, `blocked`, `needs_approval`,
`succeeded`, `failed`, and `cancelled`. The last three are terminal.

Allowed transitions:

| From | To | Rule |
|---|---|---|
| `queued` | `running`, `cancelled`, `blocked`, `needs_approval` | Start requires an admitted execution or explicit transition evidence; cancellation is owner/policy authorized |
| `running` | `blocked`, `needs_approval`, `succeeded`, `failed`, `cancelled` | Transition is recorded with actor and evidence; success requires verified result evidence |
| `blocked` | `queued`, `running`, `needs_approval`, `cancelled`, `failed` | A blocker resolution/retry or explicit terminal decision is recorded |
| `needs_approval` | `queued`, `running`, `blocked`, `cancelled`, `failed` | Approval/rejection/expiry is resolved and audited; approval authorizes only the bound action |
| Terminal | none | Terminal state is immutable; correction is a new event/compensating task, not silent rewrite |

The lifecycle API validates transitions and persists the transition evidence
atomically with the Task row. A worker final message containing `done`,
`succeeded`, or equivalent text is only a report. It can never by itself mark a
Task successful. Success requires a structured completion result from the
trusted execution/control path, satisfied acceptance criteria, and evidence
references (for example a verified artifact or successful Agent Job run/effect
reconciliation). If evidence is absent, contradictory, or stale, the task
remains non-terminal or becomes `blocked`/`failed` according to the recorded
reason; the system must not invent success.

### Correlated event envelope

OP-05 will normalize events at existing append/dispatch boundaries to this
versioned envelope; existing event stores remain the persistence mechanisms:

```json
{
  "schemaVersion": 1,
  "eventId": "evt_<opaque-id>",
  "type": "task.state_changed",
  "occurredAt": "2026-01-01T00:00:00.000Z",
  "actor": { "kind": "owner|assistant|worker|system|connector", "id": "opaque-or-null", "origin": "web|whatsapp|agent_job|scheduler|..." },
  "projectId": "prj_<opaque-id-or-null>",
  "taskId": "tsk_<opaque-id-or-null>",
  "threadId": "opaque-or-null",
  "runId": "opaque-or-null",
  "causationId": "prior-event-or-command-id-or-null",
  "idempotencyKey": "stable-command-or-delivery-key",
  "cursor": "opaque-monotonic-feed-cursor",
  "data": {}
}
```

`eventId` identifies the event; `idempotencyKey` deduplicates command/effect
replay and is scoped to its source/operation; `causationId` links the immediate
cause, not an arbitrary conversation; `cursor` is assigned by the durable feed
and is opaque to clients. The actor's `origin` distinguishes human input,
delegation, automation and connectors. Event payloads must be bounded and must
not contain credentials or unnecessary message bodies. OP-05 owns the final
envelope normalization and cursor semantics; lanes must not introduce another
event schema or event bus.

OP-05 uses a feature-gated transactional dispatch outbox in the existing Agent
Job SQLite store. Task creation and state transitions enqueue their event in
the same transaction as the task mutation; dispatch appends the envelope to
`events.jsonl` and its existing rotations. A replay after append-before-ack
recognizes the stable `eventId`; the outbox enforces `(source, idempotencyKey)`
uniqueness and drops the payload after journal acknowledgement while retaining
only cursor/idempotency metadata. This is a delivery index, not a second event
journal. External effects continue to use the Agent Job effect ledger and its
reconciliation rules.

The migration is additive and runs only with `personalAgentFeature(env)`;
flag-off databases and older binaries remain compatible. Rollback is code-only:
revert the event-feed code and leave the outbox table and journal intact. Do
not drop event metadata or journal lines during rollback because consumers may
already hold cursors referencing them.

The owner-only `GET /api/personal-agent/events?cursor=<opaque>&limit=<n>` feed
drains pending internal events, then pages the retained JSONL journal. Its
cursor is an opaque `pa1.<base36-sequence>` token allocated transactionally;
clients must not parse or increment it. Replaying a cursor returns only later
logical events, with duplicate `eventId`s collapsed. If retention has removed
the cursor's continuation, the response sets `resetRequired: true` rather than
silently claiming a complete replay. The feed is disabled with the Personal
Agent flag and requires the authenticated owner context.

This first integration emits task lifecycle events through the common feed.
Existing message, worker, connector, tool, and artifact producers are not
implicitly rewritten by this change; they need explicit adapters that preserve
their source-specific actor and delivery semantics. In particular, connector
request/accepted/delivered states must remain distinct when those adapters are
added. Existing effect-ledger reconciliation remains authoritative for
uncertain external effects; an event replay is never permission to repeat one.

### Approval binding

Every approval decision is bound to the exact proposed `action`, canonical
`target`, permitted `scope`, and absolute `expiresAt`, plus task/run/effect
references, argument digest, requesting actor, and decision evidence. Approval
is single-use and is valid only while all binding fields still match and the
approval has not expired or been revoked. A changed argument, target, scope,
task, or expired approval requires a new approval. Existing Agent Job
`approvals` and `effects` are authoritative for execution; OP-14 connects task
scope and user-facing review to those records. App-level checks do not contain
root-capable workers.

### Flag and capability

There is one top-level configuration flag: `ORKESTR_PERSONAL_AGENT_ENABLED`.
Only the case-insensitive trimmed values `1` and `true` enable it; the default
is off. Its only reader is the Lane A-owned
`packages/core/src/personal-agent-feature.js`, whose contract is:

```js
export function personalAgentFeature(env = process.env) {
  return ["1", "true"].includes(String(env.ORKESTR_PERSONAL_AGENT_ENABLED || "").trim().toLowerCase());
}
```

Settings or instance-config UI is deferred to OP-20/OP-24 and must be an
additive change; no second source of truth or `features.personalAgent` field is
introduced.

`enabled` in the capability response reports this flag and is the UI visibility
gate. When enabled but storage prerequisites are unhealthy, show a
degraded/offline shell rather than hiding the feature. `capability` is true
only when enabled and the OP-03 Project/Task tables are present and usable.
Local assistant runtime health does not affect `capability`; it is reported
separately under `assistant`. When the flag is off, Personal Agent write APIs
are unavailable and legacy threads and Agent Jobs continue unchanged. The flag
does not change live channel routing.

### Minimal vertical-slice API contracts

These are contracts, not claims that routes already exist. All routes require
the existing authenticated owner context, enforce the single-user policy, and
return stable opaque IDs and structured errors. Read APIs return persisted
state plus `updatedAt`/source evidence; they do not infer state from chat text.

| Method and path | Contract |
|---|---|
| `GET /api/personal-agent/capability` | Authenticated owner-only, no side effects. Return `{ enabled: boolean, capability: boolean, reason?: "disabled" | "storage_unavailable", assistant: { available: boolean, reason?: "not_configured" | "local_runtime_unavailable" } }`. |
| `GET /api/personal-agent/projects` | List owner projects with bounded pagination/cursor and persisted summary/status |
| `POST /api/personal-agent/projects` | Idempotently create an explicit project from `{ title, goal?, idempotencyKey }`; return project and creation/replay result |
| `GET /api/personal-agent/projects/:projectId` | Return one project and bounded task summaries |
| `POST /api/personal-agent/projects/:projectId/tasks` | Create a `queued` task from `{ title, outcome, acceptanceCriteria, idempotencyKey, threadId? }`; no execution or external effect |
| `GET /api/personal-agent/tasks/:taskId` | Return persisted lifecycle, blocker/next-action evidence, and thread/run references |
| `POST /api/personal-agent/tasks/:taskId/transitions` | Request a validated `{ to, reason?, evidenceRefs?, idempotencyKey }` transition; policy and lifecycle service decide; free-form worker text is not evidence of success |

Cursor/event streaming is deliberately deferred to OP-05; these APIs must not
invent a private cursor or imply real-time completeness before that contract
exists. Request schemas are versioned with additive optional fields; unknown
state names and incompatible updates fail explicitly.

The capability endpoint must exist before OP-06. Lane A owns it as a small
server change; it checks the authenticated owner context and has no side
effects. With the flag off it still returns HTTP 200:

```json
{"enabled":false,"capability":false,"reason":"disabled","assistant":{"available":false,"reason":"not_configured"}}
```

When enabled, capability depends only on storage readiness (the OP-03 tables);
local-runtime health never makes it false. Until OP-09 supplies runtime health,
`assistant` is `{ available: false, reason: "not_configured" }`.

### OP-09 local assistant adapter contract

Lane B fills and registers the existing `openai-compatible` Agent Job adapter
slot; it does not add a second runtime or task store. Its adapter contract is:

- `step(ctx, { input, transcript })` processes one bounded step; cancellation
  follows the provided `AbortSignal`.
- Runtime configuration is explicit, with no implicit endpoint. Lane B owns
  `ORKESTR_PERSONAL_AGENT_LOCAL_BASE_URL`,
  `ORKESTR_PERSONAL_AGENT_LOCAL_MODEL`, and
  `ORKESTR_PERSONAL_AGENT_LOCAL_REASONING_EFFORT`. Probe/discovery reports
  health only for that configured endpoint; it must be loopback-only in the
  first release, with no scanning or silent model-server selection.
- Stream incremental `message.delta` updates through the existing `emit`
  mechanism and report usage through the existing Agent Job usage path.
- `toolLoop = "orkestr"`: all tools go through Orkestr policy and the existing
  effect ledger; the model adapter does not dispatch tools itself.
- `resume = "transcript"`; `structuredOutput = "validate"`.
- Missing/unavailable local inference is an explicit unavailable result. Never
  synthesize a reply or silently fall back to a cloud model.

Lane B owns the local-runtime environment variable names and exports
`personalAgentLocalRuntimeStatus(env)` with the contract
`{ available, reason?: "not_configured" | "local_runtime_unavailable", model?, checkedAt }`.
The capability endpoint delegates its `assistant` field to this helper once the
OP-09 change is available. Until then it returns
`{ available: false, reason: "not_configured" }`. Lane A alone owns
`ORKESTR_PERSONAL_AGENT_ENABLED`, Project/Task/Memory schemas and their
migrations, and the correlated event envelope. Lane B implements memory
services against the OP-07 record contract above and does not add competing
schemas or event formats.

Lane B's `b09f00bb` change passes the pinned provider config to
`agentJobProviderStatus` during admission and exports the existing native
attempt journal helper for adapter event emission. OP-03 adds only Project/Task
tables and store initialization; it does not modify
`agent-job-admission.js` or `agent-job-native-attempt.js`, so those changes are
file-disjoint and retain the Agent Job execution/effect contract.

### OP-18 route and UI boundary

The new Personal Agent route is `/assistant` in the existing manual path
routing. `/` and all legacy routes stay unchanged; changing the landing page is
deferred to OP-21 or an owner setting. The navigation entry and route are
available only when `enabled` is true. With the flag off, direct navigation to
`/assistant` returns the client to `/`. When enabled but `capability` is false,
the route remains visible and renders a degraded/offline shell without fake
project/task data. If `assistant.available` is false, the conversation pane
states that the local assistant is unavailable and must not fabricate replies.
Lane C may use clearly labelled test fixtures for the capability response
shape only. Project/task data integration and the APIs owned by OP-06/OP-08 are
out of OP-18 scope.

### Additive migration and rollback

OP-03 adds only Project/Task tables and indexes to the existing `agent-jobs.sqlite`
through an idempotent schema migration. Existing tables and rows are untouched;
no existing thread, run, effect, or approval IDs are rewritten. DDL is additive
and uses `CREATE TABLE/INDEX IF NOT EXISTS`; initialization must be safe on
legacy databases and on rerun. Tests use isolated sanitized fixture databases,
exercise dry-run planning without writes, and verify reopen/rerun and legacy
Agent Job operations.

Before any future production activation, back up the SQLite database and
validate the migration against a copy. Rollback is feature disablement plus a
forward-compatible binary rollback: old binaries ignore the new tables. Do not
drop new tables automatically on downgrade because they may contain user work.
Any destructive cleanup requires a separately reviewed export/backup and
explicit operator action. OP-03 does not run a production migration.

## Sample flows

### Ordinary conversation

1. Owner asks a question in an existing conversation.
2. The assistant answers in that thread; no Project or Task is created.
3. Any durable memory is handled only under OP-07 consent/provenance rules.

### Durable delegated work

1. Owner explicitly starts a project and bounded task; API creates the records
   idempotently in the Agent Job store.
2. The orchestration service creates or selects an existing child thread via
   task-agent/worker primitives and binds its ID to the Task. An Agent Job run
   may be admitted and referenced; it remains the execution source of truth.
3. Correlated events record admission, worker progress, blocker or approval
   requirement. A thread watch may deliver a finished child report to its
   parent, but does not update task state by itself.
4. On completion, trusted control logic verifies structured output and
   acceptance evidence before transitioning to `succeeded`; otherwise it
   records `blocked` or `failed`. A worker saying “done” is insufficient.

### Approval-required action

1. A task-scoped action is evaluated by existing policy/effect services.
2. If approval is required, the task enters `needs_approval`; the approval
   references the exact action, target, scope, expiry, argument digest, task,
   and run/effect.
3. Owner approval/rejection/expiry is audited. Only an unexpired, matching,
   unconsumed approval can authorize dispatch; a changed action needs a new
   approval.

## Consequences

- Lane B can define the local adapter against a durable, model-neutral task and
  evidence contract; local inference remains replaceable and is not the source
  of task truth.
- Lane C can build a flagged view against explicit capability and resource
  contracts without inventing UI-owned entities.
- Project/Task rows are a projection/coordination layer beside existing Agent
  Job execution records, not a second execution engine.
- The first slice has no durable event cursor until OP-05; clients must not
  treat polling timestamps as a gap-free event stream.

## Open questions for review

1. Should a Project be allowed to exist without Tasks, and what explicit
   statuses should Projects expose in the first UI?
2. Which completion evidence is mandatory for non-Agent-Job child threads, and
   which service owns acceptance-criteria verification?
3. Should the initial task API allow an ungrouped task, or require a Project?
4. None for the flag source, capability response, or OP-18 route gate; these
   are coordinator-bound decisions above. Other endpoint fields remain subject
   to their owning OP contracts.
5. Are event payload retention/redaction and owner export policy sufficient in
   OP-05, or does any event class require a narrower retention contract?
6. Which thread resource references should be first-class task columns versus
   typed `resource_refs` in the bounded JSON payload?
7. Lanes B/C: what minimum task/project states and API response fields does the
   first local-model interaction and home view require?

## References

- `docs/product/personal-agent-plan.md` and `docs/product/personal-agent-backlog.json`
- `docs/spec/agent-job.md`
- `packages/core/src/agent-job-store.js`, `agent-job-ledger.js`,
  `agent-job-admission.js`, `task-agents.js`, `thread-workers.js`,
  `thread-watches.js`, and `orkestr-events.js`
