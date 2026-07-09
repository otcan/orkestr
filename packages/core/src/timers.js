import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { ensureDataDirs } from "../../storage/src/paths.js";
import { createTimerRepository } from "../../storage/src/repositories.js";
import { appendEvent } from "../../storage/src/store.js";
import { assertSanitizedAction } from "./llm-sanitizer.js";
import { enqueueAgentMessage } from "./messages.js";
import { principalForUserId, userPrincipal } from "./principal.js";
import { enqueueThreadInput, getThread, getThreadForPrincipal, listThreads, listThreadsForPrincipal } from "./threads.js";
import { assertResourceAccess, filterResourcesForPrincipal, isAdminPrincipal, policyError } from "./policy.js";
import { adminUserId, normalizeUserId } from "./users.js";

const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;
const timerDoctorGraceMs = 2 * 60 * 1000;
const defaultManualRunDedupeMs = 2 * 60 * 1000;
const timerCadences = new Set(["once", "daily", "weekly", "interval"]);

function parseClock(time = "09:00") {
  const match = String(time || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return { hour: 9, minute: 0 };
  return {
    hour: Math.max(0, Math.min(23, Number(match[1]))),
    minute: Math.max(0, Math.min(59, Number(match[2]))),
  };
}

function normalizeTimerTimezone(value = "") {
  const timezone = String(value || "").trim().slice(0, 80);
  if (!timezone) return "";
  try {
    return Intl.DateTimeFormat("en-US", { timeZone: timezone }).resolvedOptions().timeZone || timezone;
  } catch {
    const error = new Error("invalid_timer_timezone");
    error.statusCode = 400;
    throw error;
  }
}

function storedTimerTimezone(value = "") {
  try {
    return normalizeTimerTimezone(value);
  } catch {
    return "";
  }
}

function timeZoneParts(date = new Date(), timezone = "") {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function timeZoneOffsetMs(date = new Date(), timezone = "") {
  const parts = timeZoneParts(date, timezone);
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0);
  return localAsUtc - date.getTime();
}

function zonedWallClockToUtc(parts = {}, timezone = "") {
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
  let utcMs = localAsUtc;
  for (let index = 0; index < 3; index += 1) {
    utcMs = localAsUtc - timeZoneOffsetMs(new Date(utcMs), timezone);
  }
  return new Date(utcMs);
}

function addLocalDays(parts = {}, days = 1) {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, parts.hour, parts.minute, 0, 0));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

function nextZonedClockRunAt(timer, from = new Date()) {
  const timezone = normalizeTimerTimezone(timer.timezone);
  const cadence = String(timer.cadence || "daily").toLowerCase();
  const { hour, minute } = parseClock(timer.time || "09:00");
  const localNow = timeZoneParts(from, timezone);
  let candidateParts = { ...localNow, hour, minute };
  let candidate = zonedWallClockToUtc(candidateParts, timezone);
  if (candidate <= from) {
    candidateParts = addLocalDays(candidateParts, cadence === "weekly" ? 7 : 1);
    candidate = zonedWallClockToUtc(candidateParts, timezone);
  }
  return candidate.toISOString();
}

function parseIntervalMs(value) {
  const match = String(value || "").trim().match(/^(\d+)\s*(m|h|d)$/i);
  if (!match) return dayMs;
  const amount = Math.max(1, Number(match[1]));
  const unit = match[2].toLowerCase();
  if (unit === "m") return amount * 60 * 1000;
  if (unit === "h") return amount * hourMs;
  return amount * dayMs;
}

export function parseTimerDelayMs(value) {
  const text = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^in\s+/, "")
    .replace(/^after\s+/, "");
  if (!text) return null;
  const match = text.match(/^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i);
  if (!match) {
    const error = new Error("invalid_timer_delay");
    error.statusCode = 400;
    throw error;
  }
  const amount = Math.max(1, Number(match[1]));
  const unit = match[2].toLowerCase();
  if (["m", "min", "mins", "minute", "minutes"].includes(unit)) return amount * 60 * 1000;
  if (["h", "hr", "hrs", "hour", "hours"].includes(unit)) return amount * hourMs;
  return amount * dayMs;
}

export function timerRunAtFromDelay(value, from = new Date()) {
  const delayMs = parseTimerDelayMs(value);
  if (delayMs === null) return "";
  return new Date(from.getTime() + delayMs).toISOString();
}

function intervalText(milliseconds) {
  const ms = Math.max(60_000, Number(milliseconds || 0) || 0);
  if (ms % dayMs === 0) return `${ms / dayMs}d`;
  if (ms % hourMs === 0) return `${ms / hourMs}h`;
  return `${Math.max(1, Math.round(ms / 60_000))}m`;
}

function clockFromIso(value, fallback = "09:00") {
  const date = new Date(value || "");
  if (Number.isNaN(date.getTime())) return fallback;
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function cleanOptionalMetadata(value = "") {
  return String(value || "").trim().slice(0, 120);
}

function manualRunDedupeMs(env = process.env) {
  const parsed = Number(env.ORKESTR_TIMER_MANUAL_RUN_DEDUPE_MS || env.ORKESTR_TIMER_MANUAL_DEDUPE_MS || "");
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return defaultManualRunDedupeMs;
}

function recentManualRun(timer, now = new Date(), env = process.env) {
  const windowMs = manualRunDedupeMs(env);
  if (windowMs <= 0) return null;
  const lastMs = Date.parse(String(timer.lastManualRunAt || ""));
  if (!Number.isFinite(lastMs)) return null;
  const ageMs = now.getTime() - lastMs;
  if (ageMs < 0 || ageMs >= windowMs) return null;
  return {
    lastManualRunAt: String(timer.lastManualRunAt || ""),
    lastManualRunMessageId: String(timer.lastManualRunMessageId || ""),
    ageMs,
    windowMs,
  };
}

function timerOwnerUserId(timer, env = process.env) {
  return normalizeUserId(timer?.ownerUserId || timer?.userId || env.ORKESTR_ADMIN_USER_ID || adminUserId);
}

function timerOwnerIsAdmin(timer, env = process.env) {
  return timerOwnerUserId(timer, env) === normalizeUserId(env.ORKESTR_ADMIN_USER_ID || adminUserId);
}

async function principalForTimerOwner(timer, env = process.env) {
  const ownerUserId = timerOwnerUserId(timer, env);
  return await principalForUserId(ownerUserId, env) ||
    userPrincipal({ id: ownerUserId, role: "user", source: "timer-owner", displayName: ownerUserId });
}

async function assertTimerExecutionSanitized(timer, source, env = process.env, principal = null) {
  if (timerOwnerIsAdmin(timer, env)) return null;
  const ownerPrincipal = principal && !isAdminPrincipal(principal) ? principal : await principalForTimerOwner(timer, env);
  return assertSanitizedAction({
    action: "timer.execute",
    principal: ownerPrincipal,
    resource: {
      type: "timer",
      id: timer.id,
      ownerUserId: timerOwnerUserId(timer, env),
      target: timer.target,
      targetType: timer.targetType || "agent",
    },
    input: {
      source,
      label: timer.label || "",
      target: timer.target || "",
      targetType: timer.targetType || "",
      prompt: String(timer.prompt || "").slice(0, 8000),
      promptFile: timer.promptFile || "",
    },
  }, env);
}

function whatsappTimerThreadDefaults(thread, input = {}) {
  const binding = thread?.binding || {};
  const connector = String(binding.connector || "").trim().toLowerCase();
  if (connector !== "whatsapp" && !binding.chatId) return input;
  const chatId = String(binding.chatId || "").trim();
  if (!chatId) return input;
  return {
    ...input,
    connector: String(input.connector || "whatsapp").trim(),
    originSurface: String(input.originSurface || "timer").trim(),
    originTransport: String(input.originTransport || "timer").trim(),
    chatId,
    accountId: String(
      input.accountId ||
      binding.responderAccountId ||
      binding.outboundAccountId ||
      binding.senderAccountId ||
      binding.inboundAccountId ||
      "",
    ).trim(),
  };
}

export function nextRunAt(timer, from = new Date()) {
  const cadence = String(timer.cadence || "daily").toLowerCase();
  if (cadence === "once") {
    return new Date(timer.runAt || from.getTime() + hourMs).toISOString();
  }
  if (cadence === "interval") {
    return new Date(from.getTime() + parseIntervalMs(timer.every || "1d")).toISOString();
  }
  if (timer.timezone) return nextZonedClockRunAt(timer, from);
  const { hour, minute } = parseClock(timer.time || "09:00");
  const next = new Date(from);
  next.setHours(hour, minute, 0, 0);
  if (next <= from) {
    next.setDate(next.getDate() + (cadence === "weekly" ? 7 : 1));
  }
  return next.toISOString();
}

export function normalizeStoredTimer(timer, now = new Date(), env = process.env) {
  const status = String(timer.status || timer.legacy?.status || "").trim().toLowerCase();
  const repeat = timer.repeat && typeof timer.repeat === "object" ? timer.repeat : timer.legacy?.repeat || null;
  const repeatLabel = String(repeat?.label || repeat?.type || "").trim().toLowerCase();
  const everyMs = Number(repeat?.everyMs || 0) || 0;
  const legacyDueAt = String(timer.dueAt || timer.legacy?.dueAt || "").trim();
  const cadence = String(timer.cadence || "").trim().toLowerCase() ||
    (repeat
      ? repeatLabel === "weekly"
        ? "weekly"
        : repeatLabel === "daily" || everyMs === dayMs
          ? "daily"
          : "interval"
      : "once");
  const every = String(timer.every || "").trim() || (cadence === "interval" ? intervalText(everyMs || dayMs) : null);
  const enabled = timer.enabled !== false &&
    !["cancelled", "canceled", "disabled", "failed"].includes(status) &&
    !(status === "fired" && !repeat);
  const normalized = {
    ...timer,
    id: String(timer.id || randomUUID()).trim(),
    ownerUserId: normalizeUserId(timer.ownerUserId || timer.userId || env.ORKESTR_ADMIN_USER_ID || adminUserId),
    label: String(timer.label || repeatLabel || "Recurring agent task").trim(),
    targetType: String(timer.targetType || (timer.threadId ? "thread" : "agent")).trim(),
    target: String(timer.target || timer.threadId || timer.agentId || "coding-agent").trim(),
    cadence,
    time: String(timer.time || clockFromIso(legacyDueAt || timer.runAt)).trim(),
    timezone: storedTimerTimezone(timer.timezone),
    every,
    runAt: String(timer.runAt || (cadence === "once" ? legacyDueAt : "")).trim(),
    prompt: String(timer.prompt || timer.text || "").trim(),
    promptFile: String(timer.promptFile || "").trim(),
    requiredDesktop: cleanOptionalMetadata(timer.requiredDesktop || timer.desktopSlug || timer.requiresDesktop),
    requiredConnector: cleanOptionalMetadata(timer.requiredConnector || timer.connector || timer.requiresConnector),
    enabled,
    createdAt: timer.createdAt || now.toISOString(),
  };
  normalized.nextRunAt = enabled
    ? String(timer.nextRunAt || legacyDueAt || nextRunAt(normalized, now)).trim()
    : null;
  return normalized;
}

export async function listTimers(env = process.env) {
  const timers = await createTimerRepository(env).list();
  return timers.map((timer) => normalizeStoredTimer(timer, new Date(), env));
}

export async function listTimersForPrincipal(principal, env = process.env) {
  return filterResourcesForPrincipal(await listTimers(env), principal, env);
}

async function fileExists(filePath) {
  if (!filePath) return false;
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function timerIssue(timer, severity, code, message, details = {}) {
  return {
    severity,
    code,
    message,
    timerId: timer?.id || null,
    timerLabel: timer?.label || null,
    target: timer?.target || null,
    targetType: timer?.targetType || null,
    details,
  };
}

function timerStatusFromIssues(issues) {
  if (issues.some((issue) => issue.severity === "error")) return "broken";
  if (issues.some((issue) => issue.severity === "warning")) return "warning";
  return "ok";
}

export async function doctorTimers(env = process.env, now = new Date(), options = {}) {
  const paths = await ensureDataDirs(env);
  const issues = [];
  let storeExists = true;
  try {
    await fs.access(paths.timers);
  } catch (error) {
    if (error?.code === "ENOENT") {
      storeExists = false;
    } else {
      issues.push(timerIssue(null, "error", "timer_store_unreadable", "Timer store cannot be read.", {
        path: paths.timers,
        error: error?.message || String(error),
      }));
    }
  }

  let timers = [];
  if (Array.isArray(options.timers)) {
    timers = options.timers.map((timer) => normalizeStoredTimer(timer, now, env));
  } else {
    try {
      timers = await listTimers(env);
    } catch (error) {
      issues.push(timerIssue(null, "error", "timer_store_invalid", "Timer store is not valid JSON.", {
        path: paths.timers,
        error: error?.message || String(error),
      }));
    }
  }

  const threads = Array.isArray(options.threads)
    ? options.threads
    : await listThreads(env).catch(() => []);
  const threadKeys = new Set(threads.flatMap((thread) => [thread.id, thread.name, thread.bindingName].filter(Boolean).map(String)));
  const nowMs = now.getTime();

  for (const timer of timers) {
    const enabled = timer.enabled !== false;
    const cadence = String(timer.cadence || "").trim().toLowerCase();
    const nextMs = Date.parse(String(timer.nextRunAt || ""));
    if (!timerCadences.has(cadence)) {
      issues.push(timerIssue(timer, "error", "invalid_cadence", `Timer cadence "${cadence || "missing"}" is not supported.`));
    }
    if (!timer.prompt && !timer.promptFile) {
      issues.push(timerIssue(timer, "error", "missing_prompt", "Timer has neither prompt nor promptFile."));
    }
    if (timer.promptFile && !(await fileExists(timer.promptFile))) {
      issues.push(timerIssue(timer, "error", "missing_prompt_file", "Timer promptFile does not exist.", {
        promptFile: timer.promptFile,
      }));
    }
    if (String(timer.targetType || "").toLowerCase() === "thread" && !threadKeys.has(String(timer.target || ""))) {
      issues.push(timerIssue(timer, "error", "missing_thread_target", "Timer targets a thread that does not exist."));
    }
    if (enabled && !timer.nextRunAt) {
      issues.push(timerIssue(timer, "error", "missing_next_run", "Enabled timer has no nextRunAt."));
    } else if (enabled && Number.isNaN(nextMs)) {
      issues.push(timerIssue(timer, "error", "invalid_next_run", "Enabled timer nextRunAt is not a valid timestamp.", {
        nextRunAt: timer.nextRunAt,
      }));
    } else if (enabled && nextMs + timerDoctorGraceMs < nowMs) {
      issues.push(timerIssue(timer, "error", "timer_overdue", "Enabled timer is overdue; the timer loop may not be running.", {
        nextRunAt: timer.nextRunAt,
        overdueMs: nowMs - nextMs,
      }));
    }
    if (timer.lastError) {
      issues.push(timerIssue(timer, "warning", "last_timer_error", "Timer recorded a previous delivery error.", {
        lastError: timer.lastError,
        lastErrorAt: timer.lastErrorAt || null,
        failureCount: Number(timer.failureCount || 0) || 0,
      }));
    }
  }

  if (!storeExists && !issues.length) {
    issues.push(timerIssue(null, "warning", "timer_store_missing", "Timer store has not been initialized yet.", {
      path: paths.timers,
    }));
  }

  const enabledTimers = timers.filter((timer) => timer.enabled !== false);
  const dueTimers = enabledTimers.filter((timer) => {
    const nextMs = Date.parse(String(timer.nextRunAt || ""));
    return Number.isFinite(nextMs) && nextMs <= nowMs;
  });
  const status = timerStatusFromIssues(issues);
  const counts = {
    total: timers.length,
    enabled: enabledTimers.length,
    disabled: timers.length - enabledTimers.length,
    due: dueTimers.length,
    errors: issues.filter((issue) => issue.severity === "error").length,
    warnings: issues.filter((issue) => issue.severity === "warning").length,
  };
  const summary = status === "broken"
    ? `${counts.errors} timer problem${counts.errors === 1 ? "" : "s"} need attention.`
    : status === "warning"
      ? `${counts.warnings} timer warning${counts.warnings === 1 ? "" : "s"} found.`
      : `${counts.total} timer${counts.total === 1 ? "" : "s"} checked.`;
  return {
    ok: status !== "broken",
    status,
    summary,
    generatedAt: now.toISOString(),
    storePath: paths.timers,
    storeExists,
    counts,
    issues,
  };
}

export async function doctorTimersForPrincipal(principal, env = process.env, now = new Date()) {
  if (isAdminPrincipal(principal)) return doctorTimers(env, now);
  return doctorTimers(env, now, {
    timers: await listTimersForPrincipal(principal, env),
    threads: await listThreadsForPrincipal(principal, env),
  });
}

export async function createTimer(input, env = process.env) {
  const timerRepository = createTimerRepository(env);
  const timers = await listTimers(env);
  const prompt = String(input.prompt || "").trim();
  const promptFile = String(input.promptFile || "").trim();
  const delayedRunAt = timerRunAtFromDelay(input.delay || input.after || input.in);
  const runAt = String(input.runAt || input.dueAt || delayedRunAt || "").trim();
  const cadence = runAt ? "once" : String(input.cadence || "daily").trim().toLowerCase();
  if (!prompt && !promptFile) {
    const error = new Error("timer_prompt_required");
    error.statusCode = 400;
    throw error;
  }
  const timer = {
    id: randomUUID(),
    ownerUserId: normalizeUserId(input.ownerUserId || input.userId || env.ORKESTR_ADMIN_USER_ID || adminUserId),
    label: String(input.label || "Recurring agent task").trim(),
    targetType: String(input.targetType || (input.threadId ? "thread" : "agent")).trim(),
    target: String(input.target || input.threadId || input.agentId || "coding-agent").trim(),
    cadence,
    time: String(input.time || "09:00").trim(),
    timezone: normalizeTimerTimezone(input.timezone || input.timeZone),
    every: String(input.every || "").trim() || null,
    runAt,
    prompt,
    promptFile,
    requiredDesktop: cleanOptionalMetadata(input.requiredDesktop || input.desktopSlug || input.requiresDesktop),
    requiredConnector: cleanOptionalMetadata(input.requiredConnector || input.connector || input.requiresConnector),
    enabled: input.enabled !== false,
    createdAt: new Date().toISOString(),
  };
  timer.nextRunAt = nextRunAt(timer);
  timers.push(timer);
  await timerRepository.save(timers);
  await appendEvent({ type: "timer_created", timerId: timer.id, label: timer.label, target: timer.target, ownerUserId: timer.ownerUserId, timezone: timer.timezone || null }, env);
  return timer;
}

export async function createTimerForPrincipal(input, principal, env = process.env) {
  if (!isAdminPrincipal(principal) && !String(principal?.userId || "").trim()) {
    throw policyError("timer_owner_required", 403);
  }
  const targetType = String(input?.targetType || (input?.threadId ? "thread" : "agent")).trim().toLowerCase();
  const target = String(input?.target || input?.threadId || input?.agentId || "").trim();
  if (targetType === "thread" && target) {
    await getThreadForPrincipal(target, principal, env);
  }
  if (!isAdminPrincipal(principal)) {
    await assertSanitizedAction({
      action: "timer.create",
      principal,
      resource: { type: "timer", ownerUserId: principal?.userId || "" },
      input: {
        label: input?.label || "",
        targetType: input?.targetType || "",
        target: input?.target || input?.threadId || input?.agentId || "",
        cadence: input?.cadence || "",
        prompt: String(input?.prompt || "").slice(0, 8000),
        promptFile: input?.promptFile || "",
      },
    }, env);
  }
  return createTimer({
    ...input,
    ownerUserId: isAdminPrincipal(principal)
      ? normalizeUserId(input.ownerUserId || input.userId || env.ORKESTR_ADMIN_USER_ID || adminUserId)
      : normalizeUserId(principal?.userId),
  }, env);
}

async function enqueueTimerMessage(timer, source, env, principal = null) {
  await assertTimerExecutionSanitized(timer, source, env, principal);
  const input = {
    source,
    text: timer.prompt,
    promptFile: timer.promptFile || "",
    ownerUserId: timer.ownerUserId,
  };
  if (timer.targetType !== "thread") return enqueueAgentMessage(timer.target, input, env);
  const thread = await getThread(timer.target, env).catch(() => null);
  return enqueueThreadInput(thread?.id || timer.target, whatsappTimerThreadDefaults(thread, input), env);
}

export async function deleteTimer(id, env = process.env) {
  const timerRepository = createTimerRepository(env);
  const timers = await listTimers(env);
  const next = timers.filter((timer) => timer.id !== id);
  await timerRepository.save(next);
  if (timers.length !== next.length) {
    await appendEvent({ type: "timer_deleted", timerId: id }, env);
  }
  return timers.length !== next.length;
}

export async function deleteTimerForPrincipal(id, principal, env = process.env) {
  const timer = (await listTimers(env)).find((entry) => entry.id === id);
  if (!timer) return false;
  assertResourceAccess(principal, timer, "timer_delete", env);
  return deleteTimer(id, env);
}

function timerUpdatePatch(existing = {}, patch = {}, now = new Date()) {
  const next = { ...existing };
  const scheduleKeys = new Set(["cadence", "time", "timezone", "timeZone", "every", "runAt", "dueAt", "delay", "after", "in"]);
  let scheduleChanged = false;
  for (const [key, rawValue] of Object.entries(patch || {})) {
    if (rawValue === undefined) continue;
    if (key === "id" || key === "ownerUserId" || key === "userId" || key === "createdAt") continue;
    if (key === "timerId") continue;
    if (key === "threadId") {
      next.targetType = "thread";
      next.target = String(rawValue || "").trim();
      scheduleChanged = true;
      continue;
    }
    if (key === "agentId") {
      next.targetType = "agent";
      next.target = String(rawValue || "").trim();
      continue;
    }
    if (key === "timeZone") {
      next.timezone = normalizeTimerTimezone(rawValue);
      scheduleChanged = true;
      continue;
    }
    if (key === "timezone") {
      next.timezone = normalizeTimerTimezone(rawValue);
      scheduleChanged = true;
      continue;
    }
    if (["runAt", "dueAt", "delay", "after", "in"].includes(key)) {
      const delayedRunAt = timerRunAtFromDelay(rawValue);
      next.runAt = String(key === "delay" || key === "after" || key === "in" ? delayedRunAt : rawValue || "").trim();
      if (next.runAt) next.cadence = "once";
      scheduleChanged = true;
      continue;
    }
    if (key === "enabled") {
      next.enabled = rawValue !== false;
      scheduleChanged = true;
      continue;
    }
    next[key] = typeof rawValue === "string" ? rawValue.trim() : rawValue;
    if (scheduleKeys.has(key)) scheduleChanged = true;
  }
  if (next.cadence && !timerCadences.has(String(next.cadence).toLowerCase())) {
    const error = new Error("invalid_timer_cadence");
    error.statusCode = 400;
    throw error;
  }
  next.cadence = String(next.cadence || existing.cadence || "daily").toLowerCase();
  next.targetType = String(next.targetType || existing.targetType || "agent").trim();
  next.target = String(next.target || existing.target || "").trim();
  next.label = String(next.label || existing.label || "Recurring agent task").trim();
  next.prompt = String(next.prompt || "").trim();
  next.promptFile = String(next.promptFile || "").trim();
  next.time = String(next.time || "09:00").trim();
  next.every = String(next.every || "").trim() || null;
  next.enabled = next.enabled !== false;
  next.updatedAt = now.toISOString();
  if (scheduleChanged) {
    next.nextRunAt = next.enabled ? nextRunAt(next, now) : null;
  }
  return next;
}

export async function updateTimer(id, patch = {}, env = process.env, now = new Date()) {
  const timerRepository = createTimerRepository(env);
  const timerId = String(id || patch?.timerId || "").trim();
  const timers = await listTimers(env);
  let updated = null;
  const next = timers.map((timer) => {
    if (timer.id !== timerId) return timer;
    updated = timerUpdatePatch(timer, patch, now);
    return updated;
  });
  if (!updated) {
    const error = new Error("timer_not_found");
    error.statusCode = 404;
    throw error;
  }
  await timerRepository.save(next);
  await appendEvent({
    type: "timer_updated",
    timerId: updated.id,
    ownerUserId: updated.ownerUserId,
    target: updated.target,
    enabled: updated.enabled !== false,
  }, env);
  return updated;
}

export async function updateTimerForPrincipal(id, patch = {}, principal, env = process.env) {
  const timer = (await listTimers(env)).find((entry) => entry.id === id);
  if (!timer) {
    const error = new Error("timer_not_found");
    error.statusCode = 404;
    throw error;
  }
  assertResourceAccess(principal, timer, "timer_update", env);
  const targetType = String(patch?.targetType || (patch?.threadId ? "thread" : "")).trim().toLowerCase();
  const target = String(patch?.target || patch?.threadId || patch?.agentId || "").trim();
  if (targetType === "thread" && target) {
    await getThreadForPrincipal(target, principal, env);
  }
  if (!isAdminPrincipal(principal)) {
    await assertSanitizedAction({
      action: "timer.update",
      principal,
      resource: { type: "timer", id: timer.id, ownerUserId: timer.ownerUserId },
      input: {
        label: patch?.label || "",
        targetType: patch?.targetType || "",
        target: patch?.target || patch?.threadId || patch?.agentId || "",
        cadence: patch?.cadence || "",
        enabled: patch?.enabled,
        prompt: String(patch?.prompt || "").slice(0, 8000),
      },
    }, env);
  }
  return updateTimer(id, patch, env);
}

export async function runTimerNow(id, env = process.env, now = new Date(), options = {}) {
  const timerRepository = createTimerRepository(env);
  const timers = await listTimers(env);
  const timer = timers.find((entry) => entry.id === id);
  if (!timer) {
    const error = new Error("timer_not_found");
    error.statusCode = 404;
    throw error;
  }
  const duplicate = options.allowDuplicate === true ? null : recentManualRun(timer, now, env);
  if (duplicate) {
    return appendEvent(
      {
        type: "timer_manual_run",
        timerId: timer.id,
        ownerUserId: timer.ownerUserId,
        target: timer.target,
        messageId: duplicate.lastManualRunMessageId,
        label: timer.label,
        prompt: timer.prompt ? timer.prompt.slice(0, 240) : "",
        promptFile: timer.promptFile || "",
        deduped: true,
        skipped: true,
        skipReason: "recent_manual_run",
        lastManualRunAt: duplicate.lastManualRunAt,
        ageMs: duplicate.ageMs,
        dedupeWindowMs: duplicate.windowMs,
      },
      env,
    );
  }
  const message = await enqueueTimerMessage(timer, "timer_manual_run", env, options.principal || null);
  timer.lastRunAt = now.toISOString();
  timer.lastManualRunAt = now.toISOString();
  timer.lastManualRunMessageId = message.id;
  timer.nextRunAt = timer.cadence === "once" ? null : nextRunAt(timer, now);
  if (timer.cadence === "once") timer.enabled = false;
  delete timer.lastError;
  delete timer.lastErrorAt;
  await timerRepository.save(timers);
  return appendEvent(
    {
      type: "timer_manual_run",
      timerId: timer.id,
      ownerUserId: timer.ownerUserId,
      target: timer.target,
      messageId: message.id,
      label: timer.label,
      prompt: timer.prompt ? timer.prompt.slice(0, 240) : "",
      promptFile: timer.promptFile || "",
    },
    env,
  );
}

export async function runTimerNowForPrincipal(id, principal, env = process.env, now = new Date()) {
  const timer = (await listTimers(env)).find((entry) => entry.id === id);
  if (!timer) {
    const error = new Error("timer_not_found");
    error.statusCode = 404;
    throw error;
  }
  assertResourceAccess(principal, timer, "timer_run", env);
  return runTimerNow(id, env, now, { principal });
}

export async function markDueTimers(env = process.env, now = new Date()) {
  const timerRepository = createTimerRepository(env);
  const timers = await listTimers(env);
  let changed = false;
  const due = [];
  const next = [];
  for (const timer of timers) {
    if (!timer.enabled || !timer.nextRunAt || Date.parse(timer.nextRunAt) > now.getTime()) {
      next.push(timer);
      continue;
    }
    try {
      const message = await enqueueTimerMessage(timer, "timer_due", env);
      due.push(timer);
      changed = true;
      next.push({
        ...timer,
        enabled: timer.cadence === "once" ? false : timer.enabled,
        lastRunAt: now.toISOString(),
        nextRunAt: timer.cadence === "once" ? null : nextRunAt(timer, now),
        lastError: null,
        lastErrorAt: null,
      });
      await appendEvent(
        {
          ts: now.toISOString(),
          type: "timer_due",
          timerId: timer.id,
          ownerUserId: timer.ownerUserId,
          target: timer.target,
          targetType: timer.targetType || "agent",
          messageId: message.id,
          label: timer.label,
        },
        env,
      );
    } catch (error) {
      changed = true;
      next.push({
        ...timer,
        lastError: error?.message || String(error),
        lastErrorAt: now.toISOString(),
        failureCount: Number(timer.failureCount || 0) + 1,
      });
      await appendEvent(
        {
          ts: now.toISOString(),
          type: "timer_due_failed",
          timerId: timer.id,
          ownerUserId: timer.ownerUserId,
          target: timer.target,
          targetType: timer.targetType || "agent",
          label: timer.label,
          error: error?.message || String(error),
        },
        env,
      ).catch(() => {});
    }
  }
  if (changed) await timerRepository.save(next);
  return due;
}
