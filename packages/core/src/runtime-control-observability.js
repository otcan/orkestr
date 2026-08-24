import { incrementCounter, observeHistogram } from "./observability.js";

const runtimeControlSignals = new Set([
  "false_recovery",
  "unresolved_steering_input",
  "duplicate_turn",
  "checkpoint_resume",
  "pending_final_delivery",
  "runtime_acceptance",
  "stop_latency",
  "transport_send",
  "delivery_acknowledgement",
]);
const runtimeControlOutcomes = new Set([
  "accepted",
  "avoided",
  "blocked",
  "completed",
  "delivered",
  "detected",
  "failed",
  "pending",
  "prevented",
  "resumed",
  "retryable",
]);
const runtimeStopPhases = new Set(["model", "tool", "mcp", "child_process", "approval", "finalization", "unknown"]);
const runtimeStopLatencyBuckets = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30];

function clean(value = "") {
  return String(value || "").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

function enumLabel(value = "", allowed = new Set(), fallback = "unknown") {
  const normalized = lower(value);
  return allowed.has(normalized) ? normalized : fallback;
}

function countValue(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
}

export function recordRuntimeControlMetric({ signal = "unknown", outcome = "unknown", phase = "unknown", durationMs = null } = {}) {
  const normalizedSignal = enumLabel(signal, runtimeControlSignals);
  const normalizedOutcome = enumLabel(outcome, runtimeControlOutcomes);
  incrementCounter("orkestr_runtime_control_events_total", {
    signal: normalizedSignal,
    outcome: normalizedOutcome,
  });
  if (signal === "stop_latency" || durationMs != null) {
    observeHistogram(
      "orkestr_runtime_stop_latency_seconds",
      countValue(durationMs) / 1000,
      { phase: enumLabel(phase, runtimeStopPhases), result: normalizedOutcome },
      runtimeStopLatencyBuckets,
    );
  }
}

export function evaluateRuntimeControlReleaseGate(input = {}, env = process.env) {
  const stopLatencyTargetMs = Math.max(1, Number(env.ORKESTR_RUNTIME_STOP_LATENCY_GATE_MS || 5_000) || 5_000);
  const checks = [
    { signal: "false_recovery", actual: countValue(input.falseRecoveries), limit: 0 },
    { signal: "unresolved_steering_input", actual: countValue(input.unresolvedSteeringInputs), limit: 0 },
    { signal: "duplicate_turn", actual: countValue(input.duplicateTurns), limit: 0 },
    { signal: "stop_latency_ms", actual: countValue(input.maxStopLatencyMs), limit: stopLatencyTargetMs },
    { signal: "checkpoint_resume_failure", actual: countValue(input.checkpointResumeFailures), limit: 0 },
    { signal: "pending_final_delivery", actual: countValue(input.pendingFinalDeliveries), limit: 0 },
  ].map((check) => ({ ...check, ok: check.actual <= check.limit }));
  return { ok: checks.every((check) => check.ok), checks };
}
