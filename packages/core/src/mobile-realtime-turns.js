import { createHash } from "node:crypto";
import { mobileDeviceContextIsActive } from "./mobile-devices.js";
import { createHushVoiceTurn } from "./hush-voice.js";
import { adminPrincipal, userPrincipal } from "./principal.js";
import { defaultAdminUser, getUser } from "./users.js";
import {
  getMobileRealtimeCall,
  getMobileRealtimeCallInternal,
  mutateMobileRealtimeCall,
  recordMobileRealtimeProgress,
} from "./mobile-realtime-store.js";

const ACTIVE_STATES = new Set(["connecting", "active", "reconnecting"]);
const SOURCE_KINDS = new Set(["typed", "provider_audio"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function clean(value = "") {
  return String(value || "").trim();
}

function hash(value = "") {
  return createHash("sha256").update(String(value)).digest("hex");
}

function httpError(code, statusCode, extra = {}) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  Object.assign(error, extra);
  return error;
}

function deterministicTurnId(callId, sourceKind, sourceId) {
  const bytes = Buffer.from(hash(`${clean(callId)}\n${clean(sourceKind)}:${clean(sourceId)}`).slice(0, 32), "hex");
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = bytes.toString("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
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

async function principalFor(call, env) {
  const user = await getUser(call.ownerUserId, env);
  if (user?.status === "disabled") throw httpError("mobile_realtime_owner_unavailable", 403);
  const principal = user?.role === "admin"
    ? adminPrincipal({ ...(user || defaultAdminUser(env)), id: call.ownerUserId })
    : userPrincipal({ ...(user || {}), id: call.ownerUserId, role: "user", source: "hush" });
  principal.source = "hush";
  return principal;
}

function turnForSource(call, sourceKind, sourceId) {
  return (call.turns || []).find((turn) =>
    clean(turn.sourceKind) === clean(sourceKind) && clean(turn.sourceId) === clean(sourceId)
  );
}

function acceptance(call, turn) {
  return {
    accepted: true,
    callId: clean(call.id),
    turnId: clean(turn.turnId),
    taskId: clean(turn.taskId),
    state: clean(turn.state) === "accepted" ? "accepted" : "queued",
  };
}

async function reserveTurn(callId, input, env) {
  return mutateMobileRealtimeCall(callId, (call, markDirty) => {
    if (!ACTIVE_STATES.has(clean(call.status))) throw httpError("mobile_realtime_call_inactive", 409);
    const existing = turnForSource(call, input.sourceKind, input.sourceId);
    if (existing) {
      if (clean(existing.contentHash) !== input.contentHash) throw httpError("mobile_realtime_turn_id_conflict", 409);
      if (clean(existing.status) === "accepted") return { created: false, acceptance: acceptance(call, existing) };
      existing.status = "reserving";
      existing.updatedAt = new Date().toISOString();
      call.activeTaskRunning = true;
      markDirty();
      return { created: true };
    }
    if (call.activeTaskRunning === true) {
      throw httpError("mobile_realtime_task_already_active", 409, { retryable: true });
    }
    const now = new Date().toISOString();
    call.turns = [...(call.turns || []), {
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      contentHash: input.contentHash,
      clientTurnId: input.clientTurnId,
      status: "reserving",
      turnId: "",
      taskId: "",
      state: "queued",
      createdAt: now,
      updatedAt: now,
    }];
    call.activeTaskRunning = true;
    markDirty();
    return { created: true };
  }, env);
}

async function completeTurn(callId, input, env) {
  const result = await mutateMobileRealtimeCall(callId, (call, markDirty) => {
    const stored = turnForSource(call, input.sourceKind, input.sourceId);
    if (!stored || clean(stored.contentHash) !== input.contentHash) {
      throw httpError("mobile_realtime_turn_not_reserved", 409);
    }
    if (clean(stored.status) === "accepted") {
      if (clean(stored.turnId) !== input.turnId) throw httpError("mobile_realtime_turn_id_conflict", 409);
      return { acceptance: acceptance(call, stored), eventRequired: false };
    }
    stored.status = "accepted";
    stored.turnId = input.turnId;
    stored.taskId = input.taskId || input.turnId;
    stored.state = input.state === "queued" ? "queued" : "accepted";
    stored.updatedAt = new Date().toISOString();
    call.activeTaskId = stored.taskId;
    call.activeTaskRunning = true;
    call.taskProjectionHash = "";
    call.finalSidebandDelivered = false;
    call.finalSidebandDeliveredAt = "";
    markDirty();
    return { acceptance: acceptance(call, stored), eventRequired: true };
  }, env);
  if (result.eventRequired) {
    await recordMobileRealtimeProgress(callId, {
      dedupeKey: `task:${result.acceptance.taskId}:accepted`,
      type: "task",
      taskId: result.acceptance.taskId,
      stage: "accepted",
      detail: "Orkestr accepted the request.",
    }, env).catch(() => {});
  }
  return result.acceptance;
}

async function failTurn(callId, input, env) {
  const changed = await mutateMobileRealtimeCall(callId, (call, markDirty) => {
    const stored = turnForSource(call, input.sourceKind, input.sourceId);
    if (!stored || clean(stored.status) === "accepted") return false;
    stored.status = "failed";
    stored.updatedAt = new Date().toISOString();
    call.activeTaskRunning = false;
    markDirty();
    return true;
  }, env).catch(() => false);
  if (changed) {
    await recordMobileRealtimeProgress(callId, {
      dedupeKey: `turn:${input.sourceKind}:${input.sourceId}:failed`,
      type: "task",
      stage: "failed",
      detail: "Orkestr could not accept the request. Please retry.",
      requiresUserAction: true,
    }, env).catch(() => {});
  }
}

export async function submitMobileRealtimeTurn(input = {}, options = {}) {
  const env = options.env || process.env;
  const callId = clean(input.callId);
  const sourceKind = clean(input.sourceKind);
  const rawSourceId = clean(input.sourceId);
  const sourceId = sourceKind === "typed" ? rawSourceId.toLowerCase() : rawSourceId;
  const text = clean(input.text);
  const locale = clean(input.locale);
  if (!callId || !SOURCE_KINDS.has(sourceKind) || !sourceId || sourceId.length > 200) {
    throw httpError("mobile_realtime_turn_source_invalid", 400);
  }
  if (sourceKind === "typed" && !UUID_PATTERN.test(sourceId)) throw httpError("mobile_realtime_turn_id_invalid", 400);
  if (!text || text.length > 50_000) throw httpError("mobile_realtime_turn_text_invalid", 400);
  if (locale.length < 2 || locale.length > 64) throw httpError("mobile_realtime_turn_locale_invalid", 400);
  if (input.device && input.principal) {
    await getMobileRealtimeCall(callId, { device: input.device, principal: input.principal }, { env });
  }
  const call = await getMobileRealtimeCallInternal(callId, env);
  if (!call) throw httpError("mobile_realtime_call_not_found", 404);
  const device = input.device || deviceFor(call);
  const deviceActive = options.dependencies?.deviceActive || mobileDeviceContextIsActive;
  if (!(await deviceActive(device, env))) throw httpError("mobile_device_revoked", 401);
  const principal = input.principal || await principalFor(call, env);
  const contentHash = hash(`${locale}\n${text}`);
  const clientTurnId = deterministicTurnId(callId, sourceKind, sourceId);
  const reserved = await reserveTurn(callId, { sourceKind, sourceId, contentHash, clientTurnId }, env);
  if (!reserved.created) return reserved.acceptance;
  try {
    const turn = await createHushVoiceTurn({
      device,
      principal,
      clientTurnId,
      transcript: text,
      locale,
      source: { kind: sourceKind, id: sourceId, callId },
    }, { env, dependencies: options.dependencies || {}, maxTranscriptLength: 50_000 });
    return completeTurn(callId, {
      sourceKind,
      sourceId,
      contentHash,
      turnId: turn.id,
      taskId: turn.id,
      state: turn.status === "queued" ? "queued" : "accepted",
    }, env);
  } catch (error) {
    await failTurn(callId, { sourceKind, sourceId }, env);
    throw error;
  }
}
