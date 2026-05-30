import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { assertSanitizedAction } from "./llm-sanitizer.js";
import { enqueueAgentMessage } from "./messages.js";
import { principalForUserId, userPrincipal } from "./principal.js";
import { enqueueThreadInput, getThreadForPrincipal, listThreads, listThreadsForPrincipal } from "./threads.js";
import { assertResourceAccess, filterResourcesForPrincipal, isAdminPrincipal } from "./policy.js";
import { adminUserId, normalizeUserId } from "./users.js";

const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;
const timerDoctorGraceMs = 2 * 60 * 1000;
const timerCadences = new Set(["once", "daily", "weekly", "interval"]);

function parseClock(time = "09:00") {
  const match = String(time || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return { hour: 9, minute: 0 };
  return {
    hour: Math.max(0, Math.min(23, Number(match[1]))),
    minute: Math.max(0, Math.min(59, Number(match[2]))),
  };
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

export function nextRunAt(timer, from = new Date()) {
  const cadence = String(timer.cadence || "daily").toLowerCase();
  if (cadence === "once") {
    return new Date(timer.runAt || from.getTime() + hourMs).toISOString();
  }
  if (cadence === "interval") {
    return new Date(from.getTime() + parseIntervalMs(timer.every || "1d")).toISOString();
  }
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
    every,
    runAt: String(timer.runAt || (cadence === "once" ? legacyDueAt : "")).trim(),
    prompt: String(timer.prompt || timer.text || "").trim(),
    promptFile: String(timer.promptFile || "").trim(),
    enabled,
    createdAt: timer.createdAt || now.toISOString(),
  };
  normalized.nextRunAt = enabled
    ? String(timer.nextRunAt || legacyDueAt || nextRunAt(normalized, now)).trim()
    : null;
  return normalized;
}

export async function listTimers(env = process.env) {
  const paths = await ensureDataDirs(env);
  const timers = await readJson(paths.timers, []);
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
  const paths = await ensureDataDirs(env);
  const timers = await listTimers(env);
  const prompt = String(input.prompt || "").trim();
  const promptFile = String(input.promptFile || "").trim();
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
    cadence: String(input.cadence || "daily").trim().toLowerCase(),
    time: String(input.time || "09:00").trim(),
    every: String(input.every || "").trim() || null,
    prompt,
    promptFile,
    enabled: input.enabled !== false,
    createdAt: new Date().toISOString(),
  };
  timer.nextRunAt = nextRunAt(timer);
  timers.push(timer);
  await writeJson(paths.timers, timers);
  await appendEvent({ type: "timer_created", timerId: timer.id, label: timer.label, target: timer.target, ownerUserId: timer.ownerUserId }, env);
  return timer;
}

export async function createTimerForPrincipal(input, principal, env = process.env) {
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
  return timer.targetType === "thread"
    ? enqueueThreadInput(timer.target, input, env)
    : enqueueAgentMessage(timer.target, input, env);
}

export async function deleteTimer(id, env = process.env) {
  const paths = await ensureDataDirs(env);
  const timers = await listTimers(env);
  const next = timers.filter((timer) => timer.id !== id);
  await writeJson(paths.timers, next);
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

export async function runTimerNow(id, env = process.env, now = new Date(), options = {}) {
  const paths = dataPaths(env);
  const timers = await listTimers(env);
  const timer = timers.find((entry) => entry.id === id);
  if (!timer) {
    const error = new Error("timer_not_found");
    error.statusCode = 404;
    throw error;
  }
  const message = await enqueueTimerMessage(timer, "timer_manual_run", env, options.principal || null);
  timer.lastRunAt = now.toISOString();
  timer.nextRunAt = timer.cadence === "once" ? null : nextRunAt(timer, now);
  if (timer.cadence === "once") timer.enabled = false;
  delete timer.lastError;
  delete timer.lastErrorAt;
  await writeJson(paths.timers, timers);
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
  const paths = dataPaths(env);
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
  if (changed) await writeJson(paths.timers, next);
  return due;
}
