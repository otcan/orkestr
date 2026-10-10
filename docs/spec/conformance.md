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
# All bundled harnesses (reference, Codex app-server, Claude Code) + self-tests
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
| `input.idempotent` | no | `idempotent-redelivery` | same `inputId` twice → `duplicate: true`, same turn id, one provider turn |
| `tools.approval` | no | `tool-permission-deny`, `tool-permission-approve` | hook called once; deny blocks, approve runs the tool |
| `errors.auth` | no | `error-auth` | `status: failed`, `error.class: auth` |
| `errors.transient` | no | `error-transient` | `error.class: transient` |
| `errors.permanent` | no | `error-permanent` | `error.class: permanent` |

`checks-self.test.js` breaks the reference adapter on purpose (re-runs
duplicates, ignores deny, ignores cancel, opens a new session after restart,
misclassifies errors) and asserts the matching check fails.

## Current matrix

| check | reference | codex-app-server | claude-code |
| --- | --- | --- | --- |
| start-turn | pass | pass | pass |
| final-output | pass | pass | pass |
| streaming-progress | pass | pass | pass (connector-origin input only, see gaps) |
| cancellation | pass | pass | pass |
| restart-resume | pass | pass | pass |
| idempotent-redelivery | pass | pass | pass |
| tool-permission-deny | pass | pass | skip (gap) |
| tool-permission-approve | pass | pass | skip (gap) |
| error-auth | pass | pass | pass |
| error-transient | pass | skip (gap) | pass (class mapped in harness) |
| error-permanent | pass | skip (gap) | pass (class mapped in harness) |

The Codex and Claude Code harnesses drive the real Orkestr adapters
(`packages/core/src/codex-app-server*.js`,
`packages/core/src/runtime-claude-code-adapter.js`) through the Orkestr thread
layer against fake processes in `test/conformance/fakes/`, derived from the
inline fakes in `test/codex-app-server.test.js` and
`test/claude-code-runtime.test.js`.

## Known gaps

These were found while writing the harnesses. Fixed items are marked.

1. **Codex: no transient vs permanent error class.** Non-auth turn failures
   persist only raw error text (`thread.state = "failed"`,
   `runtime.lastTurnError`). Only auth failures are classified
   (`failed_auth` + `runtime.authFailure`). A retry policy cannot tell a 429 or
   stream disconnect from a malformed request.
2. **Codex: stale runtime snapshot written after `turn/start`.** Fixed.
   Runtime writers now merge only the fields they own onto the latest record
   under the thread store lock (`updateThreadRuntime` in
   `packages/core/src/runtime-record-update.js`). Codex notifications for one
   thread are handled in arrival order, and `runtime.turnGeneration` stops a
   writer for an older turn from overwriting a newer one. Regression tests:
   `test/codex-app-server-start-write-race.test.js` and
   `test/runtime-write-ordering.test.js` (`FAKE_CODEX_STEP_MS=30`).
3. **Claude Code: no tool-permission hook.** Claude Code runs its own tool loop
   under a fixed permission mode/MCP policy. Orkestr cannot approve or deny
   individual calls, so `approval_required` actions cannot be enforced for this
   adapter yet.
4. **Claude Code: progress is only projected for connector-originated turns.**
   `createClaudeCodeProgressReporter` is enabled only for WhatsApp-origin
   inputs. The harness poses the `progress` scenario as a WhatsApp input with
   fake ids. API, timer and job callers get no progress stream.
5. **Claude Code: error class lives in the harness.** The adapter throws
   low-cardinality codes (`claude_code_auth_required`,
   `claude_code_rate_limited`, `claude_code_failed`, …). The code-to-class
   mapping is in `claude-code-harness.js`, not in the adapter.
6. **Both: no result lookup by input id.** Idempotency comes from the thread
   layer (`clientMessageId` dedupe in `appendThreadMessage`). A re-delivered
   input returns the original queued message, but there is no API that returns
   the original turn's structured result for that input id. Durable jobs will
   need one to reconcile after a crash.
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
