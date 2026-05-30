import { listEvents } from "../../storage/src/store.js";
import { canAccessOwner, isAdminPrincipal, resourceOwnerUserId } from "./policy.js";
import { listThreads } from "./threads.js";
import { normalizeUserId } from "./users.js";

function eventOwnerCandidates(event = {}, threadOwners = new Map(), env = process.env) {
  const candidates = [
    event.ownerUserId,
    event.userId,
    event.actorUserId,
    event.subjectUserId,
  ].map((value) => normalizeUserId(value)).filter(Boolean);
  for (const key of ["threadId", "targetThreadId", "parentThreadId"]) {
    const threadId = String(event[key] || "").trim();
    const owner = threadId ? threadOwners.get(threadId) : "";
    if (owner) candidates.push(owner);
  }
  const resource = event.resource && typeof event.resource === "object" ? event.resource : null;
  if (resource) candidates.push(resourceOwnerUserId(resource, env));
  return [...new Set(candidates.filter(Boolean))];
}

export async function listEventsForPrincipal(principal = {}, env = process.env, limit = 100) {
  const requestedLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const events = await listEvents(env, 500);
  if (isAdminPrincipal(principal)) return events.slice(-requestedLimit);
  const threadOwners = new Map((await listThreads(env)).map((thread) => [thread.id, resourceOwnerUserId(thread, env)]));
  return events
    .filter((event) => eventOwnerCandidates(event, threadOwners, env).some((owner) => canAccessOwner(principal, owner, env)))
    .slice(-requestedLimit);
}
