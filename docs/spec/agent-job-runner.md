# Agent Job runner (v0)

Status: the runtime (store, recovery, ledger, approvals, triggers, CLI) is
implemented and proven with the `simulated` **test fixture**. Real jobs must
use a connected `codex` or `claude-code` provider (owner decision 2026-10-10,
[agent-job.md §9](agent-job.md#9-owner-decisions-2026-10-10)). Both have a
built-in job executor behind one shared native executor interface
([Native executors](#native-executors)): `codex` on its own Codex app-server,
`claude-code` on `claude -p` with a per-call permission hook. Orkestr
sends no usage telemetry or pings. Spec: [agent-job.md](agent-job.md).
Guarantees: [runtime-guarantees.md](runtime-guarantees.md).

## What works today (2026-10-10)

| Provider | Connected when | Runnable when | Stock install |
| --- | --- | --- | --- |
| `codex` | `codex login status` reports logged in **and** `codex app-server --help` works (the same checks as `orkestr doctor`) | connected **and** the built-in Codex job executor (`agent-job-codex.js`, `jobExecutor: "codex-app-server"`) is registered and not switched off with `ORKESTR_AGENT_JOB_CODEX_EXECUTOR=0`, or an overlay executor with id `codex` is registered | **runnable** once logged in |
| `claude-code` | `claude auth status --json` reports logged in | connected **and** the built-in Claude Code job executor (`agent-job-claude-code.js`, `jobExecutor: "claude-code-cli"`) is registered and not switched off with `ORKESTR_AGENT_JOB_CLAUDE_CODE_EXECUTOR=0`, or an overlay executor with id `claude-code` / `claude` is registered | **runnable** once logged in |
| `openai-compatible` | no probe yet | no adapter yet | not runnable |
| `simulated` | only under `node --test` | only under `node --test` | never selectable in user job specs |

So on a stock install a logged-in Codex or Claude Code runs jobs. When a
provider is logged in but has no executor (its switch is `0`), `orkestr init`
writes a job and warns, while `orkestr run`, the trigger endpoint, schedules
and WhatsApp triggers refuse and audit the refusal. Executors registered by an
overlay (`ORKESTR_OVERLAY_DIR`) under those ids are an explicit operator
choice and take precedence over the built-in executors. The thread-level
`codex` registry entry in `executors.js` (used by thread routing, not by jobs)
and `getExecutorAdapter()`'s fallback to the no-op executor never count as job
executors. The runtime itself (store,
recovery, ledger, approvals, triggers, audit) is fully exercised by the
tests with the simulated fixture.

## Modules

| Module (`packages/core/src/`) | Role |
| --- | --- |
| `agent-job-store.js` | SQLite store `ORKESTR_HOME/agent-jobs.sqlite` (override: `ORKESTR_AGENT_JOBS_DB`): pinned specs, registered jobs, runs, attempts, the checkpoint journal and run leases. Every multi-row change is one `BEGIN IMMEDIATE` transaction, which also serializes the server, `orkestr run` and `orkestr jobs` processes that share one home. |
| `agent-job-admission.js` | Loads job files, registers them, admits runs with `run_key = H(job, trigger, dedupe_key)`, applies `concurrency`, records cancels. |
| `agent-job-runner.js` | `driveRun()`: takes the lease, recovers an interrupted attempt, runs attempts until the run is terminal or parked. `driveDueRuns()` drives everything that can progress. |
| `agent-job-effects.js` | Authorizes every tool call (`agentJobToolDecision`), runs side effects through the ledger, reconciles after crashes and applies approval binding. |
| `agent-job-ledger.js` | Effect rows (`intended` → `committed` \| `failed` \| `unknown`) and approvals. |
| `agent-job-tools.js` | Tool registry (`effect`, `logicalKey`, `reconcile`, `perform`) and the offline tools: `demo.*`, `repo.*` (local git) and `github.*` (fake code host only, opt-in with `inputs.code_host: fake`). |
| `agent-job-adapters.js` | Adapter registry and the provider gate (`agentJobExecutorFor`): overlay executor first, else the built-in native executor if its env switch is on. Registers `codex`, `claude-code` and the `simulated` test fixture (scripted, Orkestr tool loop, transcript resume; resolvable only under `node --test`). Overlay executors run one native turn through `executors.js` (trigger event included in the prompt). |
| `agent-job-native-interface.js` | The shared native executor interface: context and outcome contract, `NATIVE_EVENT_TYPES`, env switches, `nativeAttemptError` (turn error classes → runner kind/retryable) and `nativeExecutorProblems` (shape check). |
| `agent-job-native-attempt.js` | Runner side of native attempts: builds the context (workspace, resume, signal, `emit` into the run journal, `authorizeTool` per-call authorization with approvals, `executeTool` through the effect ledger) and maps the outcome. |
| `agent-job-codex.js` | The `codex` executor, see [Codex](#codex). Uses `codex-job-session.js` (start/resume/turn/interrupt on a Codex thread that has no Orkestr thread record) and `codex-job-client.js` (a separate app-server process whose notifications go to the job session, never to thread projection or WhatsApp). |
| `agent-job-claude-code.js` | The `claude-code` executor, see [Claude Code](#claude-code). |
| `agent-job-permission-broker.js`, `agent-job-claude-permission-hook.js` | Per-attempt Unix-socket permission broker and the Claude Code `PreToolUse` hook command that asks it (fails closed). |
| `agent-job-workspace.js` | Per-run workspace `ORKESTR_HOME/agent-job-workspaces/<job>/<run>`: a detached `git worktree` of `inputs.repository_path` for repository jobs, else a plain directory. |
| `agent-job-providers.js` | Honest provider gate. A provider is *connected* when the user's login works and *runnable* when Orkestr also has a real job executor for it. Runs are admitted, and attempts started, only on runnable providers; every admission refusal is written to `trigger_audit`. Probes live in `packages/connectors/src/agent-job-provider-probes.js` (cached 60 s); with no probe a provider counts as not connected. |
| `packages/connectors/src/whatsapp-job-triggers.js` | WhatsApp group-message triggers and `approve`/`deny` replies, called from the existing inbound router (`routeWhatsAppInbound`). |
| `agent-job-audit.js` | Sealed audit record per terminal run and notification intents, written in the same transaction as the state change they announce. |
| `packages/connectors/src/agent-job-notification-relay.js` | Moves notification intents into the connector outbox (same idempotency key). Called by the server scheduler and the CLI after driving. |
| `packages/connectors/src/agent-job-notification-dispatcher.js`, `agent-job-webhook-delivery.js` | Delivers `agent_job` outbox rows to thread, WhatsApp, email and outgoing webhooks, at most once per row (see [Notifications](#notifications)). Run by the server scheduler after each relay. |
| `agent-job-hooks-http.js`, `agent-job-webhook-signature.js`, `agent-job-secrets.js` | Signed webhook trigger `POST /api/jobs/<job>/hooks/<name>`: HMAC-SHA256 with the trigger's `secret_ref`, resolved through the secure secret manager. |
| `agent-job-timer-entries.js` | Schedule triggers as read-only rows in `GET /api/timers`. |
| `agent-job-scheduler.js` | Server background driver: resume on start, schedule triggers, periodic sweep. |
| `agent-job-http.js`, `agent-job-trigger-auth.js` | `POST /api/jobs/<job>/trigger` and its machine-token auth. |
| `agent-job-faults.js` | Fault injection at named points (tests). |

`effect-ledger.js` (used by the thread-level `simulated` executor) uses the
same effect state names.

## Lifecycle as implemented

1. **Admit.** `admitRun()` resolves the trigger, computes `run_key`, and in one
   transaction returns the existing run (`deduplicated: true`) or inserts a
   `pending` run pinned to `spec_hash`. With `concurrency: forbid` a run that
   meets an active one is stored as `skipped` (sealed); `replace` records a
   cancel on the active runs; `queue` waits until older runs are terminal.
2. **Lease.** A driver holds `runs.lease_holder` (`host:pid:nonce`) with an
   expiry (`ORKESTR_AGENT_JOB_LEASE_MS`, default 30 s) renewed by a heartbeat.
   Another driver may take over when the lease expired, or immediately when
   the holder is a dead pid on the same host (so a restart after `kill -9`
   does not wait). Effects are dispatched only while the lease is held.
3. **Recover.** If the last attempt is still `starting`/`running`, it is
   marked `interrupted` (with the journal point it died at), every dispatched
   but uncommitted effect is reconciled, and every `unknown` effect gets an
   approval request that parks the run (G4).
4. **Attempt.** The provider is `[agent, ...fallback][provider_index]`. For
   the Orkestr tool loop, each step is checkpointed (`message`,
   `tool_requested`, `tool_decision`, `effect_intended`, `effect_dispatched`,
   `effect_committed`, `tool_result`, `approval_requested`, `final_output`).
   A resumed attempt receives the transcript and continues after the last
   completed step; committed effects are short-circuited (G3).
5. **Errors.** `provider` errors move to the next fallback provider;
   retryable errors back off (`runtime.retry`) in state `retrying`; task
   errors fail the run. Attempts that ended in an approval wait do not count
   toward `max_attempts`; interrupted attempts do. Exhausted runs fail with
   `recovery_loop` when the last two or more interruptions happened at the
   same journal point, else `max_attempts_exhausted` (G5).
6. **Finish.** Output is checked against `output_schema` (type, required,
   properties, items, enum), the run becomes terminal and its audit record is
   sealed in the same transaction, together with the notification intents.

## Native executors

`codex` and `claude-code` implement one interface
(`agent-job-native-interface.js`, conformance gap 7). The runner
(`agent-job-native-attempt.js`) gives each attempt the same context and reads
the same outcome:

| Part | Contract |
| --- | --- |
| start | `run(ctx, input)` runs one attempt in `await ctx.prepareWorkspace(input)` and emits `session.started {sessionRef, resumed}` before any tool runs |
| resume | `ctx.resume = {sessionRef, attempt, reason}` from the last `session_started` checkpoint of the same provider; the executor resumes that provider session (`thread/resume`, `--resume`) |
| cancel | `ctx.signal` aborts with `cancelled`, `timeout` or `lease_lost`; cooperative executors (`codex`) get 10 s to interrupt the turn, kill-style ones (`claude-code`) 5 s |
| progress | `ctx.emit(event)` with `workspace.ready`, `session.started`, `message.delta` / `message.completed`, `tool.requested` / `tool.completed`, `usage`, `output.repair`; the runner writes redacted, capped checkpoints (`workspace`, `session_started`, `progress`, `usage`, `output_repair`) |
| tool permission hook | every provider-native call asks `ctx.authorizeTool({tool, args, callId})` → `allow`, `deny`, `pending`, `expired`, `cancelled` under `permissions.tools` (default deny); each decision is a `tool_decision` checkpoint |
| approval pause | `pending` binds an approval to `(tool, args)`; the executor stops the turn and returns `{type: "park", approval}`; after `approve` the next attempt resumes the session and the same call is allowed once (G7), after `deny` it is refused. The runner parks the run through the same path as Orkestr tools, so the `approval_required` notification (with the `approve <id>` / `deny <id>` hint) is relayed and delivered by the [notification dispatcher](#notifications) |
| Orkestr tools | `ctx.executeTool(call)` runs a job tool through the decision and the effect ledger (`codex` exposes them as dynamic tools) |
| output | `{type: "final", output}`; with `output_schema` the final answer is parsed as JSON (bare or fenced) |
| error class | failures throw `nativeAttemptError(classification)` with the turn error classes of `runtime-turn-error-class.js`: `auth` → provider error, no retry (fallback applies); `rate_limit` / `transient` → retryable provider error; `permanent` → task error |
| gate | `jobExecutor`, `enabled(env)` and an env switch (`ORKESTR_AGENT_JOB_CODEX_EXECUTOR`, `ORKESTR_AGENT_JOB_CLAUDE_CODE_EXECUTOR`; `0`/`false`/`off` disables) |

`test/agent-job-native-interface.test.js` checks that both executors satisfy
the interface and the gate and drives each with the same recording context
(one turn, and the approval pause). `test/agent-job-native-notifications.test.js`
checks that a native approval pause of either executor is delivered once by
the dispatcher with the approve/deny hint.

### Codex

One attempt is one turn on a Codex app-server thread owned by the run.

* **Workspace.** Codex runs in the run's workspace with sandbox
  `workspace-write` and approval policy `untrusted`. Repository jobs get a
  detached git worktree of the repository's `HEAD`; the repository's own
  working tree and `HEAD` are untouched.
* **Orkestr tools.** Every registered job tool that `permissions.tools` does
  not deny is given to Codex as a dynamic tool (`repo.branch.push` →
  `repo__branch__push`). Each `item/tool/call` runs `ctx.executeTool`. A call
  to a tool that was not exposed is still checked and denied.
* **Codex approvals.** Codex's own approval requests go through
  `ctx.authorizeTool` as job tools:
  `item/commandExecution/requestApproval` → `codex.command {command, cwd}`,
  `item/fileChange/requestApproval` → `codex.file_change {changes}`,
  `item/permissions/requestApproval` → `codex.permissions`, MCP tool-call
  elicitations → `codex.mcp {server, message}`. `allow` accepts (not
  ledgered: it stays inside the sandbox), `deny` or unlisted declines,
  `approval_required` interrupts the turn and parks the run. Other server
  requests (user input, auth refresh) are refused: nobody watches a job turn.
* **Cancel, timeout, resume.** The abort sends `turn/interrupt`. The next
  attempt (after a crash, restart, backoff or approval) resumes the Codex
  thread with `thread/resume` and starts a turn that says what was already
  committed. If the thread cannot be resumed, a new one is started with the
  committed-effects summary.
* **Output.** A schema mismatch is re-asked once. Without a schema, non-JSON
  text becomes `{ text }`. API keys are redacted from error messages.

### Claude Code

An attempt runs `claude -p --output-format stream-json` with the host Claude
login (the one `claude auth status` reports), no thread record:

* **Workspace.** The run's workspace (mode 0700), the same for every attempt.
  The child gets an allowlisted env (`PATH`, `HOME`, locale, `TMPDIR`, TLS CA
  vars, `CLAUDE_CONFIG_DIR`), background tasks off, no MCP servers
  (`--strict-mcp-config`) and no `ORKESTR_*` values besides the broker address
  and token.
* **Per-call permissions (G6).** `--settings` installs a `PreToolUse` hook for
  every tool. The hook asks the attempt's broker, which calls
  `ctx.authorizeTool`: Claude tools are named `claude.<tool>` (`Bash` →
  `claude.bash`), MCP tools `mcp.<server>.<tool>`. A blocked call is reported
  to the model with the reason. A hook error, timeout or missing broker
  blocks the call (exit 2). A `tool_result` for a call that never passed the
  hook fails the attempt with `claude_code_permission_hook_bypassed`.
* **Cancel and resume.** The abort sends SIGTERM, then SIGKILL, to the process
  group. The session id is emitted before any tool runs; the next attempt runs
  `--resume` on it.
* **Errors.** CLI failure codes are classified with
  `classifyClaudeCodeFailureCode`; a killed process is `transient`, a missing
  CLI a non-retryable provider error.

Tests: `test/agent-job-codex.test.js`, `test/agent-job-codex-example-a.test.js`
(Example A end to end on the fake Codex app-server and fake code host),
`test/agent-job-claude-code.test.js` and the `codex-job` and
`claude-code-job` conformance suites, all against fake CLIs (the Claude fake
runs the real hook).

## Approvals

An approval is bound to `(effect_key, args_hash)`. Deciding is one atomic
update, so concurrent `approve`/`deny` calls from several processes produce
exactly one decision; later ones get `approval_already_decided`. Approved
approvals are consumed once, right before the effect is dispatched. If the
agent issues the call with different args, the old approval no longer
matches and a new one is requested. Pending approvals expire after
`runtime.approval_timeout`; the effect fails (`expired`) and the run fails with
`approval_expired`. For an `unknown` effect, *approve* means "perform it once
more" and *deny* means "skip it" (the agent gets `skipped`).

Decisions come from `orkestr jobs approve|deny`, or from a WhatsApp reply
`approve <approval-id>` / `deny <approval-id>` posted in the job's configured
group by an allowlisted sender of that job's `whatsapp` trigger (anything
else is rejected and audited). Email approvals and a UI button are
follow-ups.

## Triggers

* **API**: `orkestr run <job.yaml|dir>` (registers the job file, admits, drives)
  or `POST /api/jobs/<job>/trigger` with an optional `Idempotency-Key`.
* **Webhook (signed)**: `POST /api/jobs/<job>/hooks/<name>` needs no session or
  bearer token; it is authenticated only by an HMAC-SHA256 signature over the
  raw request body, made with the trigger's `secret_ref` (`vault://<name>`,
  resolved through the secure secret manager, user scope of the admin first,
  then global; never logged or stored in the job store). Accepted headers:
  * `X-Orkestr-Timestamp: <unix seconds>` + `X-Orkestr-Signature-256:
    sha256=<hex>` over `<timestamp>.<raw body>`. The timestamp must be within
    `ORKESTR_AGENT_JOB_WEBHOOK_TOLERANCE_S` (default 300 s).
  * GitHub style `X-Hub-Signature-256: sha256=<hex>` over the raw body.
    GitHub signs no timestamp; `ORKESTR_AGENT_JOB_WEBHOOK_REQUIRE_TIMESTAMP=1`
    refuses it.

  The comparison is constant time. The dedupe key comes only from the signed
  body (the trigger's `event_id` JSON pointer, else the body hash); unsigned
  headers such as `Idempotency-Key` or `X-GitHub-Delivery` are ignored, so a
  replayed request can never start a second run. Redeliveries return the
  first run with HTTP 200, new runs return 202. Every refusal (unknown job or
  hook, missing secret, bad/stale/missing signature) returns the same 401
  `agent_job_webhook_unauthorized` and is written to `trigger_audit` with a
  reason code and no body. Only `application/json` bodies are accepted.
* **Webhook (token)**: `POST /api/jobs/<job>/trigger?hook=<name>` with the
  trigger bearer token or an admin session still works, with the same dedupe
  rules plus an optional `Idempotency-Key`.
* **WhatsApp**: the inbound router (`routeWhatsAppInbound`) offers every
  message to `dispatchWhatsAppJobTriggers()` before thread routing; failures
  there never block thread routing. A run is admitted only for a message in
  the trigger's `group` (chat id, or `binding:<id>` resolved through the
  existing binding registry), from a sender on `senders` (compared as
  canonical participant ids, so `+15550100001` matches
  `15550100001@c.us`), matching `match`. The message id is the dedupe key.
  The trigger event (`text`, `sender`, `messageId`, `chatId`, `quoted`) is
  stored with the run and passed to the agent. The local bridge now records
  quoted/reply context (`whatsapp-quoted-context.js`). DMs from allowlisted
  people, unknown senders in the group and provider-not-connected refusals
  are written to the `trigger_audit` table without message text; own
  (`fromMe`) messages are ignored so Orkestr's own replies cannot trigger
  jobs. There is no email trigger.
* **WebUI**: uses the API trigger; a WebUI button is a follow-up.
* **Schedule**: each schedule trigger keeps a `next_fire_at` slot computed
  with the timer cadence code (`nextRunAt` in `timers.js`). The slot time is
  the dedupe key, so a slot fires once even across processes, and missed
  slots while the server was down are coalesced into one run. A slot whose
  admission is refused (for example the provider is not connected) is
  skipped and audited. Admins see every schedule trigger in `GET /api/timers`
  (`orkestr timers list`, Ops "Global Timers") as a read-only row
  (`id: agent-job:<job>:schedule-<n>`, `targetType: agent_job`,
  `readOnly: true`, next fire time from the schedule slot). The rows are not
  stored as timers and the timer runner never runs them; edit, pause, run and
  delete return 409 `agent_job_schedule_read_only`. Change the job file
  instead.

Auth: the trigger endpoint accepts a bearer token from
`ORKESTR_AGENT_JOB_TRIGGER_TOKEN(S)` (machine auth `agent_job_trigger`) or a
normal admin session / CLI token.

Jobs are registered by `orkestr run`, and on every server sweep from
`ORKESTR_HOME/agent-jobs/` (or `ORKESTR_AGENT_JOBS_DIR`) and
`$ORKESTR_OVERLAY_DIR/jobs/`.

## Notifications

Notification intents are written with the state change (G10), relayed into
the connector outbox as `connector: agent_job` rows keyed
`H(run, event, channel, target)`, and delivered by
`dispatchAgentJobNotifications()`. Only the holder of a row's outbox claim
delivers it and terminal rows are never claimed again:

| channel | target | delivery | after a crash mid-delivery |
| --- | --- | --- | --- |
| `thread` | thread id | `appendThreadMessage` as an assistant message (`source: agent_job`) with the row key as idempotency key | retried; the thread returns the first message |
| `whatsapp` | chat id or `binding:<id>` | a `connector: whatsapp` outbox row (`<row key>:whatsapp`, `deliveryType: agent_job_notification`) through the existing claim → `sendWhatsAppText` → mark path | the expired claim is quarantined as `delivery_uncertain`; never resent |
| `email` | address | the existing mail path (`sendEmail`) | a send fence is written first; a fenced row without an outcome becomes `delivery_uncertain` |
| `webhook` | `https://` URL or `vault://` ref to one | `POST` JSON with `Idempotency-Key` / `X-Orkestr-Delivery` = row key, redirects not followed | retried with the same key so the receiver can drop it |

WhatsApp `approval_required` messages always end with
`Reply "approve <id>" or "deny <id>" in this group.`, the reply handled by
`whatsapp-job-triggers.js`. Network errors, timeouts, HTTP 408/425/429/5xx,
thread and email errors are retried with exponential backoff
(`ORKESTR_CONNECTOR_OUTBOX_RETRY_BACKOFF_MS`, capped by
`ORKESTR_CONNECTOR_OUTBOX_RETRY_BACKOFF_MAX_MS`) up to
`ORKESTR_AGENT_JOB_NOTIFY_MAX_ATTEMPTS` (default 8), then dead-lettered.
Plain-http webhook targets, other 4xx, unknown threads and unresolved
WhatsApp targets are dead-lettered at once; unconfigured mail is `skipped`.
Errors hold reason codes only, never a resolved URL or secret. The server
dispatches after every relay; `ORKESTR_AGENT_JOB_NOTIFY_DISPATCH=0` leaves
rows queued. The CLI only relays, so notifications from `orkestr run` are
delivered by the next server tick.

## Server

`startAgentJobScheduler()` runs in `startServer()`: it resumes every
non-terminal run on start (G1), then every `ORKESTR_AGENT_JOB_SWEEP_MS`
(default 5 s) syncs job directories, fires due schedules and drives due runs,
one driver per run. Disable with `ORKESTR_AGENT_JOBS_ENABLED=0`. Server boot
no longer has to fail job runs: `recoverInterruptedExecutions` still applies
to thread executions only.

## CLI

```text
orkestr init [dir] [--force]
orkestr run <job.yaml|dir> [--job name] [--idempotency-key key] [--no-wait] [--json]
orkestr jobs list|status|approvals|approve|deny|cancel ...
```

These commands use the local store directly and need no running server.
`orkestr init` writes `jobs/hello-job.yaml` for the first connected provider
(the second becomes the fallback) and, like `orkestr run`, refuses with
"connect Codex or Claude first: ..." when none is connected. The legacy
`orkestr jobs run|poll` (job alerts) is unchanged. `orkestr demo` is kept as an
explicitly labelled simulation for newcomers (owner decision 2026-10-10): it
announces that it uses a simulated AI, runs the thread-level simulated
executor in a throwaway `ORKESTR_HOME`, and never touches the Agent Job store
or creates user jobs (`test/simulated-provider.test.js`).

## Guarantee tests

| id | Tests |
| --- | --- |
| G1 | `test/agent-job-runner.test.js` (crash before the first attempt, resumed by the server scheduler); kill -9 tests in `test/agent-job-recovery.test.js` |
| G2 | `test/agent-job-runner.test.js` (HTTP 202/200, cross-process concurrent admission, body-hash dedupe) |
| G3 | `test/agent-job-runner.test.js` (crash at every effect checkpoint, 30 randomized double-fault runs); `test/agent-job-recovery.test.js` (real `kill -9` at all 8 checkpoints); `test/agent-job-example-a.test.js` (git branch push) |
| G4 | `test/agent-job-runner.test.js` (at-most-once tool crashed after dispatch: blocks, deny skips, approve retries once) |
| G5 | `test/agent-job-runner.test.js` (recovery_loop, provider errors, task errors, fallback, backoff) |
| G6 | `test/agent-job-approvals.test.js` (unlisted and denied tools never execute and are audited); `test/agent-job-codex.test.js` (codex: unexposed and denied tools, Codex commands declined by default) |
| G7 | `test/agent-job-approvals.test.js` (args changed after approval, approve twice, concurrent decisions across processes, single use after a lost dispatch, expiry, denial) |
| G8 | `test/agent-job-approvals.test.js` (job file edited mid-run) |
| G9 | `test/agent-job-recovery.test.js` (sealed record contents, canary secret absent from the record and the database files) |
| G10 | `test/agent-job-recovery.test.js` (crash after parking, and between outbox enqueue and marking the intent relayed, for `approval_required` and `succeeded`); `test/agent-job-notification-dispatch.test.js` (each channel delivered once, crash after the WhatsApp send, after an email send, after a thread post, webhook retries with one idempotency key) |
| G11 | `test/agent-job-recovery.test.js` (cancel during a tool call, during backoff, and of a run leased elsewhere) |

Codex job executor: `test/agent-job-codex.test.js` (provider gate, default
deny, `codex.command` approval park/approve/deny, cancel, resume after an
app-server restart, output repair, error classes),
`test/agent-job-codex-example-a.test.js` (Example A end to end on the fake
Codex app-server and fake code host, also with a crash after the branch push)
and `test/conformance/codex-job.test.js`.

Owner-decision tests: `test/agent-job-whatsapp-trigger.test.js` (group,
allowlist, DM/unknown/own rejections, match, message-id dedupe, quoted
context, WhatsApp approvals, the router hook), `test/agent-job-cli.test.js`
and `test/agent-job-runner.test.js` (no admission or attempt without a
connected provider), `test/agent-job-spec.test.js` (whatsapp trigger and
test-only `simulated`).

## Gaps and follow-ups

* **Claude Code executor follow-ups.** It uses the host Claude login, not the
  Orkestr-managed Claude account profiles; a re-ask on invalid structured
  output, secret injection (`ctx.resolveSecret`) and an OS sandbox for the
  workspace (Bash can still reach the rest of the host when allowed) are not
  implemented.
* **Codex executor limits.** Commands Codex itself treats as safe (read-only
  ones) run in the sandbox without an approval request, so they are not
  journaled as tool decisions. MCP servers from the user's Codex config stay
  available; side-effecting MCP calls reach Orkestr as `codex.mcp` only when
  Codex asks for approval. Dynamic tools are assumed to survive
  `thread/resume` (Codex persists them with the thread); this is covered by the
  fake app-server only. Usage/token accounting is a follow-up.
* **Workspace retention.** Per-run workspaces are kept; cleanup is a
  follow-up.
* **WhatsApp triggers.** `fromMe` messages are ignored, so the owner cannot
  trigger a job from the account Orkestr itself sends with; sender LIDs must
  be listed as `…@lid` until the alias store is consulted; the broker
  forwarding path passes `quoted` only if the broker includes it.
* **G6 for native tool loops.** `codex` and `claude-code` route provider
  tool calls through `ctx.authorizeTool` (`permissionHook: "pre_call"`).
  Overlay executors still run their own tools
  (`permissionHook: "sandbox_only"`).
* **Notifications.** Email approvals (reply parsing) are a follow-up; the
  email text names the CLI and WhatsApp commands. Outgoing webhooks are not
  signed yet. `delivery_uncertain` rows need an operator decision; there is
  no UI for them beyond the connector outbox views.
* **Secrets.** Only webhook `secret_ref`s and `vault://` webhook targets are
  resolved. `permissions.secrets` / `ctx.resolveSecret` for adapters are not
  implemented, so redaction covers secret-looking keys and values passed in
  `secretValues`.
* **Webhook bodies.** Signed hooks accept JSON only; form-encoded GitHub
  deliveries are refused.
* **Real GitHub connector** for Example A, an `openai-compatible` adapter,
  `orkestr runs show`, a Run detail UI, per-attempt process isolation for
  native turns and run retention are not part of this change.
