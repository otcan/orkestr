import { createHash, randomUUID } from "node:crypto";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { ensureDataDirs } from "../../storage/src/paths.js";
import { withStorageFileLock } from "../../storage/src/storage-lock.js";
import {
  enqueueThreadInputForPrincipal,
  getThreadForPrincipal,
  listThreadMessages,
} from "./threads.js";
import { requestThreadInputDelivery, runtimeStatus } from "./runtime-leases.js";
import { processApiAgentThreadInput, threadUsesApiAgent } from "./tenant-api-agent.js";
import { snapshotEnvironment } from "../../storage/src/test-storage-isolation.js";
import { createHushReplyDeliveryIntent } from "./reply-delivery-intent.js";

export const HUSH_MOBILE_MACHINE_AUTH = "mobile_device";
export const HUSH_MOBILE_ROUTE_KIND = "hush_mobile";

const TERMINAL_STATES = new Set(["final", "failed"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function clean(value = "") {
  return String(value || "").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

function nowIso() {
  return new Date().toISOString();
}

function httpError(message, statusCode, extra = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = message;
  Object.assign(error, extra);
  return error;
}

function transcriptHash(transcript, locale) {
  return createHash("sha256").update(`${clean(locale)}\n${clean(transcript)}`).digest("hex");
}

function turnStoreDefaults(raw = {}) {
  return {
    schemaVersion: 1,
    turns: Array.isArray(raw?.turns) ? raw.turns : [],
    updatedAt: clean(raw?.updatedAt),
  };
}

function retentionLimit(env = process.env) {
  const value = Number(env.ORKESTR_HUSH_TURN_RETENTION || 2000);
  return Math.max(100, Math.min(20_000, Number.isFinite(value) ? Math.floor(value) : 2000));
}

function trimTurnStore(store, env = process.env) {
  const limit = retentionLimit(env);
  const ordered = [...store.turns].sort((left, right) => Date.parse(clean(left.updatedAt || left.createdAt)) - Date.parse(clean(right.updatedAt || right.createdAt)));
  const terminal = ordered.filter((turn) => TERMINAL_STATES.has(lower(turn.status)));
  const removable = new Set(terminal.slice(0, Math.max(0, ordered.length - limit)).map((turn) => clean(turn.id)));
  store.turns = ordered.filter((turn) => !removable.has(clean(turn.id)));
}

async function withTurnStore(env, operation) {
  const paths = await ensureDataDirs(env);
  const filePath = paths.mobileVoiceTurns;
  return withStorageFileLock(filePath, async () => {
    const store = turnStoreDefaults(await readJson(filePath, { schemaVersion: 1, turns: [] }));
    let dirty = false;
    const result = await operation(store, () => { dirty = true; });
    if (dirty) {
      trimTurnStore(store, env);
      store.updatedAt = nowIso();
      await writeJson(filePath, store);
    }
    return result;
  });
}

function safeError(error = {}) {
  // Error messages can contain runtime, storage, or provider details. Only
  // known internal error codes may leave this boundary; everything else is a
  // stable public code.
  const candidate = clean(error.code);
  const code = /^(?:hush_|mobile_voice_)[a-z0-9_.:-]{0,100}$/i.test(candidate)
    ? candidate
    : "hush_turn_failed";
  return {
    code,
    retryable: error.retryable !== false,
    message: "Orkestr could not finish this turn. Try again from Hush.",
  };
}

export function hushSpeech(text) {
  const speech = clean(text)
    .replace(/```[\s\S]*?```/g, " Code is shown in the text response. ")
    .replace(/https?:\/\/\S+/g, " link ")
    .replace(/[`*_>#]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
  return speech || "The response is available on screen.";
}

function publicTurn(turn = {}) {
  const output = {
    id: clean(turn.id),
    clientTurnId: clean(turn.clientTurnId),
    status: lower(turn.status) || "queued",
    createdAt: clean(turn.createdAt),
    updatedAt: clean(turn.updatedAt),
    traceId: clean(turn.traceId),
  };
  if (lower(turn.status) === "final") {
    output.answer = clean(turn.answer);
    output.speech = clean(turn.speech) || hushSpeech(turn.answer);
  }
  if (lower(turn.status) === "failed" && turn.error) output.error = turn.error;
  return output;
}

function appendTurnEvent(turn, type) {
  const events = Array.isArray(turn.events) ? turn.events : [];
  const eventId = Math.max(0, ...events.map((event) => Number(event?.eventId || 0)).filter(Number.isFinite)) + 1;
  turn.events = [...events, {
    eventId,
    type,
    at: nowIso(),
    turn: publicTurn(turn),
  }];
}

function completedFinal(message) {
  return lower(message?.role) === "assistant" &&
    lower(message?.state) === "completed" &&
    lower(message?.phase) === "final_answer";
}

function canonicalExecutorTurnId(message = {}) {
  return clean(message?.codexTurnId || message?.executorTurnId);
}

function completedFinalFor(message, parentMessageId) {
  return completedFinal(message) && clean(message?.parentMessageId) === clean(parentMessageId);
}

function completedFinalForExecutorTurn(message, turnId) {
  const candidateTurnId = canonicalExecutorTurnId(message);
  return completedFinal(message) && Boolean(turnId) && Boolean(candidateTurnId) && candidateTurnId === turnId;
}

function runtimeWorking(status = {}) {
  return status?.working === true || status?.foregroundWorking === true ||
    ["working", "running", "busy"].includes(lower(status?.state || status?.status || status?.runtimeState));
}

function inputIndicatesWorking(input = {}, status = {}) {
  if (lower(input?.state) === "running") return true;
  return Boolean(clean(input?.deliveredAt) || lower(input?.deliveryState) === "delivered") && runtimeWorking(status);
}

function validClientTurnId(value) {
  return UUID_PATTERN.test(clean(value));
}

function deviceContextIdentifier(context, field) {
  if (typeof context?.[field] !== "string") throw httpError("mobile_device_profile_unavailable", 403);
  const value = context[field].trim();
  if (!value || value.length > 512) throw httpError("mobile_device_profile_unavailable", 403);
  return value;
}

/**
 * Returns only a context injected after device-proof authentication. This
 * function never reads body/query/header thread identifiers, so the caller
 * cannot select a different thread than its server-owned Hush profile.
 */
export function hushMobileDeviceContext(request = {}) {
  const context = request?.orkestrMachineAuthContext || {};
  if (request?.orkestrMachineAuth !== HUSH_MOBILE_MACHINE_AUTH ||
      clean(context.principalKind) !== HUSH_MOBILE_MACHINE_AUTH ||
      clean(context.routeKind) !== HUSH_MOBILE_ROUTE_KIND) {
    throw httpError("mobile_device_auth_required", 401);
  }
  const device = {
    deviceId: deviceContextIdentifier(context, "deviceId"),
    profileId: deviceContextIdentifier(context, "profileId"),
    threadId: deviceContextIdentifier(context, "threadId"),
    ownerUserId: deviceContextIdentifier(context, "ownerUserId"),
    ...(context.mirrorRepliesToWhatsApp === true ? { mirrorRepliesToWhatsApp: true } : {}),
  };
  return device;
}

function assertDevicePrincipal(device, principal) {
  const owner = clean(device.ownerUserId);
  const actor = clean(principal?.userId);
  if (!owner || !actor || owner !== actor) throw httpError("mobile_device_profile_forbidden", 403);
}

function turnForDevice(store, turnId, device) {
  const turn = store.turns.find((candidate) => clean(candidate.id) === clean(turnId));
  if (!turn || clean(turn.deviceId) !== clean(device.deviceId) || clean(turn.profileId) !== clean(device.profileId)) {
    throw httpError("mobile_voice_turn_not_found", 404);
  }
  return turn;
}

const defaults = {
  appendEvent,
  enqueueThreadInputForPrincipal,
  getThreadForPrincipal,
  listThreadMessages,
  processApiAgentThreadInput,
  requestThreadInputDelivery,
  runtimeStatus,
  threadUsesApiAgent,
};

async function recordTurnFailure(turnId, error, env, dependencies) {
  return withTurnStore(env, async (store, markDirty) => {
    const turn = store.turns.find((candidate) => clean(candidate.id) === clean(turnId));
    if (!turn || TERMINAL_STATES.has(lower(turn.status))) return turn ? publicTurn(turn) : null;
    turn.status = "failed";
    turn.error = safeError(error);
    turn.updatedAt = nowIso();
    appendTurnEvent(turn, "failed");
    markDirty();
    await dependencies.appendEvent({
      type: "hush_voice_turn_failed",
      turnId: turn.id,
      traceId: turn.traceId,
      threadId: turn.threadId,
      inputMessageId: turn.inputMessageId,
      error: turn.error.code,
    }, env).catch(() => {});
    return publicTurn(turn);
  });
}

async function dispatchTurn(turn, thread, env, dependencies) {
  try {
    if (dependencies.threadUsesApiAgent(thread, env)) {
      await dependencies.processApiAgentThreadInput(thread.id, env);
    } else {
      dependencies.requestThreadInputDelivery(thread.id, env);
    }
  } catch (error) {
    await recordTurnFailure(turn.id, error, env, dependencies);
  }
}

export async function createHushVoiceTurn(input = {}, options = {}) {
  const env = snapshotEnvironment(options.env || process.env);
  const dependencies = { ...defaults, ...(options.dependencies || {}) };
  const device = input.device || {};
  const principal = input.principal || {};
  assertDevicePrincipal(device, principal);
  const clientTurnId = clean(input.clientTurnId);
  const transcript = clean(input.transcript);
  const locale = clean(input.locale);
  if (!validClientTurnId(clientTurnId)) throw httpError("mobile_voice_turn_id_invalid", 400);
  if (!transcript || transcript.length > 12000) throw httpError("mobile_voice_transcript_invalid", 400);
  if (!locale || locale.length > 64) throw httpError("mobile_voice_locale_invalid", 400);
  const contentHash = transcriptHash(transcript, locale);
  let created = false;
  let scheduledTurn = null;
  let scheduledThread = null;

  const result = await withTurnStore(env, async (store, markDirty) => {
    const existing = store.turns.find((turn) => clean(turn.deviceId) === clean(device.deviceId) && clean(turn.clientTurnId) === clientTurnId);
    if (existing) {
      if (clean(existing.contentHash) !== contentHash) throw httpError("mobile_voice_turn_id_conflict", 409);
      return publicTurn(existing);
    }
    const thread = await dependencies.getThreadForPrincipal(device.threadId, principal, env);
    if (!thread || clean(thread.id) !== clean(device.threadId)) throw httpError("mobile_voice_profile_thread_forbidden", 403);
    if (clean(thread.ownerUserId) && clean(thread.ownerUserId) !== clean(device.ownerUserId)) {
      throw httpError("mobile_voice_profile_thread_forbidden", 403);
    }
    const replyDeliveryIntent = createHushReplyDeliveryIntent(thread, {
      enabled: device.mirrorRepliesToWhatsApp === true,
      requestedByUserId: device.ownerUserId,
    });
    const message = await dependencies.enqueueThreadInputForPrincipal(thread.id, {
      source: "hush",
      originSurface: "mobile",
      originTransport: "hush-mobile",
      text: transcript,
      externalId: clean(device.deviceId),
      clientMessageId: `hush:${clean(device.deviceId)}:${clientTurnId}`,
      attachments: [],
      commandProcessing: "disabled",
      ...(replyDeliveryIntent ? { replyDeliveryIntent } : {}),
    }, principal, env);
    const now = nowIso();
    const turn = {
      id: randomUUID(),
      deviceId: clean(device.deviceId),
      profileId: clean(device.profileId),
      ownerUserId: clean(device.ownerUserId),
      threadId: thread.id,
      inputMessageId: clean(message?.id),
      clientTurnId,
      contentHash,
      locale,
      status: "queued",
      traceId: `hush-${randomUUID()}`,
      createdAt: now,
      updatedAt: now,
      events: [],
    };
    appendTurnEvent(turn, "queued");
    store.turns.push(turn);
    markDirty();
    created = true;
    scheduledTurn = turn;
    scheduledThread = thread;
    await dependencies.appendEvent({
      type: "hush_voice_turn_queued",
      turnId: turn.id,
      traceId: turn.traceId,
      deviceId: turn.deviceId,
      profileId: turn.profileId,
      threadId: turn.threadId,
      inputMessageId: turn.inputMessageId,
    }, env).catch(() => {});
    return publicTurn(turn);
  });

  // The durable record exists before delivery is requested. A device retry can
  // therefore resume the same turn after a network failure without duplicating
  // the thread input.
  if (created && scheduledTurn && scheduledThread) {
    void dispatchTurn(scheduledTurn, scheduledThread, env, dependencies);
  }
  return result;
}

function reconcileTurn(turn, messages, status) {
  if (TERMINAL_STATES.has(lower(turn.status))) return false;
  const input = messages.find((message) => clean(message?.id) === clean(turn.inputMessageId));
  const exactFinal = messages.find((message) => completedFinalFor(message, turn.inputMessageId));
  const inputTurnId = canonicalExecutorTurnId(input);
  const final = exactFinal || messages.find((message) => completedFinalForExecutorTurn(message, inputTurnId));
  if (final) {
    turn.status = "final";
    turn.answer = clean(final.text);
    turn.speech = hushSpeech(turn.answer);
    turn.finalMessageId = clean(final.id);
    turn.updatedAt = nowIso();
    appendTurnEvent(turn, "final");
    return true;
  }
  if (lower(input?.state) === "failed") {
    turn.status = "failed";
    turn.error = safeError({ code: "hush_runtime_failed", retryable: true });
    turn.updatedAt = nowIso();
    appendTurnEvent(turn, "failed");
    return true;
  }
  if (lower(turn.status) === "queued" && inputIndicatesWorking(input, status)) {
    turn.status = "working";
    turn.updatedAt = nowIso();
    appendTurnEvent(turn, "working");
    return true;
  }
  return false;
}

export async function getHushVoiceTurn(turnId, input = {}, options = {}) {
  const env = snapshotEnvironment(options.env || process.env);
  const dependencies = { ...defaults, ...(options.dependencies || {}) };
  const device = input.device || {};
  const principal = input.principal || {};
  assertDevicePrincipal(device, principal);
  return withTurnStore(env, async (store, markDirty) => {
    const turn = turnForDevice(store, turnId, device);
    const messages = await dependencies.listThreadMessages(turn.threadId, env);
    const status = await dependencies.runtimeStatus(turn.threadId, env).catch(() => ({}));
    const changed = reconcileTurn(turn, messages, status);
    if (changed) {
      markDirty();
      const eventType = lower(turn.status);
      await dependencies.appendEvent({
        type: `hush_voice_turn_${eventType}`,
        turnId: turn.id,
        traceId: turn.traceId,
        threadId: turn.threadId,
        inputMessageId: turn.inputMessageId,
        finalMessageId: turn.finalMessageId || null,
      }, env).catch(() => {});
    }
    return publicTurn(turn);
  });
}

export async function listHushVoiceTurnEvents(turnId, afterEventId, input = {}, options = {}) {
  const lastEventId = afterEventId === null || afterEventId === undefined || afterEventId === "" ? 0 : Number(afterEventId);
  if (!Number.isInteger(lastEventId) || lastEventId < 0) throw httpError("mobile_voice_event_id_invalid", 400);
  await getHushVoiceTurn(turnId, input, options);
  const env = snapshotEnvironment(options.env || process.env);
  const device = input.device || {};
  const principal = input.principal || {};
  assertDevicePrincipal(device, principal);
  return withTurnStore(env, async (store) => {
    const turn = turnForDevice(store, turnId, device);
    return (Array.isArray(turn.events) ? turn.events : [])
      .filter((event) => Number(event?.eventId || 0) > lastEventId)
      .map((event) => ({
        eventId: Number(event.eventId),
        type: clean(event.type),
        turn: event.turn && typeof event.turn === "object" ? event.turn : publicTurn(turn),
      }));
  });
}

export function hushVoiceEventPollIntervalMs(env = process.env) {
  const configured = Number(env.ORKESTR_HUSH_EVENT_POLL_MS || 300);
  return Math.max(150, Math.min(5000, Number.isFinite(configured) ? Math.floor(configured) : 300));
}
