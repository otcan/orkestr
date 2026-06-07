function clean(value = "") {
  return String(value || "").trim();
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dateMs(value) {
  const parsed = Date.parse(clean(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function nowIso(nowMs = Date.now()) {
  return new Date(nowMs).toISOString();
}

function latestIso(values = []) {
  const latest = values.map(dateMs).filter(Boolean).sort((left, right) => right - left)[0] || 0;
  return latest ? new Date(latest).toISOString() : null;
}

function ageMs(value, nowMs = Date.now()) {
  const ms = dateMs(value);
  return ms ? Math.max(0, nowMs - ms) : null;
}

function durationText(ms) {
  if (ms === null || ms === undefined) return "unknown";
  const seconds = Math.max(0, Math.floor(Number(ms) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function latestMessageAt(messages = [], predicate = () => true) {
  return latestIso(messages
    .filter(predicate)
    .map((message) => message.updatedAt || message.createdAt || message.timestamp || message.completedAt)
    .filter(Boolean));
}

function messageLooksTool(message = {}) {
  const role = clean(message.role).toLowerCase();
  const phase = clean(message.phase).toLowerCase();
  const source = clean(message.source).toLowerCase();
  return role === "tool" || phase.includes("tool") || source.includes("tool");
}

export function rawStructuredTurnActive(thread = {}, status = {}) {
  const runtimeKind = clean(status.runtimeKind || status.runtimeState || thread.runtime?.runtimeKind).toLowerCase();
  const state = clean(status.state || status.status || thread.runtime?.state || thread.state).toLowerCase();
  return runtimeKind === "codex-app-server" && Boolean(
    status.activeTurnId ||
      thread.runtime?.activeTurnId ||
      status.pendingRequest ||
      thread.runtime?.pendingRequest ||
      status.working ||
      status.typingActive ||
      ["working", "awaiting_approval", "running"].includes(state),
  );
}

export function rawAttachPollIntervalMs(input = {}, env = process.env) {
  const parsed = numberOrNull(input.intervalMs ?? input.pollIntervalMs ?? env.ORKESTR_RAW_ATTACH_WATCH_INTERVAL_MS);
  return parsed === null ? 5000 : Math.max(1000, Math.floor(parsed));
}

export function rawAttachTimeoutMs(input = {}, env = process.env) {
  const parsed = numberOrNull(input.timeoutMs ?? env.ORKESTR_RAW_ATTACH_WATCH_TIMEOUT_MS);
  return parsed === null ? 15 * 60_000 : Math.max(1000, Math.floor(parsed));
}

/**
 * @param {{
 *   thread?: Record<string, any>,
 *   status?: Record<string, any>,
 *   messages?: Array<Record<string, any>>,
 *   startedAtMs?: number,
 *   nowMs?: number,
 *   intervalMs?: number,
 *   timeoutMs?: number,
 * }} input
 */
export function rawAttachWatchPayload({ thread = {}, status = {}, messages = [], startedAtMs = Date.now(), nowMs = Date.now(), intervalMs, timeoutMs } = {}) {
  const activeTurnId = clean(status.activeTurnId || thread.runtime?.activeTurnId);
  const pendingRequest = status.pendingRequest || thread.runtime?.pendingRequest || null;
  const lastAssistantAt = latestMessageAt(messages, (message) => clean(message.role).toLowerCase() === "assistant");
  const lastToolCallAt = latestMessageAt(messages, messageLooksTool);
  const lastOutputAt = latestIso([
    lastAssistantAt,
    lastToolCallAt,
    status.progress?.capturedAt,
    status.progress?.sampledAt,
    status.updatedAt,
    thread.runtime?.updatedAt,
    thread.updatedAt,
  ]);
  const lastEventAt = latestIso([
    lastOutputAt,
    status.heartbeatAt,
    status.lease?.heartbeatAt,
    status.activeTurnObservedAt,
    status.statusObservedAt,
    thread.runtime?.updatedAt,
    thread.updatedAt,
  ]);
  const heartbeatAt = latestIso([status.heartbeatAt, status.lease?.heartbeatAt, status.progress?.capturedAt, status.statusObservedAt]);
  const explicitProcessAlive = status.processAlive ?? status.process?.alive;
  const processAlive = explicitProcessAlive === undefined || explicitProcessAlive === null
    ? Boolean(status.codexAppServerTransport || status.sessionName || status.paneId)
    : Boolean(explicitProcessAlive);
  const cpuPercent = numberOrNull(status.cpuPercent ?? status.process?.cpuPercent ?? status.process?.cpu);
  const memoryMb = numberOrNull(status.memoryMb ?? status.process?.memoryMb ?? status.process?.rssMb);
  const heartbeatAgeMs = ageMs(heartbeatAt, nowMs);
  const lastOutputAgeMs = ageMs(lastOutputAt, nowMs);
  const activeTurnActive = rawStructuredTurnActive(thread, status);
  const activeDurationMs = activeTurnActive
    ? ageMs(status.activeTurnObservedAt || thread.runtime?.activeTurnObservedAt || thread.runtime?.updatedAt || thread.updatedAt, nowMs)
    : null;
  const queueDepth = Number(status.pendingCount || 0) + Number(status.awaitingAckCount || 0) + Number(status.runningCount || 0);
  const highRisk = processAlive === false || (heartbeatAgeMs !== null && heartbeatAgeMs > 5 * 60_000) || (lastOutputAgeMs !== null && lastOutputAgeMs > 10 * 60_000);
  const mediumRisk = !highRisk && ((heartbeatAgeMs !== null && heartbeatAgeMs > 2 * 60_000) || (lastOutputAgeMs !== null && lastOutputAgeMs > 3 * 60_000));
  const staleRisk = highRisk ? "high" : mediumRisk ? "medium" : "low";
  const recommendedAction = processAlive === false
    ? "recover"
    : pendingRequest
      ? "inspect"
      : staleRisk === "high"
        ? "interrupt"
        : staleRisk === "medium"
          ? "inspect"
          : "wait";
  const effectiveIntervalMs = rawAttachPollIntervalMs({ intervalMs });
  const effectiveTimeoutMs = rawAttachTimeoutMs({ timeoutMs });
  const elapsedMs = Math.max(0, nowMs - Number(startedAtMs || nowMs));
  return {
    mode: "watch-and-wait",
    attachable: false,
    mutationAllowed: false,
    threadId: clean(thread.id),
    threadName: clean(thread.name || thread.title || thread.id),
    runtimeMode: clean(status.runtimeKind || status.runtimeState || thread.runtime?.runtimeKind || "unknown"),
    runtimeState: clean(status.state || status.status || thread.runtime?.state || thread.state || "unknown"),
    activeTurnId: activeTurnId || null,
    activeDurationMs,
    activeDuration: durationText(activeDurationMs),
    lastEventAt,
    lastEventAgeMs: ageMs(lastEventAt, nowMs),
    lastEventAge: durationText(ageMs(lastEventAt, nowMs)),
    lastAssistantUpdateAt: lastAssistantAt,
    lastAssistantUpdateAgeMs: ageMs(lastAssistantAt, nowMs),
    lastAssistantUpdateAge: durationText(ageMs(lastAssistantAt, nowMs)),
    lastToolCallAt,
    lastToolCallAgeMs: ageMs(lastToolCallAt, nowMs),
    lastToolCallAge: durationText(ageMs(lastToolCallAt, nowMs)),
    lastOutputAt,
    lastOutputAgeMs,
    lastOutputAge: durationText(lastOutputAgeMs),
    pendingApproval: Boolean(pendingRequest),
    pendingRequest,
    queueDepth,
    appServerConnected: Boolean(status.codexAppServerTransport || status.codexAppServerSocket),
    processAlive,
    cpuPercent,
    memoryMb,
    heartbeatAt,
    heartbeatAgeMs,
    heartbeatAge: durationText(heartbeatAgeMs),
    staleRisk,
    recommendedAction,
    intervalMs: effectiveIntervalMs,
    timeoutMs: effectiveTimeoutMs,
    elapsedMs,
    nextCheckInMs: effectiveIntervalMs,
    generatedAt: nowIso(nowMs),
  };
}

export function rawAttachWatchText(watch = {}) {
  const lines = [
    "Raw attach watch-and-wait",
    `Thread: ${watch.threadName || watch.threadId || "unknown"}${watch.threadId && watch.threadName && watch.threadId !== watch.threadName ? ` (${watch.threadId})` : ""}`,
    `Runtime: ${watch.runtimeMode || "unknown"} / ${watch.runtimeState || "unknown"}`,
    `Active turn: ${watch.activeTurnId || "none"} (${watch.activeDuration || "unknown"})`,
    `Last event: ${watch.lastEventAge || "unknown"}`,
    `Last assistant update: ${watch.lastAssistantUpdateAge || "unknown"}`,
    `Last tool call: ${watch.lastToolCallAge || "unknown"}`,
    `Last output: ${watch.lastOutputAge || "unknown"}`,
    `Pending approval/input: ${watch.pendingApproval ? "yes" : "no"}`,
    `Queue depth: ${Number(watch.queueDepth || 0)}`,
    `App-server connected: ${watch.appServerConnected ? "yes" : "no"}`,
    `Process alive: ${watch.processAlive === false ? "no" : watch.processAlive === true ? "yes" : "unknown"}`,
    `CPU: ${watch.cpuPercent === null || watch.cpuPercent === undefined ? "unknown" : `${watch.cpuPercent}%`}`,
    `Memory: ${watch.memoryMb === null || watch.memoryMb === undefined ? "unknown" : `${watch.memoryMb} MB`}`,
    `Heartbeat age: ${watch.heartbeatAge || "unknown"}`,
    `Stale risk: ${watch.staleRisk || "unknown"}`,
    `Recommended action: ${watch.recommendedAction || "wait"}`,
    `Check interval: ${durationText(watch.intervalMs)}; timeout: ${durationText(watch.timeoutMs)}; next check: ${durationText(watch.nextCheckInMs)}`,
    "Hotkeys: Ctrl-C cancel; i interrupt/take over; r read-only; s refresh; a approve; d deny",
  ];
  return `${lines.join("\n")}\n`;
}
