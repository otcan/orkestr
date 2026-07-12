import { dataPaths } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { diagnoseRouterTrace, routerTracePhases } from "./router-traces.js";

const knownPhases = new Set(routerTracePhases);

function clean(value = "") {
  return String(value || "").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

function nowIso() {
  return new Date().toISOString();
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

function publicTrace(trace = {}, env = process.env) {
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
    diagnostics: diagnoseRouterTrace(trace, env),
  };
}

function backfillPhase(input = {}) {
  const phase = lower(input.phase);
  if (!knownPhases.has(phase)) return null;
  const reason = clean(input.reason);
  return {
    phase,
    ts: clean(input.ts || input.timestamp) || nowIso(),
    ...(reason ? { reason: reason.slice(0, 200) } : {}),
  };
}

export async function backfillRouterTracePhases(input = {}, env = process.env) {
  const routerTraceId = clean(input.routerTraceId);
  if (!routerTraceId) return null;
  const requested = Array.isArray(input.phases) ? input.phases : [];
  if (!requested.length) return null;
  const store = normalizeStore(await readJson(dataPaths(env).routerTraces, { schemaVersion: 1, traces: [], turns: [], outbox: [] }));
  const traces = [...store.traces];
  const index = traces.findIndex((trace) => clean(trace.routerTraceId) === routerTraceId);
  if (index < 0) return null;
  const previous = traces[index] || {};
  const previousPhases = Array.isArray(previous.phases) ? previous.phases : [];
  const existing = new Set(previousPhases.map((phase) => lower(phase.phase)).filter(Boolean));
  const additions = [];
  for (const requestedPhase of requested) {
    const raw = typeof requestedPhase === "string" ? { phase: requestedPhase } : { ...(requestedPhase || {}) };
    const phase = backfillPhase({
      ...raw,
      reason: clean(raw.reason || input.reason || "router_doctor_backfill"),
    });
    if (!phase || existing.has(phase.phase)) continue;
    additions.push(phase);
    existing.add(phase.phase);
  }
  if (!additions.length) {
    return { trace: publicTrace(previous, env), addedPhases: [] };
  }
  const mergedPhases = [...previousPhases, ...additions]
    .sort((left, right) => {
      const leftMs = Date.parse(clean(left.ts));
      const rightMs = Date.parse(clean(right.ts));
      const safeLeft = Number.isFinite(leftMs) ? leftMs : 0;
      const safeRight = Number.isFinite(rightMs) ? rightMs : 0;
      return safeLeft - safeRight;
    })
    .slice(-200);
  const next = {
    ...previous,
    updatedAt: nowIso(),
    phases: mergedPhases,
  };
  traces[index] = next;
  await writeJson(dataPaths(env).routerTraces, { ...store, traces, updatedAt: nowIso() });
  for (const phase of additions) {
    await appendEvent({
      type: "router_trace_phase_backfilled",
      routerTraceId,
      turnId: clean(previous.turnId),
      phase: phase.phase,
      connector: clean(previous.connector),
      threadId: clean(previous.threadId),
      messageId: clean(previous.messageId),
      reason: phase.reason || "",
    }, env).catch(() => {});
  }
  return { trace: publicTrace(next, env), addedPhases: additions };
}
