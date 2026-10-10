# Provider adapter interface (v0)

Status: draft v0. This doc defines the contract that every provider
(`simulated`, `codex`, `claude-code`, `openai-compatible`) implements so that
the Agent Job runtime ([agent-job.md](agent-job.md)) can treat providers
uniformly. Conformance tests live in `test/conformance/`. They run each
adapter against a scripted fake backend; real providers are opt-in and gated
by env.

Design rule: the interface has **common lifecycle semantics** and
**explicit optional capabilities**. The runtime never probes provider
behaviour. It reads `capabilities` and either uses the native feature or
supplies its own (for example, its own tool loop).

## 1. Shape

```js
// packages/core/src/agent-adapters/<id>.js (proposed location)
export const adapter = {
  id: "codex",                       // matches agent.provider in the job spec
  capabilities: {
    toolLoop: "native",              // "native" = provider runs tools; "orkestr" = Orkestr runs the loop
    resume: "session",               // "session" | "transcript" | "none"
    interrupt: "cooperative",        // "cooperative" | "kill" ; every adapter must support at least kill
    streaming: true,                 // emits incremental `message.delta`
    structuredOutput: "native",      // "native" | "validate" (Orkestr validates/re-asks)
    permissionHook: "pre_call",      // "pre_call" (can block before exec) | "sandbox_only" | "orkestr" (loop is ours)
    sandbox: "workspace_write",      // informational: "none" | "read_only" | "workspace_write" | "container"
    usage: true,                     // reports tokens/cost
  },
  async probe(ctx) {},               // -> { ok, reason? } credentials/binary present; used by `orkestr doctor`
  async start(ctx, input) {},        // -> AttemptHandle
  async resume(ctx, checkpoint) {},  // -> AttemptHandle   (only if capabilities.resume !== "none")
  async send(handle, message) {},    // follow-up/steer input within an attempt (optional)
  async interrupt(handle, { reason }) {}, // must be idempotent
  async status(handle) {},           // -> { state, sessionRef, lastEventSeq }
};
```

`ctx` is supplied by the runtime and holds `{ runId, attempt, workspace, env,
signal (AbortSignal), emit(event), authorizeTool(call), resolveSecret(ref),
checkpoint(kind, data) }`. Adapters never read the vault or the policy store
directly. They go through `ctx`.

`input` is `{ prompt, inputs, triggerEvent, outputSchema, tools[], model,
resumeSummary? }`.

`AttemptHandle` is `{ sessionRef, done: Promise<AttemptResult> }`, where
`AttemptResult` is `{ endReason, output?, error?: { kind: "provider" | "task"
| "timeout", retryable, message }, usage? }`. The `error.kind` decides fallback
(`provider` → try the next provider) versus retry or fail.

## 2. Events (`ctx.emit`)

Every event carries `{ type, seq, at }`, and `seq` increases monotonically per
attempt.

| type | payload | required |
| --- | --- | --- |
| `session.started` | `sessionRef` | yes, before any other event; this is checkpointed |
| `message.delta` | `text` | if `streaming` |
| `message.completed` | `text` | yes |
| `tool.requested` | `callId, tool, args` | yes (for native loops, mapped from provider events) |
| `tool.completed` | `callId, ok, resultSummary` | yes |
| `approval.requested` | `callId, tool, args` | when the provider asks for approval natively |
| `usage` | `inputTokens, outputTokens, costUsd?` | if `usage` |
| `attempt.ended` | `endReason` | yes, exactly once |

The runtime turns these into checkpoints and audit entries. The adapter does
not write audit itself.

## 3. Semantics every adapter must meet

1. **Cancellation.** When `ctx.signal` aborts or `interrupt()` is called, the
   adapter stops starting new tool calls immediately and emits
   `attempt.ended{cancelled|interrupted}` within 10 s. If cooperative stop
   fails, it kills the process group. `interrupt()` on a finished handle is a
   no-op.
2. **Restart and resume.** `session.started` must be emitted before the first
   tool call so that a crash afterwards can be resumed.
   * `resume: "session"`: `resume(checkpoint)` reattaches to
     `checkpoint.sessionRef`.
   * `resume: "transcript"`: the adapter rebuilds context from
     `checkpoint.transcriptRef`.
   * `resume: "none"`: the runtime calls `start()` with `input.resumeSummary`
     (the committed effects and their results).
3. **Tool permission hook.** Every tool or effect call must pass
   `await ctx.authorizeTool({ tool, args })` *before* execution. The result is
   `allow` (continue), `deny` (return a structured denial to the model) or
   `pending` (the runtime parks the attempt for approval).
   * Adapters with `permissionHook: "pre_call"` wire this into the provider's
     approval callback.
   * Adapters with `permissionHook: "sandbox_only"` cannot gate individual
     calls. The runtime then refuses jobs whose `permissions.tools` is not
     expressible in the sandbox config, and reports this at validate time.
4. **Effects go through the runtime.** Side-effecting tools (Orkestr-provided
   tools and MCP tools exposed by Orkestr) are executed by the runtime's
   effect executor, which applies the effect ledger (agent-job §5). Provider
   built-in tools that Orkestr cannot see, such as a raw shell, are confined
   to the workspace sandbox. External effects must use Orkestr tools.
5. **Structured output.** With `structuredOutput: "native"` the schema is
   passed to the provider. With `"validate"` the runtime validates the final
   message and re-asks once with the validation error.
6. **No secret leakage.** Secrets come from `ctx.resolveSecret()` and only go
   to the subprocess env or request headers, never into prompts or events.

Conformance suite (`test/conformance/adapter.conformance.js`, run once per
adapter against a fake backend): start/complete, streaming order, cancel
mid-tool, kill and resume from checkpoint, unlisted tool denied, approval
pending and resolve, structured output pass and fail, error classification,
and a secret canary that must not appear in events.

## 4. Mapping existing runtimes

### Codex (app-server)

Code: `codex-app-server.js`, `codex-app-server-client.js`, and the façade
`runtime-codex-adapter.js`.

| Interface | Codex app-server today |
| --- | --- |
| `start` | `thread/start` + `turn/start` (`startCodexAppServerThread`) |
| `resume` | `thread/resume` (`resumeCodexAppServerThread`); `resume: "session"` |
| `send` | `turn/steer`, or a queued `turn/start` (`deliverCodexAppServerPendingInputs`) |
| `interrupt` | `turn/interrupt` (`interruptCodexAppServerThread`); `cooperative` |
| `status` | `thread/read` (`codexAppServerThreadStatus`) |
| events | `item/started` and `item/completed` → `tool.*` and `message.*`; `thread/status/changed` → status |
| permission hook | `item/commandExecution/requestApproval`, `item/fileChange/requestApproval` → `pre_call` (today these become `awaiting_approval` prompts to a human; they must route to `ctx.authorizeTool` first) |
| recovery | `codex-app-server-recovery.js`, `codex-app-server-active-turn-recovery.js` (stale-turn detection) |
| gaps | Thread-level Codex is coupled to Orkestr *threads*. Agent Jobs use `agent-job-codex.js` instead: a job-owned Codex thread with no thread record (`codex-job-session.js`, `codex-job-client.js`), approvals routed to `ctx.authorizeTool` (`pre_call`), Orkestr tools exposed as dynamic tools (`item/tool/call`), `resume: "session"`. Structured output is `validate` (one re-ask). See [agent-job-runner.md](agent-job-runner.md#codex). |

### Claude Code (CLI, stream-json)

Code: `runtime-claude-code-adapter.js`, `claude-code-client.js`,
`claude-code-process-runner.js` and `claude-code-supervised-process.js`.

| Interface | Claude Code today |
| --- | --- |
| `start` | `claude -p --output-format stream-json` subprocess (`runClaudeCodeProcess`) |
| `resume` | `--resume <sessionId>`; `resume: "session"`. Reattach and orphan recovery: `claude-code-turn-reattach.js`, `claude-code-orphan-turn-recovery.js` |
| `interrupt` | `requestClaudeCodeInstantInterrupt` / process signal; `cooperative` with `kill` fallback |
| events | stream-json `tool_use` / `tool_result` blocks → `tool.*` (`claude-code-supervised-process.js`) |
| permission hook | Threads: `--permission-mode` plus an MCP allow-list (`claude-code-mcp-policy.js`) → `sandbox_only`. Job attempts (`agent-job-claude-code.js`): `pre_call` via a `PreToolUse` hook command (`--settings`) that asks a per-attempt Orkestr broker, which calls `ctx.authorizeTool`. Both job executors implement the shared native executor interface ([agent-job-runner.md](agent-job-runner.md#native-executors)). |
| gaps | Threads keep the thread coupling; job attempts do not need a thread record. Partial-work tracking exists (`claude-code-partial-work.js`) and can feed `resumeSummary`. |

### `simulated`

A deterministic, scripted adapter with no network and no credentials. A
script is a list of steps (`say`, `tool`, `crash_after`, `ask_approval`,
`output`). It declares the full capability set, `toolLoop: "orkestr"` and
`resume: "transcript"`, so the runtime's own loop, checkpointing and fault
injection are exercised in CI. It is used by `orkestr demo` and as the
reference implementation for the conformance suite. Today's `noop` executor
in `executors.js` is its ancestor.

## 5. Raw OpenAI-compatible or local model adapter

A chat-completions endpoint (vLLM, llama.cpp server, Ollama's OpenAI API, or
OpenAI itself) has no agent loop, workspace or session. The adapter is thin
(HTTP client plus streaming parser) and declares `toolLoop: "orkestr"`,
`resume: "transcript"`, `interrupt: "cooperative"` (it aborts the HTTP
request), `structuredOutput: "validate"` (or `"native"` when the endpoint
supports `response_format: json_schema`) and `permissionHook: "orkestr"`.

Orkestr must provide the rest. It can reuse the Responses-style loop in
`tenant-api-agent.js` (`postOpenAIResponse` already honours `OPENAI_BASE_URL`
and sends `Idempotency-Key`), extracted into a provider-neutral module:

1. **A tool loop.** Send messages with tool schemas, parse `tool_calls`, run
   each through `authorizeTool` and the effect executor, append the results,
   and repeat until there is a final message or `max_turns`.
2. **A tool set.** Workspace-scoped file read/write, a sandboxed shell
   (container or `bwrap`; off by default), and `git` and connector tools
   exposed as Orkestr tools so they hit the effect ledger.
3. **A transcript store.** Every request and response is persisted per
   attempt for `resume: "transcript"`, with context-window trimming.
4. **Output validation** and one repair re-ask.
5. **Usage accounting** from the `usage` fields, when present.

Fallback ordering lets a job use a local model first and `codex` as backup
(`examples/jobs/local-model-digest.yaml`).
