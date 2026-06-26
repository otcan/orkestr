import { appServerStateFromStatus, clean } from "./codex-app-server-common.js";
import { messageTurnId } from "./thread-message-visibility.js";

function timestampMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : 0;
}

function staleActiveTurnMs(env = process.env) {
  const raw = String(env.ORKESTR_CODEX_APP_SERVER_STALE_ACTIVE_TURN_MS ?? "600000").trim().toLowerCase();
  if (["0", "off", "false", "disabled"].includes(raw)) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 600000;
}

function steerActiveTurnMs(env = process.env) {
  const raw = String(env.ORKESTR_CODEX_APP_SERVER_STEER_ACTIVE_TURN_MS ?? "300000").trim().toLowerCase();
  if (["0", "off", "false", "disabled"].includes(raw)) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 300000;
}

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
  if (!activeTurnMatchesDeliveredTurn(thread, clientState, turn)) return false;
  if (pendingApprovalState(thread, clientState)) return false;
  const timeoutMs = staleActiveTurnMs(env);
  if (!timeoutMs) return false;
  const lastActivityMs = Number(turn?.lastActivityMs || 0);
  if (!lastActivityMs || Date.now() - lastActivityMs < timeoutMs) return false;
  const observedAt = timestampMs(clientState?.activeTurnObservedAt);
  if (!observedAt || Date.now() - observedAt < timeoutMs) return false;
  return true;
}

export function shouldSteerStaleActiveTurn(thread, clientState, turn, env = process.env) {
  if (!activeTurnMatchesDeliveredTurn(thread, clientState, turn)) return false;
  if (pendingApprovalState(thread, clientState)) return false;
  const steerMs = steerActiveTurnMs(env);
  const interruptMs = staleActiveTurnMs(env);
  if (!steerMs) return false;
  if (interruptMs && steerMs >= interruptMs) return false;
  const turnId = messageTurnId(turn?.latestUser) || clean(thread?.runtime?.activeTurnId) || clean(clientState?.activeTurnId);
  if (!turnId) return false;
  const lastSteer = thread?.runtime?.activeTurnSteer && typeof thread.runtime.activeTurnSteer === "object"
    ? thread.runtime.activeTurnSteer
    : null;
  if (clean(lastSteer?.turnId) === turnId && timestampMs(lastSteer?.steeredAt)) return false;
  const lastActivityMs = Number(turn?.lastActivityMs || 0);
  if (!lastActivityMs || Date.now() - lastActivityMs < steerMs) return false;
  const observedAt = timestampMs(clientState?.activeTurnObservedAt);
  if (!observedAt || Date.now() - observedAt < steerMs) return false;
  return true;
}

export function activeTurnRecoveryPending(thread, clientState, turn, env = process.env) {
  return Boolean(
    staleActiveTurnMs(env) &&
    activeTurnMatchesDeliveredTurn(thread, clientState, turn) &&
    !pendingApprovalState(thread, clientState)
  );
}
