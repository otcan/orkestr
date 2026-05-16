import { randomUUID } from "node:crypto";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { enqueueAgentMessage } from "./messages.js";
import { enqueueThreadInput } from "./threads.js";

const hourMs = 60 * 60 * 1000;
const dayMs = 24 * hourMs;

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

export function normalizeStoredTimer(timer, now = new Date()) {
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
    label: String(timer.label || repeatLabel || "Recurring agent task").trim(),
    targetType: String(timer.targetType || (timer.threadId ? "thread" : "agent")).trim(),
    target: String(timer.target || timer.threadId || timer.agentId || "job-search-assistant").trim(),
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
  return timers.map((timer) => normalizeStoredTimer(timer));
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
    label: String(input.label || "Recurring agent task").trim(),
    targetType: String(input.targetType || (input.threadId ? "thread" : "agent")).trim(),
    target: String(input.target || input.threadId || input.agentId || "job-search-assistant").trim(),
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
  await appendEvent({ type: "timer_created", timerId: timer.id, label: timer.label, target: timer.target }, env);
  return timer;
}

async function enqueueTimerMessage(timer, source, env) {
  const input = {
    source,
    text: timer.prompt,
    promptFile: timer.promptFile || "",
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

export async function runTimerNow(id, env = process.env, now = new Date()) {
  const paths = dataPaths(env);
  const timers = await listTimers(env);
  const timer = timers.find((entry) => entry.id === id);
  if (!timer) {
    const error = new Error("timer_not_found");
    error.statusCode = 404;
    throw error;
  }
  const message = await enqueueTimerMessage(timer, "timer_manual_run", env);
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
      target: timer.target,
      messageId: message.id,
      label: timer.label,
      prompt: timer.prompt ? timer.prompt.slice(0, 240) : "",
      promptFile: timer.promptFile || "",
    },
    env,
  );
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
