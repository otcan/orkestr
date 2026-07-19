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
import { createThread, getThread, updateThread } from "../packages/core/src/threads.js";

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
