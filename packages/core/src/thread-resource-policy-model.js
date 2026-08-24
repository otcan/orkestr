import { randomUUID } from "node:crypto";
import { policyError } from "./policy.js";
import { getThread } from "./threads.js";
import { normalizeUserId } from "./users.js";
import { THREAD_RESOURCE_PERMISSIONS, THREAD_RESOURCE_TYPES } from "./thread-resource-policy-constants.js";

export { THREAD_RESOURCE_PERMISSIONS, THREAD_RESOURCE_TYPES } from "./thread-resource-policy-constants.js";

const truthy = new Set(["1", "true", "yes", "on"]);
const modes = new Set(["off", "shadow", "enforce"]);
const clean = (value = "") => String(value || "").trim();
const nowIso = () => new Date().toISOString();

export function safeThreadResourceSegment(value = "", fallback = "local") {
  return clean(value).toLowerCase().replace(/[^a-z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 160) || fallback;
}

export function normalizeThreadResourceType(value = "") {
  const type = clean(value).toLowerCase();
  return Object.hasOwn(THREAD_RESOURCE_PERMISSIONS, type) ? type : "";
}

export function threadResourceBoundaryId(env = process.env) {
  return safeThreadResourceSegment(env.ORKESTR_TENANT_VM_ID || env.ORKESTR_BROKER_INSTANCE_ID || env.ORKESTR_INSTANCE_ID || env.ORKESTR_INSTALLATION_ID || "local");
}

export function threadResourceId(resourceType = "", resourceKey = "", ownerUserId = "", env = process.env) {
  const type = normalizeThreadResourceType(resourceType);
  const key = safeThreadResourceSegment(resourceKey, "");
  if (!type || !key) return "";
  const owner = normalizeUserId(ownerUserId || env.ORKESTR_ADMIN_USER_ID || "admin");
  const boundary = threadResourceBoundaryId(env);
  // Keep the original desktop resource identity stable for existing shares and leases.
  return type === THREAD_RESOURCE_TYPES.desktop ? `${boundary}:${owner}:${key}` : `${boundary}:${owner}:${type}:${key}`;
}

export function normalizeThreadResourcePermissions(resourceType = "", values = []) {
  const type = normalizeThreadResourceType(resourceType);
  const allowed = new Set(THREAD_RESOURCE_PERMISSIONS[type] || []);
  const input = Array.isArray(values) ? values : clean(values).split(/[\s,]+/g);
  return [...new Set(input.map((value) => clean(value).toLowerCase()).filter((value) => allowed.has(value)))];
}

export function threadResourceAccessMode(resourceType = "", env = process.env) {
  const type = normalizeThreadResourceType(resourceType);
  if (!type) return "enforce";
  const prefix = `ORKESTR_${type.toUpperCase()}_ACCESS_MODE`;
  const configured = clean(env[`ORKESTR_THREAD_RESOURCE_${type.toUpperCase()}_MODE`] || env[prefix]).toLowerCase();
  if (modes.has(configured)) return configured;
  if (type === THREAD_RESOURCE_TYPES.desktop && truthy.has(clean(env.ORKESTR_DESKTOP_ACCESS_ENFORCED).toLowerCase())) return "enforce";
  // Desktop remains rollout-safe. New resource types are opt-in until their explicit
  // bindings have been configured, so existing instance-level integrations keep working.
  return type === THREAD_RESOURCE_TYPES.desktop || type === THREAD_RESOURCE_TYPES.oxrm ? "shadow" : "off";
}

function desktopEnforcedBindings(env = process.env) {
  const raw = clean(env.ORKESTR_DESKTOP_ENFORCED_BINDINGS_JSON);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const bindings = parsed.map((item) => ({
      threadId: clean(item?.threadId),
      resourceId: clean(item?.resourceId || item?.desktopId),
    })).filter((item) => item.threadId && item.resourceId);
    return bindings.length === parsed.length ? bindings : null;
  } catch {
    return null;
  }
}

// Operators can graduate one exact thread/desktop binding from shadow to
// enforcement without changing the rollout mode for unrelated desktops. Both
// sides of a protected binding trigger enforcement: the protected thread
// cannot drift to another desktop, and another thread cannot target the
// protected desktop. Invalid non-empty configuration fails closed globally.
export function threadResourceAccessModeFor(resourceType = "", input = {}, env = process.env) {
  const type = normalizeThreadResourceType(resourceType);
  const configured = threadResourceAccessMode(type, env);
  if (type !== THREAD_RESOURCE_TYPES.desktop || configured !== "shadow") return configured;
  const bindings = desktopEnforcedBindings(env);
  if (bindings === null) return "enforce";
  if (!bindings.length) return configured;
  const threadId = clean(input.threadId || input.thread?.id);
  const resourceId = clean(input.resourceId || input.desktopId || input.id);
  return bindings.some((binding) =>
    (threadId && binding.threadId === threadId) ||
    (resourceId && binding.resourceId === resourceId)
  ) ? "enforce" : configured;
}

export function normalizeResource(raw = {}, env = process.env) {
  const resourceType = normalizeThreadResourceType(raw.resourceType || raw.type);
  const ownerUserId = normalizeUserId(raw.ownerUserId || raw.userId || env.ORKESTR_ADMIN_USER_ID || "admin");
  const boundaryId = safeThreadResourceSegment(raw.boundaryId || raw.tenantVmId || threadResourceBoundaryId(env));
  const suppliedId = clean(raw.canonicalResourceId || raw.resourceId || raw.id);
  const canonicalPrefix = resourceType && resourceType !== "desktop" ? `${boundaryId}:${ownerUserId}:${resourceType}:` : "";
  const suppliedCanonical = Boolean(canonicalPrefix && suppliedId.startsWith(canonicalPrefix));
  const nativeId = safeThreadResourceSegment(raw.nativeId || raw.resourceNativeId || (suppliedCanonical ? suppliedId.slice(canonicalPrefix.length) : raw.resourceKey || raw.key || raw.slug || raw.desktopSlug || raw.mailboxId || raw.instanceId || suppliedId), "");
  const resourceKey = safeThreadResourceSegment(raw.resourceKey || raw.key || raw.slug || raw.desktopSlug || nativeId, "");
  // oXRM and mailbox native identifiers are only unique within their instance
  // boundary and owner. Never use a caller-provided native identifier as the
  // policy key for those types.
  const id = resourceType === "desktop"
    ? clean(raw.id || raw.resourceId) || threadResourceId(resourceType, resourceKey, ownerUserId, { ...env, ORKESTR_TENANT_VM_ID: boundaryId })
    : threadResourceId(resourceType, nativeId, ownerUserId, { ...env, ORKESTR_TENANT_VM_ID: boundaryId });
  if (!resourceType || !resourceKey || !nativeId || !id || !ownerUserId || !boundaryId) return null;
  return {
    id,
    nativeId,
    resourceType,
    resourceKey,
    ...(resourceType === "desktop" ? { desktopSlug: resourceKey, slug: resourceKey } : {}),
    ownerUserId,
    boundaryId,
    generation: Math.max(1, Number(raw.generation || raw.resourceGeneration || raw.desktopGeneration || 1) || 1),
    status: ["active", "suspended", "retired"].includes(clean(raw.status || (raw.retiredAt ? "retired" : "active")).toLowerCase())
      ? clean(raw.status || (raw.retiredAt ? "retired" : "active")).toLowerCase()
      : "suspended",
    backend: clean(raw.backend || raw.type || resourceType) || resourceType,
    createdAt: clean(raw.createdAt) || nowIso(),
    updatedAt: clean(raw.updatedAt || raw.createdAt) || nowIso(),
    retiredAt: clean(raw.retiredAt) || null,
  };
}

export function normalizeGrant(raw = {}, env = process.env) {
  const resourceType = normalizeThreadResourceType(raw.resourceType || raw.type || (raw.desktopSlug ? "desktop" : ""));
  const resourceKey = safeThreadResourceSegment(raw.resourceKey || raw.key || raw.desktopSlug || raw.slug || raw.mailboxId || raw.instanceId || raw.resourceId || raw.id, "");
  const ownerUserId = normalizeUserId(raw.ownerUserId || raw.userId || env.ORKESTR_ADMIN_USER_ID || "admin");
  const boundaryId = safeThreadResourceSegment(raw.boundaryId || raw.tenantVmId || threadResourceBoundaryId(env));
  const resourceId = clean(raw.resourceId || raw.desktopId) || threadResourceId(resourceType, resourceKey, ownerUserId, { ...env, ORKESTR_TENANT_VM_ID: boundaryId });
  const threadId = clean(raw.threadId);
  if (!threadId || !resourceType || !resourceKey || !resourceId || !ownerUserId || !boundaryId) return null;
  const permissions = normalizeThreadResourcePermissions(resourceType, raw.permissions);
  return {
    id: clean(raw.id) || randomUUID(),
    threadId,
    resourceType,
    resourceId,
    resourceKey,
    ...(resourceType === "desktop" ? { desktopId: resourceId, desktopSlug: resourceKey } : {}),
    ownerUserId,
    boundaryId,
    permissions: permissions.length ? permissions : [...THREAD_RESOURCE_PERMISSIONS[resourceType]],
    revision: Math.max(1, Number(raw.revision || 1) || 1),
    source: clean(raw.source || "explicit") || "explicit",
    createdAt: clean(raw.createdAt) || nowIso(),
    updatedAt: clean(raw.updatedAt || raw.createdAt) || nowIso(),
    revokedAt: clean(raw.revokedAt) || null,
    revokedBy: clean(raw.revokedBy) || null,
    reason: clean(raw.reason) || null,
  };
}

export function normalizeThreadResourcePolicyState(raw = {}, env = process.env) {
  const resources = (Array.isArray(raw?.resources) ? raw.resources : []).map((item) => normalizeResource(item, env)).filter(Boolean);
  const resourceFor = (item = {}) => resources.find((resource) =>
    resource.resourceType === item.resourceType &&
    resource.ownerUserId === item.ownerUserId &&
    resource.boundaryId === item.boundaryId &&
    (resource.id === item.resourceId || resource.nativeId === item.resourceId || resource.nativeId === item.resourceKey || resource.resourceKey === item.resourceKey)
  ) || null;
  const grants = (Array.isArray(raw?.grants) ? raw.grants : []).map((item) => normalizeGrant(item, env)).filter(Boolean).map((grant) => {
    // Upgrade the first generic-policy increment's non-desktop native IDs to
    // their owner/boundary-bound canonical identity on the next write.
    const resource = resourceFor(grant);
    return resource ? { ...grant, resourceId: resource.id, resourceKey: resource.resourceKey, ownerUserId: resource.ownerUserId, boundaryId: resource.boundaryId } : grant;
  });
  const ceilings = (Array.isArray(raw?.ceilings) ? raw.ceilings : []).map((item) => ({
    threadId: clean(item.threadId), resourceType: normalizeThreadResourceType(item.resourceType), resourceId: clean(item.resourceId),
    permissions: normalizeThreadResourcePermissions(item.resourceType, item.permissions), parentThreadId: clean(item.parentThreadId), createdAt: clean(item.createdAt) || nowIso(),
  })).filter((item) => item.threadId && item.resourceType && item.resourceId && item.parentThreadId).map((ceiling) => {
    const resource = resources.find((item) => item.resourceType === ceiling.resourceType && (item.id === ceiling.resourceId || item.nativeId === ceiling.resourceId));
    return resource ? { ...ceiling, resourceId: resource.id } : ceiling;
  });
  return {
    version: 1,
    revision: Math.max(0, Number(raw?.revision || 0) || 0),
    resources,
    grants,
    policies: (Array.isArray(raw?.policies) ? raw.policies : []).map((item) => ({
      threadId: clean(item.threadId), resourceType: normalizeThreadResourceType(item.resourceType), revision: Math.max(0, Number(item.revision || 0) || 0),
      explicitEmpty: item.explicitEmpty === true,
      inheritanceMode: clean(item.inheritanceMode || "explicit").toLowerCase() === "snapshot_ceiling" ? "snapshot_ceiling" : "explicit",
      parentSnapshotRevision: Math.max(0, Number(item.parentSnapshotRevision || 0) || 0),
      createdAt: clean(item.createdAt) || nowIso(), updatedAt: clean(item.updatedAt || item.createdAt) || nowIso(),
    })).filter((item) => item.threadId && item.resourceType),
    ceilings,
    mutations: Array.isArray(raw?.mutations) ? raw.mutations : [],
    mailboxListeners: Array.isArray(raw?.mailboxListeners) ? raw.mailboxListeners : [],
    mailboxDeliveries: Array.isArray(raw?.mailboxDeliveries) ? raw.mailboxDeliveries : [],
    mailboxPumpLeases: Array.isArray(raw?.mailboxPumpLeases) ? raw.mailboxPumpLeases : [],
    mailboxRoutes: Array.isArray(raw?.mailboxRoutes) ? raw.mailboxRoutes : [],
    mailboxSources: Array.isArray(raw?.mailboxSources) ? raw.mailboxSources : [],
    mailboxRouteWork: Array.isArray(raw?.mailboxRouteWork) ? raw.mailboxRouteWork : [],
    mailboxContexts: Array.isArray(raw?.mailboxContexts) ? raw.mailboxContexts : [],
    resourceSessions: (Array.isArray(raw?.resourceSessions) ? raw.resourceSessions : []).map((item) => ({
      id: clean(item?.id), jtiHash: clean(item?.jtiHash), tokenIdHash: clean(item?.tokenIdHash), bearerHash: clean(item?.bearerHash), audience: clean(item?.audience),
      scopes: Array.isArray(item?.scopes) ? item.scopes.map((scope) => clean(scope).toLowerCase()).filter(Boolean) : [],
      principalKind: clean(item?.principalKind) || "external_instance", principalId: clean(item?.principalId), ownerUserId: clean(item?.ownerUserId),
      instanceId: clean(item?.instanceId), accountId: clean(item?.accountId), accountService: clean(item?.accountService).toLowerCase(),
      resourceType: normalizeThreadResourceType(item?.resourceType), resourceId: clean(item?.resourceId),
      actions: normalizeThreadResourcePermissions(item?.resourceType, item?.actions),
      connectorService: clean(item?.connectorService).toLowerCase(), connectorAccountId: clean(item?.connectorAccountId),
      connectorConversationId: clean(item?.connectorConversationId), connectorBindingId: clean(item?.connectorBindingId),
      connectorTargetThreadId: clean(item?.connectorTargetThreadId), connectorOperationRef: clean(item?.connectorOperationRef),
      connectorTool: clean(item?.connectorTool).toLowerCase(), connectorAction: clean(item?.connectorAction).toLowerCase(),
      threadId: clean(item?.threadId), grantThreadId: clean(item?.grantThreadId || item?.threadId), rootThreadId: clean(item?.rootThreadId), boundaryId: clean(item?.boundaryId),
      policyRevision: Math.max(0, Number(item?.policyRevision || 0) || 0), grantRevision: Math.max(0, Number(item?.grantRevision || 0) || 0),
      resourceGeneration: Math.max(1, Number(item?.resourceGeneration || 1) || 1),
      state: ["active", "invalidated", "expired"].includes(clean(item?.state).toLowerCase()) ? clean(item.state).toLowerCase() : "invalidated",
      epoch: Math.max(1, Number(item?.epoch || 1) || 1), issuedAt: clean(item?.issuedAt), expiresAt: clean(item?.expiresAt),
      lastUsedAt: clean(item?.lastUsedAt) || null, createdAt: clean(item?.createdAt) || nowIso(), updatedAt: clean(item?.updatedAt || item?.createdAt) || nowIso(),
      invalidatedAt: clean(item?.invalidatedAt) || null, invalidationReason: clean(item?.invalidationReason) || null,
    })).filter((item) => item.id && item.jtiHash && item.tokenIdHash && item.resourceType && item.resourceId && item.actions.length && item.threadId && item.rootThreadId && item.boundaryId && item.issuedAt && item.expiresAt),
    policyAuditOutbox: (Array.isArray(raw?.policyAuditOutbox) ? raw.policyAuditOutbox : []).map((item) => ({
      ...item,
      resourceType: normalizeThreadResourceType(item?.resourceType),
      resourceId: clean(item?.resourceId), threadId: clean(item?.threadId), permission: clean(item?.permission).toLowerCase(),
      boundaryId: clean(item?.boundaryId), ownerUserId: clean(item?.ownerUserId), changeRef: clean(item?.changeRef),
      state: ["pending", "claimed", "delivered"].includes(clean(item?.state).toLowerCase()) ? clean(item.state).toLowerCase() : "pending",
      claimToken: clean(item?.claimToken) || null, claimExpiresAt: clean(item?.claimExpiresAt) || null, deliveredAt: clean(item?.deliveredAt) || null,
    })),
    updatedAt: clean(raw?.updatedAt) || null,
  };
}

export function permissionForThreadResource(resourceType, action = "") {
  const requested = clean(action).toLowerCase();
  const allowed = THREAD_RESOURCE_PERMISSIONS[resourceType] || [];
  if (allowed.includes(requested)) return requested;
  if (["list", "status", "discover", "whereiam", "inventory"].includes(requested)) return "discover";
  if (resourceType === "desktop" && ["lease", "heartbeat", "release"].includes(requested)) return "acquire";
  if (resourceType === "desktop" && ["proxy", "open_share", "approve_share"].includes(requested)) return "share";
  if (resourceType === "oxrm" && ["operate", "call", "skill"].includes(requested)) return "execute";
  if (resourceType === "mailbox" && ["listener", "listen", "create_listener", "subscribe"].includes(requested)) return "subscribe";
  if (resourceType === "mailbox" && ["revoke_listener", "listeners", "manage"].includes(requested)) return "manage";
  return "";
}

export function exactGrantPermissions(resourceType, entry = {}) {
  if (!Object.hasOwn(entry, "permissions") || entry.permissions === undefined || entry.permissions === null) return [...THREAD_RESOURCE_PERMISSIONS[resourceType]];
  const raw = Array.isArray(entry.permissions) ? entry.permissions : clean(entry.permissions).split(/[\s,]+/g);
  if (!raw.length || raw.some((value) => !clean(value))) throw policyError("thread_resource_permissions_invalid", 400);
  const normalized = normalizeThreadResourcePermissions(resourceType, raw);
  if (normalized.length !== new Set(raw.map((value) => clean(value).toLowerCase())).size) throw policyError("thread_resource_permissions_invalid", 400);
  return normalized;
}

function directGrants(state, threadId, resource) {
  return state.grants.filter((grant) => !grant.revokedAt && grant.threadId === threadId && grant.resourceType === resource.resourceType && grant.resourceId === resource.id && grant.ownerUserId === resource.ownerUserId && grant.boundaryId === resource.boundaryId);
}

export function declaredChildScopeEntries(thread = {}, resourceType = "") {
  const sources = [thread.resourceGrants, thread.resourceAccess?.grants, resourceType === "desktop" ? thread.desktopGrants : []];
  return sources.flatMap((source) => Array.isArray(source) ? source : []).flatMap((entry) => {
    const item = typeof entry === "string" ? { resourceKey: entry, resourceType: "desktop" } : entry || {};
    if (normalizeThreadResourceType(item.resourceType || item.type || (item.desktopSlug || item.slug ? "desktop" : "")) !== resourceType) return [];
    const nativeId = safeThreadResourceSegment(item.nativeId || item.resourceNativeId || item.resourceId || item.id || item.resourceKey || item.key || item.slug || item.desktopSlug || item.mailboxId || item.instanceId, "");
    if (!nativeId) throw policyError("thread_resource_child_scope_invalid", 400);
    return [{ nativeId, permissions: exactGrantPermissions(resourceType, item) }];
  });
}

function declaredChildScope(thread = {}, resourceType = "") {
  return declaredChildScopeEntries(thread, resourceType).length > 0;
}

export function declaredScopePermissions(entries = [], resource = {}) {
  const matching = entries.filter((entry) => entry.nativeId === resource.nativeId || entry.nativeId === resource.resourceKey || entry.nativeId === resource.id);
  if (!matching.length) return null;
  return new Set(matching.flatMap((entry) => entry.permissions));
}

export async function effectiveThreadResourceGrant(state, thread, resource, permission, env, seen = new Set()) {
  if (!thread?.id || seen.has(thread.id)) return null;
  seen.add(thread.id);
  const direct = directGrants(state, thread.id, resource);
  const directGrant = direct.find((grant) => grant.permissions.includes(permission)) || null;
  const parentId = clean(thread.parentThreadId);
  if (!parentId) return directGrant;
  const ceiling = state.ceilings.find((item) => item.threadId === thread.id && item.resourceType === resource.resourceType && item.resourceId === resource.id) || null;
  // Child ceilings are captured at creation. A later parent grant never widens
  // an existing worker/task-agent; a parent revocation still narrows it now.
  if (!ceiling || !ceiling.permissions.includes(permission)) return null;
  const parent = await getThread(parentId, env);
  if (!parent) return null;
  const parentGrant = await effectiveThreadResourceGrant(state, parent, resource, permission, env, seen);
  if (!parentGrant) return null;
  const policy = state.policies.find((item) => item.threadId === thread.id && item.resourceType === resource.resourceType) || null;
  // A snapshot marker records creation-time inheritance but is not itself an
  // explicit child restriction. Explicit policy rows and direct grants narrow.
  const narrowed = (policy?.inheritanceMode !== "snapshot_ceiling" && Boolean(policy)) || state.grants.some((grant) => !grant.revokedAt && grant.threadId === thread.id && grant.resourceType === resource.resourceType) || declaredChildScope(thread, resource.resourceType);
  if (policy?.explicitEmpty) return null;
  if (!narrowed) return { ...parentGrant, inheritedByThreadId: thread.id, inheritedFromThreadId: parentGrant.threadId };
  if (!directGrant) return null;
  return { ...directGrant, inheritedByThreadId: thread.id, inheritedFromThreadId: parentGrant.threadId, revision: Math.max(parentGrant.revision, directGrant.revision) };
}

export function effectiveThreadResourceGrantForLineage(state, lineage = [], resource, permission) {
  let effective = null;
  for (let index = 0; index < lineage.length; index += 1) {
    const thread = lineage[index];
    const direct = directGrants(state, thread.id, resource);
    const directGrant = direct.find((grant) => grant.permissions.includes(permission)) || null;
    if (index === 0) { effective = directGrant; continue; }
    // A descendant direct grant is only a restriction of an already-effective
    // ancestor grant. It can never re-root a denied lineage.
    if (!effective) return null;
    const ceiling = state.ceilings.find((item) => item.threadId === thread.id && item.resourceType === resource.resourceType && item.resourceId === resource.id) || null;
    if (!ceiling?.permissions.includes(permission)) return null;
    const policy = state.policies.find((item) => item.threadId === thread.id && item.resourceType === resource.resourceType) || null;
    const narrowed = (policy?.inheritanceMode !== "snapshot_ceiling" && Boolean(policy)) || state.grants.some((grant) => !grant.revokedAt && grant.threadId === thread.id && grant.resourceType === resource.resourceType) || declaredChildScope(thread, resource.resourceType);
    if (policy?.explicitEmpty) return null;
    if (!narrowed) continue;
    if (!directGrant) return null;
    effective = { ...directGrant, inheritedByThreadId: thread.id, inheritedFromThreadId: effective.threadId, revision: Math.max(effective.revision, directGrant.revision) };
  }
  return effective;
}

// Doctor/report callers can use the exact inheritance calculation without an
// authorization decision, event append, or metric. The supplied state and
// thread map are snapshots owned by the caller, so this remains read-only.
export function effectiveThreadResourceGrantFromSnapshot({ state = {}, threadsById = new Map(), threadId = "", resourceType = "", resourceId = "", permission = "" } = {}) {
  const type = normalizeThreadResourceType(resourceType);
  const permitted = permissionForThreadResource(type, permission);
  const resource = (state.resources || []).find((item) => item.resourceType === type && item.id === clean(resourceId));
  if (!type || !permitted || !resource || resource.status !== "active" || resource.retiredAt) return null;
  const lookup = threadsById instanceof Map ? threadsById : new Map(Object.entries(threadsById || {}));
  const lineage = [];
  const seen = new Set();
  let thread = lookup.get(clean(threadId)) || null;
  while (thread?.id) {
    // Match the authorization path's fail-closed behavior for a broken
    // lineage. A missing/cyclic parent must never make a descendant a root.
    if (seen.has(thread.id)) return null;
    seen.add(thread.id);
    lineage.unshift(thread);
    const parentId = clean(thread.parentThreadId);
    if (!parentId) break;
    thread = lookup.get(parentId) || null;
    if (!thread) return null;
  }
  if (!lineage.length) return null;
  try {
    return effectiveThreadResourceGrantForLineage(state, lineage, resource, permitted);
  } catch {
    // A malformed persisted declared scope is not evidence of a current grant.
    return null;
  }
}
