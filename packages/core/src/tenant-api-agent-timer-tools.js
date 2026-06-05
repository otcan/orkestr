import {
  createTimerForPrincipal,
  deleteTimerForPrincipal,
  listTimersForPrincipal,
  runTimerNowForPrincipal,
} from "./timers.js";
import { readUserOnboardingProfileForPrincipal } from "./user-onboarding.js";

function clean(value) {
  return String(value || "").trim();
}

function timerCreateInput(args = {}, thread = null, profileTimezone = "") {
  const targetType = clean(args.targetType || "thread").toLowerCase();
  const target = clean(args.target || (targetType === "thread" ? thread?.id : ""));
  const delay = clean(args.delay || args.after || args.in);
  const runAt = clean(args.runAt || args.dueAt);
  const cadence = delay || runAt ? "once" : clean(args.cadence || "daily").toLowerCase();
  return {
    label: clean(args.label),
    targetType,
    target,
    cadence,
    time: clean(args.time || "09:00"),
    timezone: clean(args.timezone || args.timeZone || profileTimezone),
    every: clean(args.every),
    delay,
    runAt,
    prompt: clean(args.prompt),
    enabled: args.enabled !== false,
  };
}

export function tenantApiAgentTimerToolDefinitions() {
  return [
    {
      type: "function",
      name: "orkestr_list_timers",
      description: "List timers visible to this tenant.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_create_timer",
      description: "Create a timer for this tenant from chat. Use this when the user asks to remind them, schedule a recurring check, or run a future task in this chat. For daily or weekly clock times, use the user's saved IANA timezone from the onboarding profile.",
      parameters: {
        type: "object",
        properties: {
          label: { type: "string", description: "Short timer label." },
          targetType: { type: "string", enum: ["thread", "agent"], description: "Usually thread for the current chat." },
          target: { type: "string", description: "Target thread or agent id. Use empty string to target the current chat." },
          cadence: { type: "string", enum: ["once", "daily", "weekly", "interval"], description: "Timer cadence." },
          delay: { type: "string", description: "Relative delay for one-shot timers, such as 2m, 10 minutes, or 2 hours. Empty string if unused." },
          runAt: { type: "string", description: "Absolute ISO time for one-shot timers. Empty string if unused." },
          time: { type: "string", description: "Clock time such as 09:00 for daily/weekly timers, or empty string for interval timers." },
          timezone: { type: "string", description: "IANA timezone for daily/weekly clock times, such as Europe/Berlin. Empty string for relative or interval timers." },
          every: { type: "string", description: "Interval expression such as 2h or 1d for interval timers, otherwise empty string." },
          prompt: { type: "string", description: "The instruction Orkestr should send when the timer fires." },
          enabled: { type: "boolean", description: "Whether the timer should be enabled immediately." },
        },
        required: ["label", "targetType", "target", "cadence", "delay", "runAt", "time", "timezone", "every", "prompt", "enabled"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_delete_timer",
      description: "Delete one of this tenant's timers.",
      parameters: {
        type: "object",
        properties: {
          timerId: { type: "string", description: "Timer id to delete." },
        },
        required: ["timerId"],
        additionalProperties: false,
      },
      strict: true,
    },
    {
      type: "function",
      name: "orkestr_run_timer",
      description: "Run one of this tenant's timers immediately.",
      parameters: {
        type: "object",
        properties: {
          timerId: { type: "string", description: "Timer id to run now." },
        },
        required: ["timerId"],
        additionalProperties: false,
      },
      strict: true,
    },
  ];
}

export async function runTenantApiAgentTimerTool(name = "", args = {}, context = {}, env = process.env) {
  const tool = clean(name);
  const principal = context.principal || null;
  if (tool === "orkestr_list_timers") {
    return { handled: true, result: { timers: await listTimersForPrincipal(principal, env) } };
  }
  if (tool === "orkestr_create_timer") {
    const profile = await readUserOnboardingProfileForPrincipal(principal, env).catch(() => null);
    return {
      handled: true,
      result: { timer: await createTimerForPrincipal(timerCreateInput(args, context.thread || null, profile?.profile?.timezone || ""), principal, env) },
    };
  }
  if (tool === "orkestr_delete_timer") {
    return { handled: true, result: { ok: await deleteTimerForPrincipal(args.timerId, principal, env) } };
  }
  if (tool === "orkestr_run_timer") {
    return { handled: true, result: { event: await runTimerNowForPrincipal(args.timerId, principal, env) } };
  }
  return { handled: false, result: null };
}
