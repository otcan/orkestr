import { isAdminPrincipal, resourceOwnerUserId } from "./policy.js";
import { listThreads } from "./threads.js";
import {
  THREAD_RESOURCE_PERMISSIONS,
  listThreadResourceGrants,
  readThreadResourcePolicy,
  registerThreadResource,
  setThreadResourceGrants,
} from "./thread-resource-grants.js";

const clean = (value = "") => String(value || "").trim();

function objects(thread = {}) {
  return [thread, thread.runtime, thread.binding, thread.executor?.metadata, thread.resourceAccess]
    .filter((item) => item && typeof item === "object" && !Array.isArray(item));
}

function nativeId(entry = {}) {
  return clean(entry.nativeId || entry.resourceNativeId || entry.resourceId || entry.instanceId || entry.mailboxId || entry.id || entry.resourceKey || entry.key);
}

function explicitEntries(thread = {}, resourceType = "") {
  const entries = [];
  const scalarKeys = resourceType === "oxrm"
    ? ["oxrmInstanceId", "oxrmResourceId"]
    : ["mailboxId", "mailboxResourceId"];
  for (const source of objects(thread)) {
    for (const key of ["resourceResources", "resources", `${resourceType}Resources`]) {
      for (const entry of Array.isArray(source[key]) ? source[key] : []) {
        if (clean(entry?.resourceType || entry?.type).toLowerCase() === resourceType && nativeId(entry)) entries.push({ kind: "resource", entry });
      }
    }
    for (const key of ["resourceGrants", "grants", `${resourceType}Grants`]) {
      for (const entry of Array.isArray(source[key]) ? source[key] : []) {
        if (clean(entry?.resourceType || entry?.type).toLowerCase() === resourceType && nativeId(entry)) entries.push({ kind: "grant", entry });
      }
    }
    for (const key of scalarKeys) if (clean(source[key])) entries.push({ kind: "resource", entry: { nativeId: source[key], resourceKey: source[key] } });
  }
  return entries;
}

function normalizedPermissions(resourceType = "", entry = {}) {
  const raw = Array.isArray(entry.permissions) ? entry.permissions : [];
  const allowed = new Set(THREAD_RESOURCE_PERMISSIONS[resourceType] || []);
  const values = [...new Set(raw.map((value) => clean(value).toLowerCase()).filter((value) => allowed.has(value)))];
  return values.length === raw.length && values.length ? values : [];
}

export async function explicitThreadResourceBackfillPlan(env = process.env) {
  const [threads, state] = await Promise.all([listThreads(env), readThreadResourcePolicy(env)]);
  const plannedResources = []; const plannedGrants = []; const ambiguous = []; const unregistered = [];
  for (const thread of threads.filter((item) => !item.deletedAt)) {
    const ownerUserId = resourceOwnerUserId(thread, env);
    for (const resourceType of ["oxrm", "mailbox"]) {
      const entries = explicitEntries(thread, resourceType);
      if (!entries.length) continue;
      const resources = new Map(entries.filter((item) => item.kind === "resource").map(({ entry }) => [nativeId(entry), entry]));
      const grants = entries.filter((item) => item.kind === "grant").map(({ entry }) => entry);
      for (const [id, entry] of resources) {
        const registered = state.resources.some((resource) => resource.resourceType === resourceType && resource.ownerUserId === ownerUserId && resource.nativeId === id);
        if (!registered) {
          plannedResources.push({ threadId: thread.id, ownerUserId, resourceType, nativeId: id, resourceKey: clean(entry.resourceKey || id) || id });
          unregistered.push({ threadId: thread.id, resourceType, reason: "explicit_resource_not_registered" });
        }
      }
      for (const entry of grants) {
        const id = nativeId(entry); const permissions = normalizedPermissions(resourceType, entry);
        if (!permissions.length) { ambiguous.push({ threadId: thread.id, resourceType, reason: "explicit_grant_permissions_missing_or_invalid", quarantined: true }); continue; }
        const hasResourceEvidence = resources.has(id) || state.resources.some((resource) => resource.resourceType === resourceType && resource.ownerUserId === ownerUserId && resource.nativeId === id);
        if (!hasResourceEvidence) { unregistered.push({ threadId: thread.id, resourceType, reason: "explicit_grant_target_unregistered", quarantined: true }); continue; }
        plannedGrants.push({ threadId: thread.id, ownerUserId, resourceType, nativeId: id, resourceKey: clean(entry.resourceKey || id) || id, permissions });
      }
    }
  }
  return { ok: true, plannedResources, plannedGrants, ambiguous, unregistered };
}

export async function backfillExplicitThreadResources({ principal = null, dryRun = true } = {}, env = process.env) {
  if (!isAdminPrincipal(principal || {})) {
    const error = new Error("thread_resource_backfill_admin_required"); error.statusCode = 403; throw error;
  }
  const plan = await explicitThreadResourceBackfillPlan(env);
  if (dryRun) return { ...plan, dryRun: true, appliedResources: [], appliedGrants: [] };
  const appliedResources = [];
  for (const item of plan.plannedResources) {
    const result = await registerThreadResource({ ...item, resourceId: item.nativeId, status: "active" }, { principal, source: "explicit_metadata_backfill" }, env);
    appliedResources.push({ resourceType: result.resource.resourceType, status: result.resource.status });
  }
  const grouped = new Map();
  for (const item of plan.plannedGrants) {
    const key = `${item.threadId}:${item.resourceType}`;
    grouped.set(key, [...(grouped.get(key) || []), item]);
  }
  const appliedGrants = [];
  for (const entries of grouped.values()) {
    const first = entries[0];
    const current = await listThreadResourceGrants(first.threadId, first.resourceType, principal, env);
    if (current.grants.length) continue;
    const result = await setThreadResourceGrants(first.threadId, first.resourceType, entries, { principal, source: "explicit_metadata_backfill", reason: "explicit_thread_resource_metadata" }, env);
    appliedGrants.push({ resourceType: result.resourceType, grantCount: result.grants.length });
  }
  return { ...plan, dryRun: false, appliedResources, appliedGrants };
}
