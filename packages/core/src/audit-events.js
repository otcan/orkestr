import { listEvents } from "../../storage/src/store.js";
import { canAccessOwner, isAdminPrincipal, resourceOwnerUserId } from "./policy.js";
import { listThreads } from "./threads.js";
import { normalizeUserId } from "./users.js";

const sensitiveAuditKey = /token|secret|password|authorization|api.?key|content|text|prompt|body|raw/i;

function normalizeOptionalUserId(value = "") {
  const raw = String(value || "").trim();
  return raw ? normalizeUserId(raw) : "";
}

function eventOwnerCandidates(event = {}, threadOwners = new Map(), env = process.env) {
  const candidates = [
    event.ownerUserId,
    event.userId,
    event.actorUserId,
    event.subjectUserId,
  ].map((value) => normalizeOptionalUserId(value)).filter(Boolean);
  for (const key of ["threadId", "targetThreadId", "parentThreadId"]) {
    const threadId = String(event[key] || "").trim();
    const owner = threadId ? threadOwners.get(threadId) : "";
    if (owner) candidates.push(owner);
  }
  const resource = event.resource && typeof event.resource === "object" ? event.resource : null;
  if (resource) candidates.push(resourceOwnerUserId(resource, env));
  return [...new Set(candidates.filter(Boolean))];
}

function auditAction(type = "") {
  return String(type || "event").trim().replace(/_/g, ".");
}

function auditOutcome(event = {}) {
  const explicit = String(event.outcome || event.state || "").trim().toLowerCase();
  if (["allowed", "blocked", "failed", "completed", "success", "error"].includes(explicit)) return explicit;
  const type = String(event.type || "").toLowerCase();
  if (/denied|blocked|forbidden|rejected/.test(type)) return "blocked";
  if (/failed|error|broken|invalid|unavailable/.test(type)) return "failed";
  return "allowed";
}

function auditResourceType(event = {}) {
  if (event.resourceType) return String(event.resourceType);
  const resource = event.resource && typeof event.resource === "object" ? event.resource : null;
  if (resource?.type) return String(resource.type);
  if (event.threadId || event.targetThreadId || event.parentThreadId) return "thread";
  if (event.timerId) return "timer";
  if (event.desktopSlug || event.browser || event.slug) return "desktop";
  if (event.connector || event.accountId || event.provider) return "connector";
  if (event.userId || event.subjectUserId) return "user";
  return "system";
}

function auditConnector(event = {}) {
  if (event.connector) return String(event.connector);
  if (event.provider) return String(event.provider);
  const type = String(event.type || "").toLowerCase();
  for (const connector of ["gmail", "outlook", "whatsapp", "linkedin", "codex", "openai"]) {
    if (type.includes(connector)) return connector;
  }
  return "";
}

function redactAuditValue(key, value, depth = 0) {
  if (sensitiveAuditKey.test(String(key || ""))) return "[redacted]";
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (depth >= 3) return "[redacted]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => redactAuditValue(key, item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([childKey, childValue]) => [childKey, redactAuditValue(childKey, childValue, depth + 1)]),
  );
}

export function normalizeAuditEvent(event = {}, threadOwners = new Map(), env = process.env) {
  const ownerCandidates = eventOwnerCandidates(event, threadOwners, env);
  const resource = event.resource && typeof event.resource === "object" ? event.resource : null;
  const normalized = Object.fromEntries(
    Object.entries(event).map(([key, value]) => [key, redactAuditValue(key, value)]),
  );
  return {
    ...normalized,
    actorUserId: normalizeOptionalUserId(event.actorUserId || event.principal?.userId || ""),
    ownerUserId: normalizeOptionalUserId(event.ownerUserId || (resource ? resourceOwnerUserId(resource, env) : ownerCandidates[0]) || ""),
    resourceType: auditResourceType(event),
    action: String(event.action || auditAction(event.type)).trim(),
    outcome: auditOutcome(event),
    connector: auditConnector(event),
  };
}

function matchesFilter(event = {}, filters = {}) {
  const user = normalizeOptionalUserId(filters.user || filters.userId || "");
  const resource = String(filters.resource || filters.resourceType || "").trim().toLowerCase();
  const connector = String(filters.connector || "").trim().toLowerCase();
  const outcome = String(filters.outcome || filters.state || "").trim().toLowerCase();
  if (user && event.actorUserId !== user && event.ownerUserId !== user && normalizeOptionalUserId(event.userId) !== user) return false;
  if (resource && String(event.resourceType || "").toLowerCase() !== resource) return false;
  if (connector && String(event.connector || "").toLowerCase() !== connector) return false;
  if (outcome && String(event.outcome || "").toLowerCase() !== outcome) return false;
  return true;
}

export async function listEventsForPrincipal(principal = {}, env = process.env, limit = 100, filters = {}) {
  const requestedLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const events = await listEvents(env, 500);
  const threadOwners = new Map((await listThreads(env)).map((thread) => [thread.id, resourceOwnerUserId(thread, env)]));
  const visible = isAdminPrincipal(principal)
    ? events
    : events.filter((event) => eventOwnerCandidates(event, threadOwners, env).some((owner) => canAccessOwner(principal, owner, env)));
  return visible
    .map((event) => normalizeAuditEvent(event, threadOwners, env))
    .filter((event) => matchesFilter(event, filters))
    .slice(-requestedLimit);
}
