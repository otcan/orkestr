const terminalPhases = new Set(["skipped", "completed"]);

function clean(value = "") {
  return String(value || "").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

function stuckThresholdMs(env = process.env) {
  const parsed = Number(env.ORKESTR_ROUTER_TRACE_STUCK_MS || 10 * 60 * 1000);
  return Math.max(30_000, Number.isFinite(parsed) ? Math.floor(parsed) : 10 * 60 * 1000);
}

export function diagnoseRouterTrace(trace = {}, env = process.env) {
  const updatedMs = Date.parse(clean(trace.updatedAt));
  const ageMs = Number.isFinite(updatedMs) ? Date.now() - updatedMs : 0;
  const currentPhase = lower(trace.currentPhase);
  const terminal = trace.terminal === true || terminalPhases.has(currentPhase);
  const stuck = !terminal && ageMs >= stuckThresholdMs(env) && [
    "queued",
    "delivery_started",
    "delivered_to_runtime",
    "mirror_claimed",
    "mirror_failed",
    "runtime_failed",
    "stuck",
  ].includes(currentPhase);
  let recovery = "No recovery needed.";
  if (stuck && ["queued", "delivery_started"].includes(currentPhase)) {
    recovery = "Check the assigned runtime and wake or retry the delivery queue; do not duplicate the inbound message.";
  } else if (stuck && currentPhase === "delivered_to_runtime") {
    recovery = "Inspect runtime output and assistant message import before retrying; the user input may already be visible to the runtime.";
  } else if (stuck && ["mirror_claimed", "mirror_failed"].includes(currentPhase)) {
    recovery = "Check connector status and retry the durable outbox item for this turn.";
  } else if (stuck && currentPhase === "runtime_failed") {
    recovery = "Repair or restart the runtime, then explicitly retry the queued turn if the user still expects a reply.";
  }
  return {
    stuck,
    ageMs,
    terminal,
    currentPhase,
    recovery,
    lastError: clean(trace.lastError),
    failureCode: clean(trace.failureCode),
    classification: clean(trace.classification),
    effectiveRole: clean(trace.effectiveRole),
    policyRevision: clean(trace.policyRevision),
    bindingRevision: clean(trace.bindingRevision),
    retryable: trace.retryable === undefined || trace.retryable === null ? null : trace.retryable === true,
    remediation: clean(trace.remediation),
  };
}
