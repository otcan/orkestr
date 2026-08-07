import { listEvents } from "../../storage/src/store.js";
import { listThreads } from "./threads.js";
import { explicitThreadResourceBackfillPlan } from "./thread-resource-backfill.js";
import {
  THREAD_RESOURCE_PERMISSIONS,
  readThreadResourcePolicy,
  threadResourceAccessMode,
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
  // The current store opens SQLite for its inherited `auto` and other local
  // storage aliases. Never echo an unknown configuration value into doctor
  // output, since it could be a connection string.
  return ["json", "postgres", "postgresql"].includes(backend) ? backend : "sqlite";
}

function globalWriteMode(env = process.env) {
  const value = clean(env.ORKESTR_THREAD_RESOURCE_WRITE_MODE).toLowerCase() || "unified";
  return ["legacy", "dual", "unified"].includes(value) ? value : "invalid";
}

export async function threadResourcePolicyDoctorReport(env = process.env, now = Date.now()) {
  const backend = safeBackend(threadResourcePolicyStoreMode(env));
  const modes = Object.fromEntries(Object.keys(THREAD_RESOURCE_PERMISSIONS).map((type) => [type, threadResourceAccessMode(type, env)]));
  const writeModes = Object.fromEntries(Object.keys(THREAD_RESOURCE_PERMISSIONS).map((type) => [type, threadResourceWritePlan(type, env)]));
  let state;
  try {
    state = await readThreadResourcePolicy(env);
  } catch (error) {
    return {
      ok: false, backend, health: "unavailable", error: safeError(error),
      global: { access: "per_resource_only", write: globalWriteMode(env) }, modes, writeModes,
      counts: { resources: {}, grants: {}, policies: {}, listeners: 0, deliveries: {}, auditOutbox: 0 },
      shadowMismatches: 0, stale: { sessions: 0, listeners: 0, deliveries: 0 }, queue: { pending: 0, deadLetter: 0, oldestLagMs: 0 },
      evidence: { unregistered: 0, ambiguous: 0, plannedResources: 0, plannedGrants: 0 }, breakGlass: { active: 0, pendingAudit: 0 },
    };
  }
  const [threads, events, evidence] = await Promise.all([
    listThreads(env),
    listEvents(env, Math.max(10, Math.min(1000, Number(env.ORKESTR_THREAD_RESOURCE_DOCTOR_EVENT_LIMIT || 500) || 500))).catch(() => []),
    explicitThreadResourceBackfillPlan(env).catch(() => ({ plannedResources: [], plannedGrants: [], ambiguous: [], unregistered: [] })),
  ]);
  const listenerStaleMs = duration(env, "ORKESTR_THREAD_RESOURCE_STALE_LISTENER_MS", 24 * 60 * 60_000);
  const deliveryStaleMs = duration(env, "ORKESTR_THREAD_RESOURCE_STALE_DELIVERY_MS", 30 * 60_000);
  const sessionStaleMs = duration(env, "ORKESTR_THREAD_RESOURCE_STALE_SESSION_MS", 30 * 60_000);
  const pending = state.mailboxDeliveries.filter((item) => ["pending", "claimed"].includes(item.state));
  const oldestAt = pending.map((item) => Date.parse(item.createdAt)).filter(Number.isFinite).sort((a, b) => a - b)[0] || 0;
  const activeBreakGlass = (state.policyAuditOutbox || []).filter((item) => item.action === "break_glass" && item.expiresAt && Date.parse(item.expiresAt) > now);
  const shadowMismatches = events.filter((event) => event.type === "thread_resource_access_shadow_denied" || (event.type === "mailbox_thread_delivery_shadow_evaluated" && event.mismatch === true)).length;
  const staleSessions = threads.filter((thread) => ["working", "running"].includes(clean(thread.state).toLowerCase()) && old(thread.runtime?.heartbeatAt || thread.heartbeatAt || thread.updatedAt, sessionStaleMs, now)).length;
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
      grants: countBy(state.grants.filter((item) => !item.revokedAt)),
      policies: countBy(state.policies),
      listeners: state.mailboxListeners.length,
      deliveries: Object.fromEntries(["pending", "claimed", "delivered", "revoked", "quarantined", "dead-letter"].map((name) => [name, state.mailboxDeliveries.filter((item) => item.state === name).length])),
      auditOutbox: state.policyAuditOutbox.length,
    },
    shadowMismatches,
    stale: {
      sessions: staleSessions,
      listeners: state.mailboxListeners.filter((item) => item.status === "active" && old(item.updatedAt, listenerStaleMs, now)).length,
      deliveries: pending.filter((item) => old(item.updatedAt || item.createdAt, deliveryStaleMs, now)).length,
    },
    queue: { pending: pending.length, deadLetter: state.mailboxDeliveries.filter((item) => item.state === "dead-letter").length, oldestLagMs: oldestAt ? Math.max(0, now - oldestAt) : 0 },
    evidence: { unregistered: evidence.unregistered.length, ambiguous: evidence.ambiguous.length, plannedResources: evidence.plannedResources.length, plannedGrants: evidence.plannedGrants.length },
    breakGlass: { active: activeBreakGlass.length, pendingAudit: activeBreakGlass.filter((item) => item.state === "pending").length },
  };
}

export async function threadResourcePolicyDoctorCheck(env = process.env) {
  const report = await threadResourcePolicyDoctorReport(env);
  const allOff = Object.values(report.modes).every((mode) => mode === "off");
  const problems = !report.ok || report.queue.deadLetter > 0 || report.stale.sessions > 0 || report.stale.listeners > 0 || report.stale.deliveries > 0 || report.evidence.unregistered > 0 || report.evidence.ambiguous > 0;
  const status = !report.ok ? (allOff ? "ok" : "warning") : problems ? "warning" : "ok";
  return {
    id: "thread_resource_policy",
    label: "Thread resource policy",
    status,
    severity: status === "warning" ? "warning" : "info",
    summary: !report.ok
      ? (allOff ? "Policy storage is unavailable while all resource modes are off." : `Policy storage is unavailable (${report.error}).`)
      : `Policy ${report.backend} is healthy; ${report.queue.pending} mailbox delivery item(s) pending and ${report.queue.deadLetter} dead-lettered.`,
    report,
    repair: problems ? "Review resource-grants doctor evidence and mailbox delivery status before enforcing additional resource modes." : "",
  };
}
