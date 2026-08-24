import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  completeRuntimeLiveness,
  recordRuntimeLiveness,
  recordRuntimeLivenessProbeFailure,
  saveRuntimeCheckpoint,
} from "../packages/core/src/runtime-liveness.js";
import {
  acknowledgeRuntimeFinalDelivery,
  markRuntimeFinalDeliveryPending,
  recordRuntimeFinalDeliveryFailure,
  runtimeFinalDeliveryPending,
} from "../packages/core/src/runtime-final-delivery.js";
import { appendThreadMessage, createThread, getThread, listThreadMessages, updateThread } from "../packages/core/src/threads.js";
import { runtimeFaultBoundaries, runtimeStopPhaseFor } from "../packages/core/src/runtime-fault-injection.js";
import { parseThreadInputCommand } from "../packages/core/src/thread-commands.js";

function failBoundaryOnce(boundary) {
  let remaining = 1;
  return async ({ boundary: observed }) => {
    if (observed !== boundary || remaining <= 0) return;
    remaining -= 1;
    const error = new Error(`injected_${boundary}`);
    error.code = "runtime_fault_injected";
    throw error;
  };
}

test("runtime fault boundaries remain explicit and low-cardinality", () => {
  assert.deepEqual(runtimeFaultBoundaries(), [
    "message_persistence",
    "steering_submission",
    "runtime_acceptance",
    "tool_mcp_execution",
    "checkpoint_persistence",
    "final_persistence",
    "transport_send",
    "delivery_acknowledgement",
  ]);
});

test("all stop aliases share one control action and phase taxonomy", () => {
  for (const alias of ["/interrupt", "/stop", "/cancel", "/quit"]) {
    const parsed = parseThreadInputCommand({ text: `${alias} trailing text is ignored` });
    assert.equal(parsed.command, "stop");
  }
  assert.deepEqual([
    "model_output",
    "tool_execution",
    "mcp_call",
    "child_process",
    "awaiting_approval",
    "final_delivery",
  ].map((phase) => runtimeStopPhaseFor({ runtime: { liveness: { phase } } })), [
    "model",
    "tool",
    "mcp",
    "child_process",
    "approval",
    "finalization",
  ]);
});

test("message, checkpoint, final, and acknowledgement faults converge without losing accepted state", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-runtime-persistence-faults-"));
  const baseEnv = { ORKESTR_HOME: home };
  await createThread({
    id: "runtime-persistence-fault-thread",
    name: "Runtime persistence fault thread",
    codexThreadId: "fault-generation",
    executor: { type: "codex", codexThreadId: "fault-generation" },
    runtime: { runtimeGeneration: "fault-generation", activeTurnId: "fault-turn" },
  }, baseEnv);

  const messageEnv = { ...baseEnv, ORKESTR_TEST_RUNTIME_FAULT_INJECTOR: failBoundaryOnce("message_persistence") };
  await assert.rejects(() => appendThreadMessage("runtime-persistence-fault-thread", {
    role: "user",
    source: "test",
    text: "durable input",
    clientMessageId: "fault-input-1",
    state: "queued",
  }, messageEnv), /injected_message_persistence/);
  assert.equal((await listThreadMessages("runtime-persistence-fault-thread", baseEnv)).length, 0);
  const message = await appendThreadMessage("runtime-persistence-fault-thread", {
    role: "user",
    source: "test",
    text: "durable input",
    clientMessageId: "fault-input-1",
    state: "queued",
  }, messageEnv);

  const checkpointEnv = { ...baseEnv, ORKESTR_TEST_RUNTIME_FAULT_INJECTOR: failBoundaryOnce("checkpoint_persistence") };
  const checkpointInput = {
    runtimeGeneration: "fault-generation",
    turnId: "fault-turn",
    executionId: "fault-execution",
    checkpointId: "fault-checkpoint",
    payload: { cursor: 7 },
  };
  await assert.rejects(() => saveRuntimeCheckpoint("runtime-persistence-fault-thread", checkpointInput, checkpointEnv), /injected_checkpoint_persistence/);
  assert.equal((await getThread("runtime-persistence-fault-thread", baseEnv)).runtime.checkpoint, undefined);
  await saveRuntimeCheckpoint("runtime-persistence-fault-thread", checkpointInput, checkpointEnv);

  const finalInput = {
    messageId: "fault-final",
    parentMessageId: message.id,
    runtimeGeneration: "fault-generation",
    turnId: "fault-turn",
    connector: "whatsapp",
  };
  const finalEnv = { ...baseEnv, ORKESTR_TEST_RUNTIME_FAULT_INJECTOR: failBoundaryOnce("final_persistence") };
  await assert.rejects(() => markRuntimeFinalDeliveryPending("runtime-persistence-fault-thread", finalInput, finalEnv), /injected_final_persistence/);
  assert.equal((await getThread("runtime-persistence-fault-thread", baseEnv)).runtime.finalDelivery, undefined);
  await markRuntimeFinalDeliveryPending("runtime-persistence-fault-thread", finalInput, finalEnv);

  const ackEnv = { ...baseEnv, ORKESTR_TEST_RUNTIME_FAULT_INJECTOR: failBoundaryOnce("delivery_acknowledgement") };
  await assert.rejects(() => acknowledgeRuntimeFinalDelivery("runtime-persistence-fault-thread", {
    messageId: "fault-final",
    connectorMessageId: "connector-final-1",
  }, ackEnv), /injected_delivery_acknowledgement/);
  assert.equal((await getThread("runtime-persistence-fault-thread", baseEnv)).runtime.finalDelivery.status, "pending");
  await acknowledgeRuntimeFinalDelivery("runtime-persistence-fault-thread", {
    messageId: "fault-final",
    connectorMessageId: "connector-final-1",
  }, ackEnv);

  const terminal = await getThread("runtime-persistence-fault-thread", baseEnv);
  assert.equal(terminal.runtime.checkpoint.checkpointId, "fault-checkpoint");
  assert.deepEqual(terminal.runtime.checkpoint.payload, { cursor: 7 });
  assert.equal(terminal.runtime.finalDelivery.status, "delivered");
  assert.equal(terminal.runtime.finalDelivery.connectorMessageId, "connector-final-1");
});

test("controlled liveness clock preserves healthy work beyond one hour", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-runtime-controlled-clock-"));
  const clock = { nowMs: Date.parse("2026-08-24T00:00:00.000Z") };
  const env = { ORKESTR_HOME: home, ORKESTR_TEST_RUNTIME_CLOCK: clock };
  await createThread({
    id: "runtime-controlled-clock-thread",
    name: "Runtime controlled clock thread",
    codexThreadId: "clock-generation",
    executor: { type: "codex", codexThreadId: "clock-generation" },
    runtime: { runtimeGeneration: "clock-generation", activeTurnId: "clock-turn" },
  }, env);
  const input = { runtimeGeneration: "clock-generation", turnId: "clock-turn", executionId: "clock-execution" };
  const started = await recordRuntimeLiveness("runtime-controlled-clock-thread", { ...input, evidenceType: "tool_started" }, env);
  clock.nowMs += 61 * 60_000;
  await recordRuntimeLiveness("runtime-controlled-clock-thread", { ...input, evidenceType: "mcp_progress" }, env);
  clock.nowMs += 61 * 60_000;
  const healthy = await recordRuntimeLiveness("runtime-controlled-clock-thread", { ...input, evidenceType: "child_heartbeat" }, env);

  assert.equal(started.liveness.startedAt, "2026-08-24T00:00:00.000Z");
  assert.equal(healthy.liveness.startedAt, started.liveness.startedAt);
  assert.equal(healthy.liveness.lastEvidenceAt, "2026-08-24T02:02:00.000Z");
  assert.equal(healthy.liveness.lastEvidenceType, "child_heartbeat");
  assert.equal(healthy.liveness.consecutiveProbeFailures, 0);
  assert.equal(healthy.liveness.completedAt, undefined);
});

test("runtime liveness requires two failed probes and resets failures on evidence", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-runtime-liveness-"));
  const env = { ORKESTR_HOME: home };
  await createThread({
    id: "runtime-liveness-thread",
    name: "Runtime Liveness Thread",
    runtimeKind: "codex-app-server",
    codexThreadId: "codex-generation-1",
    executor: { type: "codex", transport: "app-server", codexThreadId: "codex-generation-1" },
    runtime: { runtimeKind: "codex-app-server", state: "working", activeTurnId: "turn-1" },
  }, env);

  const recorded = await recordRuntimeLiveness("runtime-liveness-thread", {
    runtimeGeneration: "codex-generation-1",
    turnId: "turn-1",
    evidenceType: "tool_started",
    phase: "executing",
    summary: "Running test tool",
  }, env);
  const first = await recordRuntimeLivenessProbeFailure("runtime-liveness-thread", {
    runtimeGeneration: "codex-generation-1",
    turnId: "turn-1",
    reason: "probe_missing",
  }, env);
  const second = await recordRuntimeLivenessProbeFailure("runtime-liveness-thread", {
    runtimeGeneration: "codex-generation-1",
    turnId: "turn-1",
    reason: "probe_missing",
  }, env);
  const refreshed = await recordRuntimeLiveness("runtime-liveness-thread", {
    runtimeGeneration: "codex-generation-1",
    turnId: "turn-1",
    evidenceType: "child_heartbeat",
    phase: "executing",
  }, env);
  const stale = await recordRuntimeLiveness("runtime-liveness-thread", {
    runtimeGeneration: "codex-generation-old",
    turnId: "turn-1",
    evidenceType: "model_output",
  }, env);

  assert.equal(recorded.recorded, true);
  assert.equal(first.lost, false);
  assert.equal(first.failures, 1);
  assert.equal(second.lost, true);
  assert.equal(second.failures, 2);
  assert.equal(refreshed.liveness.consecutiveProbeFailures, 0);
  assert.equal(refreshed.liveness.lastEvidenceType, "child_heartbeat");
  assert.equal(stale.recorded, false);
  assert.equal(stale.reason, "stale_runtime_generation");
});

test("runtime probes do not overwrite semantic liveness evidence", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-runtime-semantic-liveness-"));
  const env = { ORKESTR_HOME: home };
  await createThread({
    id: "runtime-semantic-liveness-thread",
    name: "Runtime Semantic Liveness Thread",
    runtimeKind: "codex-app-server",
    codexThreadId: "codex-semantic-generation",
    executor: { type: "codex", transport: "app-server", codexThreadId: "codex-semantic-generation" },
    runtime: { runtimeKind: "codex-app-server", state: "working", activeTurnId: "semantic-turn" },
  }, env);

  const started = await recordRuntimeLiveness("runtime-semantic-liveness-thread", {
    runtimeGeneration: "codex-semantic-generation",
    turnId: "semantic-turn",
    evidenceType: "model_started",
  }, env);
  const output = await recordRuntimeLiveness("runtime-semantic-liveness-thread", {
    runtimeGeneration: "codex-semantic-generation",
    turnId: "semantic-turn",
    evidenceType: "model_output",
  }, env);
  const probe = await recordRuntimeLiveness("runtime-semantic-liveness-thread", {
    runtimeGeneration: "codex-semantic-generation",
    turnId: "semantic-turn",
    evidenceType: "runtime_probe",
  }, env);

  assert.equal(started.liveness.lastSemanticEvidenceAt, null);
  assert.equal(output.liveness.lastSemanticEvidenceType, "model_output");
  assert.equal(probe.liveness.lastSemanticEvidenceAt, output.liveness.lastSemanticEvidenceAt);
  assert.equal(probe.liveness.lastSemanticEvidenceType, "model_output");
  assert.equal(probe.liveness.lastEvidenceType, "runtime_probe");
  assert.notEqual(probe.liveness.lastProbeAt, null);
});

test("runtime checkpoints are scoped, bounded, and survive completion", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-runtime-checkpoint-"));
  const env = { ORKESTR_HOME: home };
  await createThread({
    id: "runtime-checkpoint-thread",
    name: "Runtime Checkpoint Thread",
    runtimeKind: "codex-app-server",
    codexThreadId: "codex-generation-2",
    executor: { type: "codex", transport: "app-server", codexThreadId: "codex-generation-2" },
    runtime: { runtimeKind: "codex-app-server", state: "working", activeTurnId: "turn-2" },
  }, env);

  const saved = await saveRuntimeCheckpoint("runtime-checkpoint-thread", {
    runtimeGeneration: "codex-generation-2",
    turnId: "turn-2",
    checkpointId: "checkpoint-2",
    phase: "executing",
    summary: "Processed first batch",
    payload: { cursor: 42, pending: ["next"] },
  }, env);
  const completed = await completeRuntimeLiveness("runtime-checkpoint-thread", {
    runtimeGeneration: "codex-generation-2",
    turnId: "turn-2",
    status: "completed",
    summary: "Done",
  }, env);
  const thread = await getThread("runtime-checkpoint-thread", env);

  assert.equal(saved.saved, true);
  assert.equal(saved.checkpoint.checkpointId, "checkpoint-2");
  assert.deepEqual(saved.checkpoint.payload, { cursor: 42, pending: ["next"] });
  assert.equal(completed.completed, true);
  assert.equal(thread.runtime.liveness.completionStatus, "completed");
  assert.equal(thread.runtime.checkpoint.checkpointId, "checkpoint-2");
  await assert.rejects(
    () => saveRuntimeCheckpoint("runtime-checkpoint-thread", {
      runtimeGeneration: "codex-generation-2",
      turnId: "turn-2",
      payload: { value: "x".repeat(70 * 1024) },
    }, env),
    /runtime_checkpoint_payload_too_large/,
  );
});

test("runtime completion waits for the exact final connector acknowledgement", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-runtime-final-delivery-"));
  const env = { ORKESTR_HOME: home };
  await createThread({
    id: "runtime-final-delivery-thread",
    name: "Runtime final delivery",
    executorId: "codex",
    executor: { type: "codex", codexThreadId: "runtime-final-generation" },
    runtime: { runtimeGeneration: "runtime-final-generation", activeTurnId: "runtime-final-turn" },
  }, env);
  await recordRuntimeLiveness("runtime-final-delivery-thread", {
    runtimeGeneration: "runtime-final-generation",
    turnId: "runtime-final-turn",
    executionId: "runtime-final-execution",
    evidenceType: "model_output",
  }, env);

  const pending = await markRuntimeFinalDeliveryPending("runtime-final-delivery-thread", {
    messageId: "assistant-final-1",
    runtimeGeneration: "runtime-final-generation",
    turnId: "runtime-final-turn",
    connector: "whatsapp",
    chatId: "jobs@g.us",
  }, env);
  const wrongAck = await acknowledgeRuntimeFinalDelivery("runtime-final-delivery-thread", {
    messageId: "assistant-final-other",
  }, env);
  const failed = await recordRuntimeFinalDeliveryFailure("runtime-final-delivery-thread", {
    messageId: "assistant-final-1",
    status: "failed_retryable",
    error: "worker unavailable",
  }, env);
  const acknowledged = await acknowledgeRuntimeFinalDelivery("runtime-final-delivery-thread", {
    messageId: "assistant-final-1",
    deliveredAt: "2026-07-18T12:00:00.000Z",
    outboxJobId: "outbox-final-1",
    connectorMessageId: "wa-final-1",
  }, env);
  const thread = await getThread("runtime-final-delivery-thread", env);

  assert.equal(pending.pending, true);
  assert.equal(runtimeFinalDeliveryPending(pending.thread, "runtime-final-turn"), true);
  assert.equal(wrongAck.acknowledged, false);
  assert.equal(failed.finalDelivery.status, "failed_retryable");
  assert.equal(acknowledged.acknowledged, true);
  assert.equal(thread.runtime.finalDelivery.status, "delivered");
  assert.equal(thread.runtime.finalDelivery.connectorMessageId, "wa-final-1");
  assert.equal(thread.runtime.liveness.completionStatus, "completed");
  assert.equal(thread.runtime.liveness.phase, "complete");
});

test("runtime final delivery keeps canonical delivery when duplicate final projection appears later", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-runtime-duplicate-final-delivery-"));
  const env = { ORKESTR_HOME: home };
  await createThread({
    id: "runtime-duplicate-final-thread",
    name: "Runtime duplicate final delivery",
    executorId: "codex",
    executor: { type: "codex", codexThreadId: "runtime-duplicate-generation" },
    runtime: { runtimeGeneration: "runtime-duplicate-generation", activeTurnId: "runtime-duplicate-turn" },
  }, env);

  await markRuntimeFinalDeliveryPending("runtime-duplicate-final-thread", {
    messageId: "assistant-final-canonical",
    parentMessageId: "user-message-1",
    runtimeGeneration: "runtime-duplicate-generation",
    turnId: "runtime-duplicate-turn",
    connector: "whatsapp",
    chatId: "features@g.us",
    accountId: "sender",
  }, env);
  await acknowledgeRuntimeFinalDelivery("runtime-duplicate-final-thread", {
    messageId: "assistant-final-canonical",
    deliveredAt: "2026-08-10T09:47:30.000Z",
    outboxJobId: "outbox-canonical",
    connectorMessageId: "wa-canonical",
  }, env);

  const duplicate = await markRuntimeFinalDeliveryPending("runtime-duplicate-final-thread", {
    messageId: "assistant-final-unix-seconds-duplicate",
    parentMessageId: "user-message-1",
    runtimeGeneration: "runtime-duplicate-generation",
    turnId: "runtime-duplicate-turn",
    connector: "whatsapp",
    chatId: "features@g.us",
    accountId: "sender",
  }, env);
  const duplicateFailure = await recordRuntimeFinalDeliveryFailure("runtime-duplicate-final-thread", {
    messageId: "assistant-final-unix-seconds-duplicate",
    status: "failed_retryable",
    error: "duplicate outbox failed after canonical delivery",
  }, env);
  const duplicateAck = await acknowledgeRuntimeFinalDelivery("runtime-duplicate-final-thread", {
    messageId: "assistant-final-unix-seconds-duplicate",
    deliveredAt: "2026-08-10T09:47:35.000Z",
    outboxJobId: "outbox-duplicate",
    connectorMessageId: "wa-duplicate",
  }, env);
  const thread = await getThread("runtime-duplicate-final-thread", env);

  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.superseded, true);
  assert.equal(duplicate.pending, false);
  assert.equal(duplicateFailure.recorded, false);
  assert.equal(duplicateFailure.reason, "final_delivery_already_delivered");
  assert.equal(duplicateAck.acknowledged, true);
  assert.equal(duplicateAck.duplicate, true);
  assert.equal(thread.runtime.finalDelivery.messageId, "assistant-final-canonical");
  assert.equal(thread.runtime.finalDelivery.status, "delivered");
  assert.equal(thread.runtime.finalDelivery.connectorMessageId, "wa-canonical");
  assert.deepEqual(thread.runtime.finalDelivery.supersededMessageIds, ["assistant-final-unix-seconds-duplicate"]);
});

test("runtime final delivery does not coalesce different turns in the same generation", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-runtime-generation-is-not-duplicate-"));
  const env = { ORKESTR_HOME: home };
  await createThread({
    id: "runtime-generation-is-not-duplicate-thread",
    name: "Runtime generation is not duplicate identity",
    executorId: "codex",
    executor: { type: "codex", codexThreadId: "runtime-shared-generation" },
    runtime: { runtimeGeneration: "runtime-shared-generation", activeTurnId: "turn-2" },
  }, env);

  await markRuntimeFinalDeliveryPending("runtime-generation-is-not-duplicate-thread", {
    messageId: "assistant-final-turn-1",
    parentMessageId: "user-message-1",
    runtimeGeneration: "runtime-shared-generation",
    turnId: "turn-1",
    connector: "whatsapp",
    chatId: "features@g.us",
    accountId: "sender",
  }, env);
  await acknowledgeRuntimeFinalDelivery("runtime-generation-is-not-duplicate-thread", {
    messageId: "assistant-final-turn-1",
    deliveredAt: "2026-08-10T09:47:30.000Z",
    outboxJobId: "outbox-turn-1",
    connectorMessageId: "wa-turn-1",
  }, env);

  const nextTurn = await markRuntimeFinalDeliveryPending("runtime-generation-is-not-duplicate-thread", {
    messageId: "assistant-final-turn-2",
    parentMessageId: "user-message-2",
    runtimeGeneration: "runtime-shared-generation",
    turnId: "turn-2",
    connector: "whatsapp",
    chatId: "features@g.us",
    accountId: "sender",
  }, env);
  const thread = await getThread("runtime-generation-is-not-duplicate-thread", env);

  assert.equal(nextTurn.pending, true);
  assert.equal(nextTurn.duplicate, undefined);
  assert.equal(thread.runtime.finalDelivery.messageId, "assistant-final-turn-2");
  assert.equal(thread.runtime.finalDelivery.status, "pending");
  assert.equal(thread.runtime.finalDelivery.turnId, "turn-2");
  assert.equal(thread.runtime.finalDelivery.parentMessageId, "user-message-2");
  assert.equal(thread.runtime.finalDelivery.connectorMessageId, undefined);
  assert.equal(thread.runtime.finalDelivery.supersededMessageIds, undefined);
});

test("an old final acknowledgement cannot complete a newer turn", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-runtime-old-final-ack-"));
  const env = { ORKESTR_HOME: home };
  await createThread({
    id: "runtime-old-final-ack-thread",
    name: "Runtime old final ack",
    executor: { type: "codex", codexThreadId: "runtime-shared-generation" },
    runtime: { runtimeGeneration: "runtime-shared-generation", activeTurnId: "turn-old" },
  }, env);
  await recordRuntimeLiveness("runtime-old-final-ack-thread", {
    runtimeGeneration: "runtime-shared-generation",
    executionId: "execution-old",
    turnId: "turn-old",
    evidenceType: "model_output",
  }, env);
  await markRuntimeFinalDeliveryPending("runtime-old-final-ack-thread", {
    messageId: "assistant-old",
    runtimeGeneration: "runtime-shared-generation",
    turnId: "turn-old",
    connector: "whatsapp",
  }, env);
  const beforeNewTurn = await getThread("runtime-old-final-ack-thread", env);
  await updateThread("runtime-old-final-ack-thread", {
    runtime: { ...beforeNewTurn.runtime, activeTurnId: "turn-new" },
  }, env);
  await recordRuntimeLiveness("runtime-old-final-ack-thread", {
    runtimeGeneration: "runtime-shared-generation",
    executionId: "execution-new",
    turnId: "turn-new",
    evidenceType: "model_started",
  }, env);

  const acknowledged = await acknowledgeRuntimeFinalDelivery("runtime-old-final-ack-thread", {
    messageId: "assistant-old",
  }, env);
  const thread = await getThread("runtime-old-final-ack-thread", env);

  assert.equal(acknowledged.acknowledged, true);
  assert.equal(thread.runtime.finalDelivery.status, "delivered");
  assert.equal(thread.runtime.liveness.turnId, "turn-new");
  assert.equal(thread.runtime.liveness.executionId, "execution-new");
  assert.equal(thread.runtime.liveness.completedAt, undefined);
});
