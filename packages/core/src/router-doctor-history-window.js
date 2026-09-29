// Age-aware classification for the WhatsApp router doctor.
//
// Per-message delivery invariants (orphaned finals, swallowed inputs, missing
// trace phases, ...) are only actionable for recent traffic. Older findings are
// usually history from before mirror markers/outbox jobs existed or from after
// outbox retention pruned jobs, so they are aggregated into one informational
// summary per group instead of being reported as thousands of errors.

const DEFAULT_WINDOW_HOURS = 72;

const ORPHANED_FINAL_CODES = new Set([
  "orphaned_whatsapp_final_answer",
  "orphaned_ui_whatsapp_reply_delivery",
]);

const PER_MESSAGE_DELIVERY_CODES = new Set([
  ...ORPHANED_FINAL_CODES,
  "queued_whatsapp_input_marked_terminal_without_runtime_delivery",
  "older_reply_completed_newer_user_message",
  "runtime_delivery_completed_without_assistant",
  "queue_notice_without_runtime_delivery",
  "assistant_seen_older_than_user_message",
  "missing_router_trace_phase",
]);

function clean(value = "") {
  return String(value || "").trim();
}

function dateMs(value = "") {
  const ms = Date.parse(clean(value));
  return Number.isFinite(ms) ? ms : 0;
}

export function whatsappDoctorWindowHours(env = process.env) {
  const raw = clean(env.ORKESTR_WHATSAPP_DOCTOR_WINDOW_HOURS);
  if (!raw) return DEFAULT_WINDOW_HOURS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_WINDOW_HOURS;
}

export function whatsappDoctorWindowCutoffMs(env = process.env, nowMs = Date.now()) {
  return nowMs - whatsappDoctorWindowHours(env) * 60 * 60 * 1000;
}

function checkTimestampMs(check = {}, { messagesById, tracesById }) {
  const message = messagesById.get(clean(check.messageId));
  const messageMs = message ? dateMs(message.createdAt || message.updatedAt) : 0;
  if (messageMs) return messageMs;
  const trace = tracesById.get(clean(check.routerTraceId));
  return trace ? dateMs(trace.createdAt || trace.updatedAt) : 0;
}

// Splits per-thread checks into in-window checks and historical ones. Checks
// without a resolvable timestamp, non-per-message checks (transport, stale
// queues, stale outbox claims, ...) and info findings always stay current.
export function partitionHistoricalChecks(checks = [], { messages = [], traces = [], env = process.env, nowMs = Date.now() } = {}) {
  const cutoffMs = whatsappDoctorWindowCutoffMs(env, nowMs);
  const messagesById = new Map((messages || []).map((message) => [clean(message.id), message]));
  const tracesById = new Map((traces || []).map((trace) => [clean(trace.routerTraceId), trace]));
  const current = [];
  const historical = [];
  for (const check of checks) {
    if (!PER_MESSAGE_DELIVERY_CODES.has(check.code) || !["error", "warn"].includes(check.severity)) {
      current.push(check);
      continue;
    }
    const ts = checkTimestampMs(check, { messagesById, tracesById });
    if (ts && ts < cutoffMs) historical.push({ ...check, historical: true, occurredAt: new Date(ts).toISOString() });
    else current.push(check);
  }
  return { current, historical };
}

function emptyHistoricalGroup() {
  return { count: 0, byCode: {}, oldestAt: "", newestAt: "" };
}

function addToGroup(group, check) {
  group.count += 1;
  group.byCode[check.code] = (group.byCode[check.code] || 0) + 1;
  if (check.occurredAt && (!group.oldestAt || check.occurredAt < group.oldestAt)) group.oldestAt = check.occurredAt;
  if (check.occurredAt && (!group.newestAt || check.occurredAt > group.newestAt)) group.newestAt = check.occurredAt;
}

export function summarizeHistoricalChecks(historical = []) {
  const orphanedFinals = emptyHistoricalGroup();
  const other = emptyHistoricalGroup();
  for (const check of historical) addToGroup(ORPHANED_FINAL_CODES.has(check.code) ? orphanedFinals : other, check);
  return { total: orphanedFinals.count + other.count, orphanedFinals, other };
}

// Builds at most two aggregated info checks for historical findings so the
// report stays readable and the overall status reflects only in-window errors.
export function historicalSummaryChecks(historical = [], env = process.env) {
  const summary = summarizeHistoricalChecks(historical);
  const windowHours = whatsappDoctorWindowHours(env);
  const threadCount = (items) => new Set(items.map((check) => clean(check.threadId)).filter(Boolean)).size;
  const checks = [];
  if (summary.orphanedFinals.count) {
    const items = historical.filter((check) => ORPHANED_FINAL_CODES.has(check.code));
    checks.push({
      code: "historical_orphaned_whatsapp_finals",
      severity: "info",
      summary: `${summary.orphanedFinals.count} WhatsApp final${summary.orphanedFinals.count === 1 ? "" : "s"} older than ${windowHours}h have no mirror delivery marker or outbox job (historical, not alarming).`,
      count: summary.orphanedFinals.count,
      threads: threadCount(items),
      windowHours,
      byCode: summary.orphanedFinals.byCode,
      oldestAt: summary.orphanedFinals.oldestAt,
      newestAt: summary.orphanedFinals.newestAt,
    });
  }
  if (summary.other.count) {
    const items = historical.filter((check) => !ORPHANED_FINAL_CODES.has(check.code));
    checks.push({
      code: "historical_whatsapp_delivery_findings",
      severity: "info",
      summary: `${summary.other.count} WhatsApp delivery finding${summary.other.count === 1 ? "" : "s"} older than ${windowHours}h (historical, not alarming).`,
      count: summary.other.count,
      threads: threadCount(items),
      windowHours,
      byCode: summary.other.byCode,
      oldestAt: summary.other.oldestAt,
      newestAt: summary.other.newestAt,
    });
  }
  return checks;
}
