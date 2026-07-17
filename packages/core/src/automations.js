import {
  createConnectorPromptPushForPrincipal,
  deleteConnectorPromptPushForPrincipal,
  listConnectorPromptPushesForPrincipal,
  runConnectorPromptPush,
  updateConnectorPromptPushForPrincipal,
} from "./connector-pushes.js";
import {
  createGmailNotificationForPrincipal,
  deleteGmailNotificationForPrincipal,
  listGmailNotificationsForPrincipal,
  runGmailNotificationNowForPrincipal,
  updateGmailNotificationForPrincipal,
} from "./gmail-notifications.js";
import {
  createTimerForPrincipal,
  deleteTimerForPrincipal,
  listTimersForPrincipal,
  runTimerNowForPrincipal,
  updateTimerForPrincipal,
} from "./timers.js";
import { readUserOnboardingProfileForPrincipal } from "./user-onboarding.js";

function clean(value = "") {
  return String(value || "").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

function splitAutomationId(id = "", fallbackType = "") {
  const value = clean(id);
  const match = value.match(/^(timer|push|gmail_notification):(.+)$/);
  if (match) return { type: match[1], id: match[2] };
  return { type: lower(fallbackType), id: value };
}

function timerAutomation(timer = {}) {
  const requiredDesktop = clean(timer.requiredDesktop || timer.desktopSlug || timer.requiresDesktop);
  const requiredConnector = clean(timer.requiredConnector || timer.connector || timer.requiresConnector);
  return {
    automationId: `timer:${clean(timer.id)}`,
    rawId: clean(timer.id),
    type: "timer",
    provider: "timer",
    verb: "run",
    object: "timer",
    label: clean(timer.label || timer.id),
    enabled: timer.enabled !== false,
    targetType: clean(timer.targetType || "agent"),
    target: clean(timer.target),
    ownerUserId: clean(timer.ownerUserId),
    schedule: {
      cadence: clean(timer.cadence),
      time: clean(timer.time),
      timezone: clean(timer.timezone),
      every: clean(timer.every),
      runAt: clean(timer.runAt),
      nextRunAt: clean(timer.nextRunAt),
    },
    requirements: {
      desktop: requiredDesktop,
      connector: requiredConnector,
    },
    prompt: clean(timer.prompt),
    createdAt: clean(timer.createdAt),
    updatedAt: clean(timer.updatedAt),
    lastRunAt: clean(timer.lastRunAt),
    lastError: clean(timer.lastError),
    lastErrorAt: clean(timer.lastErrorAt),
    blockedReason: clean(timer.blockedReason),
    blockedConnector: clean(timer.blockedConnector),
    connectorState: clean(timer.connectorState),
  };
}

function pushType(push = {}) {
  return lower(push.automationType || push.notificationType || push.schedule?.type) === "gmail_notification"
    ? "gmail_notification"
    : "push";
}

function pushAutomation(push = {}) {
  const type = pushType(push);
  return {
    automationId: `${type}:${clean(push.id)}`,
    rawId: clean(push.id),
    type,
    provider: clean(push.connector || push.source),
    verb: "watch",
    object: type === "gmail_notification" ? "notification" : "connector_push",
    label: clean(push.label || push.id),
    enabled: push.enabled === true,
    targetType: clean(push.targetType),
    target: clean(push.target),
    ownerUserId: clean(push.ownerUserId || push.userId),
    schedule: {
      type: clean(push.schedule?.type || push.automationType),
      every: clean(push.schedule?.every),
      intervalMs: Number(push.schedule?.intervalMs || 0) || 0,
      nextRunAt: clean(push.nextRunAt || push.schedule?.nextRunAt),
    },
    sourceConfig: push.sourceConfig || {},
    safety: push.safety || {},
    promptTemplate: clean(push.promptTemplate || push.prompt),
    createdAt: clean(push.createdAt),
    updatedAt: clean(push.updatedAt),
    lastRunAt: clean(push.lastRunAt),
    lastDeliveredAt: clean(push.lastDeliveredAt),
    lastError: clean(push.lastError),
  };
}

function targetForArgs(args = {}, thread = null) {
  const targetType = lower(args.targetType || "thread");
  return clean(args.target || (targetType === "thread" ? thread?.id : ""));
}

function hasPatchValue(args = {}, key = "") {
  if (args[key] === undefined) return false;
  return !(typeof args[key] === "string" && clean(args[key]) === "");
}

function boolPatchValue(args = {}, key = "") {
  if (!hasPatchValue(args, key)) return undefined;
  const value = args[key];
  if (value === true || value === false) return value;
  const text = lower(value);
  if (text === "true") return true;
  if (text === "false") return false;
  return undefined;
}

function positiveNumberPatchValue(args = {}, key = "") {
  if (args[key] === undefined) return undefined;
  const value = Number(args[key]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function timerInput(args = {}, thread = null, timezone = "") {
  const targetType = lower(args.targetType || "thread");
  return {
    label: clean(args.label || "Recurring agent task"),
    targetType,
    target: targetForArgs(args, thread),
    cadence: lower(args.cadence || (clean(args.delay || args.runAt) ? "once" : "daily")),
    delay: clean(args.delay),
    runAt: clean(args.runAt),
    time: clean(args.time || "09:00"),
    timezone: clean(args.timezone || args.timeZone || timezone),
    every: clean(args.every || args.interval),
    prompt: clean(args.prompt),
    requiredDesktop: clean(args.requiredDesktop || args.desktopSlug || args.requiresDesktop),
    requiredConnector: clean(args.requiredConnector || args.connector || args.requiresConnector),
    enabled: args.enabled !== false,
  };
}

function timerPatch(args = {}, thread = null) {
  const patch = {};
  for (const key of ["label", "cadence", "delay", "runAt", "time", "timezone", "timeZone", "every", "prompt", "targetType", "target", "requiredDesktop", "desktopSlug", "requiresDesktop", "requiredConnector", "connector", "requiresConnector"]) {
    if (hasPatchValue(args, key)) patch[key] = args[key];
  }
  const enabled = boolPatchValue(args, "enabled");
  if (enabled !== undefined) patch.enabled = enabled;
  if (args.target === "" && lower(args.targetType) === "thread" && thread?.id) patch.target = thread.id;
  if (hasPatchValue(args, "interval") && patch.every === undefined) patch.every = args.interval;
  return patch;
}

function gmailNotificationInput(args = {}, thread = null) {
  return {
    label: clean(args.label || "Gmail notifications"),
    targetType: lower(args.targetType || "thread"),
    target: targetForArgs(args, thread),
    query: clean(args.query),
    interval: clean(args.interval || args.every),
    maxItemsPerRun: Number(args.maxItemsPerRun || 1) || 1,
    enabled: args.enabled !== false,
    allowBroadQuery: args.allowBroadQuery === true,
  };
}

function gmailNotificationPatch(args = {}, thread = null) {
  const patch = {};
  if (hasPatchValue(args, "label")) patch.label = clean(args.label);
  if (hasPatchValue(args, "query")) patch.query = clean(args.query);
  if (hasPatchValue(args, "interval") || hasPatchValue(args, "every")) patch.interval = clean(args.interval || args.every);
  const maxItemsPerRun = positiveNumberPatchValue(args, "maxItemsPerRun");
  if (maxItemsPerRun !== undefined) patch.maxItemsPerRun = maxItemsPerRun;
  const enabled = boolPatchValue(args, "enabled");
  if (enabled !== undefined) patch.enabled = enabled;
  const allowBroadQuery = boolPatchValue(args, "allowBroadQuery");
  if (allowBroadQuery !== undefined) patch.allowBroadQuery = allowBroadQuery;
  if (hasPatchValue(args, "targetType")) patch.targetType = lower(args.targetType);
  if (args.target === "" && lower(args.targetType) === "thread" && thread?.id) patch.target = thread.id;
  else if (hasPatchValue(args, "target")) patch.target = clean(args.target);
  if (hasPatchValue(args, "promptTemplate") || hasPatchValue(args, "prompt")) patch.promptTemplate = clean(args.promptTemplate || args.prompt);
  if (args.noReply !== undefined) patch.noReply = args.noReply === true;
  if (hasPatchValue(args, "noReplyBehavior")) patch.noReplyBehavior = clean(args.noReplyBehavior);
  return patch;
}

function connectorPushInput(args = {}, thread = null) {
  const provider = lower(args.provider || args.connector || "gmail");
  return {
    connector: provider,
    label: clean(args.label || `${provider} prompt push`),
    targetType: lower(args.targetType || "thread"),
    target: targetForArgs(args, thread),
    prompt: clean(args.prompt || args.promptTemplate),
    promptTemplate: clean(args.promptTemplate || args.prompt),
    sourceConfig: {
      query: clean(args.query),
      ...(args.sourceConfig && typeof args.sourceConfig === "object" ? args.sourceConfig : {}),
    },
    safety: {
      maxItemsPerRun: Number(args.maxItemsPerRun || 1) || 1,
      allowBroadQuery: args.allowBroadQuery === true,
      requireQuery: args.requireQuery !== false,
      noReplyBehavior: clean(args.noReplyBehavior),
    },
    automationType: lower(args.automationType || "connector_push"),
    schedule: {
      type: lower(args.scheduleType || "connector_push"),
      every: clean(args.every || args.interval),
    },
    enabled: args.enabled === true,
  };
}

function pushPatch(args = {}) {
  const patch = {};
  if (hasPatchValue(args, "label")) patch.label = clean(args.label);
  if (hasPatchValue(args, "prompt") || hasPatchValue(args, "promptTemplate")) {
    patch.prompt = clean(args.prompt || args.promptTemplate);
    patch.promptTemplate = clean(args.promptTemplate || args.prompt);
  }
  const enabled = boolPatchValue(args, "enabled");
  if (enabled !== undefined) patch.enabled = enabled;
  if (hasPatchValue(args, "query") || args.sourceConfig !== undefined) {
    patch.sourceConfig = {
      ...(args.sourceConfig && typeof args.sourceConfig === "object" ? args.sourceConfig : {}),
      ...(args.query !== undefined ? { query: clean(args.query) } : {}),
    };
  }
  const maxItemsPerRun = positiveNumberPatchValue(args, "maxItemsPerRun");
  const allowBroadQuery = boolPatchValue(args, "allowBroadQuery");
  if (maxItemsPerRun !== undefined || allowBroadQuery !== undefined || args.requireQuery !== undefined || args.noReplyBehavior !== undefined) {
    patch.safety = {
      ...(maxItemsPerRun !== undefined ? { maxItemsPerRun } : {}),
      ...(allowBroadQuery !== undefined ? { allowBroadQuery } : {}),
      ...(args.requireQuery !== undefined ? { requireQuery: args.requireQuery !== false } : {}),
      ...(args.noReplyBehavior !== undefined ? { noReplyBehavior: clean(args.noReplyBehavior) } : {}),
    };
  }
  return patch;
}

export async function listAutomationsForPrincipal(principal, env = process.env) {
  const [timers, pushes] = await Promise.all([
    listTimersForPrincipal(principal, env),
    listConnectorPromptPushesForPrincipal(principal, env),
  ]);
  return [
    ...timers.map(timerAutomation),
    ...pushes.map(pushAutomation),
  ].sort((a, b) => clean(a.label).localeCompare(clean(b.label), undefined, { sensitivity: "base" }));
}

export async function createAutomationForPrincipal(args = {}, principal, env = process.env, context = {}) {
  const type = lower(args.type || args.automationType || args.object || (lower(args.provider) === "timer" ? "timer" : ""));
  if (type === "timer") {
    const profile = await readUserOnboardingProfileForPrincipal(principal, env).catch(() => null);
    const timer = await createTimerForPrincipal(timerInput(args, context.thread || null, profile?.profile?.timezone || ""), principal, env);
    return { ok: true, automation: timerAutomation(timer), timer };
  }
  if (type === "gmail_notification") {
    const notification = await createGmailNotificationForPrincipal(gmailNotificationInput(args, context.thread || null), principal, env, { thread: context.thread || null });
    return { ok: true, automation: pushAutomation({ ...notification, automationType: "gmail_notification" }), notification };
  }
  if (type === "push" || type === "connector_push") {
    const push = await createConnectorPromptPushForPrincipal(connectorPushInput(args, context.thread || null), principal, env);
    return { ok: true, automation: pushAutomation(push), push };
  }
  const error = new Error("automation_type_unsupported");
  error.statusCode = 400;
  throw error;
}

export async function updateAutomationForPrincipal(args = {}, principal, env = process.env, context = {}) {
  const parsed = splitAutomationId(args.automationId || args.id, args.type || args.automationType);
  if (parsed.type === "timer") {
    const timer = await updateTimerForPrincipal(parsed.id, timerPatch(args, context.thread || null), principal, env);
    return { ok: true, automation: timerAutomation(timer), timer };
  }
  if (parsed.type === "gmail_notification") {
    const notification = await updateGmailNotificationForPrincipal(parsed.id, gmailNotificationPatch(args, context.thread || null), principal, env, { thread: context.thread || null });
    return { ok: true, automation: pushAutomation({ ...notification, automationType: "gmail_notification" }), notification };
  }
  if (parsed.type === "push" || parsed.type === "connector_push") {
    const push = await updateConnectorPromptPushForPrincipal(parsed.id, pushPatch(args), principal, env);
    return { ok: true, automation: pushAutomation(push), push };
  }
  const error = new Error("automation_type_required");
  error.statusCode = 400;
  throw error;
}

export async function setAutomationEnabledForPrincipal(args = {}, enabled = true, principal, env = process.env) {
  return updateAutomationForPrincipal({ ...args, enabled }, principal, env);
}

export async function deleteAutomationForPrincipal(args = {}, principal, env = process.env) {
  const parsed = splitAutomationId(args.automationId || args.id, args.type || args.automationType);
  if (parsed.type === "timer") return { ok: await deleteTimerForPrincipal(parsed.id, principal, env), automationId: `timer:${parsed.id}` };
  if (parsed.type === "gmail_notification") return { ok: await deleteGmailNotificationForPrincipal(parsed.id, principal, env), automationId: `gmail_notification:${parsed.id}` };
  if (parsed.type === "push" || parsed.type === "connector_push") return { ok: await deleteConnectorPromptPushForPrincipal(parsed.id, principal, env), automationId: `${parsed.type}:${parsed.id}` };
  const error = new Error("automation_type_required");
  error.statusCode = 400;
  throw error;
}

export async function runAutomationForPrincipal(args = {}, principal, env = process.env, context = {}) {
  const parsed = splitAutomationId(args.automationId || args.id, args.type || args.automationType);
  if (parsed.type === "timer") {
    return {
      ok: true,
      event: await runTimerNowForPrincipal(parsed.id, principal, env, new Date(), {
        connectorStatusProvider: context.connectorStatusProvider,
      }),
      automationId: `timer:${parsed.id}`,
    };
  }
  if (parsed.type === "gmail_notification") {
    return runGmailNotificationNowForPrincipal(parsed.id, principal, env, context.fetchImpl || fetch);
  }
  if (parsed.type === "push" || parsed.type === "connector_push") {
    const sourceItems = Array.isArray(args.sourceItems) ? args.sourceItems : [];
    return { ok: true, run: await runConnectorPromptPush(parsed.id, sourceItems, env, { principal, force: args.force === true }), automationId: `${parsed.type}:${parsed.id}` };
  }
  const error = new Error("automation_type_required");
  error.statusCode = 400;
  throw error;
}
