# 12-week roadmap: Agent Jobs

Status: draft for owner review. Week 1 starts 2026-10-12. Each block lists its
work items, the existing code it reuses, and acceptance criteria (AC). An AC
counts only when it is a passing test or a reproducible command run on a
clean clone **without cloud credentials** (unless the block says otherwise).

Specs: [positioning](positioning.md), [agent-job](../spec/agent-job.md),
[guarantees](../spec/runtime-guarantees.md),
[adapter interface](../spec/adapter-interface.md),
[code audit](code-audit.md).

## Success metrics (by end of week 12)

| Metric | Target | Measured by |
| --- | --- | --- |
| Developers who ran `orkestr demo` or `orkestr run` to completion | 10 | Opt-in anonymous `orkestr feedback` ping or self-reported issues/discussions (no default telemetry) |
| Repeat users (ran a real job on 2+ separate days) | 5 | Same channel as above, plus direct conversations |
| Provider adapters passing `test/conformance/` | 2+ real (codex, claude-code) + `simulated` | CI |
| External contributions merged | 1+ | GitHub |

## Weeks 1–2: Lock the identity (this PR)

* Positioning, code audit, Agent Job spec v0, guarantees, adapter interface
  and this roadmap (`docs/product/*`, `docs/spec/*`).
* `core/agent-job-spec.js` (strict validator/normalizer), the YAML loader and
  `examples/jobs/*.yaml`.
* An AGENTS.md scope proposal for the owner ([proposal](agents-scope-proposal.md)).
* **AC:** the validator test is green, all example jobs validate, and the owner
  has accepted or edited the positioning.

## Weeks 3–4: Run store, `simulated` provider and `orkestr demo`

* `core/agent-job-store.js`: Job, Run and Attempt records and the checkpoint
  journal. Reuses `packages/storage` (SQLite via the thread-registry pattern)
  and `storage-lock.js`.
* `core/agent-adapters/simulated.js` with the scripted steps described in
  [adapter-interface §4](../spec/adapter-interface.md).
* `core/agent-job-runner.js`: admit (with `run_key` dedupe), attempt loop,
  retries and backoff, `max_attempts`. Reuses the retry policy shape from
  `connectors/connector-outbox-retry-policy.js`.
* CLI modules: `orkestr demo`, `orkestr init`, `orkestr run <dir|file>`,
  `orkestr runs list|show`.
* Replace the placeholder `codex` executor path (`executors.js`) with a
  redirect to the adapter registry, behind a flag. Done for Agent Jobs
  (2026-10-10): `codex` jobs run on the built-in Codex app-server executor
  (`agent-job-codex.js`, switch `ORKESTR_AGENT_JOB_CODEX_EXECUTOR`) and
  `claude-code` jobs on `agent-job-claude-code.js`, both behind the shared
  native executor interface. The thread-level placeholder stays for threads.
* **AC:** `npx orkestr demo` finishes in under 60 s on a clean machine with no
  network and no credentials. G1, G2, G5 and G8 have tests in
  `test/agent-job-*.test.js`.

## Weeks 5–6: Effect ledger and recovery (the core guarantee)

* `core/agent-job-effects.js`: the effect ledger (intended →
  committed|failed|unknown) using the connector-outbox claim protocol, plus a
  tool registry with `logicalKey` and `reconcile` hooks.
* Boot recovery: interrupted attempts → reconcile → resume. This replaces
  `recoverInterruptedExecutions`'s "mark failed" behaviour for job runs.
* Fault injection via `core/runtime-fault-injection.js` at every checkpoint.
* A simulated `demo.pull_request.create` tool backed by a local fake Git
  host.
* **AC:** G3, G4 and G11 pass. The kill-at-every-checkpoint test produces
  exactly one PR on the fake host across 100 randomized runs.

## Weeks 7–8: Authorization, approvals and triggers

* Tool decisions through `ctx.authorizeTool` (`agentJobToolDecision`). The
  audit goes to the resource-policy audit outbox pattern.
* A generic approval queue (`core/agent-job-approvals.js`) bound to
  `effect_key` and `args_hash`, with expiry. CLI
  `orkestr approvals list|approve|deny`, plus a minimal Run detail approval
  button.
* Triggers: schedule → `timers.js`; `POST /api/jobs/<job>/runs` (API);
  `POST /api/jobs/<job>/hooks/<name>` with HMAC verification (reusing the
  signing code in `mcp-event-delivery.js`).
* Notifications through the connector outbox (G10).
* **AC:** the full [defining demo](positioning.md#the-defining-demo) runs
  end-to-end on `simulated`. G6, G7 and G10 pass. The webhook redelivery test
  passes.

## Weeks 9–10: Real adapters and conformance

* `test/conformance/` suite plus fake backends.
* `core/agent-adapters/codex.js` delegating to `runtime-codex-adapter.js`.
  Codex approval requests go to `ctx.authorizeTool`.
* `core/agent-adapters/claude-code.js` delegating to
  `runtime-claude-code-adapter.js`, with a permission-prompt MCP tool for a
  `pre_call` hook.
* Decouple both from chat threads: a job attempt owns a hidden runtime
  session record.
* **AC:** codex, claude-code and simulated pass conformance in CI (fake
  backends). An opt-in live run of the defining demo with Codex and with
  Claude is recorded in `docs/demo-logs/`. Provider fallback is tested.

## Week 11: Local models and the audit record

* `core/agent-adapters/openai-compatible.js` plus the Orkestr tool loop,
  extracted from `tenant-api-agent.js` into a provider-neutral module.
* A sealed per-run audit record and `orkestr runs show --json`. Secret canary
  test (G9).
* **AC:** the `local-model-digest` example runs against a fake
  OpenAI-compatible server in CI. G9 passes.

## Week 12: Launch

* README rewritten to the positioning line. Quickstart is the "first five
  minutes" from the positioning doc.
* `CONTRIBUTING.md`: "write an adapter" and "write a tool with reconcile"
  guides, and `good first issue` labels (aimed at the external contribution
  metric).
* Recorded demo (reusing `scripts/record-demo.mjs`) and a launch post.
* **AC:** a fresh-VM install-to-demo takes under 5 minutes. All G1–G11 are
  green. Docs link only to green guarantees.

## Explicitly not in these 12 weeks

DAGs or sub-jobs, cron expressions, a visual editor, multi-tenant job sharing,
new connectors, new dashboard pages beyond Runs list/detail, and any work on
the [freeze list](code-audit.md#peripheral-freeze-list).
