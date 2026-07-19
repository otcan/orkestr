import { appendEvent } from "../../storage/src/store.js";
import { getThread, updateThread } from "./threads.js";

const EVIDENCE_TYPES = new Set([
  "model_started",
  "model_output",
  "tool_started",
  "tool_completed",
  "mcp_progress",
  "child_heartbeat",
  "output_growth",
  "desktop_heartbeat",
  "approval_pending",
  "user_input_pending",
  "checkpoint",
  "runtime_probe",
]);

const TRANSPORT_ONLY_EVIDENCE_TYPES = new Set([
  "model_started",
  "runtime_probe",
]);

function clean(value) {
  return String(value || "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function runtimeGeneration(thread = {}, input = {}) {
  return clean(
    input.runtimeGeneration ||
    input.codexThreadId ||
    thread?.executor?.codexThreadId ||
    thread?.codexThreadId ||
    thread?.runtime?.runtimeGeneration
  );
}

function currentRuntimeGeneration(thread = {}) {
  return clean(thread?.executor?.codexThreadId || thread?.codexThreadId || thread?.runtime?.runtimeGeneration);
}

function scopedToCurrentRuntime(thread = {}, input = {}) {
  const expected = currentRuntimeGeneration(thread);
  const actual = runtimeGeneration(thread, input);
  return !expected || !actual || expected === actual;
}

function boundedObject(value, maxBytes = 16_384) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) {
    const error = new Error("runtime_checkpoint_payload_too_large");
    error.statusCode = 400;
    throw error;
  }
  return JSON.parse(serialized);
}

export async function recordRuntimeLiveness(threadId, input = {}, env = process.env) {
  const thread = await getThread(threadId, env);
  if (!thread) return { ok: false, recorded: false, reason: "thread_not_found" };
  if (!scopedToCurrentRuntime(thread, input)) {
    await appendEvent({
      type: "runtime_liveness_stale_generation_rejected",
      threadId: thread.id,
      expectedRuntimeGeneration: currentRuntimeGeneration(thread) || null,
      runtimeGeneration: runtimeGeneration(thread, input) || null,
      turnId: clean(input.turnId) || null,
    }, env).catch(() => {});
    return { ok: false, recorded: false, reason: "stale_runtime_generation" };
  }
  const evidenceType = clean(input.evidenceType || "runtime_probe").toLowerCase();
  if (!EVIDENCE_TYPES.has(evidenceType)) {
    const error = new Error("runtime_liveness_evidence_invalid");
    error.statusCode = 400;
    throw error;
  }
  const at = clean(input.at) || nowIso();
  const runtime = thread.runtime && typeof thread.runtime === "object" ? thread.runtime : {};
  const current = runtime.liveness && typeof runtime.liveness === "object" ? runtime.liveness : {};
  const generation = runtimeGeneration(thread, input);
  const turnId = clean(input.turnId || runtime.activeTurnId || current.turnId);
  const activeTurnId = clean(runtime.activeTurnId);
  if (activeTurnId && turnId && activeTurnId !== turnId) {
    return { ok: false, recorded: false, reason: "stale_turn" };
  }
  const executionId = clean(input.executionId || turnId || current.executionId || generation);
  const sameExecution = Boolean(current.executionId && executionId && current.executionId === executionId && clean(current.runtimeGeneration) === generation);
  const semanticEvidence = !TRANSPORT_ONLY_EVIDENCE_TYPES.has(evidenceType);
  const runtimeProbe = evidenceType === "runtime_probe";
  const liveness = {
    ...current,
    executionId: executionId || null,
    runtimeGeneration: generation || null,
    turnId: turnId || null,
    startedAt: sameExecution ? current.startedAt || at : clean(input.startedAt) || at,
    lastEvidenceAt: at,
    lastEvidenceType: evidenceType,
    lastSemanticEvidenceAt: semanticEvidence
      ? at
      : sameExecution
        ? current.lastSemanticEvidenceAt || null
        : null,
    lastSemanticEvidenceType: semanticEvidence
      ? evidenceType
      : sameExecution
        ? current.lastSemanticEvidenceType || null
        : null,
    lastProbeAt: runtimeProbe
      ? at
      : sameExecution
        ? current.lastProbeAt || null
        : null,
    phase: clean(input.phase) || current.phase || "executing",
    summary: clean(input.summary).slice(0, 1000) || current.summary || "",
    counters: boundedObject(input.counters, 4096) || current.counters || null,
    consecutiveProbeFailures: 0,
    lastProbeFailureAt: null,
    lastProbeFailureReason: null,
    completedAt: sameExecution ? current.completedAt : undefined,
    completionStatus: sameExecution ? current.completionStatus : undefined,
    updatedAt: at,
  };
  const updated = await updateThread(thread.id, {
    runtime: {
      ...runtime,
      runtimeGeneration: generation || runtime.runtimeGeneration || null,
      liveness,
    },
  }, env);
  await appendEvent({
    type: "runtime_liveness_recorded",
    threadId: thread.id,
    runtimeGeneration: generation || null,
    executionId: executionId || null,
    turnId: turnId || null,
    evidenceType,
    phase: liveness.phase,
  }, env).catch(() => {});
  return { ok: true, recorded: true, liveness: updated.runtime?.liveness || liveness, thread: updated };
}

export async function recordRuntimeLivenessProbeFailure(threadId, input = {}, env = process.env) {
  const thread = await getThread(threadId, env);
  if (!thread) return { ok: false, lost: false, reason: "thread_not_found" };
  if (!scopedToCurrentRuntime(thread, input)) return { ok: false, lost: false, reason: "stale_runtime_generation" };
  const runtime = thread.runtime && typeof thread.runtime === "object" ? thread.runtime : {};
  const current = runtime.liveness && typeof runtime.liveness === "object" ? runtime.liveness : {};
  const turnId = clean(input.turnId || runtime.activeTurnId || current.turnId);
  if (current.turnId && turnId && clean(current.turnId) !== turnId) {
    return { ok: false, lost: false, reason: "stale_turn" };
  }
  const failures = Math.max(0, Number(current.consecutiveProbeFailures) || 0) + 1;
  const at = nowIso();
  const liveness = {
    ...current,
    runtimeGeneration: runtimeGeneration(thread, input) || current.runtimeGeneration || null,
    turnId: turnId || current.turnId || null,
    consecutiveProbeFailures: failures,
    lastProbeFailureAt: at,
    lastProbeFailureReason: clean(input.reason || "runtime_probe_failed").slice(0, 500),
    updatedAt: at,
  };
  const updated = await updateThread(thread.id, { runtime: { ...runtime, liveness } }, env);
  await appendEvent({
    type: "runtime_liveness_probe_failed",
    threadId: thread.id,
    runtimeGeneration: liveness.runtimeGeneration,
    turnId: liveness.turnId,
    failures,
    lost: failures >= 2,
    reason: liveness.lastProbeFailureReason,
  }, env).catch(() => {});
  return { ok: true, lost: failures >= 2, failures, liveness: updated.runtime?.liveness || liveness, thread: updated };
}

export async function saveRuntimeCheckpoint(threadId, input = {}, env = process.env) {
  const payload = boundedObject(input.payload || {}, 64 * 1024) || {};
  const liveness = await recordRuntimeLiveness(threadId, {
    ...input,
    evidenceType: "checkpoint",
    phase: clean(input.phase) || "checkpointed",
  }, env);
  if (!liveness.ok) return liveness;
  const thread = liveness.thread;
  const at = nowIso();
  const checkpoint = {
    version: 1,
    checkpointId: clean(input.checkpointId) || `${clean(liveness.liveness?.executionId || thread.id)}:${Date.now()}`,
    runtimeGeneration: clean(liveness.liveness?.runtimeGeneration) || null,
    executionId: clean(liveness.liveness?.executionId) || null,
    turnId: clean(liveness.liveness?.turnId) || null,
    phase: clean(input.phase) || liveness.liveness?.phase || "checkpointed",
    summary: clean(input.summary).slice(0, 2000),
    payload,
    createdAt: at,
    updatedAt: at,
  };
  const updated = await updateThread(thread.id, {
    runtime: {
      ...(thread.runtime || {}),
      checkpoint,
    },
  }, env);
  await appendEvent({
    type: "runtime_checkpoint_saved",
    threadId: thread.id,
    checkpointId: checkpoint.checkpointId,
    runtimeGeneration: checkpoint.runtimeGeneration,
    executionId: checkpoint.executionId,
    turnId: checkpoint.turnId,
  }, env).catch(() => {});
  return { ok: true, saved: true, checkpoint: updated.runtime?.checkpoint || checkpoint, liveness: updated.runtime?.liveness || liveness.liveness };
}

export async function completeRuntimeLiveness(threadId, input = {}, env = process.env) {
  const thread = await getThread(threadId, env);
  if (!thread) return { ok: false, completed: false, reason: "thread_not_found" };
  if (!scopedToCurrentRuntime(thread, input)) return { ok: false, completed: false, reason: "stale_runtime_generation" };
  const runtime = thread.runtime && typeof thread.runtime === "object" ? thread.runtime : {};
  const current = runtime.liveness && typeof runtime.liveness === "object" ? runtime.liveness : {};
  const turnId = clean(input.turnId || current.turnId);
  if (current.turnId && turnId && clean(current.turnId) !== turnId) {
    return { ok: false, completed: false, reason: "stale_turn" };
  }
  const at = nowIso();
  const liveness = {
    ...current,
    phase: clean(input.phase || "complete"),
    completedAt: at,
    completionStatus: clean(input.status || "completed"),
    summary: clean(input.summary).slice(0, 1000) || current.summary || "",
    consecutiveProbeFailures: 0,
    updatedAt: at,
  };
  const updated = await updateThread(thread.id, { runtime: { ...runtime, liveness } }, env);
  await appendEvent({
    type: "runtime_liveness_completed",
    threadId: thread.id,
    runtimeGeneration: liveness.runtimeGeneration || null,
    executionId: liveness.executionId || null,
    turnId: liveness.turnId || null,
    status: liveness.completionStatus,
  }, env).catch(() => {});
  return { ok: true, completed: true, liveness: updated.runtime?.liveness || liveness, thread: updated };
}
