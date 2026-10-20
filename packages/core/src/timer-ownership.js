// Timer ownership fence for the V1 -> V2 timer handoff.
//
// One timer, one owner, always. While a timer is marked `ownedBy: "v2"` the
// V2 runtime fires it and V1 must never enqueue, run, edit, or delete it. The
// marker is only set or cleared through the ownership API (see
// timer-ownership-service.js), keyed by a caller-chosen handoffId so that a
// replayed handoff/handback is idempotent and a mismatched one is a conflict.
//
// These helpers are pure; timers.js calls them from its normalize/run/update
// paths so the fence holds even if a stale timers.json still says enabled.

export const TIMER_OWNER_V1 = "v1";
export const TIMER_OWNER_V2 = "v2";
export const HANDOFF_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const ownershipFields = ["ownedBy", "ownership"];

export function timerOwnedByV2(timer = {}) {
  return timer?.ownedBy === TIMER_OWNER_V2;
}

export function timerOwnershipError(code, statusCode = 409) {
  const error = new Error(code);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

export function assertTimerNotOwnedByV2(timer = {}) {
  if (timerOwnedByV2(timer)) throw timerOwnershipError("timer_owned_by_v2");
}

// A V2-owned timer is always disabled with no schedule in V1, whatever the
// stored row says.
export function applyTimerOwnershipFence(timer) {
  if (!timerOwnedByV2(timer)) return timer;
  timer.enabled = false;
  timer.nextRunAt = null;
  return timer;
}

export function isTimerOwnershipField(key = "") {
  return ownershipFields.includes(key);
}

export function parseTimerOwnershipRequest(body = {}) {
  const ownedBy = String(body?.ownedBy || "").trim().toLowerCase();
  if (ownedBy !== TIMER_OWNER_V1 && ownedBy !== TIMER_OWNER_V2) {
    throw timerOwnershipError("invalid_timer_owner", 400);
  }
  const handoffId = typeof body?.handoffId === "string" ? body.handoffId : "";
  if (!HANDOFF_ID_PATTERN.test(handoffId)) throw timerOwnershipError("invalid_handoff_id", 400);
  if (body?.enable !== undefined && body?.enable !== null && typeof body.enable !== "boolean") {
    throw timerOwnershipError("invalid_enable", 400);
  }
  return { ownedBy, handoffId, enable: typeof body?.enable === "boolean" ? body.enable : undefined };
}

function handOffToV2(timer, request, now) {
  if (timerOwnedByV2(timer)) {
    if (timer.ownership?.handoffId === request.handoffId) return { timer, changed: false };
    throw timerOwnershipError("timer_ownership_conflict");
  }
  const next = {
    ...timer,
    ownedBy: TIMER_OWNER_V2,
    ownership: {
      owner: TIMER_OWNER_V2,
      handoffId: request.handoffId,
      changedAt: now.toISOString(),
      enabledBeforeHandoff: timer.enabled !== false,
      nextRunAtBeforeHandoff: timer.nextRunAt || null,
    },
    enabled: false,
    nextRunAt: null,
  };
  delete next.retryAt;
  return { timer: next, changed: true };
}

function handBackToV1(timer, request, now, computeNextRunAt) {
  if (!timerOwnedByV2(timer)) {
    if (timer.ownership?.owner === TIMER_OWNER_V1 && timer.ownership?.handoffId === request.handoffId) {
      return { timer, changed: false };
    }
    throw timerOwnershipError("timer_not_owned_by_v2");
  }
  if (timer.ownership?.handoffId !== request.handoffId) throw timerOwnershipError("timer_ownership_conflict");
  const next = { ...timer };
  delete next.ownedBy;
  delete next.retryAt;
  next.ownership = {
    owner: TIMER_OWNER_V1,
    handoffId: request.handoffId,
    changedAt: now.toISOString(),
    returnedFrom: TIMER_OWNER_V2,
  };
  let enabled = typeof request.enable === "boolean" ? request.enable : timer.ownership?.enabledBeforeHandoff === true;
  // The schedule restarts from now: runs missed while V2 owned the timer are
  // not caught up. A one-shot whose time passed during the handoff stays off.
  let nextRunAt = enabled ? computeNextRunAt(next, now) : null;
  if (enabled && String(next.cadence || "").toLowerCase() === "once" && !(Date.parse(nextRunAt) > now.getTime())) {
    enabled = false;
    nextRunAt = null;
  }
  next.enabled = enabled;
  next.nextRunAt = nextRunAt;
  next.updatedAt = now.toISOString();
  return { timer: next, changed: true };
}

// Returns { timer, changed }; throws 409 errors for conflicting requests.
export function applyTimerOwnershipChange(timer, request, now, computeNextRunAt) {
  return request.ownedBy === TIMER_OWNER_V2
    ? handOffToV2(timer, request, now)
    : handBackToV1(timer, request, now, computeNextRunAt);
}
