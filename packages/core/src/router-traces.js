import crypto from "node:crypto";
import { dataPaths } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { recordWatcherAlert } from "./watcher-alerts.js";

export const routerTracePhases = [
  "received",
  "skipped",
  "routed",
  "queued",
  "delivery_started",
  "delivered_to_runtime",
  "runtime_failed",
  "assistant_seen",
  "mirror_claimed",
  "mirror_sent",
  "mirror_failed",
  "completed",
  "stuck",
];

const knownPhases = new Set(routerTracePhases);
const terminalPhases = new Set(["skipped", "completed"]);
const failurePhases = new Set(["runtime_failed", "mirror_failed"]);
const watcherAlertPhases = new Set(["runtime_failed", "mirror_failed", "stuck"]);

function clean(value) {
  return String(value || "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function nowIso() {
  return new Date().toISOString();
}

function hashId(prefix, parts = []) {
  const payload = parts.map((part) => clean(part)).join("\n");
  if (!payload.trim()) return "";
  return `${prefix}_${crypto.createHash("sha256").update(payload).digest("hex").slice(0, 24)}`;
}

function optionalNumber(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function retentionLimit(env = process.env) {
  const parsed = Number(env.ORKESTR_ROUTER_TRACE_RETENTION || 1000);
  return Math.max(100, Math.min(20_000, Number.isFinite(parsed) ? Math.floor(parsed) : 1000));
}

function outboxRetentionLimit(env = process.env) {
  const parsed = Number(env.ORKESTR_ROUTER_OUTBOX_RETENTION || retentionLimit(env));
  return Math.max(100, Math.min(20_000, Number.isFinite(parsed) ? Math.floor(parsed) : retentionLimit(env)));
}

function stuckThresholdMs(env = process.env) {
  const parsed = Number(env.ORKESTR_ROUTER_TRACE_STUCK_MS || 10 * 60 * 1000);
  return Math.max(30_000, Number.isFinite(parsed) ? Math.floor(parsed) : 10 * 60 * 1000);
}

function safeError(value) {
  return clean(value?.message || value).replace(/\s+/g, " ").slice(0, 500);
}

function retryableWhatsAppMirrorFailure(phase = {}, trace = {}) {
  if (phase.phase !== "mirror_failed") return false;
  if (lower(trace.connector) !== "whatsapp") return false;
  const error = lower(phase.error || phase.reason || trace.lastError);
  return error.includes("not_ready") ||
    error.includes("bridge_not_ready") ||
    error.includes("whatsapp_local_bridge_not_ready") ||
    error.includes("detached frame") ||
    error.includes("target closed") ||
    error.includes("session closed") ||
    error.includes("fetch failed") ||
    error.includes("econnrefused") ||
    error.includes("timeout");
}

function safeArray(values = [], max = 50) {
  return [...new Set((Array.isArray(values) ? values : []).map(clean).filter(Boolean))].slice(-max);
}

function safeMeta(input = {}) {
  const output = {};
  for (const key of [
    "reason",
    "deliveryType",
    "routerUpdateType",
    "ownerProcess",
    "claimKey",
    "outboxId",
    "intentId",
    "status",
    "terminalState",
  ]) {
    const value = clean(input[key]);
    if (value) output[key] = value.slice(0, 200);
  }
  for (const key of ["attempt", "attempts", "retryCount", "messageCursor"]) {
    const value = optionalNumber(input[key]);
    if (value !== null) output[key] = value;
  }
  if (input.terminal !== undefined) output.terminal = Boolean(input.terminal);
  return output;
}

function normalizeStore(raw = {}) {
  return {
    schemaVersion: 1,
    traces: Array.isArray(raw?.traces) ? raw.traces : [],
    turns: Array.isArray(raw?.turns) ? raw.turns : [],
    outbox: Array.isArray(raw?.outbox) ? raw.outbox : [],
    updatedAt: clean(raw?.updatedAt),
  };
}

async function readRouterTraceStore(env = process.env) {
  return normalizeStore(await readJson(dataPaths(env).routerTraces, { schemaVersion: 1, traces: [], turns: [], outbox: [] }));
}

async function writeRouterTraceStore(store, env = process.env) {
  const limit = retentionLimit(env);
  const outboxLimit = outboxRetentionLimit(env);
  const normalized = normalizeStore(store);
  normalized.traces = [...normalized.traces]
    .sort((left, right) => Date.parse(clean(left.updatedAt || left.createdAt)) - Date.parse(clean(right.updatedAt || right.createdAt)))
    .slice(-limit);
  const keptTraceIds = new Set(normalized.traces.map((trace) => clean(trace.routerTraceId)).filter(Boolean));
  normalized.turns = [...normalized.turns]
    .filter((turn) => !clean(turn.routerTraceId) || keptTraceIds.has(clean(turn.routerTraceId)))
    .sort((left, right) => Date.parse(clean(left.updatedAt || left.createdAt)) - Date.parse(clean(right.updatedAt || right.createdAt)))
    .slice(-limit);
  normalized.outbox = [...normalized.outbox]
    .filter((item) => !clean(item.routerTraceId) || keptTraceIds.has(clean(item.routerTraceId)))
    .sort((left, right) => Date.parse(clean(left.updatedAt || left.createdAt)) - Date.parse(clean(right.updatedAt || right.createdAt)))
    .slice(-outboxLimit);
  normalized.updatedAt = nowIso();
  await writeJson(dataPaths(env).routerTraces, normalized);
  return normalized;
}

export function routerTraceIdFor(input = {}) {
  const connector = lower(input.connector || input.source || "connector");
  const sourceEventId = clean(input.sourceEventId || input.eventId || input.externalId || input.messageId || input.id);
  const accountId = clean(input.accountId || input.account || input.connectorAccountId);
  const chatId = clean(input.chatId || input.destination || input.target);
  const fallback = clean(input.fallbackId);
  return hashId("rt", [connector, accountId, chatId, sourceEventId || fallback]);
}

export function turnIdFor(input = {}) {
  const existing = clean(input.turnId);
  if (existing) return existing;
  const routerTraceId = clean(input.routerTraceId) || routerTraceIdFor(input);
  return hashId("turn", [routerTraceId]);
}

export function routerOutboxIdFor(input = {}) {
  const turnId = clean(input.turnId) || turnIdFor(input);
  return hashId("outbox", [
    turnId,
    lower(input.connector || input.source || "connector"),
    clean(input.destination || input.chatId || input.target),
    clean(input.eventId || input.messageId || input.sourceMessageId),
    clean(input.payloadHash || input.textKey || input.intentId),
  ]);
}

function phaseFor(input = {}) {
  const phase = lower(input.phase || input.type || input.status);
  return knownPhases.has(phase) ? phase : "routed";
}

function traceTerminalState(trace = {}, input = {}) {
  const phase = phaseFor(input);
  if (input.terminal !== undefined) return Boolean(input.terminal);
  if (terminalPhases.has(phase)) return true;
  if (failurePhases.has(phase) && input.retryable === false) return true;
  return Boolean(trace.terminal && !["queued", "delivery_started", "mirror_claimed"].includes(phase));
}

function publicPhase(input = {}) {
  const ts = clean(input.ts || input.timestamp) || nowIso();
  return {
    phase: phaseFor(input),
    ts,
    ...(clean(input.reason) ? { reason: clean(input.reason).slice(0, 200) } : {}),
    ...(safeError(input.error) ? { error: safeError(input.error) } : {}),
    ...safeMeta(input),
  };
}

function comparableWithoutUpdatedAt(value = {}) {
  const comparable = { ...(value || {}) };
  delete comparable.updatedAt;
  return JSON.stringify(comparable);
}

function comparablePhase(phase = {}) {
  const comparable = { ...(phase || {}) };
  delete comparable.ts;
  return JSON.stringify(comparable);
}

function phaseAlreadyRecorded(trace = {}, phase = {}) {
  const key = comparablePhase(phase);
  if (!key) return false;
  return (Array.isArray(trace.phases) ? trace.phases : []).some((entry) => comparablePhase(entry) === key);
}

function publicTrace(trace = {}, env = process.env) {
  const diagnostics = diagnoseRouterTrace(trace, env);
  return {
    routerTraceId: clean(trace.routerTraceId),
    turnId: clean(trace.turnId),
    connector: clean(trace.connector),
    accountId: clean(trace.accountId),
    chatId: clean(trace.chatId),
    sourceEventId: clean(trace.sourceEventId),
    threadId: clean(trace.threadId),
    messageId: clean(trace.messageId),
    currentPhase: clean(trace.currentPhase),
    terminal: trace.terminal === true,
    terminalState: clean(trace.terminalState),
    retryCount: Number(trace.retryCount || 0) || 0,
    lastError: clean(trace.lastError),
    ownerProcess: clean(trace.ownerProcess),
    createdAt: clean(trace.createdAt),
    updatedAt: clean(trace.updatedAt),
    phases: Array.isArray(trace.phases) ? trace.phases : [],
    diagnostics,
  };
}

export async function recordRouterTraceEvent(input = {}, env = process.env) {
  const routerTraceId = clean(input.routerTraceId) || routerTraceIdFor(input);
  if (!routerTraceId) return null;
  const turnId = clean(input.turnId) || turnIdFor({ ...input, routerTraceId });
  const phase = publicPhase(input);
  const store = await readRouterTraceStore(env);
  const now = phase.ts || nowIso();
  const traces = [...store.traces];
  const index = traces.findIndex((trace) => clean(trace.routerTraceId) === routerTraceId);
  const previous = index >= 0 ? traces[index] : {};
  const duplicatePhase = phaseAlreadyRecorded(previous, phase);
  const previousPhases = Array.isArray(previous.phases) ? previous.phases : [];
  const next = {
    ...previous,
    routerTraceId,
    turnId,
    connector: lower(input.connector || previous.connector),
    accountId: clean(input.accountId || previous.accountId),
    chatId: clean(input.chatId || previous.chatId),
    sourceEventId: clean(input.sourceEventId || input.eventId || input.externalId || previous.sourceEventId),
    threadId: clean(input.threadId || previous.threadId),
    messageId: clean(input.messageId || previous.messageId),
    ownerUserId: clean(input.ownerUserId || previous.ownerUserId),
    currentPhase: phase.phase,
    terminal: traceTerminalState(previous, input),
    terminalState: clean(input.terminalState || (terminalPhases.has(phase.phase) ? phase.phase : previous.terminalState)),
    retryCount: Math.max(Number(previous.retryCount || 0) || 0, Number(input.retryCount || input.attempts || 0) || 0),
    lastError: safeError(input.error) || clean(input.lastError || previous.lastError),
    ownerProcess: clean(input.ownerProcess || previous.ownerProcess),
    createdAt: clean(previous.createdAt) || now,
    updatedAt: duplicatePhase ? clean(previous.updatedAt) || now : now,
    phases: duplicatePhase ? previousPhases : [...previousPhases, phase].slice(-200),
  };
  next.currentPhase = duplicatePhase ? clean(previous.currentPhase || next.currentPhase) : phase.phase;
  if (!next.connector) delete next.connector;
  if (index >= 0 && comparableWithoutUpdatedAt(previous) === comparableWithoutUpdatedAt(next)) {
    return publicTrace(previous, env);
  }
  if (index >= 0) traces[index] = next;
  else traces.push(next);
  await writeRouterTraceStore({ ...store, traces }, env);
  await appendEvent({
    type: "router_trace_event",
    routerTraceId,
    turnId,
    phase: phase.phase,
    connector: next.connector || "",
    threadId: next.threadId || "",
    messageId: next.messageId || "",
    reason: phase.reason || "",
    error: phase.error || "",
    terminal: next.terminal === true,
  }, env).catch(() => {});
  if (watcherAlertPhases.has(phase.phase) && !retryableWhatsAppMirrorFailure(phase, next)) {
    await recordWatcherAlert({
      severity: "error",
      source: `router.${phase.phase}`,
      code: "router_trace_failure",
      message: phase.error || phase.reason || phase.phase,
      routerTraceId,
      threadId: next.threadId || "",
      messageId: next.messageId || "",
      details: {
        connector: next.connector || "",
        phase: phase.phase,
        reason: phase.reason || "",
        terminal: next.terminal === true,
      },
    }, env).catch(() => {});
  }
  return publicTrace(next, env);
}

export async function ensureRouterTurn(input = {}, env = process.env) {
  const routerTraceId = clean(input.routerTraceId) || routerTraceIdFor(input);
  if (!routerTraceId) return null;
  const turnId = clean(input.turnId) || turnIdFor({ ...input, routerTraceId });
  const store = await readRouterTraceStore(env);
  const turns = [...store.turns];
  const index = turns.findIndex((turn) => clean(turn.turnId) === turnId);
  const previous = index >= 0 ? turns[index] : {};
  const now = nowIso();
  const turn = {
    ...previous,
    turnId,
    routerTraceId,
    threadId: clean(input.threadId || previous.threadId),
    messageIds: safeArray([...(previous.messageIds || []), input.messageId]),
    eventIds: safeArray([...(previous.eventIds || []), input.sourceEventId || input.eventId || input.externalId]),
    source: {
      ...(previous.source || {}),
      connector: lower(input.connector || previous.source?.connector),
      accountId: clean(input.accountId || previous.source?.accountId),
      chatId: clean(input.chatId || previous.source?.chatId),
      eventId: clean(input.sourceEventId || input.eventId || input.externalId || previous.source?.eventId),
    },
    mirrorPolicy: clean(input.mirrorPolicy || previous.mirrorPolicy || "source_connector"),
    state: clean(input.state || previous.state || "open"),
    createdAt: clean(previous.createdAt) || now,
    updatedAt: now,
  };
  if (index >= 0) turns[index] = turn;
  else turns.push(turn);
  await writeRouterTraceStore({ ...store, turns }, env);
  return turn;
}

export async function planRouterOutboxItem(input = {}, env = process.env) {
  const routerTraceId = clean(input.routerTraceId);
  const turnId = clean(input.turnId) || turnIdFor({ routerTraceId });
  const outboxId = clean(input.outboxId) || routerOutboxIdFor({ ...input, turnId });
  if (!outboxId) return null;
  const store = await readRouterTraceStore(env);
  const outbox = [...store.outbox];
  const index = outbox.findIndex((item) => clean(item.outboxId) === outboxId);
  const previous = index >= 0 ? outbox[index] : {};
  const now = nowIso();
  const item = {
    ...previous,
    outboxId,
    turnId,
    routerTraceId,
    connector: lower(input.connector || previous.connector),
    destination: clean(input.destination || input.chatId || previous.destination),
    eventId: clean(input.eventId || input.messageId || input.sourceMessageId || previous.eventId),
    payloadHash: clean(input.payloadHash || input.textKey || input.intentId || previous.payloadHash),
    status: clean(input.status || previous.status || "pending"),
    attempts: Math.max(Number(previous.attempts || 0) || 0, Number(input.attempts || 0) || 0),
    createdAt: clean(previous.createdAt) || now,
    updatedAt: now,
    ...(clean(input.error) ? { error: safeError(input.error) } : {}),
    ...(clean(input.deliveredAt || previous.deliveredAt) ? { deliveredAt: clean(input.deliveredAt || previous.deliveredAt) } : {}),
  };
  if (index >= 0 && comparableWithoutUpdatedAt(previous) === comparableWithoutUpdatedAt(item)) {
    return previous;
  }
  if (index >= 0) outbox[index] = item;
  else outbox.push(item);
  await writeRouterTraceStore({ ...store, outbox }, env);
  return item;
}

export async function markRouterOutboxItem(outboxId, patch = {}, env = process.env) {
  const id = clean(outboxId);
  if (!id) return null;
  const store = await readRouterTraceStore(env);
  let updated = null;
  const outbox = store.outbox.map((item) => {
    if (clean(item.outboxId) !== id) return item;
    updated = {
      ...item,
      status: clean(patch.status || item.status),
      attempts: Math.max(Number(item.attempts || 0) || 0, Number(patch.attempts || 0) || 0),
      updatedAt: nowIso(),
      ...(clean(patch.error) ? { error: safeError(patch.error) } : {}),
      ...(clean(patch.deliveredAt) ? { deliveredAt: clean(patch.deliveredAt) } : {}),
    };
    if (comparableWithoutUpdatedAt(item) === comparableWithoutUpdatedAt(updated)) {
      updated = item;
      return item;
    }
    return updated;
  });
  if (!updated) return null;
  if (store.outbox.some((item) => item === updated)) return updated;
  await writeRouterTraceStore({ ...store, outbox }, env);
  return updated;
}

export async function listRouterTraces(filters = {}, env = process.env) {
  const store = await readRouterTraceStore(env);
  const traces = store.traces.map((trace) => publicTrace(trace, env)).filter((trace) => {
    if (clean(filters.routerTraceId) && trace.routerTraceId !== clean(filters.routerTraceId)) return false;
    if (clean(filters.threadId) && trace.threadId !== clean(filters.threadId)) return false;
    if (clean(filters.messageId) && trace.messageId !== clean(filters.messageId)) return false;
    if (clean(filters.connector) && trace.connector !== lower(filters.connector)) return false;
    if (clean(filters.phase) && trace.currentPhase !== lower(filters.phase)) return false;
    if (filters.stuck === true && trace.diagnostics?.stuck !== true) return false;
    return true;
  });
  return traces.sort((left, right) => Date.parse(clean(right.updatedAt)) - Date.parse(clean(left.updatedAt)));
}

export async function getRouterTrace(routerTraceId, env = process.env) {
  return (await listRouterTraces({ routerTraceId }, env))[0] || null;
}

export async function listRouterTurns(filters = {}, env = process.env) {
  const store = await readRouterTraceStore(env);
  return store.turns.filter((turn) => {
    if (clean(filters.threadId) && clean(turn.threadId) !== clean(filters.threadId)) return false;
    if (clean(filters.routerTraceId) && clean(turn.routerTraceId) !== clean(filters.routerTraceId)) return false;
    return true;
  });
}

export async function listRouterOutbox(filters = {}, env = process.env) {
  const store = await readRouterTraceStore(env);
  return store.outbox.filter((item) => {
    if (clean(filters.routerTraceId) && clean(item.routerTraceId) !== clean(filters.routerTraceId)) return false;
    if (clean(filters.turnId) && clean(item.turnId) !== clean(filters.turnId)) return false;
    if (clean(filters.status) && clean(item.status) !== lower(filters.status)) return false;
    return true;
  });
}

export function diagnoseRouterTrace(trace = {}, env = process.env) {
  const updatedMs = Date.parse(clean(trace.updatedAt));
  const ageMs = Number.isFinite(updatedMs) ? Date.now() - updatedMs : 0;
  const currentPhase = lower(trace.currentPhase);
  const terminal = trace.terminal === true || terminalPhases.has(currentPhase);
  const stuck = !terminal && ageMs >= stuckThresholdMs(env) && [
    "queued",
    "delivery_started",
    "delivered_to_runtime",
    "mirror_claimed",
    "mirror_failed",
    "runtime_failed",
    "stuck",
  ].includes(currentPhase);
  let recovery = "No recovery needed.";
  if (stuck && ["queued", "delivery_started"].includes(currentPhase)) {
    recovery = "Check the assigned runtime and wake or retry the delivery queue; do not duplicate the inbound message.";
  } else if (stuck && currentPhase === "delivered_to_runtime") {
    recovery = "Inspect runtime output and assistant message import before retrying; the user input may already be visible to the runtime.";
  } else if (stuck && ["mirror_claimed", "mirror_failed"].includes(currentPhase)) {
    recovery = "Check connector status and retry the durable outbox item for this turn.";
  } else if (stuck && currentPhase === "runtime_failed") {
    recovery = "Repair or restart the runtime, then explicitly retry the queued turn if the user still expects a reply.";
  }
  return {
    stuck,
    ageMs,
    terminal,
    currentPhase,
    recovery,
    lastError: clean(trace.lastError),
  };
}

export async function detectStuckRouterTraces(env = process.env) {
  const traces = await listRouterTraces({}, env);
  const stuck = traces.filter((trace) => trace.diagnostics?.stuck === true);
  for (const trace of stuck) {
    await appendEvent({
      type: "router_trace_stuck",
      routerTraceId: trace.routerTraceId,
      turnId: trace.turnId,
      threadId: trace.threadId,
      messageId: trace.messageId,
      currentPhase: trace.currentPhase,
      ageMs: trace.diagnostics.ageMs,
      recovery: trace.diagnostics.recovery,
    }, env).catch(() => {});
  }
  return stuck;
}

export async function routerTraceMetrics(env = process.env) {
  const store = await readRouterTraceStore(env);
  const traces = await listRouterTraces({}, env);
  return {
    traces: traces.length,
    turns: store.turns.length,
    outbox: store.outbox.length,
    stuck: traces.filter((trace) => trace.diagnostics?.stuck === true).length,
    failed: traces.filter((trace) => failurePhases.has(trace.currentPhase)).length,
    terminal: traces.filter((trace) => trace.terminal === true).length,
    updatedAt: store.updatedAt || "",
  };
}
