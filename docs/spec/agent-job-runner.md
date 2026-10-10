# Agent Job runner (v0)

Status: the runtime (store, recovery, ledger, approvals, triggers, CLI) is
implemented and proven with the `simulated` **test fixture**. Real jobs must
use a connected `codex` or `claude-code` provider (owner decision 2026-10-10,
[agent-job.md §9](agent-job.md#9-owner-decisions-2026-10-10)); those run
through the existing executor registry with the gaps listed below. Orkestr
sends no usage telemetry or pings. Spec: [agent-job.md](agent-job.md).
Guarantees: [runtime-guarantees.md](runtime-guarantees.md).

## Modules

| Module (`packages/core/src/`) | Role |
| --- | --- |
| `agent-job-store.js` | SQLite store `ORKESTR_HOME/agent-jobs.sqlite` (override: `ORKESTR_AGENT_JOBS_DB`): pinned specs, registered jobs, runs, attempts, the checkpoint journal and run leases. Every multi-row change is one `BEGIN IMMEDIATE` transaction, which also serializes the server, `orkestr run` and `orkestr jobs` processes that share one home. |
| `agent-job-admission.js` | Loads job files, registers them, admits runs with `run_key = H(job, trigger, dedupe_key)`, applies `concurrency`, records cancels. |
| `agent-job-runner.js` | `driveRun()`: takes the lease, recovers an interrupted attempt, runs attempts until the run is terminal or parked. `driveDueRuns()` drives everything that can progress. |
| `agent-job-effects.js` | Authorizes every tool call (`agentJobToolDecision`), runs side effects through the ledger, reconciles after crashes and applies approval binding. |
| `agent-job-ledger.js` | Effect rows (`intended` → `committed` \| `failed` \| `unknown`) and approvals. |
| `agent-job-tools.js` | Tool registry (`effect`, `logicalKey`, `reconcile`, `perform`) and the offline tools: `demo.*`, `repo.*` (local git) and `github.*` (fake code host only, opt-in with `inputs.code_host: fake`). |
| `agent-job-adapters.js` | Provider adapters: `codex` / `claude-code` (one native turn through `executors.js`, trigger event included in the prompt) and the `simulated` test fixture (scripted, Orkestr tool loop, transcript resume; resolvable only under `node --test`). |
| `agent-job-providers.js` | Provider connectivity gate. Runs are not admitted, and attempts not started, on a provider that is not connected. Probes (`codex login status`, `claude auth status --json`, cached 60 s) live in `packages/connectors/src/agent-job-provider-probes.js`; with no probe a provider counts as not connected. |
| `packages/connectors/src/whatsapp-job-triggers.js` | WhatsApp group-message triggers and `approve`/`deny` replies, called from the existing inbound router (`routeWhatsAppInbound`). |
| `agent-job-audit.js` | Sealed audit record per terminal run and notification intents, written in the same transaction as the state change they announce. |
| `packages/connectors/src/agent-job-notification-relay.js` | Moves notification intents into the connector outbox (same idempotency key). Called by the server scheduler and the CLI after driving. |
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
* **Webhook**: `POST /api/jobs/<job>/trigger?hook=<name>`. The dedupe key comes
  from the trigger's `event_id` JSON pointer, else from the body hash.
  Redeliveries return the first run with HTTP 200, new runs return 202.
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
  skipped and audited.

Auth: the trigger endpoint accepts a bearer token from
`ORKESTR_AGENT_JOB_TRIGGER_TOKEN(S)` (machine auth `agent_job_trigger`) or a
normal admin session / CLI token.

Jobs are registered by `orkestr run`, and on every server sweep from
`ORKESTR_HOME/agent-jobs/` (or `ORKESTR_AGENT_JOBS_DIR`) and
`$ORKESTR_OVERLAY_DIR/jobs/`.

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
| G6 | `test/agent-job-approvals.test.js` (unlisted and denied tools never execute and are audited) |
| G7 | `test/agent-job-approvals.test.js` (args changed after approval, approve twice, concurrent decisions across processes, single use after a lost dispatch, expiry, denial) |
| G8 | `test/agent-job-approvals.test.js` (job file edited mid-run) |
| G9 | `test/agent-job-recovery.test.js` (sealed record contents, canary secret absent from the record and the database files) |
| G10 | `test/agent-job-recovery.test.js` (crash after parking, and between outbox enqueue and marking the intent relayed, for `approval_required` and `succeeded`) |
| G11 | `test/agent-job-recovery.test.js` (cancel during a tool call, during backoff, and of a run leased elsewhere) |

Owner-decision tests: `test/agent-job-whatsapp-trigger.test.js` (group,
allowlist, DM/unknown/own rejections, match, message-id dedupe, quoted
context, WhatsApp approvals, the router hook), `test/agent-job-cli.test.js`
and `test/agent-job-runner.test.js` (no admission or attempt without a
connected provider), `test/agent-job-spec.test.js` (whatsapp trigger and
test-only `simulated`).

## Gaps and follow-ups

* **Native providers (most important).** `codex` and `claude-code` call the
  executor registry (`getExecutorAdapter`). The built-in `codex` executor is
  still a placeholder that fails with `codex_executor_not_configured` (a
  non-retryable provider error, so fallback applies) and there is no
  built-in `claude-code` executor, so on a stock install a connected
  provider is admitted but its attempt fails until a job-attempt adapter for
  the Codex app-server / Claude Code runtimes exists (one that does not need a
  thread record). Overlay executors registered under those ids work today.
* **WhatsApp triggers.** `fromMe` messages are ignored, so the owner cannot
  trigger a job from the account Orkestr itself sends with; sender LIDs must
  be listed as `…@lid` until the alias store is consulted; the broker
  forwarding path passes `quoted` only if the broker includes it.
* **G6 for native tool loops.** Native adapters run their own tools; only
  Orkestr tools pass `agentJobToolDecision`. The pre-call permission hook from
  the adapter interface is not wired yet (`permissionHook: "sandbox_only"`).
* **Notification delivery.** Notifications are enqueued once in the connector
  outbox (`connector: agent_job`, payload with channel and target) by the
  relay. A dispatcher that delivers them over thread/WhatsApp/email/webhook
  is a follow-up; existing WhatsApp pumps do not touch these rows. Email
  approvals are a follow-up.
* **Webhook HMAC.** Webhook triggers use bearer tokens; HMAC signatures with
  the trigger's `secret_ref` and the `/hooks/<name>` path from the spec are a
  follow-up. Secret resolution (`permissions.secrets`, `ctx.resolveSecret`) is
  not implemented, so redaction covers secret-looking keys and values passed
  in `secretValues`.
* **Schedules in the timers UI.** Schedule triggers reuse timer cadence math
  but do not create rows in the timers list.
* **Real GitHub connector** for Example A, an `openai-compatible` adapter,
  `orkestr runs show`, a Run detail UI, per-attempt process isolation for
  native turns and run retention are not part of this change.
