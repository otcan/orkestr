import { appServerStateFromStatus, clean } from "./codex-app-server-common.js";
import { messageTurnId } from "./thread-message-visibility.js";

function timestampMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : 0;
}

function staleDynamicExecMs(env = process.env) {
  const raw = String(env.ORKESTR_CODEX_APP_SERVER_STALE_DYNAMIC_EXEC_MS ?? "300000").trim().toLowerCase();
  if (["0", "off", "false", "disabled"].includes(raw)) return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.max(30_000, Math.floor(parsed)) : 300_000;
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

function steeredUserWaiting(turn = null) {
  const latestUser = turn?.latestUser || {};
  return latestUser.steerActiveTurn === true ||
    clean(latestUser.codexDeliveryMode).toLowerCase() === "instant_steer" ||
    clean(latestUser.observedVia).toLowerCase() === "codex_app_server_turn_steer";
}

export function staleDynamicExecCall(clientState = {}, env = process.env) {
  const timeoutMs = staleDynamicExecMs(env);
  if (!timeoutMs) return null;
  const call = clientState?.activeDynamicToolCall || null;
  if (!call || clean(call.tool).toLowerCase() !== "exec") return null;
  const durationMs = Math.max(0, Number(call.durationMs || 0) || 0);
  const observedAt = timestampMs(call.observedAt);
  const observedDurationMs = observedAt ? Math.max(0, Date.now() - observedAt) : 0;
  if (Math.max(durationMs, observedDurationMs) < timeoutMs) return null;
  return call;
}

export function shouldRecoverStaleActiveTurn(thread, clientState, turn, env = process.env) {
  if (!activeTurnMatchesDeliveredTurn(thread, clientState, turn)) return false;
  if (pendingApprovalState(thread, clientState)) return false;
  if (!steeredUserWaiting(turn)) return false;
  // Overall turn age is never a recovery signal. Dynamic exec callbacks are
  // bounded exchanges: long work must yield a session/heartbeat instead of
  // leaving Codex permanently blocked on a missing tool response.
  return Boolean(staleDynamicExecCall(clientState, env));
}

export function shouldSteerStaleActiveTurn(thread, clientState, turn, env = process.env) {
  void thread;
  void clientState;
  void turn;
  void env;
  return false;
}

export function activeTurnRecoveryPending(thread, clientState, turn, env = process.env) {
  return Boolean(
    staleDynamicExecMs(env) &&
    activeTurnMatchesDeliveredTurn(thread, clientState, turn) &&
    !pendingApprovalState(thread, clientState) &&
    steeredUserWaiting(turn)
  );
}
