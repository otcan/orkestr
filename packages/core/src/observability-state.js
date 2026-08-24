const pendingInputStates = new Set(["queued", "pending_delivery", "awaiting_ack", "running"]);
const runtimeFinalDeliveryStates = new Set(["pending", "failed_retryable", "delivery_uncertain", "failed", "dead_letter", "suppressed", "skipped"]);

function clean(value = "") {
  return String(value || "").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

function labelValue(value = "", fallback = "unknown") {
  const normalized = lower(value)
    .replace(/[^a-z0-9_.:-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return normalized || fallback;
}

function enumLabel(value = "", allowed = new Set(), fallback = "unknown") {
  const normalized = lower(value);
  return allowed.has(normalized) ? normalized : fallback;
}

function safeLabels(labels = {}) {
  const result = {};
  for (const [key, value] of Object.entries(labels || {})) {
    const name = clean(key).replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 80);
    if (name) result[name] = clean(value).slice(0, 160);
  }
  return result;
}

function threadKindLabel(thread = {}) {
  if (clean(thread.threadKind) === "task-agent" || clean(thread.agentTaskId)) return "task_agent";
  if (clean(thread.parentThreadId)) return "worker";
  return "thread";
}

function labelText(labels = {}) {
  const entries = Object.entries(safeLabels(labels));
  if (!entries.length) return "";
  const escape = (value) => clean(value).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
  return `{${entries.map(([key, value]) => `${key}="${escape(value)}"`).join(",")}}`;
}

function formatNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? String(Math.round(numeric * 1000000) / 1000000) : "0";
}

function renderGaugeSeries(lines, name, help, series) {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} gauge`);
  if (!series.size) {
    lines.push(`${name} 0`);
    return;
  }
  const items = [...series.values()].sort((left, right) => JSON.stringify(left.labels).localeCompare(JSON.stringify(right.labels)));
  for (const item of items) lines.push(`${name}${labelText(item.labels)} ${formatNumber(item.value)}`);
}

function renderGauge(lines, name, help, value) {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} gauge`);
  lines.push(`${name} ${formatNumber(value)}`);
}

export async function collectStateMetricLines(env = process.env) {
  if (env.ORKESTR_METRICS_STATE_ENABLED === "0") return [];
  const maxThreads = Math.max(0, Math.min(1000, Math.floor(Number(env.ORKESTR_METRICS_MAX_THREADS || 250) || 250)));
  const includeQueues = env.ORKESTR_METRICS_QUEUE_STATE_ENABLED !== "0";
  const { listThreads, listThreadMessageCandidates } = await import("./threads.js");
  const threads = (await listThreads(env)).slice(0, maxThreads || 0);
  const lines = [];
  const threadCounts = new Map();
  const runtimeCounts = new Map();
  const taskAgentCounts = new Map();
  const pendingCounts = new Map();
  const pendingFinalCounts = new Map();
  const unresolvedSteeringCounts = new Map();
  let resumableCheckpoints = 0;
  const add = (map, labels, amount = 1) => {
    const normalized = safeLabels(labels);
    const key = JSON.stringify(normalized);
    const current = map.get(key) || { labels: normalized, value: 0 };
    current.value += amount;
    map.set(key, current);
  };

  for (const thread of threads) {
    const kind = threadKindLabel(thread);
    const state = labelValue(thread.state || "unknown");
    add(threadCounts, { kind, state });
    add(runtimeCounts, { kind, state: labelValue(thread.runtime?.state || thread.state || "unknown") });
    const finalDeliveryStatus = lower(thread.runtime?.finalDelivery?.status);
    if (finalDeliveryStatus && finalDeliveryStatus !== "delivered") {
      add(pendingFinalCounts, { state: enumLabel(finalDeliveryStatus, runtimeFinalDeliveryStates) });
    }
    if (thread.runtime?.checkpoint?.checkpointId) resumableCheckpoints += 1;
    if (kind === "task_agent") add(taskAgentCounts, { status: labelValue(thread.agentTaskStatus || thread.state || "unknown") });
    if (!includeQueues) continue;
    const candidates = await listThreadMessageCandidates(thread.id, {
      states: [...pendingInputStates],
      tailLimit: Math.max(10, Math.min(1000, Math.floor(Number(env.ORKESTR_METRICS_QUEUE_TAIL_LIMIT || 500) || 500))),
    }, env).catch(() => []);
    for (const message of candidates) {
      if (String(message?.role || "") !== "user" || !pendingInputStates.has(String(message?.state || ""))) continue;
      add(pendingCounts, {
        state: labelValue(message.state),
        delivery_state: labelValue(message.deliveryState || message.state),
        connector: labelValue(message.connector || message.originSurface || "direct"),
      });
      if (["awaiting_active_turn", "codex_app_server_sending", "operator_required"].includes(lower(message.deliveryState))) {
        add(unresolvedSteeringCounts, { state: labelValue(message.deliveryState) });
      }
    }
  }

  renderGaugeSeries(lines, "orkestr_threads_current", "Current Orkestr threads by public kind and state.", threadCounts);
  renderGaugeSeries(lines, "orkestr_runtime_threads_current", "Current Orkestr runtime threads by public kind and runtime state.", runtimeCounts);
  renderGaugeSeries(lines, "orkestr_task_agents_current", "Current task-agent threads by task status.", taskAgentCounts);
  renderGaugeSeries(lines, "orkestr_thread_pending_inputs_current", "Current pending user inputs by state, delivery state, and connector.", pendingCounts);
  renderGaugeSeries(lines, "orkestr_runtime_pending_final_deliveries_current", "Current runtime finals awaiting a terminal connector acknowledgement.", pendingFinalCounts);
  renderGaugeSeries(lines, "orkestr_runtime_unresolved_steering_inputs_current", "Current accepted steering inputs without a terminal runtime disposition.", unresolvedSteeringCounts);
  renderGauge(lines, "orkestr_runtime_resumable_checkpoints_current", "Current durable runtime checkpoints available for scoped resume.", resumableCheckpoints);
  renderGauge(lines, "orkestr_metrics_threads_scanned", "Number of Orkestr threads scanned while rendering this metrics response.", threads.length);
  return lines;
}
