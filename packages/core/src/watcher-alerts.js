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
  next.alerts = [...next.alerts]
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
  if (alert?.mirrorToConnector === false) return {};
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
    mirrorToConnector: input.mirrorToConnector !== false,
    createdAt,
  };
  const store = await readAlertStore(env);
  const latest = [...store.alerts].reverse().find((item) => clean(item.id) === alert.id);
  const dedupeMs = watcherDedupeWindowMs(env);
  if (latest && dedupeMs > 0 && Date.now() - Date.parse(clean(latest.createdAt)) <= dedupeMs) {
    await appendEvent({
      type: "watcher_alert_deduped",
      alertId: alert.id,
      source: alert.source,
      code: alert.code,
      threadId: alert.threadId || "",
    }, env).catch(() => {});
    return { ok: true, skipped: true, reason: "deduped", alert: latest };
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
  await writeAlertStore({ ...store, alerts: [...store.alerts, recorded] }, env);
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
