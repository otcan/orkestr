import fs from "node:fs/promises";
import { listEvents } from "../../storage/src/store.js";
import { dataPaths } from "../../storage/src/paths.js";
import { listThreads } from "./threads.js";
import { explicitThreadResourceBackfillPlan } from "./thread-resource-backfill.js";
import {
  THREAD_RESOURCE_PERMISSIONS,
  effectiveThreadResourceGrantFromSnapshot,
  readThreadResourcePolicy,
  threadResourceAccessMode,
  threadResourceGrantIsCurrent,
  threadResourceWritePlan,
} from "./thread-resource-grants.js";
import { threadResourcePolicyStoreMode } from "./thread-resource-policy-store.js";

const clean = (value = "") => String(value || "").trim();
const countBy = (items = [], key = "resourceType") => Object.fromEntries(Object.keys(THREAD_RESOURCE_PERMISSIONS).map((type) => [type, items.filter((item) => item[key] === type).length]));

function duration(env, key, fallback) {
  const value = Number(env[key] || fallback);
  return Number.isFinite(value) ? Math.max(1_000, value) : fallback;
}

function old(value, threshold, now) {
  const at = Date.parse(clean(value));
  return Number.isFinite(at) && at < now - threshold;
}

function safeError(error) {
  const value = clean(error?.message || error || "policy_store_unavailable").toLowerCase();
  return /^thread_resource_policy_[a-z0-9_]+$/.test(value) ? value : "policy_store_unavailable";
}

function safeBackend(value = "") {
  const backend = clean(value).toLowerCase();
  if (backend === "postgresql") return "postgres";
  return ["sqlite", "json", "postgres", "postgresql", "invalid"].includes(backend) ? backend : "invalid";
}

function globalWriteMode(env = process.env) {
  const value = clean(env.ORKESTR_THREAD_RESOURCE_WRITE_MODE).toLowerCase() || "unified";
  return ["legacy", "dual", "unified"].includes(value) ? value : "invalid";
}

function emptyReport({ ok, backend, health, error = "", modes, writeModes, globalWrite = "unified", disabled = false } = {}) {
  return {
    ok, backend, health, ...(error ? { error } : {}), ...(disabled ? { disabled: true } : {}),
    global: { access: "per_resource_only", write: globalWrite }, modes, writeModes,
    counts: { resources: {}, grants: {}, policies: {}, listeners: 0, deliveries: {}, routes: {}, routeSources: {}, routeWork: {}, contexts: {}, auditOutbox: 0, resourceSessions: {} },
    outbox: { total: 0, pending: 0, claimed: 0, delivered: 0 },
    shadowMismatches: 0,
    coverage: { resourceSessions: "unsupported" },
    stale: { sessions: 0, listeners: 0, deliveries: 0, routeWork: 0 },
    queue: { pending: 0, deadLetter: 0, oldestLagMs: 0, routePending: 0, routeDeadLetter: 0 },
    evidence: { unregistered: 0, ambiguous: 0, plannedResources: 0, plannedGrants: 0 },
    breakGlass: { active: 0, pendingAudit: 0 },
  };
}

async function policyStoreIsInitialized(env = process.env) {
  const target = dataPaths(env).threadResourcePolicyDb;
  return fs.stat(target).then((stat) => stat.isFile() && stat.size > 0, () => false);
}

function listenerHasCurrentGrant(listener = {}, state = {}, threadsById = new Map()) {
  const resource = state.resources.find((item) => item.resourceType === "mailbox" && item.id === listener.resourceId);
  if (!resource || resource.status !== "active" || resource.retiredAt || Number(resource.generation) !== Number(listener.resourceGeneration)) return false;
  const grant = effectiveThreadResourceGrantFromSnapshot({
    state, threadsById, threadId: listener.threadId, resourceType: "mailbox",
    resourceId: resource.id, permission: "subscribe",
  });
  return Boolean(grant && Number(grant.revision) === Number(listener.grantRevision));
}

export async function threadResourcePolicyDoctorReport(env = process.env, now = Date.now()) {
  const backend = safeBackend(threadResourcePolicyStoreMode(env));
  const modes = Object.fromEntries(Object.keys(THREAD_RESOURCE_PERMISSIONS).map((type) => [type, threadResourceAccessMode(type, env)]));
  const writeModes = Object.fromEntries(Object.keys(THREAD_RESOURCE_PERMISSIONS).map((type) => [type, threadResourceWritePlan(type, env)]));
  const allOff = Object.values(modes).every((mode) => mode === "off");
  if (backend === "invalid") return emptyReport({ ok: false, backend, health: "unavailable", error: "thread_resource_policy_store_mode_invalid", modes, writeModes, globalWrite: globalWriteMode(env) });
  if (allOff && backend === "sqlite" && !(await policyStoreIsInitialized(env))) {
    return emptyReport({ ok: true, backend, health: "not_initialized", modes, writeModes, globalWrite: globalWriteMode(env), disabled: true });
  }
  let state;
  try {
    state = await readThreadResourcePolicy(env);
  } catch (error) {
    return emptyReport({ ok: false, backend, health: "unavailable", error: safeError(error), modes, writeModes, globalWrite: globalWriteMode(env) });
  }
  const [threads, events, evidence] = await Promise.all([
    listThreads(env),
    listEvents(env, Math.max(10, Math.min(1000, Number(env.ORKESTR_THREAD_RESOURCE_DOCTOR_EVENT_LIMIT || 500) || 500))).catch(() => []),
    explicitThreadResourceBackfillPlan(env).catch(() => ({ plannedResources: [], plannedGrants: [], ambiguous: [], unregistered: [] })),
  ]);
  const deliveryStaleMs = duration(env, "ORKESTR_THREAD_RESOURCE_STALE_DELIVERY_MS", 30 * 60_000);
  const pending = state.mailboxDeliveries.filter((item) => ["pending", "claimed"].includes(item.state));
  const routeWork = state.mailboxRouteWork || [];
  const routePending = routeWork.filter((item) => ["pending", "claimed"].includes(item.state));
  const oldestAt = pending.map((item) => Date.parse(item.createdAt)).filter(Number.isFinite).sort((a, b) => a - b)[0] || 0;
  const activeBreakGlass = (state.policyAuditOutbox || []).filter((item) => item.action === "break_glass" && item.expiresAt && Date.parse(item.expiresAt) > now);
  const outbox = Object.fromEntries(["pending", "claimed", "delivered"].map((name) => [name, state.policyAuditOutbox.filter((item) => item.state === name).length]));
  outbox.total = state.policyAuditOutbox.length;
  const resourceSessions = state.resourceSessions || [];
  const resourceSessionCounts = Object.fromEntries(["active", "invalidated", "expired"].map((name) => [name, resourceSessions.filter((item) => item.state === name).length]));
  const shadowMismatches = events.filter((event) => event.type === "thread_resource_access_shadow_denied" || (event.type === "mailbox_thread_delivery_shadow_evaluated" && event.mismatch === true)).length;
  const threadsById = new Map(threads.map((thread) => [thread.id, thread]));
  return {
    ok: true,
    backend,
    health: "healthy",
    global: { access: "per_resource_only", write: globalWriteMode(env) },
    modes,
    writeModes,
    revision: state.revision,
    counts: {
      resources: countBy(state.resources),
      grants: countBy(state.grants.filter((item) => threadResourceGrantIsCurrent(item, now))),
      policies: countBy(state.policies),
      listeners: state.mailboxListeners.length,
      deliveries: Object.fromEntries(["pending", "claimed", "delivered", "revoked", "quarantined", "dead-letter"].map((name) => [name, state.mailboxDeliveries.filter((item) => item.state === name).length])),
      routes: Object.fromEntries(["active", "revoked"].map((name) => [name, (state.mailboxRoutes || []).filter((item) => item.status === name).length])),
      routeSources: Object.fromEntries(["stored", "suppressed", "unrouted", "dead-letter"].map((name) => [name, (state.mailboxSources || []).filter((item) => item.state === name).length])),
      routeWork: Object.fromEntries(["pending", "claimed", "accepted", "running", "completed", "failed", "delivered", "dead-letter", "cancelled", "context_pending"].map((name) => [name, routeWork.filter((item) => item.state === name).length])),
      contexts: Object.fromEntries(["pending", "reserved", "consumed", "cancelled"].map((name) => [name, (state.mailboxContexts || []).filter((item) => item.status === name).length])),
      auditOutbox: state.policyAuditOutbox.length,
      resourceSessions: resourceSessionCounts,
    },
    outbox,
    shadowMismatches,
    coverage: { resourceSessions: "transactional_aggregate" },
    stale: {
      sessions: resourceSessions.filter((item) => item.state === "active" && Date.parse(item.expiresAt) <= now).length,
      listeners: state.mailboxListeners.filter((item) => item.status === "active" && !item.revokedAt && !listenerHasCurrentGrant(item, state, threadsById)).length,
      deliveries: pending.filter((item) => old(item.updatedAt || item.createdAt, deliveryStaleMs, now)).length,
      routeWork: routePending.filter((item) => old(item.updatedAt || item.createdAt, deliveryStaleMs, now)).length,
    },
    queue: { pending: pending.length, deadLetter: state.mailboxDeliveries.filter((item) => item.state === "dead-letter").length, oldestLagMs: oldestAt ? Math.max(0, now - oldestAt) : 0, routePending: routePending.length, routeDeadLetter: routeWork.filter((item) => item.state === "dead-letter").length },
    evidence: { unregistered: evidence.unregistered.length, ambiguous: evidence.ambiguous.length, plannedResources: evidence.plannedResources.length, plannedGrants: evidence.plannedGrants.length },
    breakGlass: { active: activeBreakGlass.length, pendingAudit: activeBreakGlass.filter((item) => item.state === "pending").length },
  };
}

export async function threadResourcePolicyDoctorCheck(env = process.env) {
  const report = await threadResourcePolicyDoctorReport(env);
  const allOff = Object.values(report.modes).every((mode) => mode === "off");
  const problems = !report.ok || report.queue.deadLetter > 0 || report.queue.routeDeadLetter > 0 || report.stale.sessions > 0 || report.stale.listeners > 0 || report.stale.deliveries > 0 || report.stale.routeWork > 0 || report.evidence.unregistered > 0 || report.evidence.ambiguous > 0;
  const status = !report.ok ? (allOff ? "ok" : "warning") : problems ? "warning" : "ok";
  return {
    id: "thread_resource_policy",
    label: "Thread resource policy",
    status,
    severity: status === "warning" ? "warning" : "info",
    summary: !report.ok
      ? (allOff ? "Policy storage is unavailable while all resource modes are off." : `Policy storage is unavailable (${report.error}).`)
      : report.health === "not_initialized"
        ? "Policy storage is not initialized while all resource modes are off."
        : `Policy ${report.backend} is healthy; ${report.queue.pending} mailbox delivery item(s) and ${report.queue.routePending} route work item(s) pending, ${report.queue.deadLetter + report.queue.routeDeadLetter} dead-lettered, and ${report.outbox.pending} audit item(s) pending delivery.`,
    report,
    repair: problems ? "Review resource-grants doctor evidence and mailbox delivery status before enforcing additional resource modes." : "",
  };
}
