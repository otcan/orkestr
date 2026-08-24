# Runtime Liveness Fault Validation And Attended Rollout

This document covers the public, deterministic validation added for ORK-369.
It does not authorize a deployment, production canary, tenant operation, or live
WhatsApp test.

## Gap Analysis

ORK-363 already tests the two-probe loss rule, evidence refresh, stale runtime
generation fencing, stale approval refusal, checkpoint scoping, restart retry,
safe-reset continuation, stop preemption, final deduplication, connector retry,
and exact final-delivery acknowledgement. ORK-369 therefore adds only the gaps:

| Area | Existing coverage retained | ORK-369 addition |
| --- | --- | --- |
| Durable input | idempotent input and delivery claims | pre-persistence failure and retry |
| Steering | normal input steers a verified turn | multiple messages, submission failure, acceptance reconciliation, terminal disposition |
| Liveness | semantic evidence and double probe | controlled clock beyond two hours |
| Tools and MCP | scoped execution and checkpoint contract | deterministic execution failure followed by one terminal answer |
| Checkpoint/final | bounded checkpoint and exact final ack | injected persistence and acknowledgement failures |
| Transport | retryable outbox and final dedupe | delayed send with exactly one eventual WhatsApp reply |
| Stop | aliases and approval preemption | shared model/tool/MCP/child/approval/finalization phase taxonomy and latency metric |
| Rollout | runtime and connector diagnostics | low-cardinality release-gate JSON |

The test-only seam is `ORKESTR_TEST_RUNTIME_FAULT_INJECTOR`. It accepts hooks
for `message_persistence`, `steering_submission`, `runtime_acceptance`,
`tool_mcp_execution`, `checkpoint_persistence`, `final_persistence`,
`transport_send`, and `delivery_acknowledgement`. It is ignored unless the
environment value is an in-process function or object, so a string in a normal
service environment cannot activate it. `ORKESTR_TEST_RUNTIME_CLOCK` provides
the corresponding controlled clock.

## Release-Gate Output

The metrics surface uses fixed signal, outcome, phase, and state labels. The
main series are:

- `orkestr_runtime_control_events_total`
- `orkestr_runtime_stop_latency_seconds`
- `orkestr_runtime_pending_final_deliveries_current`
- `orkestr_runtime_unresolved_steering_inputs_current`
- `orkestr_runtime_resumable_checkpoints_current`

Create an aggregate JSON file from the attended observation window and run:

```bash
node scripts/runtime-control-release-gate.mjs --input runtime-control-gate.json
```

The input fields are `falseRecoveries`, `unresolvedSteeringInputs`,
`duplicateTurns`, `maxStopLatencyMs`, `checkpointResumeFailures`, and
`pendingFinalDeliveries`. All count limits are zero. Stop latency defaults to
5000 ms and can be set with `ORKESTR_RUNTIME_STOP_LATENCY_GATE_MS`. The command
returns exit code 0 when every check passes, 1 when an invariant fails, and 2
for invalid input or execution errors.

## Attended Rollout

1. Run the focused deterministic suite and capture the gate JSON as a release
   artifact.
2. Enable shadow observation only. Compare proposed recovery decisions with
   live runtime evidence; do not interrupt work in this phase.
3. Enable enforcement for internal test threads. Include a controlled
   long-running tool, MCP activity, approval wait, process restart, and delayed
   connector acknowledgement.
4. Run attended canaries on explicitly selected non-sensitive test threads.
   Confirm every accepted input has a terminal disposition and every final has
   one connector acknowledgement.
5. Expand one cohort at a time only after a complete observation window passes
   all six release-gate checks. Live WhatsApp E2E remains optional and attended.

Record transport, router, runtime, model, tool/MCP, checkpoint, final
persistence, and acknowledgement timestamps separately. Do not infer a healthy
segment from an end-to-end success alone.

## Rollback

Disable recovery-decision enforcement first while leaving liveness recording,
durable inputs, checkpoints, connector outbox records, and delivery
acknowledgements enabled. Stop cohort expansion, export the six gate inputs and
segment diagnostics, and let already accepted messages converge to delivered,
cancelled, or operator-required. Do not delete pending inputs, checkpoints, or
outbox jobs during rollback. Resume enforcement only after the deterministic
reproduction passes and an attended observation window returns a clean gate.
