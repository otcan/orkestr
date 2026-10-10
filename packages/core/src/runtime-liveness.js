import { appendEvent } from "../../storage/src/store.js";
import { getThread, updateThread } from "./threads.js";
import { currentCodexGenerationMatches, resolveCurrentCodexGeneration } from "./codex-generation.js";
import { injectRuntimeFault, runtimeNowIso, runtimeNowMs } from "./runtime-fault-injection.js";
import { recordRuntimeControlMetric } from "./observability.js";

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

function runtimeGeneration(thread = {}, input = {}) {
  return clean(
    input.runtimeGeneration ||
    input.codexThreadId ||
    resolveCurrentCodexGeneration(thread).id
  );
}

function currentRuntimeGeneration(thread = {}) {
  return clean(resolveCurrentCodexGeneration(thread).id);
}

function scopedToCurrentRuntime(thread = {}, input = {}) {
  const actual = clean(input.runtimeGeneration || input.codexThreadId);
  const resolution = resolveCurrentCodexGeneration(thread);
  if (resolution.ambiguous) return false;
  // Liveness also covers connector-only threads. With no known Codex
  // generation there is no basis for declaring an incoming delivery update
  // stale; begin enforcing as soon as the thread is bound to Codex.
  if (!resolution.id) return true;
  return !actual || currentCodexGenerationMatches(thread, actual).ok;
}

async function recordGenerationRejection(thread, input, operation, env = process.env) {
  const resolution = resolveCurrentCodexGeneration(thread);
  await appendEvent({
    type: "runtime_liveness_generation_rejected",
    operation,
    threadId: thread.id,
    expectedRuntimeGeneration: resolution.id || null,
    observedRuntimeGeneration: clean(input.runtimeGeneration || input.codexThreadId) || null,
    reason: resolution.ambiguous ? resolution.reason : "superseded_or_missing_runtime_generation",
    candidateSources: Object.keys(resolution.candidates || {}),
  }, env).catch(() => {});
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

// Write only the fields this module owns onto the latest runtime, under the
// thread store lock, so concurrent lifecycle updates are not overwritten.
function mergeRuntimeFields(threadId, fields, env) {
  return updateThread(threadId, (latest) => ({ runtime: { ...(latest.runtime || {}), ...fields } }), env);
}

// Derive the next liveness from the latest record under the store lock, so
// concurrent liveness writers (evidence, probe failures, completion) build on
// each other instead of on a stale read. `build(thread, runtime, liveness)`
// returns { fields, result } to write, or { result } alone to skip.
async function updateLivenessLocked(thread, build, env) {
  let outcome = null;
  const updated = await updateThread(thread.id, (latest) => {
    const runtime = latest.runtime && typeof latest.runtime === "object" ? latest.runtime : {};
    const current = runtime.liveness && typeof runtime.liveness === "object" ? runtime.liveness : {};
    outcome = build(latest, runtime, current);
    return outcome?.fields ? { runtime: { ...runtime, ...outcome.fields } } : null;
  }, env);
  return { updated, ...(outcome || {}) };
}

function evidenceLiveness(thread, runtime, current, input, { evidenceType, at, counters }) {
  if (!scopedToCurrentRuntime(thread, input)) return { result: { ok: false, recorded: false, reason: "stale_runtime_generation", rejected: true } };
  const generation = runtimeGeneration(thread, input);
  const turnId = clean(input.turnId || runtime.activeTurnId || current.turnId);
  const activeTurnId = clean(runtime.activeTurnId);
  if (activeTurnId && turnId && activeTurnId !== turnId) {
    return { result: { ok: false, recorded: false, reason: "stale_turn" } };
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
    counters: counters || current.counters || null,
    consecutiveProbeFailures: 0,
    lastProbeFailureAt: null,
    lastProbeFailureReason: null,
    completedAt: sameExecution ? current.completedAt : undefined,
    completionStatus: sameExecution ? current.completionStatus : undefined,
    updatedAt: at,
  };
  return {
    fields: { runtimeGeneration: generation || runtime.runtimeGeneration || null, liveness },
    result: { ok: true, recorded: true, liveness },
  };
}

function probeFailureLiveness(thread, runtime, current, input, { at }) {
  if (!scopedToCurrentRuntime(thread, input)) return { result: { ok: false, lost: false, reason: "stale_runtime_generation", rejected: true } };
  const turnId = clean(input.turnId || runtime.activeTurnId || current.turnId);
  if (current.turnId && turnId && clean(current.turnId) !== turnId) {
    return { result: { ok: false, lost: false, reason: "stale_turn" } };
  }
  const failures = Math.max(0, Number(current.consecutiveProbeFailures) || 0) + 1;
  const liveness = {
    ...current,
    runtimeGeneration: runtimeGeneration(thread, input) || current.runtimeGeneration || null,
    turnId: turnId || current.turnId || null,
    consecutiveProbeFailures: failures,
    lastProbeFailureAt: at,
    lastProbeFailureReason: clean(input.reason || "runtime_probe_failed").slice(0, 500),
    updatedAt: at,
  };
  return { fields: { liveness }, result: { ok: true, failures, liveness } };
}

function completedLiveness(thread, runtime, current, input, { at }) {
  if (!scopedToCurrentRuntime(thread, input)) return { result: { ok: false, completed: false, reason: "stale_runtime_generation", rejected: true } };
  const turnId = clean(input.turnId || current.turnId);
  if (current.turnId && turnId && clean(current.turnId) !== turnId) {
    return { result: { ok: false, completed: false, reason: "stale_turn" } };
  }
  const liveness = {
    ...current,
    phase: clean(input.phase || "complete"),
    completedAt: at,
    completionStatus: clean(input.status || "completed"),
    summary: clean(input.summary).slice(0, 1000) || current.summary || "",
    consecutiveProbeFailures: 0,
    updatedAt: at,
  };
  return { fields: { liveness }, result: { ok: true, liveness } };
}

export async function recordRuntimeLiveness(threadId, input = {}, env = process.env) {
  const thread = await getThread(threadId, env);
  if (!thread) return { ok: false, recorded: false, reason: "thread_not_found" };
  const evidenceType = clean(input.evidenceType || "runtime_probe").toLowerCase();
  if (!EVIDENCE_TYPES.has(evidenceType)) {
    const error = new Error("runtime_liveness_evidence_invalid");
    error.statusCode = 400;
    throw error;
  }
  const at = clean(input.at) || runtimeNowIso(env);
  const counters = boundedObject(input.counters, 4096);
  const { updated, result } = await updateLivenessLocked(thread, (latest, runtime, current) =>
    evidenceLiveness(latest, runtime, current, input, { evidenceType, at, counters }), env);
  if (result.rejected) {
    await recordGenerationRejection(updated, input, "record", env);
    return { ok: false, recorded: false, reason: result.reason };
  }
  if (!result.ok) return result;
  const liveness = updated.runtime?.liveness || result.liveness;
  await appendEvent({
    type: "runtime_liveness_recorded",
    threadId: thread.id,
    runtimeGeneration: liveness.runtimeGeneration || null,
    executionId: liveness.executionId || null,
    turnId: liveness.turnId || null,
    evidenceType,
    phase: liveness.phase,
  }, env).catch(() => {});
  return { ok: true, recorded: true, liveness, thread: updated };
}

export async function recordRuntimeLivenessProbeFailure(threadId, input = {}, env = process.env) {
  const thread = await getThread(threadId, env);
  if (!thread) return { ok: false, lost: false, reason: "thread_not_found" };
  const at = runtimeNowIso(env);
  const { updated, result } = await updateLivenessLocked(thread, (latest, runtime, current) =>
    probeFailureLiveness(latest, runtime, current, input, { at }), env);
  if (result.rejected) {
    await recordGenerationRejection(updated, input, "probe_failure", env);
    return { ok: false, lost: false, reason: result.reason };
  }
  if (!result.ok) return result;
  const { failures } = result;
  const liveness = updated.runtime?.liveness || result.liveness;
  await appendEvent({
    type: "runtime_liveness_probe_failed",
    threadId: thread.id,
    runtimeGeneration: liveness.runtimeGeneration,
    turnId: liveness.turnId,
    failures,
    lost: failures >= 2,
    reason: liveness.lastProbeFailureReason,
  }, env).catch(() => {});
  return { ok: true, lost: failures >= 2, failures, liveness, thread: updated };
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
  const at = runtimeNowIso(env);
  const checkpoint = {
    version: 1,
    checkpointId: clean(input.checkpointId) || `${clean(liveness.liveness?.executionId || thread.id)}:${runtimeNowMs(env)}`,
    runtimeGeneration: clean(liveness.liveness?.runtimeGeneration) || null,
    executionId: clean(liveness.liveness?.executionId) || null,
    turnId: clean(liveness.liveness?.turnId) || null,
    phase: clean(input.phase) || liveness.liveness?.phase || "checkpointed",
    summary: clean(input.summary).slice(0, 2000),
    payload,
    createdAt: at,
    updatedAt: at,
  };
  await injectRuntimeFault("checkpoint_persistence", {
    threadId: thread.id,
    checkpointId: checkpoint.checkpointId,
    runtimeGeneration: checkpoint.runtimeGeneration,
    turnId: checkpoint.turnId,
  }, env);
  const updated = await mergeRuntimeFields(thread.id, { checkpoint }, env);
  recordRuntimeControlMetric({ signal: "checkpoint_resume", outcome: "accepted" });
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
  const at = runtimeNowIso(env);
  const { updated, result } = await updateLivenessLocked(thread, (latest, runtime, current) =>
    completedLiveness(latest, runtime, current, input, { at }), env);
  if (result.rejected) {
    await recordGenerationRejection(updated, input, "complete", env);
    return { ok: false, completed: false, reason: result.reason };
  }
  if (!result.ok) return result;
  const liveness = updated.runtime?.liveness || result.liveness;
  await appendEvent({
    type: "runtime_liveness_completed",
    threadId: thread.id,
    runtimeGeneration: liveness.runtimeGeneration || null,
    executionId: liveness.executionId || null,
    turnId: liveness.turnId || null,
    status: liveness.completionStatus,
  }, env).catch(() => {});
  return { ok: true, completed: true, liveness, thread: updated };
}
