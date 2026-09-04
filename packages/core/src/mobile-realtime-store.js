import { createHash, randomUUID } from "node:crypto";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { ensureDataDirs } from "../../storage/src/paths.js";
import { withStorageFileLock } from "../../storage/src/storage-lock.js";
import { snapshotEnvironment } from "../../storage/src/test-storage-isolation.js";
import { mobileDeviceContextIsActive } from "./mobile-devices.js";
import { getThreadForPrincipal, threadIsRetired } from "./threads.js";

const ACTIVE_STATES = new Set(["creating", "connecting", "active", "reconnecting", "ending"]);
const TERMINAL_STATES = new Set(["ended", "failed"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function clean(value = "") {
  return String(value || "").trim();
}

function nowIso() {
  return new Date().toISOString();
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

function positiveInt(env, key, fallback, minimum = 1) {
  const parsed = Number(env[key]);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.floor(parsed)) : fallback;
}

function defaults(raw = {}) {
  return {
    schemaVersion: 1,
    calls: Array.isArray(raw?.calls) ? raw.calls : [],
    updatedAt: clean(raw?.updatedAt),
  };
}

function boundedInt(env, key, fallback, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, positiveInt(env, key, fallback, minimum)));
}

function trimCallStore(store, env) {
  const limit = boundedInt(env, "ORKESTR_MOBILE_REALTIME_CALL_RETENTION", 2000, 100, 20_000);
  const ordered = [...store.calls].sort((left, right) =>
    Date.parse(clean(left.endedAt || left.createdAt)) - Date.parse(clean(right.endedAt || right.createdAt))
  );
  const terminal = ordered.filter((call) => TERMINAL_STATES.has(clean(call.status)));
  const removable = new Set(terminal
    .slice(0, Math.max(0, ordered.length - limit))
    .map((call) => clean(call.id)));
  store.calls = ordered.filter((call) => !removable.has(clean(call.id)));
}

async function withCallStore(env, operation) {
  const paths = await ensureDataDirs(env);
  return withStorageFileLock(paths.mobileRealtimeCalls, async () => {
    const store = defaults(await readJson(paths.mobileRealtimeCalls, { schemaVersion: 1, calls: [] }));
    let dirty = false;
    const result = await operation(store, () => { dirty = true; });
    if (dirty) {
      trimCallStore(store, env);
      store.updatedAt = nowIso();
      await writeJson(paths.mobileRealtimeCalls, store);
    }
    return result;
  });
}

function callForDevice(store, callId, device) {
  const call = store.calls.find((candidate) => clean(candidate.id) === clean(callId));
  if (!call || clean(call.deviceId) !== clean(device.deviceId) ||
      clean(call.profileId) !== clean(device.profileId) ||
      clean(call.sessionId) !== clean(device.sessionId)) {
    throw httpError("mobile_realtime_call_not_found", 404);
  }
  return call;
}

function safeCall(call = {}) {
  return {
    id: clean(call.id),
    clientCallId: clean(call.clientCallId),
    status: clean(call.status),
    createdAt: clean(call.createdAt),
    connectedAt: clean(call.connectedAt) || null,
    endedAt: clean(call.endedAt) || null,
    expiresAt: clean(call.expiresAt),
    endReason: clean(call.endReason) || null,
    activeTaskId: clean(call.activeTaskId) || null,
    lastEventId: Math.max(0, Number(call.lastEventId || 0)),
  };
}

function createResponse(call) {
  if (!clean(call.answerSdp)) throw httpError("mobile_realtime_call_not_ready", 409, { retryable: true });
  return {
    ...safeCall(call),
    answerSdp: call.answerSdp,
  };
}

function appendCallEvent(call, input = {}, env = process.env) {
  const eventId = Math.max(0, Number(call.lastEventId || 0)) + 1;
  call.lastEventId = eventId;
  const event = {
    version: 1,
    eventId,
    callId: clean(call.id),
    type: clean(input.type) || "progress",
    taskId: clean(input.taskId) || null,
    stage: clean(input.stage) || "connecting",
    detail: clean(input.detail).slice(0, 240),
    occurredAt: nowIso(),
    requiresUserAction: input.requiresUserAction === true,
    ...(typeof input.answer === "string" ? { answer: input.answer.slice(0, 50_000) } : {}),
  };
  const limit = boundedInt(env, "ORKESTR_MOBILE_REALTIME_EVENT_RETENTION", 2000, 100, 20_000);
  call.events = [...(Array.isArray(call.events) ? call.events : []), event].slice(-limit);
  return event;
}

function assertPrincipal(device, principal) {
  if (!clean(device.ownerUserId) || clean(device.ownerUserId) !== clean(principal?.userId)) {
    throw httpError("mobile_device_profile_forbidden", 403);
  }
  if (!clean(device.sessionId)) throw httpError("mobile_device_session_required", 401);
}

function callDurationMs(env) {
  return positiveInt(env, "ORKESTR_MOBILE_REALTIME_MAX_CALL_SECONDS", 1800) * 1000;
}

function callRateLimit(store, device, env) {
  const limit = positiveInt(env, "ORKESTR_MOBILE_REALTIME_CREATE_LIMIT_PER_MINUTE", 6);
  const recent = store.calls.filter((call) =>
    clean(call.deviceId) === clean(device.deviceId) && Date.now() - Date.parse(call.createdAt || "") < 60_000
  );
  if (recent.length >= limit) throw httpError("mobile_realtime_call_rate_limited", 429, { retryAfterSeconds: 60 });
}

function concurrencyLimit(store, device, env) {
  const active = store.calls.filter((call) => ACTIVE_STATES.has(clean(call.status)) && Date.parse(call.expiresAt || "") > Date.now());
  const globalLimit = positiveInt(env, "ORKESTR_MOBILE_REALTIME_MAX_CALLS_GLOBAL", 100);
  const deviceLimit = positiveInt(env, "ORKESTR_MOBILE_REALTIME_MAX_CALLS_PER_DEVICE", 1);
  const ownerLimit = positiveInt(env, "ORKESTR_MOBILE_REALTIME_MAX_CALLS_PER_OWNER", 2);
  if (active.length >= globalLimit) throw httpError("mobile_realtime_capacity_reached", 429);
  if (active.filter((call) => clean(call.deviceId) === clean(device.deviceId)).length >= deviceLimit) {
    throw httpError("mobile_realtime_device_call_limit", 409);
  }
  if (active.filter((call) => clean(call.ownerUserId) === clean(device.ownerUserId)).length >= ownerLimit) {
    throw httpError("mobile_realtime_owner_call_limit", 409);
  }
  // A profile owns a fixed thread. One live call may control that thread so
  // tool results can never cross between two phones or sessions.
  if (active.some((call) => clean(call.threadId) === clean(device.threadId))) {
    throw httpError("mobile_realtime_thread_busy", 409);
  }
}

export async function reserveMobileRealtimeCall(input = {}, options = {}) {
  const env = snapshotEnvironment(options.env || process.env);
  const dependencies = {
    deviceActive: mobileDeviceContextIsActive,
    getThreadForPrincipal,
    ...(options.dependencies || {}),
  };
  const device = input.device || {};
  const principal = input.principal || {};
  const clientCallId = clean(input.clientCallId);
  const offerSdp = String(input.offerSdp || "");
  assertPrincipal(device, principal);
  if (!UUID_PATTERN.test(clientCallId)) throw httpError("mobile_realtime_client_call_id_invalid", 400);
  if (offerSdp.length < 8 || offerSdp.length > 65_536 || !/^v=0(?:\r?\n|$)/.test(offerSdp)) {
    throw httpError("mobile_realtime_offer_invalid", 400);
  }
  if (!(await dependencies.deviceActive(device, env))) throw httpError("mobile_device_revoked", 401);
  const thread = await dependencies.getThreadForPrincipal(device.threadId, principal, env).catch(() => null);
  if (!thread || clean(thread.id) !== clean(device.threadId) ||
      threadIsRetired(thread) ||
      (clean(thread.ownerUserId) && clean(thread.ownerUserId) !== clean(device.ownerUserId))) {
    throw httpError("mobile_realtime_profile_thread_forbidden", 403);
  }
  const offerHash = hash(offerSdp);
  return withCallStore(env, async (store, markDirty) => {
    const existing = store.calls.find((call) =>
      clean(call.deviceId) === clean(device.deviceId) &&
      clean(call.sessionId) === clean(device.sessionId) &&
      clean(call.clientCallId) === clientCallId
    );
    if (existing) {
      if (clean(existing.offerHash) !== offerHash) throw httpError("mobile_realtime_client_call_id_conflict", 409);
      if (["failed", "ended"].includes(clean(existing.status))) {
        throw httpError("mobile_realtime_call_terminal", 409, { retryable: false });
      }
      if (!clean(existing.answerSdp)) throw httpError("mobile_realtime_call_in_progress", 409, { retryable: true });
      return { created: false, call: structuredClone(existing), response: createResponse(existing) };
    }
    callRateLimit(store, device, env);
    concurrencyLimit(store, device, env);
    const createdAt = nowIso();
    const call = {
      id: `mrc_${randomUUID()}`,
      clientCallId,
      offerHash,
      answerSdp: "",
      providerCallId: "",
      providerHangupPending: false,
      deviceId: clean(device.deviceId),
      sessionId: clean(device.sessionId),
      profileId: clean(device.profileId),
      ownerUserId: clean(device.ownerUserId),
      threadId: clean(device.threadId),
      mirrorRepliesToWhatsApp: device.mirrorRepliesToWhatsApp === true,
      bindingRevision: hash(`${clean(device.ownerUserId)}\n${clean(device.profileId)}\n${clean(device.threadId)}\n${device.mirrorRepliesToWhatsApp === true}`),
      status: "creating",
      createdAt,
      connectedAt: "",
      endedAt: "",
      expiresAt: new Date(Date.now() + callDurationMs(env)).toISOString(),
      endReason: "",
      activeTaskId: "",
      taskProjectionHash: "",
      lastProviderEventId: "",
      lastEventId: 0,
      leaseGeneration: 0,
      leaseOwner: "",
      leaseExpiresAt: "",
      toolCalls: [],
      events: [],
    };
    appendCallEvent(call, { type: "call", stage: "connecting", detail: "Connecting securely." }, env);
    store.calls.push(call);
    markDirty();
    await appendEvent({
      type: "mobile_realtime_call_reserved",
      callId: call.id,
      deviceId: call.deviceId,
      sessionId: call.sessionId,
      profileId: call.profileId,
      threadId: call.threadId,
    }, env).catch(() => {});
    return { created: true, call: structuredClone(call), response: null };
  });
}

export async function setMobileRealtimeProviderCall(callId, input = {}, env = process.env) {
  return withCallStore(env, async (store, markDirty) => {
    const call = store.calls.find((item) => clean(item.id) === clean(callId));
    if (!call || clean(call.status) !== "creating") throw httpError("mobile_realtime_call_not_found", 404);
    call.providerCallId = clean(input.providerCallId);
    call.answerSdp = String(input.answerSdp || "");
    call.status = "connecting";
    markDirty();
    return structuredClone(call);
  });
}

export async function activateMobileRealtimeCall(callId, env = process.env) {
  return withCallStore(env, async (store, markDirty) => {
    const call = store.calls.find((item) => clean(item.id) === clean(callId));
    if (!call || !["connecting", "reconnecting"].includes(clean(call.status))) {
      throw httpError("mobile_realtime_call_not_found", 404);
    }
    call.status = "active";
    call.connectedAt ||= nowIso();
    appendCallEvent(call, { type: "call", stage: "connected", detail: "Call connected." }, env);
    markDirty();
    return createResponse(call);
  });
}

export async function setMobileRealtimeCallState(callId, status, reason = "", env = process.env) {
  return withCallStore(env, async (store, markDirty) => {
    const call = store.calls.find((item) => clean(item.id) === clean(callId));
    if (!call) return null;
    call.status = clean(status);
    if (["ended", "failed"].includes(call.status)) {
      call.endedAt ||= nowIso();
      call.endReason = clean(reason).slice(0, 120) || call.status;
      call.leaseOwner = "";
      call.leaseExpiresAt = "";
      call.answerSdp = "";
    }
    appendCallEvent(call, {
      type: "call",
      stage: call.status,
      detail: call.status === "failed"
        ? "The realtime call ended unexpectedly."
        : call.status === "reconnecting"
          ? "Restoring the secure call controller."
          : call.status === "ending"
            ? "Ending the realtime call."
            : "The realtime call ended.",
    }, env);
    markDirty();
    return structuredClone(call);
  });
}

export async function getMobileRealtimeCall(callId, input = {}, options = {}) {
  const env = snapshotEnvironment(options.env || process.env);
  const device = input.device || {};
  assertPrincipal(device, input.principal || {});
  return withCallStore(env, async (store) => safeCall(callForDevice(store, callId, device)));
}

export async function getMobileRealtimeCallInternal(callId, env = process.env) {
  return withCallStore(env, async (store) => {
    const call = store.calls.find((item) => clean(item.id) === clean(callId));
    return call ? structuredClone(call) : null;
  });
}

export async function listMobileRealtimeCallEvents(callId, afterEventId, input = {}, options = {}) {
  const cursor = afterEventId === undefined || afterEventId === null || afterEventId === "" ? 0 : Number(afterEventId);
  if (!Number.isInteger(cursor) || cursor < 0) throw httpError("mobile_realtime_event_id_invalid", 400);
  const env = snapshotEnvironment(options.env || process.env);
  const device = input.device || {};
  assertPrincipal(device, input.principal || {});
  return withCallStore(env, async (store) => {
    const call = callForDevice(store, callId, device);
    return (Array.isArray(call.events) ? call.events : []).filter((event) => Number(event.eventId) > cursor);
  });
}

export async function recordMobileRealtimeProgress(callId, event, env = process.env) {
  return withCallStore(env, async (store, markDirty) => {
    const call = store.calls.find((item) => clean(item.id) === clean(callId));
    if (!call) throw httpError("mobile_realtime_call_not_found", 404);
    const dedupeKey = clean(event.dedupeKey);
    if (dedupeKey && clean(call.lastProgressDedupeKey) === dedupeKey) return null;
    const created = appendCallEvent(call, event, env);
    call.lastProgressDedupeKey = dedupeKey;
    markDirty();
    return created;
  });
}

export async function recordMobileRealtimeTranscript(callId, input = {}, env = process.env) {
  return withCallStore(env, async (store, markDirty) => {
    const call = store.calls.find((item) => clean(item.id) === clean(callId));
    if (!call || !ACTIVE_STATES.has(clean(call.status))) return null;
    const role = clean(input.role);
    const providerItemId = clean(input.providerItemId).slice(0, 200);
    const text = clean(input.text).slice(0, 12_000);
    if (!["user", "assistant"].includes(role) || !providerItemId || !text) return null;
    const transcriptId = `${role}:${providerItemId}`;
    if ((call.transcripts || []).some((item) => item.id === transcriptId)) return null;
    const transcript = { id: transcriptId, role, text, occurredAt: nowIso() };
    const limit = boundedInt(env, "ORKESTR_MOBILE_REALTIME_TRANSCRIPT_RETENTION", 200, 20, 2000);
    call.transcripts = [...(call.transcripts || []), transcript].slice(-limit);
    markDirty();
    return structuredClone(transcript);
  });
}

export async function mutateMobileRealtimeCall(callId, operation, env = process.env) {
  return withCallStore(env, async (store, markDirty) => {
    const call = store.calls.find((item) => clean(item.id) === clean(callId));
    if (!call) throw httpError("mobile_realtime_call_not_found", 404);
    const result = await operation(call, markDirty);
    return result === undefined ? structuredClone(call) : result;
  });
}

export async function claimMobileRealtimeLease(callId, owner, ttlMs = 15_000, env = process.env) {
  return mutateMobileRealtimeCall(callId, (call, markDirty) => {
    const currentOwner = clean(call.leaseOwner);
    const live = currentOwner && Date.parse(call.leaseExpiresAt || "") > Date.now();
    if (live && currentOwner !== owner) throw httpError("mobile_realtime_lease_held", 409);
    if (currentOwner !== owner) call.leaseGeneration = Number(call.leaseGeneration || 0) + 1;
    call.leaseOwner = owner;
    call.leaseExpiresAt = new Date(Date.now() + ttlMs).toISOString();
    markDirty();
    return { generation: call.leaseGeneration, expiresAt: call.leaseExpiresAt };
  }, env);
}

export async function releaseMobileRealtimeLease(callId, owner, env = process.env) {
  return mutateMobileRealtimeCall(callId, (call, markDirty) => {
    if (clean(call.leaseOwner) === clean(owner)) {
      call.leaseOwner = "";
      call.leaseExpiresAt = "";
      markDirty();
    }
    return true;
  }, env).catch(() => false);
}

export async function listRecoverableMobileRealtimeCalls(env = process.env) {
  return withCallStore(env, async (store) => store.calls
    .filter((call) => ACTIVE_STATES.has(clean(call.status)))
    .map((call) => structuredClone(call)));
}

export async function listPendingMobileRealtimeHangups(env = process.env) {
  return withCallStore(env, async (store) => store.calls
    .filter((call) => call.providerHangupPending === true && clean(call.providerCallId))
    .map((call) => structuredClone(call)));
}

export async function listMobileRealtimeCallsWithTasks(env = process.env) {
  return withCallStore(env, async (store) => store.calls
    .filter((call) => call.activeTaskRunning === true && clean(call.activeTaskId))
    .map((call) => structuredClone(call)));
}

export async function markMobileRealtimeFinalDelivered(callId, taskId, env = process.env) {
  return mutateMobileRealtimeCall(callId, (call, markDirty) => {
    if (clean(call.activeTaskId) !== clean(taskId)) return false;
    call.finalSidebandDelivered = true;
    call.finalSidebandDeliveredAt = nowIso();
    markDirty();
    return true;
  }, env);
}

export async function setMobileRealtimeHangupPending(callId, pending, env = process.env) {
  return mutateMobileRealtimeCall(callId, (call, markDirty) => {
    call.providerHangupPending = pending === true;
    call.lastHangupAttemptAt = nowIso();
    markDirty();
    return true;
  }, env).catch(() => false);
}

export function mobileRealtimeEventPollIntervalMs(env = process.env) {
  return Math.max(150, Math.min(5000, positiveInt(env, "ORKESTR_MOBILE_REALTIME_EVENT_POLL_MS", 300)));
}
