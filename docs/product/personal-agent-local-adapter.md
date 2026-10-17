# OP-09 local inference adapter: proposal for OP-02

Coordinator-confirmed Lane B adapter contract for Lane A's ADR; domain schemas and the correlated event
envelope remain Lane A's responsibility. This implements no Project, Task or
Memory store. It reuses the Agent Job runner, `agent-jobs.sqlite`, checkpoint
journal, approvals, tool policy and effect ledger. OP-07 and OP-08 remain
dependent on the canonical contracts and projections.

## Proposed shared contract

The existing `openai-compatible` provider uses the runner's current interface:

```js
adapter.probe({ env, providerRef: { baseUrl, model } })
// { state: "available" | "unavailable", ok, connected, runnable,
//   reason, models, model, checkedAt }
adapter.step({ runId, attempt, env, signal, emit }, { input, transcript })
// { type: "final", output, stepIndex }
// or { type: "tool", tool, args, wireName, stepIndex }
```

`discoverLocalModel(env, providerRef)` performs bounded `GET /v1/models`
discovery. The server starts a discovery probe when the flag is enabled;
admission and attempt startup independently check the exact pinned endpoint
and model. A reachable endpoint with a missing or unselected model is
`unavailable`, never a fabricated answer. Discovery does not trigger inference,
pull models, select the first installed model, or require an API key.

The capability declaration is `toolLoop: orkestr`, `resume: transcript`,
`interrupt: cooperative`, `streaming: true`, `structuredOutput: validate`,
`permissionHook: orkestr`, `sandbox: none`, `usage: true`. Streaming progress
and usage use the existing attempt journal projection; Lane B does not define
a new event envelope. Partial text is progress, never successful final output.
Tools are returned to the runner, never executed by the adapter.

Lane A owns the default-off `ORKESTR_PERSONAL_AGENT_ENABLED` switch, read only
by `personalAgentFeature(env)` in `packages/core/src/personal-agent-feature.js`.
The adapter consumes that helper. No `features.personalAgent` field is added to
other capability objects. Lane A's `GET /api/personal-agent/capability` is the
single place the UI reads the capability; its assistant health does not disable
project views. The shared helper returns a plain boolean and is an exact copy
of Lane A's published file in PR #52 (`c2aacdd8`), copied from
`origin/orkestr/op-02-capability`; its ownership stays with Lane A. No other
Lane A files are brought into this branch. Lane B owns the
following local-runtime health function:

```js
personalAgentLocalRuntimeStatus(env)
// { available, reason?: "not_configured" | "local_runtime_unavailable",
//   model?, checkedAt }
```

It is exported from `packages/core/src/personal-agent-local-runtime.js` for
Lane A to fill the endpoint's `assistant` field. Missing/invalid configuration
returns `not_configured` without network access; a configured but unavailable
endpoint/model returns `local_runtime_unavailable`. It does not expose endpoint
URLs, model inventories, provider error text or credentials in this projection.

## Configuration and current limits

Set these only in an explicitly authorized instance or isolated test process:

```sh
ORKESTR_PERSONAL_AGENT_ENABLED=1
ORKESTR_PERSONAL_AGENT_LOCAL_BASE_URL=http://127.0.0.1:11434/v1
ORKESTR_PERSONAL_AGENT_LOCAL_MODEL=example-installed-model
# Optional, per-request; tested with Ollama 0.16.3:
ORKESTR_PERSONAL_AGENT_LOCAL_REASONING_EFFORT=none
```

The selected job's `agent.base_url` and `agent.model` take precedence over the
runtime configuration. The health projection requires both runtime variables;
there is no implicit endpoint or model default. There is no model auto-selection and no use of inherited
`OPENAI_API_KEY` or `OPENAI_BASE_URL`. Numeric loopback endpoints (`127.0.0.1`
or `[::1]`, `/v1`) only are supported initially; redirects, URL credentials,
query strings and fragments are refused. Containers requiring a different
host need a reviewed endpoint policy extension, not an implicit remote route.

All fallback chains involving this adapter are refused until OP-10 supplies
explicit escalation and privacy policy. Older pinned specs are checked again
before execution. Existing Codex/Claude-only chains keep their behavior.

Requests are bounded to 1,024 generated tokens, 64,000 context characters and
one tool call per response. A request has a 120-second ceiling in addition to
the job deadline. Discovery has a two-second ceiling. Cancellation and lease
loss abort the HTTP request; no partial completion becomes a result. Provider
failure, missing model, malformed/truncated SSE, token truncation, empty output
and invalid JSON/schema output all fail explicitly. There is no repair re-ask
in this first adapter revision.

Tools must declare `inputSchema`; no argument schema is guessed. Allowed and
approval-gated tools are exposed with mapped transport names. Unlisted tools,
invalid arguments and multiple simultaneous calls are refused before dispatch.
The schema subset is `type`, `properties`, `required`, `items`, `enum`, and
boolean `additionalProperties`, plus descriptive `title`/`description`.
Unsupported constraints are refused. Final output is validated locally even
when a server accepts `response_format`. When tools are exposed the schema is
an instruction and local validation constraint; no native grammar is claimed.
`repo.read` gains an explicit argument schema; other tools need one before
they can be used with this adapter.

Completed tool checkpoints retain redacted arguments and results in the
existing journal for replay. No transcript is silently trimmed: exceeding
the context limit fails. This does not establish a model's token window:
generic `/models` discovery does not
advertise that reliably. OP-07 must budget the selected model's actual window;
the transport's character ceiling cannot guarantee a server will not truncate
an oversized prompt. The effect ledger and exact-argument approval checks
handle crash/retry; tools without known outcomes remain subject to existing
unknown-effect approvals. This is not persistent assistant memory (OP-07).

These are application controls in the existing single-user trust model.
They do not isolate a root-capable runtime or prevent its direct filesystem,
network or process access.

## Validation, migration and rollback

Offline tests use a fake loopback server, synthetic model ids and fake tools.
They cover discovery and unavailable states, feature-off behavior, UTF-8 SSE,
usage, malformed output, schema/tool validation, redirect refusal, abort,
deadline, disabled-after-admission, approval and crash recovery with one effect.
The measurement report records the separate host inference experiment.

No SQLite migration or live configuration update is required. Checkpoint
payloads gain optional fields only for local tool steps; existing readers
ignore them. Removing the flag stops new admissions/attempts without deleting
jobs, effects or approvals. Let in-flight work finish or cancel it through the
existing job API before reverting code. An older binary cannot execute these
new local jobs, but can retain their records; do not switch an active local
run to a different provider. The formerly illustrative local-model example
now uses loopback and no fallback, matching the implemented limits.
