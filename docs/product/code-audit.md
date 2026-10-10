# Code audit against the six capabilities

Status: snapshot of `main` on 2026-10-10. Paths are relative to the repo root.
`core/` means `packages/core/src/`, and `connectors/` means
`packages/connectors/src/`. Line counts are approximate.

**Summary.** Orkestr already has most of the *hard* parts: supervised Codex
and Claude Code runtimes with crash recovery, an idempotent connector outbox,
resource policy with an audit outbox, approvals, a vault, timers and watches.
They are all organised around **chat threads**, not jobs. The work is to add a
thin Agent Job layer (spec, run store, effect ledger, adapter interface) that
*reuses* these pieces. It is not a rewrite. The two biggest risks are the
thread coupling inside the Codex and Claude runtimes, and the size of
`core/runtime-leases.js` (about 6.3k lines).

## P0-1 Provider adapters

| Exists | What it does |
| --- | --- |
| `core/executors.js` | Executor registry (`registerExecutorAdapter`, overlay-loaded adapters, `runNextThreadMessage`). Built-ins: `noop`, plus a `codex` placeholder that throws `codex_executor_not_configured`. |
| `core/runtime-codex-adapter.js` | Façade over the Codex app-server: start/resume/interrupt/compact/status. |
| `core/codex-app-server*.js` | JSON-RPC client (`thread/start`, `turn/start`, `turn/steer`, `turn/interrupt`, `thread/resume`), live state, approvals, user input. |
| `core/runtime-claude-code-adapter.js`, `core/claude-code-*.js` | Claude Code CLI (`stream-json`) process runner, supervised process, reattach, orphan recovery, interrupt/resume, rate-limit deferral. |
| `core/tenant-api-agent.js`, `core/tenant-api-agent-tools.js` | A Responses-API tool loop (`postOpenAIResponse`, which honours `OPENAI_BASE_URL` and sends `Idempotency-Key`). |
| `core/turn-lifecycle.js` | Normalized turn states/events (`ready`, `completed`, `failed`, `interrupted`, `awaiting_approval`). |
| `core/llm-account-profiles.js` | Provider account profiles. |

* **Reusable.** Both real runtimes and their recovery logic. The turn
  lifecycle vocabulary. The executor registry shape for the new adapter
  registry. The API-agent loop as the seed of the Orkestr-provided tool loop.
* **Gaps.**
  * There is no common interface; each runtime exposes start/interrupt/resume
    differently.
  * The runtimes are keyed by an Orkestr thread id and write chat messages.
  * There is no `simulated` provider and no conformance suite.
  * The tool loop is tied to tenant tools.
* **Risk.** Wrapping the runtimes without moving them. Each adapter in
  `core/agent-adapters/` should *delegate* to the existing modules and pass a
  synthetic "job thread", and should not fork their logic.

## P0-2 Durable execution

| Exists | What it does |
| --- | --- |
| `packages/storage/src/store.js` | JSON state plus `appendEvent` event log. |
| `packages/storage/src/thread-registry.js`, `packages/storage/src/thread-message-registry.js` | SQLite thread and message registries. |
| `core/runtime-leases.js` | Leases, wake/sleep, pending-input delivery, stale-input recovery (about 6.3k lines). |
| `core/runtime-lease-lock.js`, `packages/storage/src/storage-lock.js` | Process-identity plus file locks. |
| `core/runtime-liveness.js` | Liveness, probe failures, `saveRuntimeCheckpoint`. |
| `core/runtime-final-delivery.js` | Pending/acknowledged final replies. |
| `core/codex-app-server-recovery.js`, `core/claude-code-orphan-turn-recovery.js` | Recover stale and orphaned turns after restart. |
| `core/deploy-drain.js`, `core/runtime-fault-injection.js`, `core/state-backups.js` | Drain flag, fault injection hooks, state backups. |

* **Reusable.**
  * `saveRuntimeCheckpoint` becomes the seed of the checkpoint journal.
  * Fault injection supports the guarantee tests.
  * The lock primitives back the run lease.
  * Recovery modules sit behind `adapter.resume`.
* **Gaps.**
  * There is no Run/Attempt record and no `max_attempts` or backoff outside
    the connector outbox.
  * `executors.recoverInterruptedExecutions` marks running executions
    **failed** (`interrupted_by_orkestr_restart`) instead of resuming them.
  * There is no effect ledger for agent tool calls.
* **Risk.** Adding job logic to `runtime-leases.js`. All new run, attempt and
  checkpoint code must go in new modules (`core/agent-job-*.js`).

## P0-3 Event triggers

| Exists | What it does |
| --- | --- |
| `core/timers.js` | Timers with cadence `once`, `interval`, `daily` and `weekly` (`createTimer`, `markDueTimers`, `runTimerNow`). |
| `core/automations.js`, `core/automation-doctor.js` | Automation CRUD and diagnostics. |
| `core/thread-watches.js`, `core/thread-watch-pump.js` | Watch modes and triggers on thread finals. |
| `core/mailbox-routes.js`, `core/mailbox-thread-delivery.js` | Inbound email to thread (with an idempotency key). |
| `apps/server/src/modules/connectors/connectors.controller.ts` | WhatsApp inbound. |
| `core/mcp-event-delivery.js` | *Outbound* HMAC-signed webhooks to subscribers. |

* **Reusable.**
  * Schedule triggers compile to timers; the job spec mirrors the timer
    cadences on purpose.
  * The HMAC signing code from `mcp-event-delivery.js` can verify inbound
    signatures.
  * The mailbox idempotency pattern gives `run_key`.
* **Gaps.** There is no generic inbound webhook endpoint, no
  `POST /api/jobs/<job>/runs`, no declarative trigger config, and no run-level
  dedupe.

## P0-4 Tool authorization and approvals

| Exists | What it does |
| --- | --- |
| `core/thread-resource-policy-*.js` | Per-thread resource grants, `authorizeThreadResourceAccess`, SQLite/Postgres stores, audit outbox, doctor. |
| `core/policy.js`, `core/action-registry.js`, `core/security.js` | Owner/admin policy, action registry, security checks. |
| `core/claude-code-mcp-policy.js` | MCP tool allow-list for Claude Code. |
| `connectors/connectors-mcp-approval.js`, `connectors/outbound-message-approval.js`, `connectors/whatsapp-security-approval.js` | Approval gates for connector MCP calls and outbound messages. |
| `core/vault-*.js` | Vault store/service, thread- and turn-scoped tokens. |

* **Reusable.**
  * The approval request/decision flow from the connector approvals.
  * The resource-policy audit outbox as the audit sink for tool decisions.
  * Vault turn tokens for `ctx.resolveSecret`.
* **Gaps.**
  * There is no per-tool `allow`/`approval_required`/`deny` evaluation for
    agent tool calls; `agentJobToolDecision` in `core/agent-job-spec.js` is
    the first piece.
  * Approvals are connector-specific, with no generic queue bound to
    `effect_key`/`args_hash`.
  * Codex native approval requests go to a human prompt, not to policy.

## P1 Observability and audit

| Exists | What it does |
| --- | --- |
| `core/audit-events.js` | Normalizes and filters events from the generic event log. |
| `core/observability*.js`, `core/perf-*.js` | Counters, histograms, perf logs, health sampling. |
| `core/router-traces.js`, `core/router-doctor*.js`, `core/system-doctor.js` | Delivery traces and doctors. |

* **Reusable.** The event log as the storage for the per-run audit stream.
  Doctors as a model for `orkestr doctor jobs`.
* **Gaps.** There is no per-run sealed audit record, no `orkestr runs show`,
  and no OpenTelemetry export (P1, after the record exists).

## P2 Coordination

These already exist: `core/thread-workers.js` (parent/worker threads),
`core/task-agents*.js`, `core/thread-bridge*.js`, `core/executor-handoff*.js`
and the `orkestr send` / `orkestr watch` CLI. **Freeze them.** Revisit only
when a job needs to fan out (P2).

## Idempotency building blocks (cross-cutting)

`connectors/connector-outbox.js` is the model for the effect ledger:

* `connectorOutboxIdempotencyKey` derives the key from logical fields.
* `ensureConnectorOutboxJob` upserts on a unique `idempotency_key`.
* `claimConnectorOutboxJob`, `releaseConnectorOutboxClaim` and
  `markConnectorOutboxJob` manage the lease and state.
* Retry policy lives in `connector-outbox-retry-policy.js`.
* A Postgres variant exists.

Related pieces: `connectors/whatsapp-outbox-ledger-match.js` (matching a
ledger to observed external state, which is *reconciliation*),
`connectors/whatsapp-replay-safety.js`, `core/orkestr-events.js`
(`orkestrEventIdempotencyKey`) and `core/reply-delivery-intent.js` (epoch
fences). **Decision:** the effect ledger is a new table that follows the same
schema and claim protocol. It does not reuse the connector outbox table,
because effects are not deliveries. Notifications *do* reuse the outbox
directly.

## Peripheral: freeze list

Keep these working and fix bugs, but add no features unless the core needs
them:

* **Voice and telephony.** `core/hush-voice*.js`, `core/voice-*.js`,
  `core/vagent*.js`, `scripts/twilio-*.mjs`.
* **LinkedIn, jobs and CRM-like workflows.** `core/linkedin-*.js`,
  `core/jobs-queue.js`, `core/jobs-jd-cache-mcp.js`, `core/job-alerts.js`,
  `core/workflow-lead*.js`, `core/project-inquiries*.js`.
* **Desktop shares and virtual desktops.** `core/desktop-*.js`,
  `apps/server/src/desktop-*.ts`. Keep them as a tool backend only.
* **Tenant slices, VMs and the broker.** `core/tenant-slice-*.js`,
  `core/tenant-vm-*.js`, `core/broker-instance-*.js`.
* **Public site, waitlist and shared apps.** `apps/server/src/public-site*.ts`,
  `core/user-waitlist.js`, `core/shared-apps.js`, `core/public-apps.js`.
* **Mobile and calendar export.** `core/mobile-*.js`,
  `core/calendar-export.js`.
* **WhatsApp feature work beyond notifications and approvals.** Group
  management and media features.
* **Dashboard UI work beyond a Runs list and Run detail page.**

## Size hotspots (do not grow)

| File | Lines |
| --- | --- |
| `core/runtime-leases.js` | 6305 |
| `core/codex-app-server.js` | 2866 |
| `core/tenant-api-agent.js` | 2731 |
| `core/security.js` | 2390 |
| `core/tenant-api-agent-tools.js` | 2048 |
| `apps/cli/src/commands.js` | 2820 |

New CLI verbs (`demo`, `init`, `run`, `runs`, `approvals`) go in separate
modules under `apps/cli/src/`, with only a one-line dispatch added to
`commands.js`.

## Contributor experience

* Tests use `node:test` in `test/*.test.js`, run by
  `scripts/ci-test-runner.mjs` with an isolated env (`test/test-bootstrap.mjs`)
  and no cloud credentials. Keep it that way: the `simulated` provider and
  fake backends are mandatory for any new runtime test.
* `yaml` is currently a **devDependency** (used only by
  `scripts/security/workflow-policy.mjs`), so
  `core/agent-job-spec-yaml.js` loads it lazily. Move it to `dependencies`
  when `orkestr run <file>` ships.
