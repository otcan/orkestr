import { appServerStateFromStatus, clean, nowIso } from "./codex-app-server-common.js";

export function activeTurnsFromCodexThread(codexThread = {}) {
  const turns = Array.isArray(codexThread.turns) ? codexThread.turns : [];
  const ids = [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index] || {};
    const status = clean(turn.status).toLowerCase();
    if (["active", "inprogress", "in_progress", "running", "started"].includes(status)) {
      const id = clean(turn.id);
      if (id && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

export function activeTurnFromCodexThread(codexThread = {}) {
  return activeTurnsFromCodexThread(codexThread)[0] || "";
}

export function activeDynamicToolCallFromCodexThread(codexThread = {}, activeTurnId = "") {
  const turnId = clean(activeTurnId || activeTurnFromCodexThread(codexThread));
  if (!turnId) return null;
  const turns = Array.isArray(codexThread.turns) ? codexThread.turns : [];
  const turn = turns.find((item) => clean(item?.id) === turnId);
  const items = Array.isArray(turn?.items) ? turn.items : [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index] || {};
    if (clean(item.type).toLowerCase() !== "dynamictoolcall") continue;
    if (clean(item.status).toLowerCase() !== "inprogress") continue;
    return {
      id: clean(item.id),
      turnId,
      namespace: clean(item.namespace),
      tool: clean(item.tool),
      durationMs: Math.max(0, Number(item.durationMs || 0) || 0),
    };
  }
  return null;
}

export function liveStateFromCodexThread(codexThread = {}, fallbackCodexId = "") {
  const codexId = clean(codexThread.id || codexThread.threadId || fallbackCodexId);
  if (!codexId) return null;
  const status = codexThread.status || null;
  const activeTurnIds = activeTurnsFromCodexThread(codexThread);
  const activeTurnId = clean(codexThread.activeTurnId || codexThread.currentTurnId || activeTurnIds[0]);
  const effectiveStatus = activeTurnId && appServerStateFromStatus(status) !== "working"
    ? { type: "active", activeFlags: ["running"] }
    : status;
  if (!effectiveStatus && !activeTurnId) return null;
  return {
    status: effectiveStatus,
    activeTurnId,
    activeTurnIds: activeTurnId
      ? [activeTurnId, ...activeTurnIds.filter((id) => id !== activeTurnId)]
      : activeTurnIds,
    thread: codexThread,
  };
}

function rememberLiveCodexThreadState(client, codexId, state) {
  const previous = client.threadStates.get(codexId) || {};
  const checkedAt = nowIso();
  const previousActiveTurnId = clean(previous.activeTurnId);
  const activeTurnId = clean(state.activeTurnId);
  const activeDynamicToolCall = activeDynamicToolCallFromCodexThread(state.thread, activeTurnId);
  const sameDynamicToolCall = Boolean(
    activeDynamicToolCall?.id &&
    clean(previous.activeDynamicToolCall?.id) === activeDynamicToolCall.id &&
    clean(previous.activeDynamicToolCall?.turnId) === activeDynamicToolCall.turnId
  );
  const next = {
    ...previous,
    ...state,
    liveStateCheckedAt: checkedAt,
    activeTurnObservedAt: activeTurnId
      ? previousActiveTurnId === activeTurnId
        ? previous.activeTurnObservedAt || checkedAt
        : checkedAt
      : null,
    activeDynamicToolCall: activeDynamicToolCall
      ? {
          ...activeDynamicToolCall,
          observedAt: sameDynamicToolCall ? previous.activeDynamicToolCall.observedAt || checkedAt : checkedAt,
          checkedAt,
        }
      : null,
  };
  client.threadStates.set(codexId, next);
  return next;
}

export async function probeLiveCodexThreadState(client, codexId) {
  const id = clean(codexId);
  if (!client || !id) return { ok: false, reason: "codex_thread_id_required", state: null };
  const read = await client.request("thread/read", { threadId: id, includeTurns: true });
  const codexThread = read?.thread || null;
  const returnedId = clean(codexThread?.id || codexThread?.threadId);
  if (!codexThread || returnedId !== id) {
    return { ok: false, reason: "codex_thread_not_found", state: null, thread: codexThread };
  }
  const state = liveStateFromCodexThread(codexThread, id);
  if (!state) {
    return { ok: false, reason: "codex_thread_state_unavailable", state: null, thread: codexThread };
  }
  return {
    ok: true,
    reason: "live_thread_read",
    state: rememberLiveCodexThreadState(client, id, state),
    thread: codexThread,
  };
}

export async function readLiveCodexThreadState(client, codexId) {
  const id = clean(codexId);
  if (!client || !id) return null;
  const probe = await probeLiveCodexThreadState(client, id).catch(() => null);
  return probe?.ok ? probe.state : null;
}
