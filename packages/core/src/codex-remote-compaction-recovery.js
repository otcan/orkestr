import { incrementCounter } from "./observability.js";

export const codexRemoteCompactionFailureClass = "codex_remote_compaction_404";
export const codexRemoteCompactionEndpointCategory = "codex_responses_compact";
export const codexRemoteCompactionRecoveryPolicy = "safe_reset_once_no_automatic_turn_replay";

function clean(value) {
  return String(value || "").trim();
}

function numericStatus(error = null, text = "") {
  const candidates = [
    error?.status,
    error?.statusCode,
    error?.httpStatus,
    error?.response?.status,
  ];
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  }
  const match = clean(text).match(/(?:unexpected\s+status|status(?:\s+code)?)[\s:=]+(\d{3})\b|\b(\d{3})\s+Not Found\b/i);
  return Number(match?.[1] || match?.[2] || 0) || 0;
}

function errorText(error = null) {
  if (!error) return "";
  if (typeof error === "string") return clean(error);
  return clean(error.message || error.stderr || error.stdout || error.detail || String(error));
}

export function classifyCodexRemoteCompactionFailure(error = null, context = {}) {
  const text = errorText(error);
  const remoteCompaction = /remote\s+compact(?:ion)?\s+task|\/codex\/responses\/compact\b|\/responses\/compact\b/i.test(text);
  const upstreamStatus = numericStatus(error, text);
  if (!remoteCompaction || upstreamStatus !== 404) return null;
  return {
    classification: codexRemoteCompactionFailureClass,
    upstreamStatus,
    endpointCategory: codexRemoteCompactionEndpointCategory,
    runtimeGeneration: clean(context.runtimeGeneration),
    turnId: clean(context.turnId),
    observedAt: clean(context.observedAt) || new Date().toISOString(),
    recoveryPolicy: codexRemoteCompactionRecoveryPolicy,
    automaticRecoveryLimit: 1,
    automaticTurnReplay: false,
    operatorRetryRequired: true,
  };
}

export function remoteCompactionFailureForTurn(failure = null, context = {}) {
  if (clean(failure?.classification) !== codexRemoteCompactionFailureClass) return null;
  const generation = clean(context.runtimeGeneration);
  const turnId = clean(context.turnId);
  if (generation && clean(failure.runtimeGeneration) !== generation) return null;
  if (turnId && clean(failure.turnId) !== turnId) return null;
  return failure;
}

export function remoteCompactionRecoveryAttempted(thread = {}, failure = null) {
  if (!failure) return false;
  const recovery = thread?.runtime?.remoteCompactionRecovery || {};
  return clean(recovery.classification) === codexRemoteCompactionFailureClass &&
    clean(recovery.runtimeGeneration) === clean(failure.runtimeGeneration) &&
    clean(recovery.turnId) === clean(failure.turnId) &&
    Number(recovery.attemptCount || 0) >= 1;
}

export function remoteCompactionRecoveryAttempt(failure = null, input = {}) {
  if (!failure) return null;
  return {
    classification: codexRemoteCompactionFailureClass,
    upstreamStatus: 404,
    endpointCategory: codexRemoteCompactionEndpointCategory,
    runtimeGeneration: clean(failure.runtimeGeneration),
    turnId: clean(failure.turnId),
    attemptCount: 1,
    attemptedAt: clean(input.attemptedAt) || new Date().toISOString(),
    status: clean(input.status) || "resetting",
    automaticTurnReplay: false,
    operatorRetryRequired: true,
    error: clean(input.error) || null,
    newRuntimeGeneration: clean(input.newRuntimeGeneration) || null,
  };
}

export function recordCodexRemoteCompactionRecovery(outcome = "unknown") {
  incrementCounter("orkestr_codex_remote_compaction_recovery_total", {
    outcome: clean(outcome).toLowerCase().replace(/[^a-z0-9_.-]+/g, "_").slice(0, 80) || "unknown",
  });
}
