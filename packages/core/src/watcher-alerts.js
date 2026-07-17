import crypto from "node:crypto";
import { dataPaths } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { appendThreadMessage, createThread, listThreads } from "./threads.js";

function clean(value) {
  return String(value || "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function nowIso() {
  return new Date().toISOString();
}

function enabled(env = process.env) {
  return env.ORKESTR_WATCHER_ALERTS !== "0" && env.ORKESTR_WATCHER_ENABLED !== "0";
}

function watcherThreadTarget(env = process.env) {
  return clean(env.ORKESTR_WATCHER_THREAD_ID || env.ORKESTR_WATCHER_THREAD_NAME || env.ORKESTR_WATCHER_CHAT || "orkestr-watcher");
}

function watcherAutoCreate(env = process.env) {
  return env.ORKESTR_WATCHER_AUTO_CREATE !== "0";
}

function watcherDedupeWindowMs(env = process.env) {
  const parsed = Number(env.ORKESTR_WATCHER_DEDUPE_MS || 60_000);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 60_000;
}

function watcherRetention(env = process.env) {
  const parsed = Number(env.ORKESTR_WATCHER_ALERT_RETENTION || 1000);
  return Number.isFinite(parsed) ? Math.max(100, Math.floor(parsed)) : 1000;
}

function redact(value, limit = 2000) {
  return clean(value)
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/(authorization|token|secret|password|api[_-]?key|cookie)=([^&\s]+)/gi, "$1=[redacted]")
    .slice(0, limit);
}

function safeError(error) {
  if (!error) return {};
  return {
    name: redact(error.name || ""),
    message: redact(error.message || error),
    stack: redact(error.stack || "", 4000),
    statusCode: Number(error.statusCode || error.status || 0) || null,
  };
}

function safeDetails(input = {}) {
  const output = {};
  for (const [key, value] of Object.entries(input && typeof input === "object" ? input : {})) {
    const name = clean(key);
    if (!name || /token|secret|password|authorization|api[_-]?key|cookie/i.test(name)) continue;
    if (value === null || value === undefined) continue;
    if (["string", "number", "boolean"].includes(typeof value)) output[name] = redact(value, 1000);
  }
  return output;
}

function whatsappBridgeUnavailableAlert(alert = {}) {
  const details = alert?.details && typeof alert.details === "object" ? alert.details : {};
  const text = [
    alert.source,
    alert.code,
    alert.message,
    alert.error?.name,
    alert.error?.message,
    details.reason,
    details.error,
    details.code,
  ].map(lower).filter(Boolean).join(" ");
  if (!/(whatsapp|bridge|connector)/.test(text)) return false;
  return text.includes("not_ready") ||
    text.includes("bridge_not_ready") ||
    text.includes("whatsapp_local_bridge_not_ready") ||
    text.includes("temporarily unavailable") ||
    text.includes("detached frame") ||
    text.includes("target closed") ||
    text.includes("session closed") ||
    text.includes("fetch failed") ||
    text.includes("econnrefused") ||
    text.includes("timeout");
}

function alertStoreDefaults(raw = {}) {
  return {
    schemaVersion: 1,
    alerts: Array.isArray(raw?.alerts) ? raw.alerts : [],
    updatedAt: clean(raw?.updatedAt),
  };
}

async function readAlertStore(env = process.env) {
  return alertStoreDefaults(await readJson(dataPaths(env).watcherAlerts, { schemaVersion: 1, alerts: [] }));
}

async function writeAlertStore(store, env = process.env) {
  const next = alertStoreDefaults(store);
  const alertsById = new Map();
  for (const [index, alert] of [...next.alerts]
    .sort((left, right) => Date.parse(clean(left.createdAt)) - Date.parse(clean(right.createdAt)))
    .entries()) {
    alertsById.set(clean(alert.id) || `anonymous:${index}`, alert);
  }
  next.alerts = [...alertsById.values()]
    .sort((left, right) => Date.parse(clean(left.createdAt)) - Date.parse(clean(right.createdAt)))
    .slice(-watcherRetention(env));
  next.updatedAt = nowIso();
  await writeJson(dataPaths(env).watcherAlerts, next);
  return next;
}

function hashAlert(input = {}) {
  const payload = [
    lower(input.severity || "error"),
    clean(input.source),
    clean(input.code || input.error?.name),
    clean(input.message || input.error?.message),
    clean(input.threadId),
    clean(input.routerTraceId),
    clean(input.route),
  ].join("\n");
  return crypto.createHash("sha256").update(payload).digest("hex").slice(0, 24);
}

async function resolveWatcherThread(env = process.env) {
  const target = watcherThreadTarget(env);
  if (!target) return null;
  const threads = await listThreads(env);
  const existing = threads.find((thread) =>
    thread.id === target ||
    thread.name === target ||
    thread.bindingName === target ||
    thread.title === target
  );
  if (existing || !watcherAutoCreate(env)) return existing || null;
  return createThread({
    name: target,
    title: "Orkestr watcher",
    state: "ready",
    wakePolicy: "manual",
  }, env);
}

function watcherMessageDefaults(thread = null, alert = {}) {
  if (alert?.mirrorToConnector !== true) return {};
  if (whatsappBridgeUnavailableAlert(alert)) return {};
  const binding = thread?.binding || {};
  if (lower(binding.connector || "whatsapp") !== "whatsapp") return {};
  if (binding.mirrorToWhatsApp === false || binding.mirrorReplies === false) return {};
  const chatId = clean(binding.chatId);
  if (!chatId) return {};
  return {
    connector: "whatsapp",
    chatId,
    accountId: clean(binding.responderAccountId || binding.outboundAccountId || binding.senderAccountId || binding.inboundAccountId),
    originSurface: "watcher-alert",
    originTransport: "watcher-alert",
  };
}

function formatAlert(alert = {}) {
  const lines = [
    `[watcher:${clean(alert.severity || "error")}] ${clean(alert.source || "orkestr")}`,
    `code: ${clean(alert.code || "unhandled_error")}`,
    `message: ${redact(alert.message || alert.error?.message || "unknown_error", 1000)}`,
  ];
  if (alert.threadId) lines.push(`thread: ${clean(alert.threadId)}`);
  if (alert.messageId) lines.push(`message: ${clean(alert.messageId)}`);
  if (alert.routerTraceId) lines.push(`routerTrace: ${clean(alert.routerTraceId)}`);
  if (alert.route) lines.push(`route: ${clean(alert.method)} ${clean(alert.route)}`.trim());
  const detailLines = Object.entries(alert.details || {})
    .map(([key, value]) => `${clean(key)}=${redact(value, 500)}`)
    .filter((line) => line !== "=");
  if (detailLines.length) lines.push(`context: ${detailLines.join(" ")}`);
  lines.push(`time: ${clean(alert.createdAt) || nowIso()}`);
  if (alert.error?.stack) lines.push(`stack: ${redact(alert.error.stack, 1200)}`);
  return lines.join("\n");
}

function normalizeLifecycleAction(action = "") {
  const normalized = lower(action).replace(/_/g, "-");
  if (normalized === "ack" || normalized === "acknowledged") return "acknowledge";
  if (normalized === "resolved") return "resolve";
  if (normalized === "escalated") return "escalate";
  if (normalized === "opened") return "reopen";
  return normalized;
}

function lifecycleStatusForAction(action = "") {
  if (action === "acknowledge") return "acknowledged";
  if (action === "resolve") return "resolved";
  if (action === "escalate") return "escalated";
  if (action === "reopen") return "recorded";
  return "";
}

function lifecycleTimestampKey(action = "") {
  if (action === "acknowledge") return "acknowledgedAt";
  if (action === "resolve") return "resolvedAt";
  if (action === "escalate") return "escalatedAt";
  if (action === "reopen") return "reopenedAt";
  return "";
}

function lifecycleActorKey(action = "") {
  if (action === "acknowledge") return "acknowledgedBy";
  if (action === "resolve") return "resolvedBy";
  if (action === "escalate") return "escalatedBy";
  if (action === "reopen") return "reopenedBy";
  return "";
}

function formatLifecycleAlertMessage(alert = {}, entry = {}) {
  const lines = [
    `[watcher:${clean(entry.action || "lifecycle")}] ${clean(alert.source || "orkestr")}`,
    `code: ${clean(alert.code || "alert")}`,
    `alert: ${clean(alert.id)}`,
    `status: ${clean(alert.status || "recorded")}`,
  ];
  if (alert.threadId) lines.push(`thread: ${clean(alert.threadId)}`);
  if (entry.actorUserId) lines.push(`operator: ${clean(entry.actorUserId)}`);
  if (entry.reason) lines.push(`reason: ${redact(entry.reason, 500)}`);
  lines.push(`time: ${clean(entry.at) || nowIso()}`);
  return lines.join("\n");
}

export async function recordWatcherAlert(input = {}, env = process.env) {
  if (!enabled(env)) return { ok: false, skipped: true, reason: "watcher_disabled" };
  const error = safeError(input.error);
  const createdAt = clean(input.createdAt) || nowIso();
  const alert = {
    id: hashAlert({ ...input, error }),
    severity: lower(input.severity || "error") || "error",
    source: clean(input.source || "orkestr"),
    code: clean(input.code || error.name || "unhandled_error"),
    message: redact(input.message || error.message || "unknown_error", 1000),
    error,
    details: safeDetails(input.details),
    threadId: clean(input.threadId),
    messageId: clean(input.messageId),
    routerTraceId: clean(input.routerTraceId),
    method: clean(input.method),
    route: clean(input.route),
    mirrorToConnector: input.mirrorToConnector === true,
    createdAt,
  };
  const store = await readAlertStore(env);
  const matchingAlerts = store.alerts.filter((item) => clean(item.id) === alert.id);
  const latest = matchingAlerts.at(-1);
  const dedupeMs = watcherDedupeWindowMs(env);
  const withinDedupeWindow = latest && dedupeMs > 0 && Date.now() - Date.parse(clean(latest.createdAt)) <= dedupeMs;
  const unresolvedDuplicate = latest && lower(latest.status || "recorded") !== "resolved";
  if (withinDedupeWindow || unresolvedDuplicate) {
    if (matchingAlerts.length > 1) {
      await writeAlertStore(store, env);
    }
    if (withinDedupeWindow) {
      await appendEvent({
        type: "watcher_alert_deduped",
        alertId: alert.id,
        source: alert.source,
        code: alert.code,
        threadId: alert.threadId || "",
      }, env).catch(() => {});
    }
    return { ok: true, skipped: true, reason: withinDedupeWindow ? "deduped" : "active_alert", alert: latest };
  }

  const thread = await resolveWatcherThread(env);
  let message = null;
  if (thread) {
    message = await appendThreadMessage(thread.id, {
      role: "assistant",
      source: "watcher-alert",
      phase: "final_answer",
      state: "completed",
      text: formatAlert(alert),
      routerTraceId: alert.routerTraceId,
      ...watcherMessageDefaults(thread, alert),
    }, env);
  }
  const recorded = {
    ...alert,
    watcherThreadId: thread?.id || null,
    watcherMessageId: message?.id || null,
    status: message ? "recorded" : "thread_unavailable",
  };
  await writeAlertStore({
    ...store,
    alerts: [...store.alerts.filter((item) => clean(item.id) !== recorded.id), recorded],
  }, env);
  await appendEvent({
    type: "watcher_alert_recorded",
    alertId: recorded.id,
    source: recorded.source,
    code: recorded.code,
    threadId: recorded.threadId || "",
    watcherThreadId: recorded.watcherThreadId || "",
    watcherMessageId: recorded.watcherMessageId || "",
    status: recorded.status,
  }, env).catch(() => {});
  return { ok: true, alert: recorded, thread, message };
}

export async function updateWatcherAlertLifecycle(alertId, action, options = {}, env = process.env) {
  const id = clean(alertId);
  const normalizedAction = normalizeLifecycleAction(action);
  const status = lifecycleStatusForAction(normalizedAction);
  if (!id || !status) {
    const error = new Error("invalid_watcher_alert_action");
    error.statusCode = 400;
    throw error;
  }
  const store = await readAlertStore(env);
  const index = store.alerts.findLastIndex((alert) => clean(alert.id) === id);
  if (index === -1) {
    const error = new Error("watcher_alert_not_found");
    error.statusCode = 404;
    throw error;
  }
  const at = nowIso();
  const actorUserId = clean(options.actorUserId || options.operatorUserId || "admin") || "admin";
  const reason = redact(options.reason || "", 500);
  const prior = store.alerts[index];
  const entry = {
    action: normalizedAction,
    status,
    at,
    actorUserId,
    reason,
  };
  const timestampKey = lifecycleTimestampKey(normalizedAction);
  const actorKey = lifecycleActorKey(normalizedAction);
  const next = {
    ...prior,
    status,
    lifecycle: [...(Array.isArray(prior.lifecycle) ? prior.lifecycle : []), entry].slice(-50),
    updatedAt: at,
  };
  if (timestampKey) next[timestampKey] = at;
  if (actorKey) next[actorKey] = actorUserId;
  if (reason) next.lifecycleReason = reason;

  let message = null;
  if (normalizedAction === "escalate") {
    const thread = await resolveWatcherThread(env);
    if (thread) {
      message = await appendThreadMessage(thread.id, {
        role: "assistant",
        source: "watcher-alert-lifecycle",
        phase: "final_answer",
        state: "completed",
        text: formatLifecycleAlertMessage(next, entry),
        routerTraceId: next.routerTraceId,
        ...watcherMessageDefaults(thread, next),
      }, env);
      next.escalationThreadId = thread.id;
      next.escalationMessageId = message.id;
    }
  }

  const alerts = [...store.alerts];
  alerts[index] = next;
  const written = await writeAlertStore({ ...store, alerts }, env);
  const alert = written.alerts.find((item) => clean(item.id) === id) || next;
  await appendEvent({
    type: "watcher_alert_lifecycle_updated",
    action: `watcher.alert.${normalizedAction}`,
    outcome: "success",
    resourceType: "watcher_alert",
    alertId: id,
    source: alert.source || "",
    code: alert.code || "",
    status: alert.status || "",
    actorUserId,
    reason,
    watcherThreadId: alert.watcherThreadId || "",
    watcherMessageId: alert.watcherMessageId || "",
    escalationMessageId: alert.escalationMessageId || "",
  }, env).catch(() => {});
  return { ok: true, action: normalizedAction, alert, message };
}

export async function listWatcherAlerts(options = {}, env = process.env) {
  const store = await readAlertStore(env);
  const limit = Math.max(1, Math.min(500, Number(options.limit || 100) || 100));
  const severity = lower(options.severity || "");
  const status = lower(options.status || "");
  const source = lower(options.source || "");
  const alerts = [...store.alerts]
    .sort((left, right) => Date.parse(clean(left.createdAt)) - Date.parse(clean(right.createdAt)))
    .filter((alert) => !severity || lower(alert.severity) === severity)
    .filter((alert) => !status || lower(alert.status) === status)
    .filter((alert) => !source || lower(alert.source).includes(source));
  return {
    alerts: alerts.slice(-limit).reverse(),
    count: Math.min(alerts.length, limit),
    total: alerts.length,
    updatedAt: store.updatedAt || "",
    generatedAt: nowIso(),
  };
}
