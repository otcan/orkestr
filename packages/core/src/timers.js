import { randomUUID } from "node:crypto";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { enqueueAgentMessage } from "./messages.js";

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

export async function listTimers(env = process.env) {
  const paths = await ensureDataDirs(env);
  return readJson(paths.timers, []);
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
    target: String(input.target || "job-search-assistant").trim(),
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
  timer.lastRunAt = now.toISOString();
  timer.nextRunAt = nextRunAt(timer, now);
  await writeJson(paths.timers, timers);
  const message = await enqueueAgentMessage(
    timer.target,
    {
      source: "timer_manual_run",
      text: timer.prompt,
      promptFile: timer.promptFile || "",
    },
    env,
  );
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
  const next = timers.map((timer) => {
    if (!timer.enabled || !timer.nextRunAt || Date.parse(timer.nextRunAt) > now.getTime()) {
      return timer;
    }
    due.push(timer);
    changed = true;
    return {
      ...timer,
      lastRunAt: now.toISOString(),
      nextRunAt: nextRunAt(timer, now),
    };
  });
  if (changed) {
    await writeJson(paths.timers, next);
    for (const timer of due) {
      const message = await enqueueAgentMessage(
        timer.target,
        {
          source: "timer_due",
          text: timer.prompt,
          promptFile: timer.promptFile || "",
        },
        env,
      );
      await appendEvent(
        {
          ts: now.toISOString(),
          type: "timer_due",
          timerId: timer.id,
          target: timer.target,
          messageId: message.id,
          label: timer.label,
        },
        env,
      );
    }
  }
  return due;
}
