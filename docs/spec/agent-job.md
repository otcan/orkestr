# Agent Job specification v0

Status: draft v0. The validator is implemented in
`packages/core/src/agent-job-spec.js`, with the YAML entry point in
`agent-job-spec-yaml.js`. Execution is not implemented yet. Examples are in
`examples/jobs/*.yaml`.

An **Agent Job** is a declarative, durable unit of agent work. A **Run** is a
single execution of a job, caused by one trigger event. A run has one or more
**Attempts**. Each attempt is one adapter session, so an attempt ends when the
process crashes, times out or fails over to another provider.

Related: [runtime guarantees](runtime-guarantees.md),
[adapter interface](adapter-interface.md).

## 1. Document

Jobs are written in YAML or JSON. Keys are `snake_case`. The validator is
**strict**: unknown keys, YAML anchors and aliases, custom tags and duplicate
keys are rejected. The normalized form, which the runtime stores and hashes,
uses camelCase and has every default filled in.

```yaml
apiVersion: orkestr/v0          # required, exact
kind: AgentJob                  # required, exact
metadata:
  name: repository-maintainer   # required, DNS-label: [a-z0-9-], 1-63, unique per instance
  description: ...              # optional, <= 1000 chars
  labels: { team: example }     # optional string map
triggers: [...]                 # required, >= 1
agent: {...}                    # required
task: {...}                     # required
permissions: {...}              # optional, default-deny
runtime: {...}                  # optional
notifications: [...]            # optional
```

### 1.1 `triggers[]`

| type | fields | notes |
| --- | --- | --- |
| `schedule` | `cadence`: `interval` \| `daily` \| `weekly`; `every` (for interval, >= 1m); `time` `HH:MM` (for daily and weekly); `timezone` (default `UTC`) | Mirrors the existing timer cadences in `packages/core/src/timers.js`, so a schedule compiles to a timer. Cron syntax is out of scope for v0. |
| `webhook` | `name` (unique per job), `secret_ref` (`vault://...`, required), `event_id` (JSON Pointer into the body, optional) | Served at `POST /api/jobs/<job>/hooks/<name>` with an HMAC signature. `event_id` gives the run's dedupe key; without it, the dedupe key is the hash of the body. |
| `api` | none (at most one) | `POST /api/jobs/<job>/runs` and `orkestr run <job>`. The caller may pass an `Idempotency-Key`. |

### 1.2 `agent`

| field | notes |
| --- | --- |
| `provider` | `simulated` \| `codex` \| `claude-code` \| `openai-compatible` |
| `model` | Optional. Required for `openai-compatible`. |
| `base_url` | `http(s)://...`. Only valid for, and required by, `openai-compatible`. |
| `fallback[]` | Up to 3 `{provider, model?, base_url?}` entries tried in order when an attempt fails with a *provider* error (auth, rate limit, unavailable). The list must not repeat an earlier provider/model pair. Task errors do not trigger fallback. |

### 1.3 `task`

`prompt` (required, <= 32k chars), `inputs` (object, passed to the agent as
structured context, plus `trigger.event`), `output_schema` (optional JSON
Schema; the run fails `output_invalid` if the final output does not match).

### 1.4 `permissions`

```yaml
permissions:
  tools:
    allow: [repo.read, github.*]
    approval_required: [github.pull_request.merge]
    deny: [repo.branch.force_push]
  secrets: [vault://example-github-token]
```

* Tool names are dotted lowercase identifiers. A trailing `.*` matches a
  namespace and everything below it, and `*` alone matches every tool.
* The decision order is **deny > approval_required > allow > default deny**
  (`agentJobToolDecision`).
* An `approval_required` entry that is also matched by `deny` is a validation
  error.
* `secrets` lists the vault items that the run may resolve. Values never
  appear in the spec, the prompt or the audit record.

### 1.5 `runtime`

| field | default | notes |
| --- | --- | --- |
| `durable` | `true` | `false` means best-effort: there is no resume and `max_attempts` must be 1. |
| `max_attempts` | `3` | 1 to 20, counted across all providers in the fallback chain. |
| `timeout` | `30m` | Wall clock per attempt. |
| `approval_timeout` | `24h` | Waiting time before a pending approval becomes `expired`. |
| `concurrency` | `forbid` | What happens when a trigger fires while a run is active: `forbid` (drop it and audit as `skipped`), `queue`, or `replace` (cancel the active run). |
| `retry.backoff` | `exponential` | `fixed` \| `exponential` |
| `retry.initial_delay` | `30s` | |
| `retry.max_delay` | `10m` | Must be >= `initial_delay`. |

Durations are `<int>(ms|s|m|h|d)`.

### 1.6 `notifications[]`

`on`: a subset of `succeeded`, `failed`, `retrying`, `cancelled`,
`approval_required` and `approval_expired`. `channel`: `thread`, `webhook`
(target must be `https://` or `vault://`), `email` or `whatsapp`. `target` is a
channel-specific id. Notifications are effects too: they go through the
existing connector outbox, so each notification is delivered at most once per
`(run, event)`.

## 2. States

Run states:

```
pending ──► running ──► succeeded
   │          │  ▲ │
   │          │  │ └──► awaiting_approval ──► running   (approved / denied → agent told)
   │          │  │              └──────────► failed    (approval expired, when policy = fail)
   │          ▼  │
   │       retrying (backoff; next attempt, maybe next provider)
   │          │
   │          └──► failed     (max_attempts exhausted or non-retryable error)
   └──► skipped (concurrency: forbid)        any non-terminal ──► cancelled
```

Terminal states: `succeeded`, `failed`, `cancelled`, `skipped`.

Attempt states: `starting`, `running`, `interrupted` (the process died and was
detected on recovery), `timed_out`, `failed`, `completed`. An attempt's
`end_reason` is one of `completed`, `provider_error`, `task_error`, `timeout`,
`interrupted`, `cancelled` or `approval_wait` (the session was released while
waiting).

## 3. Lifecycle and the attempt/checkpoint model

1. **Admit.** A trigger event arrives. Orkestr computes
   `run_key = sha256(job_name, trigger_name, dedupe_key)`. If a run with that
   key already exists, it returns that run (HTTP 200, `deduplicated: true`).
   Otherwise it stores the run as `pending` together with a hash of the
   normalized spec (`spec_hash`). The spec is pinned per run, so editing the
   job does not change runs already in flight.
2. **Start attempt.** Orkestr acquires the run lease, selects the provider
   (primary, or the next fallback after a provider error), and calls
   `adapter.start()` or `adapter.resume()` with the latest checkpoint.
3. **Checkpoint.** At each of these points, Orkestr writes a checkpoint
   *before* acting: adapter session id received, tool call requested, effect
   intent written, effect committed, approval requested or resolved, and final
   output. A checkpoint is `{run_id, attempt, seq, kind, adapter_session_ref,
   transcript_ref, pending_effects[], at}` and is appended to the run journal.
4. **Recover.** On boot, and on a lease-expiry sweep, every `running` attempt
   whose lease holder is gone is marked `interrupted`. The run is then
   **reconciled** (§5) and **resumed**. Resume uses `adapter.resume(session)`
   when the adapter supports it. Otherwise a new session starts with a
   synthesized resume prompt: the original task, a summary of the checkpoints,
   and the committed effects with their results.
5. **Finish.** The final output is validated against `output_schema`, the run
   becomes terminal, notifications are enqueued, and the audit record is
   sealed.

An interrupted attempt counts toward `max_attempts`. A run that is
interrupted repeatedly at the same checkpoint `seq` fails with
`recovery_loop` after `max_attempts`.

## 4. Idempotency keys

| Level | Key | Purpose |
| --- | --- | --- |
| Run | `run_key = H(job, trigger, dedupe_key)` | A redelivered event does not start a second run. |
| Effect | `effect_key = H(run_id, tool, logical_key)` | A replayed tool call does not repeat the side effect. |
| Notification | Connector outbox key `H(run_id, event, channel, target)` | Exactly one notification per state change. |

`logical_key` is supplied by the **tool definition**, not by the model. For
example, `github.pull_request.create` uses `(repo, head_branch)` and `mail.send`
uses `(to, subject, run_id)`. Tools without a logical key fall back to
`(tool, canonical_json(args))`. Where the external API supports it, the
effect key is also sent as the request's idempotency key (as with the OpenAI
`Idempotency-Key` header), or embedded as a marker such as a PR body footer
`orkestr-effect: <effect_key>`, so reconciliation can find the effect again.

## 5. Effect ledger and reconciliation

Every tool call classified as an **effect** (anything that is not read-only) is
written to the effect ledger. The ledger is an append-only table keyed by
`effect_key` and modelled on the connector outbox
(`packages/connectors/src/connector-outbox.js`, where `idempotency_key` is
unique and writes upsert).

Effect states: `intended` → `committed` | `failed` | `unknown`.

* `intended` is written **before** the external call, with the args hash.
* `committed` is written after success, with the external reference (PR URL,
  message id).
* When the same `effect_key` is requested again in the same run:
  * `committed`: the call is short-circuited and the stored result returned.
    The tool is not called.
  * `intended` or `unknown`: the effect is reconciled first.

**Reconciliation** runs during recovery for every `intended` effect, and
before any replay of one. It calls the tool's `reconcile(effect)` hook, which
looks up the external system by logical key or marker.

* found → `committed` (with the reference)
* definitely absent → `failed`, so a re-execution is allowed
* undeterminable → `unknown`

When the result is `unknown`, the run moves to `awaiting_approval` with reason
`effect_unknown`. A human decides whether to retry or skip; Orkestr never
guesses. A tool that has no `reconcile` hook and is not idempotent at the
remote end is marked `at_most_once`. After a crash its `intended` effects
always become `unknown`.

## 6. Approval flow

1. The tool call resolves to `approval_required`. Orkestr writes an effect
   `intended`, then creates an approval with fields `{approval_id, run_id,
   effect_key, tool, args_redacted, requested_at, expires_at}`.
2. The run moves to `awaiting_approval`, the `approval_required` notification
   is sent, and the adapter session is suspended or released (§3).
3. A decision `{approved|denied, by, at, comment}` arrives through the UI,
   CLI (`orkestr approvals approve <id>`) or a notification reply. The
   decision is bound to `effect_key` and `args_hash`. If the args changed, the
   approval does not apply.
4. If approved, the effect executes once. If denied, the agent receives a
   structured `denied` tool result and continues.
5. If the approval expires, the effect becomes `failed`, the run fails with
   `approval_expired`, and an `approval_expired` notification is sent.

## 7. Audit record

There is one record per run. It is append-only and stored as an event stream
that is sealed when the run becomes terminal. `orkestr runs show <id>` prints
it, and `--json` gives the raw stream.

```json
{
  "run_id": "run_example01", "job": "repository-maintainer", "spec_hash": "sha256:...",
  "trigger": { "type": "webhook", "name": "issue-opened", "dedupe_key": "example-delivery-1" },
  "state": "succeeded",
  "attempts": [
    { "n": 1, "provider": "simulated", "state": "interrupted", "end_reason": "interrupted" },
    { "n": 2, "provider": "simulated", "state": "completed", "resumed_from_seq": 7 }
  ],
  "tool_decisions": [{ "seq": 4, "tool": "github.pull_request.create", "decision": "allow" }],
  "effects": [{ "effect_key": "...", "tool": "github.pull_request.create", "state": "committed",
                "ref": "https://git.example.com/example-org/example-repo/pull/1", "reconciled": true }],
  "approvals": [{ "approval_id": "apr_example01", "tool": "github.pull_request.merge",
                  "decision": "approved", "by": "user:example-owner", "at": "..." }],
  "output": { "summary": "..." },
  "started_at": "...", "finished_at": "..."
}
```

Secrets and secret-bearing args are redacted at write time, not at read time.

## 8. Out of scope for v0

Cron expressions, DAGs or sub-jobs (use coordination later, P2), per-tool rate
limits, multi-tenant job sharing, and a visual editor.
