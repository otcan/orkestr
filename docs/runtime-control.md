# Runtime Control And Liveness

This document defines the runtime behavior introduced by ORK-363 through
ORK-369.

## Input Control

- Trusted interactive WhatsApp and first-party WebUI input steers a verified
  active turn by default.
- Machine and durable request inputs remain passive and wait for an isolated
  turn. Hush/Vagent voice requests, timers, mailbox routes, connector prompt
  pushes, and similar callers must persist `steerActiveTurn: false` with
  `codexDeliveryMode: passive`.
- A thread/chat binding or `ORKESTR_WHATSAPP_INBOUND_STEER_DEFAULT=0` can opt a
  WhatsApp route out of interactive steering.
- `/now <text>` interrupts the active turn and sends `<text>` immediately, on
  every executor. The WebUI "Send now" button, `POST /api/threads/:id/interrupt`
  with `text`, `orkestr interrupt <thread> "<text>"`, and
  `orkestr send <thread> "<text>" --now` do the same. A bare `/now` behaves like
  `/stop`.
- `/steer` has no control meaning and is passed as ordinary text.
- `/interrupt`, `/stop`, `/cancel`, and `/quit` are equivalent preemptive stop
  commands. They cancel pending approval/input requests, interrupt the active
  execution, cancel older queued work, and leave the thread ready for new input.
- Text after a stop command is never forwarded to the model.

### Claude Code interrupt-and-resume

Claude Code runs one `claude -p` process per turn and closes its stdin after
the prompt, so input cannot be steered into a running turn. Interactive input
(WhatsApp, WebUI send) that arrives while a Claude Code turn is running
therefore interrupts and resumes instead:

1. Orkestr sends `SIGINT` to the turn's process group and waits
   `ORKESTR_CLAUDE_CODE_INTERRUPT_GRACE_MS` (default `3000`) for the stream to
   end and the session transcript to flush, then falls back to
   `SIGTERM`/`SIGKILL`.
2. The session id reported by the interrupted turn is persisted, so the next
   turn resumes the same conversation including partial work.
3. The interrupted input is marked `interrupted`
   (`observedVia: claude_code_interrupted`).
4. Every interrupting input that arrived before the next turn starts is
   coalesced, in order, into one resumed turn prefixed with a short note that
   the previous turn was interrupted. Each coalesced input records
   `coalescedIntoMessageId` and the shared `executorTurnId`; the final answer
   is linked to the first input.
5. A turn that already produced its final result during the grace window
   completes normally and the new input runs next. Duplicate interrupt
   requests for the same turn are ignored, and completed inputs are never
   replayed.

No "queued behind current work" notice is sent for such input.
`ORKESTR_CLAUDE_CODE_INSTANT_INTERRUPT=0` restores plain queueing for
interactive input (explicit `/now` and "Send now" still interrupt). The
per-binding opt-outs and `ORKESTR_WHATSAPP_INBOUND_STEER_DEFAULT=0` apply to
Claude Code threads the same way they apply to Codex.

### Claude Code turn limits and visibility

Each Claude Code turn is supervised with these limits:

| Limit | Env | Default |
| --- | --- | --- |
| Whole turn | `ORKESTR_CLAUDE_CODE_TIMEOUT_MS` | 30 min |
| Single tool call | `ORKESTR_CLAUDE_TOOL_DEADLINE_MS` | 20 min |
| Single sub-agent call (`Agent`, legacy `Task`) | `ORKESTR_CLAUDE_AGENT_TOOL_DEADLINE_MS` | `0` (exempt) |
| No stream output | `ORKESTR_CLAUDE_SEMANTIC_INACTIVITY_MS` | 10 min |

Sub-agent calls are exempt from the per-tool deadline by default; they remain
bounded by the turn timeout and the no-output detector. Tools running inside a
sub-agent keep their own per-tool deadline, measured from their own start, so
nested activity neither extends nor shortens another tool's deadline.

Claude's own short text written between tool calls is mirrored to the bound
chat as `commentary`, like Codex commentary. It is released only after a later
tool call shows it was not the final answer, deduplicated, whitespace-trimmed,
capped (`ORKESTR_CLAUDE_INTERIM_TEXT_MAX_CHARS`, default 600), and throttled
with coalescing (`ORKESTR_CLAUDE_INTERIM_TEXT_MIN_INTERVAL_MS`, default 20 s;
`ORKESTR_CLAUDE_INTERIM_TEXT_MAX_MESSAGES`, default 40). Sub-agent narration
is not mirrored. Generic "Claude Code is ..." labels are only a fallback after
Claude has written no text for `ORKESTR_CLAUDE_PROGRESS_LABEL_FALLBACK_MS`
(default 60 s).

The standing headless notice asks Claude to announce long steps, keep tool
calls and sub-agent tasks short, split large jobs into phases across turns, and
always end with a summary of done, partial (with branch and worktree paths),
and next work.

When Orkestr stops a turn itself (tool deadline, turn timeout, no-output
stall, or output cap), it appends a visible final reply that names the reason,
the tool and elapsed time, and a best-effort, time-bounded
(`ORKESTR_CLAUDE_PARTIAL_WORK_TIMEOUT_MS`, default 8 s) partial-work summary:
repository path, branch, and changed-file count for the thread workspace and
any git worktree whose path appeared in the turn's tool inputs. File contents
are never included. The session is kept, so replying "continue" resumes it with
a notice that the previous turn was stopped and may have left partial work.
User-requested interrupts (`/stop`, `/now`, instant interrupt) never produce
this notice.

## Liveness

Runtime age is not failure evidence. Live model output, tool and MCP activity,
child or desktop heartbeats, approvals, user-input waits, checkpoints, and
successful runtime probes all refresh durable liveness state. Orkestr declares
a runtime lost only after two consecutive scoped probes fail without newer
evidence.

Long-running tools should call `orkestr_runtime` with service `runtime`:

- `progress` records phase, summary, evidence type, and optional counters.
- `checkpoint` persists a bounded JSON object that can be used after runtime
  replacement.
- `blocked` records a genuine dependency or user-input wait.
- `complete` records terminal execution state.

Bearer scope is authoritative. Instance, user, thread, and runtime generation
arguments must match it; stale generations are rejected.

## Recovery And Delivery

Safe-reset continuation uses a runtime checkpoint only when its turn or
execution id matches the interrupted input. The resumed model is instructed to
reconcile external state before repeating side effects.

A final response routed to WhatsApp remains `awaiting_delivery` until the exact
assistant message receives a connector acknowledgment. Retryable and uncertain
sends remain recoverable. A mismatched or old acknowledgment cannot complete a
newer execution.

## Verification

```bash
node --test test/codex-app-server.test.js
node --import ./test/test-bootstrap.mjs --test test/claude-code-instant-interrupt.test.js
node --import ./test/test-bootstrap.mjs --test test/claude-turn-visibility.test.js test/claude-turn-kill-notice.test.js
node --test test/runtime-liveness.test.js test/connectors-mcp.test.js
node --test test/tenant-api-agent.test.js
node --test test/whatsapp-connector-outbox.test.js test/whatsapp-live-mirror-recovery.test.js
git diff --check
```

The fault cases include turns older than one hour, first-probe preservation,
second-probe recovery, approval preemption, stale runtime generations,
checkpoint resumption, connector retry, and exact final-delivery acknowledgment.
The focused ORK-369 gap matrix, deterministic injection boundaries, release-gate
output, and attended rollout/rollback procedure are documented in
`docs/runtime-liveness-fault-validation.md`.
