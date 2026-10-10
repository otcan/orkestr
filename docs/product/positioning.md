# Orkestr positioning

Status: draft for owner review (2026-10-10). This is the source of truth for
product copy. README, landing page and `orkestr --help` should follow it once
it is accepted.

## The line

> **Orkestr: Run AI agents as persistent services.** Bring Codex, Claude or
> your own models. Trigger jobs from events, run them on your infrastructure,
> recover from failures and approve sensitive actions. Open source and
> self-hosted.

Short form: *Persistent, recoverable AI agent jobs on your own infrastructure.*

## What Orkestr is

Orkestr is a self-hosted runtime for **Agent Jobs**: a durable unit of agent
work with a trigger, an agent (provider plus fallback), a task, permissions, a
runtime policy and notifications ([spec](../spec/agent-job.md)).

The product is **reliable execution**:

1. **Persistent.** A job outlives the process that started it. State is on
   disk, not in a terminal or a chat tab.
2. **Recoverable.** After a crash, deploy or interrupt, the job resumes
   *without repeating external side effects*. For example, it never opens a
   second pull request. This comes from durable attempts, idempotency keys and
   reconciliation of an effect ledger, not from blind retries
   ([guarantees](../spec/runtime-guarantees.md)).
3. **Governed.** Tools are default-deny. Sensitive actions wait for a human
   approval that is recorded with the effect it authorized.
4. **Auditable.** Every run produces one append-only record: the trigger, the
   attempts, the tool calls, approvals, effects and the result.

Cross-provider support is a **feature, not the product**. Codex, Claude Code
and OpenAI-compatible or local models sit behind one adapter interface
([adapter interface](../spec/adapter-interface.md)). That lets a job fall back
across providers and keeps users from being locked in.

## What Orkestr is not

| Not this | Use that instead | Where Orkestr stops |
| --- | --- | --- |
| A graph or agent-authoring framework | LangGraph | Orkestr does not define how an agent reasons. It runs agents (Codex, Claude Code, or a simple built-in tool loop for raw models) and makes the *run* durable. A LangGraph app could itself be the agent inside an Orkestr job. |
| A general durable-workflow engine | Temporal | Orkestr has a single primitive, the Agent Job, with agent-specific semantics: provider fallback, tool approvals, effect reconciliation. It does not offer arbitrary workflow code, sagas or multi-language SDKs. |
| An autonomous coding agent | OpenHands | Orkestr hosts coding agents; it does not compete with them. Agent quality comes from the provider. |
| An integration or automation canvas | n8n | Orkestr has no visual builder and no catalogue of hundreds of nodes. Triggers are schedule, webhook and API. Integrations are tools the agent calls under policy. |
| A chat or messaging product | n/a | WhatsApp and email are notification and approval channels for jobs, not the product. |

Rule of thumb: if a feature does not make an Agent Job more durable, more
governed, easier to trigger, or easier to inspect, it is peripheral (see
[code audit](code-audit.md#peripheral-freeze-list)).

## The defining demo

One scenario, about 3 minutes, runnable without credentials using the
`simulated` provider (`orkestr demo`), and repeatable with Codex or Claude.

1. **Event.** A webhook delivers "issue opened" to the `repository-maintainer`
   job ([example](../../examples/jobs/repository-maintainer.yaml)). A run is
   created and keyed by the event's delivery id, so a redelivered webhook does
   not start a second run.
2. **Authorized tool.** The agent reads the repo (`repo.read`: allowed), pushes
   a branch, and calls `github.pull_request.create` (allowed). Before the call,
   an effect intent with an idempotency key is written to the effect ledger.
3. **Interrupted.** The demo kills the Orkestr process after the pull request
   is created but *before* the agent sees the tool result.
4. **Recovers without duplicate action.** On restart, the run's attempt is
   marked `interrupted`. Orkestr reconciles the pending effect by looking up
   the PR by its idempotency key (branch name or marker) and finds it. It
   records the effect as `committed` and resumes the agent with the existing PR
   URL. Exactly one PR exists.
5. **Approval.** The agent asks to `github.pull_request.merge`, which is
   `approval_required`. The run moves to `awaiting_approval` and a notification
   goes to the configured channel. A human approves in the UI or CLI.
6. **Auditable record.** `orkestr runs show <run-id>` prints the trigger, two
   attempts, every tool decision (allow, deny or approval), the approval
   (who and when), the effect ledger (1 PR, 1 merge) and the final result.

The demo is the acceptance test for the product. The roadmap's Week 6 and
Week 8 milestones exist to make each step real
([roadmap](roadmap-12-weeks.md)).

## First five minutes

```sh
npx orkestr demo                          # simulated provider, no credentials
orkestr init                              # writes orkestr.yaml + examples/
orkestr run examples/repository-maintainer
```

Contributors must be able to run the full test suite, including the adapter
conformance suite in `test/conformance/`, without any cloud credentials. The
`simulated` provider exists for this.
