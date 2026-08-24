const RUNTIME_FAULT_BOUNDARIES = new Set([
  "message_persistence",
  "steering_submission",
  "runtime_acceptance",
  "tool_mcp_execution",
  "checkpoint_persistence",
  "final_persistence",
  "transport_send",
  "delivery_acknowledgement",
]);

function configuredInjector(env = process.env) {
  const injector = env?.ORKESTR_TEST_RUNTIME_FAULT_INJECTOR;
  return injector && (typeof injector === "function" || typeof injector === "object")
    ? injector
    : null;
}

export function runtimeFaultBoundaries() {
  return [...RUNTIME_FAULT_BOUNDARIES];
}

export async function injectRuntimeFault(boundary, context = {}, env = process.env) {
  if (!RUNTIME_FAULT_BOUNDARIES.has(boundary)) {
    const error = new Error("runtime_fault_boundary_invalid");
    error.code = "runtime_fault_boundary_invalid";
    throw error;
  }
  const injector = configuredInjector(env);
  if (!injector) return { injected: false, boundary };
  const hook = typeof injector === "function" ? injector : injector[boundary];
  if (typeof hook !== "function") return { injected: false, boundary };
  try {
    await hook({ boundary, ...context });
  } catch (error) {
    if (error && typeof error === "object") error.runtimeFaultBoundary = boundary;
    throw error;
  }
  return { injected: true, boundary };
}

export function runtimeNowMs(env = process.env) {
  const clock = env?.ORKESTR_TEST_RUNTIME_CLOCK;
  const value = typeof clock === "function"
    ? clock()
    : typeof clock?.now === "function"
      ? clock.now()
      : clock?.nowMs;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Date.now();
}

export function runtimeNowIso(env = process.env) {
  return new Date(runtimeNowMs(env)).toISOString();
}

export function runtimeStopPhaseFor(thread = {}) {
  const phase = String(thread?.runtime?.liveness?.phase || "").trim().toLowerCase();
  if (phase.includes("approval")) return "approval";
  if (phase.includes("mcp")) return "mcp";
  if (phase.includes("tool")) return "tool";
  if (phase.includes("child")) return "child_process";
  if (phase.includes("final") || phase.includes("deliver")) return "finalization";
  if (phase.includes("model") || phase.includes("execut")) return "model";
  return "unknown";
}
