import { appendEvent } from "../../storage/src/store.js";
import { runGmailPromptPush } from "../../connectors/src/gmail-prompt-push.js";
import {
  createConnectorPromptPush,
  createConnectorPromptPushForPrincipal,
  deleteConnectorPromptPushForPrincipal,
  getConnectorPromptPush,
  listConnectorPromptPushes,
  listConnectorPromptPushesForPrincipal,
  updateConnectorPromptPush,
} from "./connector-pushes.js";
import { isAdminPrincipal } from "./policy.js";
import { adminUserId, normalizeUserId } from "./users.js";

const minuteMs = 60_000;
const hourMs = 60 * minuteMs;
const dayMs = 24 * hourMs;
const defaultMinIntervalMs = 5 * minuteMs;
const hardMaxItemsPerRun = 5;
const defaultQuery = "is:unread newer_than:1d";
const notificationAutomationType = "gmail_notification";
const defaultPromptTemplate = [
  "New Gmail message",
  "From: {{from}}",
  "Subject: {{subject}}",
  "Date: {{date}}",
  "Snippet: {{snippet}}",
].join("\n");

function clean(value) {
  return String(value || "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return value === true || value === "true" || value === 1 || value === "1";
}

function nowIso(now = new Date()) {
  return now.toISOString();
}

function notificationError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function gmailNotificationsEnabled(env = process.env) {
  return ["1", "true", "on", "yes"].includes(lower(env.ORKESTR_GMAIL_NOTIFICATIONS_ENABLED));
}

export function gmailNotificationMinIntervalMs(env = process.env) {
  const parsed = Number(env.ORKESTR_GMAIL_NOTIFICATION_MIN_INTERVAL_MS || defaultMinIntervalMs);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : defaultMinIntervalMs;
}

export function gmailNotificationMaxItemsPerRun(env = process.env) {
  const parsed = Number(env.ORKESTR_GMAIL_NOTIFICATION_MAX_ITEMS_PER_RUN || hardMaxItemsPerRun);
  return Math.max(1, Math.min(hardMaxItemsPerRun, Number.isFinite(parsed) ? Math.floor(parsed) : hardMaxItemsPerRun));
}

function gmailNotificationDefaultQuery(env = process.env) {
  return clean(env.ORKESTR_GMAIL_NOTIFICATION_DEFAULT_QUERY) || defaultQuery;
}

function parseIntervalMs(value, fallbackMs) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  const text = clean(value).toLowerCase();
  if (!text) return fallbackMs;
  if (/^\d+$/.test(text)) return Number(text);
  const match = text.match(/^(\d+)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/);
  if (!match) return fallbackMs;
  const amount = Math.max(1, Number(match[1]));
  const unit = match[2];
  if (unit === "ms") return amount;
  if (["s", "sec", "secs", "second", "seconds"].includes(unit)) return amount * 1000;
  if (["m", "min", "mins", "minute", "minutes"].includes(unit)) return amount * minuteMs;
  if (["h", "hr", "hrs", "hour", "hours"].includes(unit)) return amount * hourMs;
  return amount * dayMs;
}

function intervalLabel(intervalMs) {
  const ms = Math.max(1, Number(intervalMs || 0) || defaultMinIntervalMs);
  if (ms % dayMs === 0) return `${ms / dayMs}d`;
  if (ms % hourMs === 0) return `${ms / hourMs}h`;
  if (ms % minuteMs === 0) return `${ms / minuteMs}m`;
  return `${ms}ms`;
}

function normalizedIntervalMs(input = {}, env = process.env) {
  const requested = parseIntervalMs(input.intervalMs ?? input.everyMs ?? input.interval ?? input.every, gmailNotificationMinIntervalMs(env));
  return Math.max(gmailNotificationMinIntervalMs(env), requested);
}

function normalizedMaxItems(input = {}, env = process.env) {
  const requested = Number(input.maxItemsPerRun ?? input.maxResults ?? 1);
  const max = Number.isFinite(requested) ? Math.floor(requested) : 1;
  return Math.max(1, Math.min(gmailNotificationMaxItemsPerRun(env), max || 1));
}

function isGmailNotification(push = {}) {
  return lower(push.connector || push.source) === "gmail" && lower(push.automationType || push.notificationType || push.schedule?.type) === notificationAutomationType;
}

function targetTypeFor(input = {}, context = {}) {
  return lower(input.targetType || (input.threadId || input.target || context.thread?.id ? "thread" : "agent")) || "thread";
}

function targetFor(input = {}, context = {}) {
  const targetType = targetTypeFor(input, context);
  return clean(input.target || input.threadId || input.agentId || (targetType === "thread" ? context.thread?.id : "coding-agent"));
}

function ownerUserIdFor(input = {}, principal = null, env = process.env) {
  if (principal && !isAdminPrincipal(principal)) return normalizeUserId(principal.userId);
  return normalizeUserId(input.ownerUserId || input.userId || env.ORKESTR_ADMIN_USER_ID || adminUserId);
}

function notificationPushInput(input = {}, principal = null, env = process.env, context = {}) {
  const intervalMs = normalizedIntervalMs(input, env);
  const requestedIntervalMs = parseIntervalMs(input.intervalMs ?? input.everyMs ?? input.interval ?? input.every, intervalMs);
  const maxItemsPerRun = normalizedMaxItems(input, env);
  const query = clean(input.query || input.sourceConfig?.query) || gmailNotificationDefaultQuery(env);
  const targetType = targetTypeFor(input, context);
  const target = targetFor(input, context);
  const enabled = input.enabled !== false;
  const nextRunAt = enabled ? nowIso() : "";
  return {
    connector: "gmail",
    automationType: notificationAutomationType,
    ownerUserId: ownerUserIdFor(input, principal, env),
    label: clean(input.label) || "Gmail notifications",
    targetType,
    target,
    promptTemplate: clean(input.promptTemplate || input.prompt) || defaultPromptTemplate,
    sourceConfig: {
      query,
      maxResults: maxItemsPerRun,
      account: clean(input.account || input.sourceConfig?.account),
      preview: "subject_from_date_snippet",
    },
    safety: {
      maxItemsPerRun,
      minIntervalMs: intervalMs,
      bodyPreviewChars: 0,
      requireQuery: true,
      allowBroadQuery: boolValue(input.allowBroadQuery || input.safety?.allowBroadQuery, false),
    },
    schedule: {
      type: notificationAutomationType,
      intervalMs,
      requestedIntervalMs,
      every: intervalLabel(intervalMs),
      nextRunAt,
    },
    nextRunAt,
    enabled,
  };
}

export function publicGmailNotification(push = {}, env = process.env) {
  const schedule = push.schedule && typeof push.schedule === "object" ? push.schedule : {};
  const sourceConfig = push.sourceConfig && typeof push.sourceConfig === "object" ? push.sourceConfig : {};
  const safety = push.safety && typeof push.safety === "object" ? push.safety : {};
  const intervalMs = Number(schedule.intervalMs || safety.minIntervalMs || gmailNotificationMinIntervalMs(env)) || gmailNotificationMinIntervalMs(env);
  return {
    id: clean(push.id),
    connector: "gmail",
    ownerUserId: normalizeUserId(push.ownerUserId || push.userId || env.ORKESTR_ADMIN_USER_ID || adminUserId),
    label: clean(push.label || "Gmail notifications"),
    targetType: lower(push.targetType || "thread"),
    target: clean(push.target),
    enabled: push.enabled === true,
    query: clean(sourceConfig.query),
    sourceConfig: {
      query: clean(sourceConfig.query),
      maxResults: Number(sourceConfig.maxResults || safety.maxItemsPerRun || 1) || 1,
      account: clean(sourceConfig.account),
      preview: clean(sourceConfig.preview || "subject_from_date_snippet"),
    },
    intervalMs,
    every: clean(schedule.every) || intervalLabel(intervalMs),
    nextRunAt: clean(push.nextRunAt || schedule.nextRunAt),
    safety: {
      maxItemsPerRun: Number(safety.maxItemsPerRun || 1) || 1,
      minIntervalMs: Number(safety.minIntervalMs || intervalMs) || intervalMs,
      allowBroadQuery: safety.allowBroadQuery === true,
      bodyPreviewChars: Number(safety.bodyPreviewChars || 0) || 0,
    },
    createdAt: clean(push.createdAt),
    updatedAt: clean(push.updatedAt),
    lastRunAt: clean(push.lastRunAt),
    lastDeliveredAt: clean(push.lastDeliveredAt),
    deliveredCount: Number(push.deliveredCount || 0) || 0,
    processedSourceItemCount: Array.isArray(push.processedSourceItemIds) ? push.processedSourceItemIds.length : 0,
    lastError: clean(push.lastError),
    lastErrorAt: clean(push.lastErrorAt),
    failureCount: Number(push.failureCount || 0) || 0,
  };
}

function publicRunResult(result = {}) {
  return {
    pushId: clean(result.pushId),
    connector: clean(result.connector),
    query: clean(result.query),
    resultSizeEstimate: Number(result.resultSizeEstimate || 0) || 0,
    delivered: Array.isArray(result.delivered) ? result.delivered : [],
    skipped: Array.isArray(result.skipped) ? result.skipped : [],
    failed: Array.isArray(result.failed) ? result.failed : [],
  };
}

export async function listGmailNotifications(env = process.env) {
  return (await listConnectorPromptPushes(env))
    .filter(isGmailNotification)
    .map((push) => publicGmailNotification(push, env));
}

export async function listGmailNotificationsForPrincipal(principal, env = process.env) {
  return (await listConnectorPromptPushesForPrincipal(principal, env))
    .filter(isGmailNotification)
    .map((push) => publicGmailNotification(push, env));
}

export async function createGmailNotification(input = {}, env = process.env) {
  if (!gmailNotificationsEnabled(env)) throw notificationError("gmail_notifications_disabled", 403);
  const push = await createConnectorPromptPush(notificationPushInput(input, null, env), env);
  await appendEvent({ type: "gmail_notification_created", notificationId: push.id, ownerUserId: push.ownerUserId, targetType: push.targetType, target: push.target }, env).catch(() => {});
  return publicGmailNotification(push, env);
}

export async function createGmailNotificationForPrincipal(input = {}, principal, env = process.env, context = {}) {
  if (!gmailNotificationsEnabled(env)) throw notificationError("gmail_notifications_disabled", 403);
  const push = await createConnectorPromptPushForPrincipal(notificationPushInput(input, principal, env, context), principal, env);
  await appendEvent({ type: "gmail_notification_created", notificationId: push.id, ownerUserId: push.ownerUserId, targetType: push.targetType, target: push.target }, env).catch(() => {});
  return publicGmailNotification(push, env);
}

export async function deleteGmailNotificationForPrincipal(id, principal, env = process.env) {
  const push = await getConnectorPromptPush(id, env);
  if (!push || !isGmailNotification(push)) return false;
  return deleteConnectorPromptPushForPrincipal(id, principal, env);
}

async function getStoredGmailNotification(id, env = process.env) {
  const push = await getConnectorPromptPush(id, env);
  if (!push || !isGmailNotification(push)) throw notificationError("gmail_notification_not_found", 404);
  return push;
}

async function scheduleAfterRun(push = {}, env = process.env, now = new Date(), patch = {}) {
  const intervalMs = Number(push.schedule?.intervalMs || push.safety?.minIntervalMs || gmailNotificationMinIntervalMs(env)) || gmailNotificationMinIntervalMs(env);
  const nextRunAt = push.enabled === true ? new Date(now.getTime() + intervalMs).toISOString() : "";
  return updateConnectorPromptPush(push.id, {
    ...patch,
    nextRunAt,
    schedule: {
      ...(push.schedule || {}),
      type: notificationAutomationType,
      intervalMs,
      every: intervalLabel(intervalMs),
      nextRunAt,
      lastScheduledRunAt: now.toISOString(),
    },
  }, env);
}

export async function runGmailNotificationNow(id, env = process.env, fetchImpl = fetch, options = {}) {
  if (!gmailNotificationsEnabled(env)) throw notificationError("gmail_notifications_disabled", 403);
  const now = options.now instanceof Date ? options.now : new Date();
  const push = await getStoredGmailNotification(id, env);
  try {
    const result = await runGmailPromptPush(push.id, env, fetchImpl, {
      ...options,
      force: options.force !== false,
    });
    const latest = result.push || await getStoredGmailNotification(push.id, env);
    const updated = await scheduleAfterRun(latest, env, now, {
      lastError: "",
      lastErrorAt: "",
    });
    await appendEvent({
      ts: now.toISOString(),
      type: "gmail_notification_run",
      notificationId: push.id,
      ownerUserId: push.ownerUserId,
      targetType: push.targetType,
      target: push.target,
      delivered: result.delivered?.length || 0,
      skipped: result.skipped?.length || 0,
      failed: result.failed?.length || 0,
    }, env).catch(() => {});
    return { ok: true, notification: publicGmailNotification(updated, env), run: publicRunResult(result) };
  } catch (error) {
    const failed = await scheduleAfterRun(push, env, now, {
      lastError: clean(error?.message || error).slice(0, 500),
      lastErrorAt: now.toISOString(),
      failureCount: Number(push.failureCount || 0) + 1,
    }).catch(() => push);
    await appendEvent({
      ts: now.toISOString(),
      type: "gmail_notification_run_failed",
      notificationId: push.id,
      ownerUserId: push.ownerUserId,
      targetType: push.targetType,
      target: push.target,
      error: clean(error?.message || error).slice(0, 500),
    }, env).catch(() => {});
    error.notification = publicGmailNotification(failed, env);
    throw error;
  }
}

export async function runGmailNotificationNowForPrincipal(id, principal, env = process.env, fetchImpl = fetch, options = {}) {
  return runGmailNotificationNow(id, env, fetchImpl, {
    ...options,
    principal,
  });
}

export async function runDueGmailNotifications(env = process.env, now = new Date(), fetchImpl = fetch) {
  if (!gmailNotificationsEnabled(env)) return [];
  const pushes = (await listConnectorPromptPushes(env)).filter(isGmailNotification);
  const due = pushes.filter((push) => {
    if (push.enabled !== true) return false;
    const nextMs = Date.parse(clean(push.nextRunAt || push.schedule?.nextRunAt));
    return !Number.isFinite(nextMs) || nextMs <= now.getTime();
  });
  const results = [];
  for (const push of due) {
    try {
      results.push(await runGmailNotificationNow(push.id, env, fetchImpl, { now, force: false }));
    } catch (error) {
      results.push({
        ok: false,
        notificationId: push.id,
        notification: error.notification || publicGmailNotification(push, env),
        error: clean(error?.message || error),
      });
    }
  }
  return results;
}
