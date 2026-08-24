import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

const httpDurationBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
const httpResponseSizeBuckets = [100, 500, 1000, 5000, 10000, 50000, 100000, 500000, 1000000, 5000000];
const backgroundDurationBuckets = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120];
const pendingInputStates = new Set(["queued", "pending_delivery", "awaiting_ack", "running"]);
const threadResourceTypes = new Set(["desktop", "oxrm", "mailbox"]);
const threadResourcePermissions = new Set(["discover", "acquire", "operate", "share", "read", "write", "execute", "subscribe", "process", "manage"]);
const threadResourceModes = new Set(["off", "shadow", "enforce"]);
const threadResourceInvalidationSubjects = new Set(["resource", "session_share", "share", "listener"]);
const threadResourceInvalidationReasons = new Set(["revoked", "generation_advanced", "grant_replaced", "listener_revoked", "policy_stale"]);
const mailboxDeliveryStates = new Set(["pending", "claimed", "delivered", "revoked", "quarantined", "dead-letter"]);
const mailboxRouteWorkStates = new Set(["pending", "claimed", "accepted", "running", "completed", "failed", "delivered", "dead-letter", "cancelled", "context_pending"]);
const breakGlassOutcomes = new Set(["allowed", "denied", "blocked"]);
const shadowBoundaryWarningOutcomes = new Set(["emitted", "deduplicated", "failed"]);
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
const runtimeFinalDeliveryStates = new Set(["pending", "failed_retryable", "delivery_uncertain", "failed", "dead_letter", "suppressed", "skipped"]);
const counters = new Map();
const histograms = new Map();
const startedAt = Date.now();

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

function countValue(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : 0;
}

function metricKey(name, labels = {}) {
  const entries = Object.entries(safeLabels(labels)).sort(([left], [right]) => left.localeCompare(right));
  return `${name}|${entries.map(([key, value]) => `${key}=${value}`).join(",")}`;
}

function safeLabels(labels = {}) {
  const result = {};
  for (const [key, value] of Object.entries(labels || {})) {
    const name = clean(key).replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 80);
    if (!name) continue;
    result[name] = clean(value).slice(0, 160);
  }
  return result;
}

export function resetObservabilityForTests() {
  counters.clear();
  histograms.clear();
}

export function incrementCounter(name, labels = {}, amount = 1) {
  const metric = clean(name);
  if (!metric) return;
  const key = metricKey(metric, labels);
  const current = counters.get(key) || { name: metric, labels: safeLabels(labels), value: 0 };
  current.value += Number.isFinite(Number(amount)) ? Number(amount) : 1;
  counters.set(key, current);
}

export function observeHistogram(name, value, labels = {}, buckets = httpDurationBuckets) {
  const metric = clean(name);
  const numeric = Number(value);
  if (!metric || !Number.isFinite(numeric)) return;
  const key = metricKey(metric, labels);
  const current = histograms.get(key) || {
    name: metric,
    labels: safeLabels(labels),
    buckets: [...buckets].sort((left, right) => left - right).map((le) => ({ le, count: 0 })),
    count: 0,
    sum: 0,
  };
  current.count += 1;
  current.sum += Math.max(0, numeric);
  for (const bucket of current.buckets) {
    if (numeric <= bucket.le) bucket.count += 1;
  }
  histograms.set(key, current);
}

export function requestIdFromHeaders(headers = {}) {
  return clean(headers["x-request-id"] || headers["x-correlation-id"]) || randomUUID();
}

export function routeTemplateFromUrl(rawUrl = "") {
  const pathname = clean(String(rawUrl || "").split("?")[0]) || "/";
  if (pathname === "/") return "/";
  const parts = pathname.split("/").filter(Boolean);
  const normalized = [];
  for (let index = 0; index < parts.length; index += 1) {
    const previous = lower(parts[index - 1]);
    const current = safeRouteSegment(parts[index]);
    if (previous === "threads") normalized.push(":threadId");
    else if (previous === "task-agents") normalized.push(":taskAgentId");
    else if (previous === "tenant-vms") normalized.push(":tenantVmId");
    else if (previous === "tenant-slices") normalized.push(":tenantSliceId");
    else if (previous === "browser-sessions") normalized.push(":desktopSlug");
    else if (previous === "browsers") normalized.push(":desktopSlug");
    else if (previous === "desktops" && current !== "leases") normalized.push(":desktopSlug");
    else if (previous === "desktop") normalized.push(":desktopSlug");
    else if (previous === "desktop-shares") normalized.push(":shareId");
    else if (previous === "router-traces") normalized.push(":routerTraceId");
    else if (previous === "accounts") normalized.push(":accountId");
    else if (previous === "attachments") normalized.push(":attachmentId");
    else if (previous === "leases") normalized.push(":leaseId");
    else if (previous === "i" || previous === "a" || previous === "s") normalized.push(":id");
    else if (looksDynamicSegment(current)) normalized.push(":id");
    else normalized.push(current);
  }
  return `/${normalized.join("/")}`;
}

function safeRouteSegment(segment = "") {
  try {
    return decodeURIComponent(clean(segment));
  } catch {
    return clean(segment);
  }
}

function looksDynamicSegment(segment = "") {
  const value = clean(segment);
  if (!value) return false;
  if (value.includes("@")) return true;
  if (/^[0-9a-f]{12,}$/i.test(value)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return true;
  if (/^(att|co|desk|task|turn|msg|msgx|exec|lease)[-_][a-z0-9_-]+$/i.test(value)) return true;
  return value.length > 40 && /[0-9]/.test(value);
}

export function recordHttpRequest({ method = "GET", route = "/", statusCode = 200, durationMs = 0, responseBytes = 0 } = {}) {
  const status = Number(statusCode) || 0;
  const labels = {
    method: clean(method).toUpperCase() || "GET",
    route: routeTemplateFromUrl(route),
    status_class: statusClass(status),
  };
  incrementCounter("orkestr_http_requests_total", labels);
  observeHistogram("orkestr_http_request_duration_seconds", Math.max(0, Number(durationMs) || 0) / 1000, labels, httpDurationBuckets);
  observeHistogram("orkestr_http_response_size_bytes", Math.max(0, Number(responseBytes) || 0), labels, httpResponseSizeBuckets);
}

export function recordBackgroundLoopMetrics({ loop = "unknown", result = "completed", durationMs = 0, counts = {} } = {}) {
  const labels = { loop: labelValue(loop), result: labelValue(result) };
  incrementCounter("orkestr_background_loop_runs_total", labels);
  observeHistogram("orkestr_background_loop_duration_seconds", countValue(durationMs) / 1000, labels, backgroundDurationBuckets);
  for (const [name, rawCount] of Object.entries(counts || {})) {
    const value = countValue(rawCount);
    if (value <= 0) continue;
    incrementCounter("orkestr_background_loop_items_total", { loop: labels.loop, item: labelValue(name) }, value);
  }
}

export function recordTaskAgentLifecycleMetric(event = "unknown", status = "unknown") {
  incrementCounter("orkestr_task_agent_lifecycle_total", {
    event: labelValue(event),
    status: labelValue(status),
  });
}

export function recordWatcherAlertMetric({ source = "unknown", code = "unknown", severity = "error" } = {}) {
  incrementCounter("orkestr_watcher_alerts_total", {
    source: labelValue(source),
    code: labelValue(code),
    severity: labelValue(severity),
  });
}

export function recordWhatsAppDeliveryMetrics({ source = "unknown", result = null, error = null, durationMs = 0 } = {}) {
  const failed = Array.isArray(result?.failed) ? result.failed.length : 0;
  const skipped = Array.isArray(result?.skipped) ? result.skipped.length : 0;
  const sent = Array.isArray(result?.sent) ? result.sent.length : Array.isArray(result?.delivered) ? result.delivered.length : 0;
  const status = error ? "failed" : failed > 0 ? "partial_failure" : "completed";
  const labels = { source: labelValue(source), result: status };
  incrementCounter("orkestr_whatsapp_delivery_runs_total", labels);
  observeHistogram("orkestr_whatsapp_delivery_duration_seconds", countValue(durationMs) / 1000, labels, backgroundDurationBuckets);
  incrementCounter("orkestr_whatsapp_delivery_messages_total", { source: labels.source, state: "sent" }, sent);
  incrementCounter("orkestr_whatsapp_delivery_messages_total", { source: labels.source, state: "failed" }, failed);
  incrementCounter("orkestr_whatsapp_delivery_messages_total", { source: labels.source, state: "skipped" }, skipped);
}

export function recordThreadResourceAccessMetric({ resourceType = "unknown", permission = "unknown", mode = "unknown", granted = false, shadowDenied = false, durationMs = 0 } = {}) {
  const outcome = shadowDenied ? "shadow_denied" : granted ? "allowed" : "denied";
  const labels = {
    resource_type: enumLabel(resourceType, threadResourceTypes),
    permission: enumLabel(permission, threadResourcePermissions),
    mode: enumLabel(mode, threadResourceModes),
    outcome,
  };
  incrementCounter("orkestr_thread_resource_access_decisions_total", labels);
  observeHistogram("orkestr_thread_resource_policy_evaluation_seconds", countValue(durationMs) / 1000, labels, backgroundDurationBuckets);
  if (shadowDenied) incrementCounter("orkestr_thread_resource_shadow_mismatches_total", { resource_type: labels.resource_type, permission: labels.permission });
}

export function recordThreadResourceInvalidationMetric({ resourceType = "unknown", subject = "resource", reason = "unknown" } = {}) {
  incrementCounter("orkestr_thread_resource_invalidations_total", {
    resource_type: enumLabel(resourceType, threadResourceTypes),
    subject: enumLabel(subject, threadResourceInvalidationSubjects),
    reason: enumLabel(reason, threadResourceInvalidationReasons),
  });
}

export function recordMailboxThreadDeliveryMetrics({ state = "unknown", lagMs = 0 } = {}) {
  const labels = { state: enumLabel(state, mailboxDeliveryStates) };
  incrementCounter("orkestr_mailbox_thread_delivery_transitions_total", labels);
  if (Number(lagMs) > 0) observeHistogram("orkestr_mailbox_thread_delivery_lag_seconds", countValue(lagMs) / 1000, labels, backgroundDurationBuckets);
}

export function recordMailboxRouteMetrics({ state = "unknown", mode = "unknown", lagMs = 0 } = {}) {
  const labels = { state: enumLabel(state, mailboxRouteWorkStates), mode: enumLabel(mode, new Set(["append_only", "process_immediately", "context_next_turn"])) };
  incrementCounter("orkestr_mailbox_route_transitions_total", labels);
  if (Number(lagMs) > 0) observeHistogram("orkestr_mailbox_route_lag_seconds", countValue(lagMs) / 1000, labels, backgroundDurationBuckets);
}

export function recordThreadResourceBreakGlassMetric({ resourceType = "unknown", outcome = "allowed" } = {}) {
  incrementCounter("orkestr_thread_resource_break_glass_total", {
    resource_type: enumLabel(resourceType, threadResourceTypes),
    outcome: enumLabel(outcome, breakGlassOutcomes),
  });
}

export function recordShadowBoundaryChatWarningMetric({ resourceType = "unknown", outcome = "emitted" } = {}) {
  incrementCounter("orkestr_shadow_boundary_chat_warnings_total", {
    resource_type: enumLabel(resourceType, threadResourceTypes),
    outcome: enumLabel(outcome, shadowBoundaryWarningOutcomes),
  });
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
      [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
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

function statusClass(statusCode) {
  if (!statusCode) return "unknown";
  return `${Math.floor(statusCode / 100)}xx`;
}

export function createObservabilityMiddleware(env = process.env) {
  return (request, response, next) => {
    const started = performance.now();
    const requestId = requestIdFromHeaders(request.headers || {});
    request.orkestrRequestId = requestId;
    response.setHeader("x-request-id", requestId);
    response.once("finish", () => {
      const route = routeTemplateFromUrl(request.originalUrl || request.url || "/");
      const bytes = Number(response.getHeader("content-length") || 0) || 0;
      recordHttpRequest({
        method: request.method,
        route,
        statusCode: response.statusCode,
        durationMs: performance.now() - started,
        responseBytes: bytes,
      });
      if (env.ORKESTR_STRUCTURED_ACCESS_LOGS === "1") {
        writeAccessLog({
          requestId,
          method: clean(request.method).toUpperCase(),
          route,
          statusCode: response.statusCode,
          durationMs: Math.round((performance.now() - started) * 100) / 100,
          responseBytes: bytes,
        });
      }
    });
    next();
  };
}

function writeAccessLog(entry) {
  process.stdout.write(`${JSON.stringify({ type: "http_access", ...entry, ts: new Date().toISOString() })}\n`);
}

export function metricsRequestAllowed(request, env = process.env) {
  if (env.ORKESTR_METRICS_ENABLED === "0") return { ok: false, statusCode: 404, error: "metrics_disabled" };
  const token = clean(env.ORKESTR_METRICS_TOKEN);
  if (token) {
    const header = clean(request?.headers?.authorization || "");
    return header === `Bearer ${token}`
      ? { ok: true }
      : { ok: false, statusCode: 401, error: "metrics_token_required" };
  }
  if (env.ORKESTR_METRICS_PUBLIC === "1") return { ok: true };
  if (isDirectLocalMetricsRequest(request)) return { ok: true };
  return { ok: false, statusCode: 403, error: "metrics_local_only" };
}

function isDirectLocalMetricsRequest(request) {
  const host = lower(String(request?.headers?.host || "").split(":")[0]).replace(/^\[|\]$/g, "");
  const remote = clean(request?.socket?.remoteAddress || request?.connection?.remoteAddress);
  const localHost = ["127.0.0.1", "localhost", "::1"].includes(host);
  const localRemote = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
  return localHost && localRemote;
}

export function createMetricsHandler(env = process.env) {
  return (_request, response) => {
    renderOpenMetricsForRequest(env)
      .then((body) => {
        response.statusCode = 200;
        response.setHeader("content-type", "text/plain; version=0.0.4; charset=utf-8");
        response.end(body);
      })
      .catch((error) => {
        response.statusCode = 500;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ ok: false, error: clean(error?.message || error || "metrics_render_failed") }));
      });
  };
}

export function renderOpenMetrics(_env = process.env) {
  return renderOpenMetricsFromLines(baseOpenMetricsLines());
}

async function renderOpenMetricsForRequest(env = process.env) {
  const lines = baseOpenMetricsLines();
  lines.push(...await collectStateMetricLines(env).catch(() => []));
  return renderOpenMetricsFromLines(lines);
}

function renderOpenMetricsFromLines(lines) {
  lines.push("# EOF");
  return `${lines.join("\n")}\n`;
}

function baseOpenMetricsLines() {
  const lines = [];
  lines.push("# HELP orkestr_process_uptime_seconds Orkestr process uptime in seconds.");
  lines.push("# TYPE orkestr_process_uptime_seconds gauge");
  lines.push(`orkestr_process_uptime_seconds ${formatNumber((Date.now() - startedAt) / 1000)}`);
  const memory = process.memoryUsage();
  renderGauge(lines, "orkestr_process_memory_rss_bytes", "Orkestr process resident memory in bytes.", memory.rss);
  renderGauge(lines, "orkestr_process_heap_used_bytes", "Orkestr process used heap in bytes.", memory.heapUsed);
  renderGauge(lines, "orkestr_process_heap_total_bytes", "Orkestr process total heap in bytes.", memory.heapTotal);

  for (const item of [...counters.values()].sort(metricSort)) {
    lines.push(`# TYPE ${item.name} counter`);
    lines.push(`${item.name}${labelText(item.labels)} ${formatNumber(item.value)}`);
  }
  for (const item of [...histograms.values()].sort(metricSort)) {
    lines.push(`# TYPE ${item.name} histogram`);
    for (const bucket of item.buckets) {
      lines.push(`${item.name}_bucket${labelText({ ...item.labels, le: bucket.le })} ${formatNumber(bucket.count)}`);
    }
    lines.push(`${item.name}_bucket${labelText({ ...item.labels, le: "+Inf" })} ${formatNumber(item.count)}`);
    lines.push(`${item.name}_sum${labelText(item.labels)} ${formatNumber(item.sum)}`);
    lines.push(`${item.name}_count${labelText(item.labels)} ${formatNumber(item.count)}`);
  }
  return lines;
}

async function collectStateMetricLines(env = process.env) {
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
    const key = JSON.stringify(safeLabels(labels));
    const current = map.get(key) || { labels: safeLabels(labels), value: 0 };
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

function threadKindLabel(thread = {}) {
  if (clean(thread.threadKind) === "task-agent" || clean(thread.agentTaskId)) return "task_agent";
  if (clean(thread.parentThreadId)) return "worker";
  return "thread";
}

function renderGaugeSeries(lines, name, help, series) {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} gauge`);
  if (!series.size) {
    lines.push(`${name} 0`);
    return;
  }
  for (const item of [...series.values()].sort(metricSort)) {
    lines.push(`${name}${labelText(item.labels)} ${formatNumber(item.value)}`);
  }
}

function renderGauge(lines, name, help, value) {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} gauge`);
  lines.push(`${name} ${formatNumber(value)}`);
}

function metricSort(left, right) {
  return `${left.name}${JSON.stringify(left.labels)}`.localeCompare(`${right.name}${JSON.stringify(right.labels)}`);
}

function labelText(labels = {}) {
  const entries = Object.entries(safeLabels(labels));
  if (!entries.length) return "";
  return `{${entries.map(([key, value]) => `${key}="${escapeLabelValue(value)}"`).join(",")}}`;
}

function escapeLabelValue(value = "") {
  return clean(value).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function formatNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "0";
  return String(Math.round(numeric * 1000000) / 1000000);
}
