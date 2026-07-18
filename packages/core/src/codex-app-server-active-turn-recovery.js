import { appServerStateFromStatus, clean } from "./codex-app-server-common.js";
import { messageTurnId } from "./thread-message-visibility.js";

function incompleteTurnMatchesRuntimeTurn(thread, turn) {
  const runtimeTurnId = clean(thread?.runtime?.activeTurnId);
  return Boolean(runtimeTurnId && runtimeTurnId === messageTurnId(turn?.latestUser));
}

function pendingApprovalState(thread = {}, clientState = {}) {
  const liveStatusState = appServerStateFromStatus(clientState?.status || null);
  const threadState = clean(thread?.state).toLowerCase();
  const runtimeState = clean(thread?.runtime?.state).toLowerCase();
  return liveStatusState === "awaiting_approval" ||
    threadState === "awaiting_approval" ||
    runtimeState === "awaiting_approval" ||
    Boolean(thread?.runtime?.pendingRequest);
}

export function activeTurnIdsFromClientState(clientState = {}) {
  const ids = [];
  const add = (value) => {
    const id = clean(value);
    if (id && !ids.includes(id)) ids.push(id);
  };
  add(clientState?.activeTurnId);
  for (const id of Array.isArray(clientState?.activeTurnIds) ? clientState.activeTurnIds : []) add(id);
  return ids;
}

function activeTurnMatchesDeliveredTurn(thread, clientState, turn) {
  const liveActiveTurnIds = activeTurnIdsFromClientState(clientState);
  if (!liveActiveTurnIds.length || !turn) return false;
  const turnId = messageTurnId(turn?.latestUser);
  if (turnId && liveActiveTurnIds.includes(turnId)) return true;
  const runtimeTurnId = clean(thread?.runtime?.activeTurnId);
  return incompleteTurnMatchesRuntimeTurn(thread, turn) && liveActiveTurnIds.includes(runtimeTurnId);
}

export function shouldRecoverStaleActiveTurn(thread, clientState, turn, env = process.env) {
  void env;
  if (!activeTurnMatchesDeliveredTurn(thread, clientState, turn)) return false;
  if (pendingApprovalState(thread, clientState)) return false;
  // A turn returned by a live thread/read probe is liveness evidence regardless
  // of its age. Recovery is driven by loss of the live runtime, never elapsed time.
  return false;
}

export function shouldSteerStaleActiveTurn(thread, clientState, turn, env = process.env) {
  void thread;
  void clientState;
  void turn;
  void env;
  return false;
}

export function activeTurnRecoveryPending(thread, clientState, turn, env = process.env) {
  void thread;
  void clientState;
  void turn;
  void env;
  return false;
}
