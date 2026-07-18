# Runtime Control And Liveness

This document defines the runtime behavior introduced by ORK-363 through
ORK-369.

## Input Control

- Normal input steers a verified active turn by default.
- `/now` and `/steer` have no control meaning and are passed as ordinary text.
- `/interrupt`, `/stop`, `/cancel`, and `/quit` are equivalent preemptive stop
  commands. They cancel pending approval/input requests, interrupt the active
  execution, cancel older queued work, and leave the thread ready for new input.
- Text after a stop command is never forwarded to the model.

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
node --test test/runtime-liveness.test.js test/connectors-mcp.test.js
node --test test/tenant-api-agent.test.js
node --test test/whatsapp-connector-outbox.test.js test/whatsapp-live-mirror-recovery.test.js
git diff --check
```

The fault cases include turns older than one hour, first-probe preservation,
second-probe recovery, approval preemption, stale runtime generations,
checkpoint resumption, connector retry, and exact final-delivery acknowledgment.
