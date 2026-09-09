import { incrementCounter, observeHistogram } from "./observability.js";

const requestPaths = new Set(["native", "rollout"]);
const requestOutcomes = new Set(["pending", "answered", "suppressed", "expired"]);
const deliveryModes = new Set(["turn_start", "turn_steer", "deferred"]);
const deliveryOutcomes = new Set(["accepted", "queued", "rejected"]);
const deliveryLatencyBuckets = [0, 0.25, 0.5, 1, 2, 5, 10, 30, 60, 180, 300];

function enumValue(value, allowed, fallback = "unknown") {
  const normalized = String(value || "").trim().toLowerCase();
  return allowed.has(normalized) ? normalized : fallback;
}

export function recordCodexUserInputRequest({ path = "unknown", outcome = "unknown", amount = 1 } = {}) {
  incrementCounter("orkestr_codex_user_input_requests_total", {
    path: enumValue(path, requestPaths),
    outcome: enumValue(outcome, requestOutcomes),
  }, amount);
}

export function recordCodexInputDelivery({ mode = "unknown", outcome = "unknown", latencyMs = null } = {}) {
  const labels = {
    mode: enumValue(mode, deliveryModes),
    outcome: enumValue(outcome, deliveryOutcomes),
  };
  incrementCounter("orkestr_codex_input_delivery_total", labels);
  const numericLatency = Number(latencyMs);
  if (Number.isFinite(numericLatency)) {
    observeHistogram(
      "orkestr_codex_input_delivery_latency_seconds",
      Math.max(0, numericLatency) / 1000,
      labels,
      deliveryLatencyBuckets,
    );
  }
}
