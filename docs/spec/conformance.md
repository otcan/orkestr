# Provider adapter conformance suite

`test/conformance/` is a reusable test suite that any Orkestr provider adapter
(Codex, Claude Code, an OpenAI-compatible or local model, a simulated provider)
can run **without cloud credentials**. It checks the lifecycle semantics a
durable Agent Job depends on: start a turn, stream progress, return a structured
final result, cancel, resume after a process restart, run a re-delivered input
at most once, consult a tool-permission hook, and classify errors.

Each check exercises one **capability**. Adapters declare the capabilities they
support; checks for required capabilities always run, checks for undeclared
optional capabilities are reported as skipped together with the declared gap.

## Run it

```bash
# All bundled harnesses (reference, Codex app-server, Claude Code thread
# runtime, Claude Code job executor) + self-tests
npm run test:conformance

# One adapter: point the runner at a harness module
node test/conformance/run.mjs ./path/to/my-adapter-harness.js
```

Both commands print a capability matrix (`pass` / `skip` / `fail` per check).
The bundled suites also run in `npm run test:ci`.

## Add a new adapter

Write a harness module that exports a conformance definition:

```js
export const myAdapterConformance = {
  name: "my-adapter",
  capabilities: ["turn.start", "turn.final_output", "turn.cancel"],
  gaps: { "session.resume": "provider has no session concept yet" },
  async create() {
    return {
      async setup() {},                       // optional
      async teardown() {},                    // optional
      async startSession({ sessionKey }) {},  // -> session (opaque to the suite)
      async runTurn(session, input, { onEvent, onToolRequest }) {}, // -> TurnResult
      async cancelTurn(session) {},           // -> { cancelled: boolean }
      async restart() {},                     // drop all in-memory adapter state
      async resumeSession(session) {},        // -> { providerSessionId, resumed: boolean }
      async providerTurnCount() {},           // -> provider turn invocations so far
    };
  },
};
```

Then run `node test/conformance/run.mjs ./path/to/harness.js`, or add a
three-line `*.test.js` next to the bundled ones so CI runs it:

```js
import { myAdapterConformance } from "./my-adapter-harness.js";
import { runConformanceSuite } from "./suite.js";
runConformanceSuite(myAdapterConformance);
```

Use a fake provider process or an in-process simulation. Never call a real
provider from the suite; contributors must be able to run it offline.
`test/conformance/reference-adapter.js` is a complete, minimal example.

### Inputs

`runTurn` receives `{ inputId, text, scenario }`. `inputId` is the idempotency
key for the input. `scenario` is a provider-neutral instruction the harness
translates into fake provider behaviour:

| scenario | expected fake behaviour |
| --- | --- |
| `echo` (default) | complete with a final answer that contains `text` |
| `progress` | emit at least one progress event, then the final answer |
| `slow` | stay active until `cancelTurn` |
| `tool` | request one tool call; run it only if the hook approves |
| `fault:auth` / `fault:transient` / `fault:permanent` | fail with that class of error |

The bundled fakes read a `[scenario:<name>]` marker appended to the prompt.

### TurnResult

```js
{
  turnId: "turn-123",            // non-empty, distinct per input
  status: "completed" | "failed" | "cancelled",
  output: { text } | null,       // final answer; null unless completed
  error: { class: "auth" | "transient" | "permanent", code } | null,
  providerSessionId: "…",        // required for session.resume
  duplicate: false,              // true when inputId was already handled
  finalMessageId: "msg-…",       // optional: persisted final message of the turn
  tool: { requested, decision: "approve" | "deny", executed }, // tool scenario only
}
```

`onEvent` receives `{ type: "progress" | "final", text }`. `onToolRequest`
receives `{ tool, input }` and resolves to `"approve"` or `"deny"`.

## Capabilities and checks

| capability | required | check | what passes |
| --- | --- | --- | --- |
| `turn.start` | yes | `start-turn` | two inputs complete with distinct turn ids |
| `turn.final_output` | yes | `final-output` | completed result with `output.text`, exactly one `final` event |
| `turn.streaming` | no | `streaming-progress` | a `progress` event precedes the `final` event |
| `turn.cancel` | no | `cancellation` | active turn settles `cancelled`, no `final` event, session still usable |
| `session.resume` | no | `restart-resume` | after `restart()` the same `providerSessionId` is resumed and used |
| `input.idempotent` | no | `idempotent-redelivery` | same `inputId` twice → `duplicate: true`, same turn id, status, output and final message id, one provider turn |
| `tools.approval` | no | `tool-permission-deny`, `tool-permission-approve` | hook called once; deny blocks, approve runs the tool |
| `errors.auth` | no | `error-auth` | `status: failed`, `error.class: auth` |
| `errors.transient` | no | `error-transient` | `error.class: transient` |
| `errors.permanent` | no | `error-permanent` | `error.class: permanent` |

`checks-self.test.js` breaks the reference adapter on purpose (re-runs
duplicates, ignores deny, ignores cancel, opens a new session after restart,
misclassifies errors) and asserts the matching check fails.

## Current matrix

| check | reference | codex-app-server | claude-code | claude-code-job |
| --- | --- | --- | --- | --- |
| start-turn | pass | pass | pass | pass |
| final-output | pass | pass | pass | pass |
| streaming-progress | pass | pass | pass | pass |
| cancellation | pass | pass | pass | pass |
| restart-resume | pass | pass | pass | pass |
| idempotent-redelivery | pass | pass | pass | skip (by design: run admission dedupes) |
| tool-permission-deny | pass | pass | skip (gap) | pass |
| tool-permission-approve | pass | pass | skip (gap) | pass |
| error-auth | pass | pass | pass | pass |
| error-transient | pass | pass | pass | pass |
| error-permanent | pass | pass | pass | pass |

The Codex and Claude Code harnesses drive the real Orkestr adapters
(`packages/core/src/codex-app-server*.js`,
`packages/core/src/runtime-claude-code-adapter.js`) through the Orkestr thread
layer against fake processes in `test/conformance/fakes/`, derived from the
inline fakes in `test/codex-app-server.test.js` and
`test/claude-code-runtime.test.js`. The `claude-code-job` harness
(`claude-code-job-harness.js`) drives the Agent Job executor
`packages/core/src/agent-job-claude-code.js` directly against the same fake,
whose `tool` scenario runs the `PreToolUse` hooks from `--settings` like the
real CLI.

## Known gaps

These were found while writing the harnesses. Fixed items are marked.

1. **Codex: no transient vs permanent error class.** Fixed. Failed turns are
   classified by `packages/core/src/runtime-turn-error-class.js` into `auth`,
   `rate_limit` (429, quota, usage limit), `transient` (network, transport,
   5xx, overload, timeouts) or `permanent` (invalid request, context too long,
   unknown), each with `code`, `retryable`, `retryAfterMs` and `hint`. The
   class is stored as `runtime.lastTurnErrorClass`, on the input message's
   `turnOutcome.error`, and on the `turn_failed` lifecycle event
   (`errorClass`, `errorCode`, `retryable`). Stale-turn recovery and the
   acceptance-uncertain delivery retry use the classifier instead of their own
   string matches. The conformance contract has three classes, so the
   harnesses report `rate_limit` as `transient`.
2. **Codex: stale runtime snapshot written after `turn/start`.** Fixed.
   Runtime writers now merge only the fields they own onto the latest record
   under the thread store lock (`updateThreadRuntime` in
   `packages/core/src/runtime-record-update.js`). Codex notifications for one
   thread are handled in arrival order, and `runtime.turnGeneration` stops a
   writer for an older turn from overwriting a newer one. Regression tests:
   `test/codex-app-server-start-write-race.test.js` and
   `test/runtime-write-ordering.test.js` (`FAKE_CODEX_STEP_MS=30`).
3. **Claude Code: no tool-permission hook.** Fixed for Agent Job attempts:
   the job executor (`agent-job-claude-code.js`) installs a `PreToolUse` hook
   that asks Orkestr before every call and enforces the job's allow /
   approval_required / deny lists (see
   [agent-job-runner.md](agent-job-runner.md#claude-code-jobs)). Interactive
   Claude Code *threads* still run under a fixed permission mode/MCP policy.
4. **Claude Code: progress is only projected for connector-originated turns.**
   Fixed. `createClaudeCodeProgressReporter` still persists commentary only for
   WhatsApp-origin inputs, but `sendClaudeCodeInput(..., { onProgress })`
   receives the same throttled, redacted progress for every origin; the
   harness now uses a non-connector input. Job attempts write progress into
   the run journal.
5. **Claude Code: error class lives in the harness.** Fixed. The adapter maps
   its failure codes with `classifyClaudeCodeFailureCode` and stores the class
   on the runtime, the input message and the lifecycle event, like Codex.
6. **Both: no result lookup by input id.** Fixed. When a turn settles, both
   adapters persist `turnOutcome` (`turnId`, `status`, `error`, `settledAt`) on
   every input message the turn consumed. `lookupThreadInputResult(threadId,
   inputId)` in `packages/core/src/runtime-input-result.js` resolves a client
   input id (or Orkestr message id) to `{ turnId, status, settled,
   finalMessageId, output, error }`. An outcome recorded for an earlier attempt
   is ignored once the input is requeued or resubmitted under a new turn. The
   harnesses answer duplicate inputs through this lookup.
7. **Both: no common adapter interface yet.** The harnesses translate the
   contract onto adapter-specific functions (`startCodexAppServerThread`,
   `sendClaudeCodeInput`, …). Progress is read back from persisted thread
   messages after the turn rather than streamed through a callback.

## Naming assumptions (to align with `docs/spec/adapter-interface.md`)

This suite was written in parallel with the adapter-interface spec and the
simulated provider. It assumes the names below. Rename here if the interface
spec settles on different ones:

- Capability ids: `turn.start`, `turn.final_output`, `turn.streaming`,
  `turn.cancel`, `session.resume`, `input.idempotent`, `tools.approval`,
  `errors.auth`, `errors.transient`, `errors.permanent`.
- Harness methods: `startSession`, `runTurn`, `cancelTurn`, `restart`,
  `resumeSession`, `providerTurnCount`.
- Result fields: `turnId`, `status` (`completed|failed|cancelled`), `output.text`,
  `error.class` (`auth|transient|permanent`), `providerSessionId`, `duplicate`,
  `tool`.
- Event types: `progress`, `final`.
- `ReferenceAdapter` is a candidate backing for the simulated provider used
  by `orkestr demo`. If the simulated provider implements the adapter
  interface directly, its harness should be a thin pass-through like
  `referenceConformance`.
