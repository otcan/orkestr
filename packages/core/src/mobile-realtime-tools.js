import { createHash } from "node:crypto";
import { mobileDeviceContextIsActive } from "./mobile-devices.js";
import { adminPrincipal, userPrincipal } from "./principal.js";
import { defaultAdminUser, getUser } from "./users.js";
import { createHushVoiceTurn, getHushVoiceTurn, hushSpeech } from "./hush-voice.js";
import {
  getMobileRealtimeCallInternal,
  mutateMobileRealtimeCall,
  recordMobileRealtimeProgress,
} from "./mobile-realtime-store.js";

const ALLOWED_TOOLS = new Set(["orkestr_start_task", "orkestr_get_task_status"]);

function clean(value = "") {
  return String(value || "").trim();
}

function hash(value = "") {
  return createHash("sha256").update(String(value)).digest("hex");
}

function toolError(code, retryable = false) {
  return { ok: false, error: { code, retryable } };
}

function deterministicTurnId(callId, toolCallId) {
  const bytes = Buffer.from(hash(`${clean(callId)}\n${clean(toolCallId)}`).slice(0, 32), "hex");
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = bytes.toString("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}


async function principalFor(call, env) {
  const user = await getUser(call.ownerUserId, env);
  if (user?.status === "disabled") throw new Error("mobile_realtime_owner_unavailable");
  const principal = user?.role === "admin"
    ? adminPrincipal({ ...(user || defaultAdminUser(env)), id: call.ownerUserId })
    : userPrincipal({ ...(user || {}), id: call.ownerUserId, role: "user", source: "hush" });
  principal.source = "hush";
  return principal;
}

function deviceFor(call) {
  return {
    deviceId: call.deviceId,
    sessionId: call.sessionId,
    profileId: call.profileId,
    ownerUserId: call.ownerUserId,
    threadId: call.threadId,
    ...(call.mirrorRepliesToWhatsApp === true ? { mirrorRepliesToWhatsApp: true } : {}),
  };
}

function parseArguments(value) {
  const parsed = typeof value === "string" ? JSON.parse(value || "{}") : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid_arguments");
  return parsed;
}

async function existingToolResult(callId, toolCallId, name, argsHash, env) {
  const call = await getMobileRealtimeCallInternal(callId, env);
  const existing = (call?.toolCalls || []).find((item) => clean(item.toolCallId) === clean(toolCallId));
  if (!existing) return null;
  if (existing.name !== name || existing.argsHash !== argsHash) return toolError("mobile_realtime_tool_call_conflict");
  if (existing.status === "completed" || existing.status === "failed") return existing.output;
  return toolError("mobile_realtime_tool_call_in_progress", true);
}

async function reserveTool(callId, toolCallId, name, argsHash, env) {
  return mutateMobileRealtimeCall(callId, (call, markDirty) => {
    if (!ALLOWED_TOOLS.has(name)) return toolError("mobile_realtime_tool_not_allowed");
    const existing = (call.toolCalls || []).find((item) => clean(item.toolCallId) === clean(toolCallId));
    if (existing) {
      if (existing.name !== name || existing.argsHash !== argsHash) return toolError("mobile_realtime_tool_call_conflict");
      return existing.output || toolError("mobile_realtime_tool_call_in_progress", true);
    }
    if (name === "orkestr_start_task" && call.activeTaskRunning === true) {
      return toolError("mobile_realtime_task_already_active", true);
    }
    const configuredLimit = Number(env.ORKESTR_MOBILE_REALTIME_TOOL_LIMIT_PER_MINUTE || 30);
    const limit = Math.max(1, Math.min(120, Number.isFinite(configuredLimit) ? Math.floor(configuredLimit) : 30));
    const recent = (call.toolCalls || []).filter((item) =>
      Date.now() - Date.parse(item.createdAt || "") < 60_000
    );
    if (recent.length >= limit) return toolError("mobile_realtime_tool_rate_limited", true);
    call.toolCalls = [...(call.toolCalls || []), {
      toolCallId: clean(toolCallId),
      name,
      argsHash,
      status: "running",
      taskId: "",
      output: null,
      createdAt: new Date().toISOString(),
      completedAt: "",
    }];
    if (name === "orkestr_start_task") call.activeTaskRunning = true;
    markDirty();
    return { ok: true };
  }, env);
}

async function completeTool(callId, toolCallId, output, taskId, env) {
  return mutateMobileRealtimeCall(callId, (call, markDirty) => {
    const tool = (call.toolCalls || []).find((item) => clean(item.toolCallId) === clean(toolCallId));
    if (!tool) return output;
    tool.status = output?.ok === false ? "failed" : "completed";
    tool.output = output;
    tool.taskId = clean(taskId);
    tool.completedAt = new Date().toISOString();
    if (taskId) {
      call.activeTaskId = clean(taskId);
      call.finalSidebandDelivered = false;
      call.finalSidebandDeliveredAt = "";
    }
    if (tool.name === "orkestr_start_task" && output?.ok === false) call.activeTaskRunning = false;
    markDirty();
    return output;
  }, env);
}

async function startTask(call, toolCallId, args, env, dependencies) {
  if (Object.keys(args).some((key) => key !== "request")) return toolError("mobile_realtime_tool_arguments_invalid");
  const request = clean(args.request);
  if (!request || request.length > 12_000) return toolError("mobile_realtime_task_request_invalid");
  const principal = await principalFor(call, env);
  const turn = await createHushVoiceTurn({
    device: deviceFor(call),
    principal,
    clientTurnId: deterministicTurnId(call.id, toolCallId),
    transcript: request,
    locale: "und",
  }, { env, dependencies });
  await recordMobileRealtimeProgress(call.id, {
    dedupeKey: `task:${turn.id}:accepted`,
    type: "task",
    taskId: turn.id,
    stage: "accepted",
    detail: "Orkestr accepted the request.",
  }, env);
  return {
    accepted: true,
    taskId: turn.id,
    state: turn.status,
    spokenAcknowledgement: "I sent that to Orkestr.",
  };
}

async function taskStatus(call, args, env, dependencies) {
  if (Object.keys(args).some((key) => key !== "taskId")) return toolError("mobile_realtime_tool_arguments_invalid");
  const taskId = clean(args.taskId);
  if (!(call.toolCalls || []).some((item) => clean(item.taskId) === taskId && item.name === "orkestr_start_task")) {
    return toolError("mobile_realtime_task_not_found");
  }
  const turn = await getHushVoiceTurn(taskId, {
    device: deviceFor(call),
    principal: await principalFor(call, env),
  }, { env, dependencies });
  return {
    taskId,
    state: turn.status,
    requiresUserAction: false,
    ...(turn.status === "final" ? { answer: turn.answer, speech: turn.speech || hushSpeech(turn.answer) } : {}),
    ...(turn.status === "failed" ? { error: turn.error } : {}),
  };
}

export async function executeMobileRealtimeTool(input = {}, options = {}) {
  const env = options.env || process.env;
  const callId = clean(input.callId);
  const toolCallId = clean(input.toolCallId);
  const name = clean(input.name);
  if (!callId || !toolCallId || !ALLOWED_TOOLS.has(name)) return toolError("mobile_realtime_tool_not_allowed");
  let args;
  try {
    args = parseArguments(input.arguments);
  } catch {
    return toolError("mobile_realtime_tool_arguments_invalid");
  }
  const call = await getMobileRealtimeCallInternal(callId, env);
  if (!call || !["connecting", "active", "reconnecting"].includes(clean(call.status))) {
    return toolError("mobile_realtime_call_inactive");
  }
  const deviceActive = options.dependencies?.deviceActive || mobileDeviceContextIsActive;
  if (!(await deviceActive(deviceFor(call), env))) return toolError("mobile_device_revoked");
  const argsHash = hash(JSON.stringify(args));
  const existing = await existingToolResult(callId, toolCallId, name, argsHash, env);
  if (existing) return existing;
  const reservation = await reserveTool(callId, toolCallId, name, argsHash, env);
  if (reservation?.ok === false) return reservation;
  let output;
  let taskId = "";
  try {
    output = name === "orkestr_start_task"
      ? await startTask(call, toolCallId, args, env, options.dependencies || {})
      : await taskStatus(call, args, env, options.dependencies || {});
    taskId = clean(output?.taskId);
  } catch {
    output = toolError("mobile_realtime_tool_failed", true);
  }
  return completeTool(callId, toolCallId, output, taskId, env);
}

export async function reconcileMobileRealtimeTask(callId, options = {}) {
  const env = options.env || process.env;
  const call = await getMobileRealtimeCallInternal(callId, env);
  if (!call?.activeTaskId) return null;
  let turn;
  try {
    turn = await getHushVoiceTurn(call.activeTaskId, {
      device: deviceFor(call),
      principal: await principalFor(call, env),
    }, { env, dependencies: options.dependencies || {} });
  } catch {
    return null;
  }
  const projectionHash = hash(JSON.stringify({ status: turn.status, answer: turn.answer || "", error: turn.error || null }));
  if (call.taskProjectionHash === projectionHash) {
    return turn.status === "final" && call.finalSidebandDelivered !== true ? { event: null, turn } : null;
  }
  const details = {
    queued: ["queued", "Orkestr queued the request."],
    working: ["working", "Orkestr is working on the request."],
    final: ["completed", "Orkestr completed the request."],
    failed: ["failed", "Orkestr could not complete the request."],
  };
  const [stage, detail] = details[turn.status] || ["working", "Orkestr is processing the request."];
  const event = await recordMobileRealtimeProgress(callId, {
    dedupeKey: `task:${turn.id}:${projectionHash}`,
    type: "task",
    taskId: turn.id,
    stage,
    detail,
    ...(turn.status === "final" ? { answer: turn.answer || "" } : {}),
  }, env);
  await mutateMobileRealtimeCall(callId, (stored, markDirty) => {
    stored.taskProjectionHash = projectionHash;
    if (["final", "failed"].includes(turn.status)) stored.activeTaskRunning = false;
    markDirty();
  }, env);
  return event ? { event, turn } : null;
}

export function mobileRealtimeToolAllowed(name) {
  return ALLOWED_TOOLS.has(clean(name));
}
