import { appServerStateFromStatus, clean, nowIso } from "./codex-app-server-common.js";

export function activeTurnFromCodexThread(codexThread = {}) {
  const turns = Array.isArray(codexThread.turns) ? codexThread.turns : [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index] || {};
    const status = clean(turn.status).toLowerCase();
    if (["active", "inprogress", "in_progress", "running", "started"].includes(status)) {
      return clean(turn.id);
    }
  }
  return "";
}

export function liveStateFromCodexThread(codexThread = {}, fallbackCodexId = "") {
  const codexId = clean(codexThread.id || codexThread.threadId || fallbackCodexId);
  if (!codexId) return null;
  const status = codexThread.status || null;
  const activeTurnId = clean(codexThread.activeTurnId || codexThread.currentTurnId || activeTurnFromCodexThread(codexThread));
  const effectiveStatus = activeTurnId && appServerStateFromStatus(status) !== "working"
    ? { type: "active", activeFlags: ["running"] }
    : status;
  if (!effectiveStatus && !activeTurnId) return null;
  return {
    status: effectiveStatus,
    activeTurnId,
    thread: codexThread,
  };
}

export async function readLiveCodexThreadState(client, codexId) {
  const id = clean(codexId);
  if (!client || !id) return null;
  const read = await client.request("thread/read", { threadId: id, includeTurns: true }).catch(() => null);
  const state = liveStateFromCodexThread(read?.thread || null, id);
  if (!state) return null;
  const previous = client.threadStates.get(id) || {};
  const checkedAt = nowIso();
  const previousActiveTurnId = clean(previous.activeTurnId);
  const activeTurnId = clean(state.activeTurnId);
  const next = {
    ...previous,
    ...state,
    liveStateCheckedAt: checkedAt,
    activeTurnObservedAt: activeTurnId
      ? previousActiveTurnId === activeTurnId
        ? previous.activeTurnObservedAt || checkedAt
        : checkedAt
      : null,
  };
  client.threadStates.set(id, next);
  return next;
}
