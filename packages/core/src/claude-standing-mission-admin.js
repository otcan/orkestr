// Admin-only mutation surface for a thread's standing mission. This is the
// only path allowed to change what claude-standing-mission.js later delivers
// on every turn -- callers must not let non-admin principals reach this, and
// must not add a general-purpose thread-patch route here.
import { appendEvent } from "../../storage/src/store.js";
import { getThread, updateThread } from "./threads.js";
import { sanitizeStandingMissionText, standingMissionMaxChars } from "./claude-standing-mission.js";

function nonEmptyString(value) {
  return String(value || "").trim();
}

function httpError(message, statusCode = 400, extra = {}) {
  const error = new Error(message);
  error.statusCode = statusCode;
  Object.assign(error, extra);
  return error;
}

function nowIso() {
  return new Date().toISOString();
}

export function threadStandingMissionSummary(thread = {}, env = process.env) {
  return {
    standingMission: thread.standingMission || null,
    standingMissionUpdatedAt: thread.standingMissionUpdatedAt || null,
    standingMissionUpdatedBy: thread.standingMissionUpdatedBy || null,
    maxChars: standingMissionMaxChars(env),
  };
}

export async function getThreadStandingMission(threadId, env = process.env) {
  const thread = await getThread(threadId, env);
  if (!thread) throw httpError("thread_not_found", 404);
  return threadStandingMissionSummary(thread, env);
}

export async function setThreadStandingMission(threadId, rawMission, actorUserId, env = process.env) {
  const thread = await getThread(threadId, env);
  if (!thread) throw httpError("thread_not_found", 404);
  const mission = sanitizeStandingMissionText(rawMission, env);
  if (!mission) throw httpError("standing_mission_required", 400);
  const updated = await updateThread(thread.id, {
    standingMission: mission,
    standingMissionUpdatedAt: nowIso(),
    standingMissionUpdatedBy: nonEmptyString(actorUserId) || null,
  }, env);
  await appendEvent({
    type: "thread_standing_mission_updated",
    threadId: thread.id,
    action: "thread.standing_mission.update",
    outcome: "success",
    resourceType: "thread",
    operatorUserId: nonEmptyString(actorUserId) || null,
    missionLength: mission.length,
  }, env).catch(() => {});
  return threadStandingMissionSummary(updated, env);
}

export async function clearThreadStandingMission(threadId, actorUserId, env = process.env) {
  const thread = await getThread(threadId, env);
  if (!thread) throw httpError("thread_not_found", 404);
  const updated = await updateThread(thread.id, {
    standingMission: null,
    standingMissionUpdatedAt: nowIso(),
    standingMissionUpdatedBy: nonEmptyString(actorUserId) || null,
  }, env);
  await appendEvent({
    type: "thread_standing_mission_cleared",
    threadId: thread.id,
    action: "thread.standing_mission.clear",
    outcome: "success",
    resourceType: "thread",
    operatorUserId: nonEmptyString(actorUserId) || null,
  }, env).catch(() => {});
  return threadStandingMissionSummary(updated, env);
}
