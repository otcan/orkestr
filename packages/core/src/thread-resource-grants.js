import { randomUUID } from "node:crypto";
import { appendEvent } from "../../storage/src/store.js";
import { canAccessOwner, isAdminPrincipal, policyError, resourceOwnerUserId } from "./policy.js";
import { getThread } from "./threads.js";
import { readThreadResourcePolicyState, withThreadResourcePolicyTransaction } from "./thread-resource-policy-store.js";
import { normalizeUserId } from "./users.js";

export const THREAD_RESOURCE_TYPES = Object.freeze({ desktop: "desktop", oxrm: "oxrm", mailbox: "mailbox" });
export const THREAD_RESOURCE_PERMISSIONS = Object.freeze({
  desktop: Object.freeze(["discover", "acquire", "operate", "share"]),
  oxrm: Object.freeze(["discover", "read", "write", "execute"]),
  mailbox: Object.freeze(["discover", "route", "read", "send"]),
});

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

function normalizeResource(raw = {}, env = process.env) {
  const resourceType = normalizeThreadResourceType(raw.resourceType || raw.type);
  const nativeId = safeThreadResourceSegment(raw.nativeId || raw.resourceNativeId || raw.resourceKey || raw.key || raw.slug || raw.desktopSlug || raw.mailboxId || raw.instanceId || raw.resourceId || raw.id, "");
  const resourceKey = safeThreadResourceSegment(raw.resourceKey || raw.key || raw.slug || raw.desktopSlug || nativeId, "");
  const ownerUserId = normalizeUserId(raw.ownerUserId || raw.userId || env.ORKESTR_ADMIN_USER_ID || "admin");
  const boundaryId = safeThreadResourceSegment(raw.boundaryId || raw.tenantVmId || threadResourceBoundaryId(env));
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

function normalizeGrant(raw = {}, env = process.env) {
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

function normalizeState(raw = {}, env = process.env) {
  const resources = (Array.isArray(raw?.resources) ? raw.resources : []).map((item) => normalizeResource(item, env)).filter(Boolean);
  const resourceFor = (item = {}) => resources.find((resource) =>
    resource.resourceType === item.resourceType &&
    resource.ownerUserId === item.ownerUserId &&
    resource.boundaryId === item.boundaryId &&
    (resource.id === item.resourceId || resource.nativeId === item.resourceId || resource.nativeId === item.resourceKey || resource.resourceKey === item.resourceKey)
  ) || null;
  const grants = (Array.isArray(raw?.grants) ? raw.grants : []).map((item) => normalizeGrant(item, env)).filter(Boolean).map((grant) => {
    const resource = resourceFor(grant);
    // Upgrade the first generic-policy increment's non-desktop native IDs to
    // their owner/boundary-bound canonical identity on the next write.
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
    updatedAt: clean(raw?.updatedAt) || null,
  };
}

async function readState(env = process.env) {
  return normalizeState(await readThreadResourcePolicyState(env), env);
}

async function mutateState(env, operation) {
  return withThreadResourcePolicyTransaction((stored) => {
    const state = normalizeState(stored, env);
    const result = operation(state);
    if (result?.noChange === true) return { result: result.result, state, persist: false };
    state.revision += 1;
    state.updatedAt = nowIso();
    return { result, state };
  }, env);
}

function permissionFor(resourceType, action = "") {
  const requested = clean(action).toLowerCase();
  const allowed = THREAD_RESOURCE_PERMISSIONS[resourceType] || [];
  if (allowed.includes(requested)) return requested;
  if (["list", "status", "discover", "whereiam", "inventory"].includes(requested)) return "discover";
  if (resourceType === "desktop" && ["lease", "heartbeat", "release"].includes(requested)) return "acquire";
  if (resourceType === "desktop" && ["proxy", "open_share", "approve_share"].includes(requested)) return "share";
  if (resourceType === "oxrm" && ["operate", "call", "skill"].includes(requested)) return "execute";
  if (resourceType === "mailbox" && ["ingest", "receive", "relay"].includes(requested)) return "route";
  return allowed.includes("operate") ? "operate" : allowed.includes("read") ? "read" : allowed[0] || "discover";
}

function directGrants(state, threadId, resource) {
  return state.grants.filter((grant) => !grant.revokedAt && grant.threadId === threadId && grant.resourceType === resource.resourceType && grant.resourceId === resource.id && grant.ownerUserId === resource.ownerUserId && grant.boundaryId === resource.boundaryId);
}

function declaredChildScopeEntries(thread = {}, resourceType = "") {
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

function declaredScopePermissions(entries = [], resource = {}) {
  const matching = entries.filter((entry) => entry.nativeId === resource.nativeId || entry.nativeId === resource.resourceKey || entry.nativeId === resource.id);
  if (!matching.length) return null;
  return new Set(matching.flatMap((entry) => entry.permissions));
}

async function effectiveGrant(state, thread, resource, permission, env, seen = new Set()) {
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
  const parentGrant = await effectiveGrant(state, parent, resource, permission, env, seen);
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

function effectiveGrantForLineage(state, lineage = [], resource, permission) {
  let effective = null;
  for (const thread of lineage) {
    const direct = directGrants(state, thread.id, resource);
    const directGrant = direct.find((grant) => grant.permissions.includes(permission)) || null;
    if (!effective) {
      effective = directGrant;
      continue;
    }
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

async function threadLineage(thread = {}, env = process.env) {
  const lineage = [];
  let cursor = thread;
  const seen = new Set();
  while (cursor?.id && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    lineage.unshift(cursor);
    const parentId = clean(cursor.parentThreadId);
    cursor = parentId ? await getThread(parentId, env) : null;
  }
  return lineage;
}

async function auditDecision(decision, env = process.env, { required = false } = {}) {
  if (decision.allowed && !decision.shadowDenied && !decision.breakGlass) return;
  try {
    await appendEvent({
      type: decision.breakGlass ? "thread_resource_access_break_glass" : decision.shadowDenied ? "thread_resource_access_shadow_denied" : "thread_resource_access_denied",
      actorUserId: decision.actorUserId, ownerUserId: decision.ownerUserId, threadId: decision.threadId,
      resourceType: decision.resourceType, resourceId: decision.resourceId, resourceKey: decision.resourceKey,
      permission: decision.permission, mode: decision.mode, reason: decision.reason,
      breakGlassReason: decision.breakGlassReason, breakGlassChangeRef: decision.breakGlassChangeRef || "", breakGlassExpiresAt: decision.breakGlassExpiresAt || "",
      outcome: decision.allowed ? "allowed" : "blocked",
    }, env);
  } catch (error) {
    if (required) throw Object.assign(new Error("thread_resource_break_glass_audit_unavailable"), { statusCode: 503, cause: error });
  }
}

function denial(base, reason, env) {
  const denied = { ...base, reason };
  return base.mode === "shadow" ? { ...denied, allowed: true, shadowDenied: true } : denied;
}

export async function authorizeThreadResourceAccess(input = {}, env = process.env) {
  const resourceType = normalizeThreadResourceType(input.resourceType || input.type);
  const mode = threadResourceAccessMode(resourceType, env);
  const principal = input.principal || null;
  const threadId = clean(input.threadId || input.thread?.id);
  const requestedOwner = normalizeUserId(input.ownerUserId || input.thread?.ownerUserId || principal?.userId || env.ORKESTR_ADMIN_USER_ID || "admin");
  const resource = normalizeResource({
    resourceType, resourceId: input.resourceId || input.id, resourceKey: input.resourceKey || input.key || input.slug || input.desktopSlug || input.mailboxId || input.instanceId,
    ownerUserId: requestedOwner, boundaryId: input.boundaryId, generation: input.resourceGeneration || input.generation || input.desktopGeneration,
  }, env);
  const permission = permissionFor(resourceType, input.permission || input.action);
  const base = {
    allowed: false, granted: false, mode, permission, threadId, resourceType, resourceId: resource?.id || "", resourceKey: resource?.resourceKey || "",
    ...(resourceType === "desktop" ? { desktopSlug: resource?.resourceKey || "", desktopId: resource?.id || "", desktopGeneration: resource?.generation || 1 } : {}),
    ownerUserId: requestedOwner, boundaryId: threadResourceBoundaryId(env), actorUserId: clean(principal?.userId), grant: null,
    grantRevision: 0, policyRevision: 0, resourceGeneration: resource?.generation || 1, shadowDenied: false,
    breakGlass: false, breakGlassReason: "", breakGlassChangeRef: "", breakGlassExpiresAt: "", authorizationBinding: null,
    reason: `${resourceType || "resource"}_access_denied`,
  };
  if (!resourceType || !resource) { const decision = denial(base, `${resourceType || "resource"}_not_found`, env); await auditDecision(decision, env); return decision; }
  if (resource.boundaryId !== base.boundaryId) { const decision = denial(base, `${resourceType}_boundary_denied`, env); await auditDecision(decision, env); return decision; }
  if (mode === "off") return { ...base, allowed: true, granted: true, reason: `${resourceType}_access_disabled`, authorizationBinding: { resourceType, resourceId: resource.id, policyRevision: 0, grantRevision: 0, resourceGeneration: resource.generation } };
  const state = await readState(env);
  base.policyRevision = state.revision;
  const stored = state.resources.find((item) => item.id === resource.id && item.resourceType === resourceType) || null;
  if (!stored) { const decision = denial(base, `${resourceType}_resource_not_registered`, env); await auditDecision(decision, env); return decision; }
  if (stored.ownerUserId !== resource.ownerUserId || stored.boundaryId !== resource.boundaryId || stored.nativeId !== resource.nativeId) {
    const decision = denial(base, `${resourceType}_resource_identity_denied`, env); await auditDecision(decision, env); return decision;
  }
  if (stored.status !== "active" || stored.retiredAt) { const decision = denial(base, `${resourceType}_resource_inactive`, env); await auditDecision(decision, env); return decision; }
  base.resourceGeneration = stored.generation;
  if (resourceType === "desktop") base.desktopGeneration = stored.generation;
  const thread = threadId ? await getThread(threadId, env) : null;
  const ownerUserId = normalizeUserId(thread?.ownerUserId || requestedOwner);
  base.ownerUserId = ownerUserId;
  if (threadId && !thread) { const decision = denial(base, `${resourceType}_thread_not_found`, env); await auditDecision(decision, env); return decision; }
  if (thread && principal && !canAccessOwner(principal, ownerUserId, env)) { const decision = denial(base, `${resourceType}_thread_owner_denied`, env); await auditDecision(decision, env); return decision; }
  if (ownerUserId !== resource.ownerUserId) { const decision = denial(base, `${resourceType}_owner_scope_denied`, env); await auditDecision(decision, env); return decision; }
  const reason = clean(input.breakGlassReason || input.reason);
  const changeRef = clean(input.breakGlassChangeRef || input.changeReference || input.changeRef);
  const recentAuthAt = Date.parse(clean(input.recentAuthAt || principal?.recentAuthAt || principal?.authenticatedAt));
  const recentAuthWindowMs = Math.max(1_000, Math.min(15 * 60_000, Number(env.ORKESTR_THREAD_RESOURCE_BREAK_GLASS_RECENT_AUTH_MS || 15 * 60_000) || 15 * 60_000));
  const recentAuth = Number.isFinite(recentAuthAt) && recentAuthAt >= Date.now() - recentAuthWindowMs && recentAuthAt <= Date.now() + 60_000;
  if (input.breakGlass === true && (!isAdminPrincipal(principal || {}) || !reason || !changeRef || !recentAuth)) {
    const decision = { ...base, reason: `${resourceType}_break_glass_requirements_missing` };
    await auditDecision(decision, env); return decision;
  }
  if (input.breakGlass === true) {
    const maxMs = Math.max(1_000, Math.min(15 * 60_000, Number(env.ORKESTR_THREAD_RESOURCE_BREAK_GLASS_TTL_MS || 5 * 60_000) || 5 * 60_000));
    const expiresAt = new Date(Date.now() + maxMs).toISOString();
    const decision = { ...base, allowed: true, granted: true, breakGlass: true, breakGlassReason: reason, breakGlassChangeRef: changeRef, breakGlassExpiresAt: expiresAt, reason: `${resourceType}_admin_break_glass`, authorizationBinding: { resourceType, resourceId: resource.id, policyRevision: state.revision, grantRevision: 0, resourceGeneration: base.resourceGeneration, expiresAt } };
    // Break-glass is usable only after its immutable audit has been committed.
    await auditDecision(decision, env, { required: true }); return decision;
  }
  const grant = thread ? await effectiveGrant(state, thread, resource, permission, env) : null;
  if (grant) return { ...base, allowed: true, granted: true, grant, grantRevision: grant.revision, reason: grant.inheritedByThreadId ? `${resourceType}_grant_inherited` : `${resourceType}_grant_allowed`, authorizationBinding: { resourceType, resourceId: resource.id, policyRevision: state.revision, grantRevision: grant.revision, resourceGeneration: base.resourceGeneration } };
  const decision = denial(base, threadId ? `${resourceType}_grant_required` : `${resourceType}_thread_scope_required`, env);
  await auditDecision(decision, env);
  return decision;
}

export async function assertThreadResourceAccess(input = {}, env = process.env) {
  const decision = await authorizeThreadResourceAccess(input, env);
  if (!decision.allowed) throw policyError(decision.reason, decision.reason.endsWith("_thread_not_found") ? 404 : 403);
  return decision;
}

export async function validateThreadResourceAuthorizationBinding(binding = {}, input = {}, env = process.env) {
  const expected = binding && typeof binding === "object" ? binding : {};
  const decision = await authorizeThreadResourceAccess({
    ...input,
    resourceType: expected.resourceType || input.resourceType,
    resourceId: expected.resourceId || input.resourceId,
    permission: input.permission || input.action,
  }, env);
  const current = decision.authorizationBinding || {};
  const matches = decision.granted === true &&
    current.resourceType === expected.resourceType && current.resourceId === expected.resourceId &&
    Number(current.policyRevision) === Number(expected.policyRevision) &&
    Number(current.grantRevision) === Number(expected.grantRevision) &&
    Number(current.resourceGeneration) === Number(expected.resourceGeneration);
  if (!matches) throw policyError("thread_resource_authorization_stale", 403);
  return decision;
}

export async function filterThreadResources(resources = [], input = {}, env = process.env) {
  const output = [];
  for (const item of Array.isArray(resources) ? resources : []) {
    const decision = await authorizeThreadResourceAccess({ ...input, resourceType: input.resourceType || item.resourceType || item.type, resourceId: input.resourceId || item.resourceId || (input.resourceIdFromItemId === false ? "" : item.id), resourceKey: item.resourceKey || item.key || item.slug || item.desktopSlug || item.mailboxId || item.instanceId, ownerUserId: item.ownerUserId || input.ownerUserId, permission: input.permission || "discover" }, env);
    if (decision.allowed) output.push({ ...item, threadResourceAccess: decision });
  }
  return output;
}

export async function listThreadResourceGrants(threadId = "", resourceType = "", principal = null, env = process.env) {
  const type = normalizeThreadResourceType(resourceType);
  const thread = await getThread(threadId, env);
  if (!thread) throw policyError("thread_not_found", 404);
  if (!canAccessOwner(principal || {}, resourceOwnerUserId(thread, env), env)) throw policyError("thread_access_forbidden", 403);
  const state = await readState(env);
  const grants = state.grants.filter((grant) => grant.threadId === thread.id && !grant.revokedAt && (!type || grant.resourceType === type));
  const policy = type ? state.policies.find((item) => item.threadId === thread.id && item.resourceType === type) || null : null;
  return { ok: true, mode: type ? threadResourceAccessMode(type, env) : null, policyRevision: state.revision, resourcePolicyRevision: policy?.revision || 0, explicitEmpty: policy?.explicitEmpty === true, threadId: thread.id, resourceType: type || null, grants, resources: state.resources.filter((resource) => grants.some((grant) => grant.resourceId === resource.id && grant.resourceType === resource.resourceType)) };
}

function exactGrantPermissions(resourceType, entry = {}) {
  if (!Object.hasOwn(entry, "permissions") || entry.permissions === undefined || entry.permissions === null) return [...THREAD_RESOURCE_PERMISSIONS[resourceType]];
  const raw = Array.isArray(entry.permissions) ? entry.permissions : clean(entry.permissions).split(/[\s,]+/g);
  if (!raw.length || raw.some((value) => !clean(value))) throw policyError("thread_resource_permissions_invalid", 400);
  const normalized = normalizeThreadResourcePermissions(resourceType, raw);
  if (normalized.length !== new Set(raw.map((value) => clean(value).toLowerCase())).size) throw policyError("thread_resource_permissions_invalid", 400);
  return normalized;
}

export async function setThreadResourceGrants(threadId = "", resourceType = "", entries = [], options = {}, env = process.env) {
  const type = normalizeThreadResourceType(resourceType);
  const principal = options.principal || null;
  if (!type) throw policyError("thread_resource_type_invalid", 400);
  if (!isAdminPrincipal(principal || {})) throw policyError("thread_resource_grant_admin_required", 403);
  const thread = await getThread(threadId, env);
  if (!thread) throw policyError("thread_not_found", 404);
  const ownerUserId = resourceOwnerUserId(thread, env);
  const boundaryId = threadResourceBoundaryId(env);
  const normalizedMap = new Map((Array.isArray(entries) ? entries : []).map((entry) => typeof entry === "string" ? { resourceKey: entry } : entry || {}).map((entry) => {
    const nativeId = safeThreadResourceSegment(entry.nativeId || entry.resourceNativeId || entry.resourceId || entry.id || entry.resourceKey || entry.key || entry.slug || entry.desktopSlug || entry.mailboxId || entry.instanceId, "");
    return {
      nativeId,
      resourceKey: safeThreadResourceSegment(entry.resourceKey || entry.key || entry.slug || entry.desktopSlug || entry.mailboxId || entry.instanceId || nativeId, ""),
      permissions: exactGrantPermissions(type, entry), reason: clean(entry.reason || options.reason), generation: entry.generation || entry.resourceGeneration,
    };
  }).filter((entry) => entry.resourceKey && entry.nativeId).map((entry) => [entry.nativeId, entry]));
  const normalized = [...normalizedMap.values()];
  const actorUserId = clean(principal?.userId || "system");
  const updated = await mutateState(env, (state) => {
    const idempotencyKey = clean(options.idempotencyKey || options.requestId);
    const prior = idempotencyKey ? state.mutations.find((item) => item.action === `grants.replace:${thread.id}:${type}` && item.idempotencyKey === idempotencyKey) : null;
    if (prior?.result?.grants) return { noChange: true, result: { ...prior.result, idempotent: true } };
    const priorPolicy = state.policies.find((item) => item.threadId === thread.id && item.resourceType === type) || null;
    if (options.expectedPolicyRevision !== undefined && Number(options.expectedPolicyRevision) !== Number(priorPolicy?.revision || 0)) {
      throw policyError("thread_resource_policy_revision_conflict", 409);
    }
    const timestamp = nowIso();
    state.grants = state.grants.map((grant) => grant.threadId === thread.id && grant.resourceType === type && !grant.revokedAt ? { ...grant, revokedAt: timestamp, revokedBy: actorUserId, updatedAt: timestamp } : grant);
    const created = normalized.map((entry) => {
      const candidate = normalizeResource({ resourceType: type, nativeId: entry.nativeId, resourceKey: entry.resourceKey, ownerUserId, boundaryId, generation: entry.generation }, env);
      let resource = state.resources.find((item) => item.id === candidate.id && item.resourceType === type) || null;
      if (!resource) { resource = candidate; state.resources.push(resource); }
      if (resource.ownerUserId !== ownerUserId || resource.boundaryId !== boundaryId || resource.status !== "active") throw policyError("thread_resource_instance_unavailable", 409);
      const grant = normalizeGrant({ threadId: thread.id, resourceType: type, resourceId: resource.id, resourceKey: resource.resourceKey, ownerUserId, boundaryId, permissions: entry.permissions, revision: state.revision + 1, source: clean(options.source || "admin"), reason: entry.reason }, env);
      state.grants.push(grant); return grant;
    });
    const policy = { threadId: thread.id, resourceType: type, revision: Number(priorPolicy?.revision || 0) + 1, explicitEmpty: created.length === 0, inheritanceMode: priorPolicy?.inheritanceMode === "snapshot_ceiling" ? "snapshot_ceiling" : "explicit", parentSnapshotRevision: priorPolicy?.parentSnapshotRevision || 0, createdAt: priorPolicy?.createdAt || timestamp, updatedAt: timestamp };
    state.policies = state.policies.filter((item) => !(item.threadId === thread.id && item.resourceType === type));
    state.policies.push(policy);
    const result = { grants: created, policy };
    if (idempotencyKey) state.mutations.push({ action: `grants.replace:${thread.id}:${type}`, idempotencyKey, result, policyRevision: state.revision + 1, createdAt: timestamp });
    return result;
  });
  const grants = updated.result.grants || [];
  if (updated.result.idempotent !== true) await appendEvent({ type: "thread_resource_grants_replaced", threadId: thread.id, ownerUserId, actorUserId, resourceType: type, resourceIds: grants.map((grant) => grant.resourceId), policyRevision: updated.state.revision, resourcePolicyRevision: updated.result.policy?.revision || 0, idempotencyKey: clean(options.idempotencyKey || options.requestId) }, env).catch(() => undefined);
  return { ok: true, mode: threadResourceAccessMode(type, env), policyRevision: updated.state.revision, resourcePolicyRevision: updated.result.policy?.revision || 0, threadId: thread.id, resourceType: type, grants, idempotent: updated.result.idempotent === true };
}

export async function advanceThreadResourceGeneration(resourceType = "", resourceKey = "", ownerUserId = "", options = {}, env = process.env) {
  const type = normalizeThreadResourceType(resourceType); const key = safeThreadResourceSegment(resourceKey, ""); const owner = normalizeUserId(ownerUserId || env.ORKESTR_ADMIN_USER_ID || "admin");
  if (!type || !key) throw policyError("thread_resource_not_found", 404);
  const candidate = normalizeResource({ resourceType: type, nativeId: options.nativeId || options.resourceNativeId || options.resourceId || key, resourceKey: key, ownerUserId: owner, boundaryId: options.boundaryId || threadResourceBoundaryId(env) }, env);
  const id = candidate.id;
  const updated = await mutateState(env, (state) => {
    let resource = state.resources.find((item) => item.id === id && item.resourceType === type) || null;
    if (!resource) { resource = candidate; state.resources.push(resource); }
    resource.generation += 1; resource.updatedAt = nowIso(); return resource;
  });
  await appendEvent({ type: "thread_resource_generation_advanced", resourceType: type, resourceId: updated.result.id, resourceKey: updated.result.resourceKey, ownerUserId: updated.result.ownerUserId, boundaryId: updated.result.boundaryId, resourceGeneration: updated.result.generation, reason: clean(options.reason || "resource_runtime_replaced") }, env).catch(() => undefined);
  return { ok: true, resource: updated.result, policyRevision: updated.state.revision };
}

export async function captureChildThreadResourceCeiling(childThread = {}, env = process.env) {
  const childId = clean(childThread.id); const parentId = clean(childThread.parentThreadId);
  if (!childId || !parentId) return { ok: true, captured: 0, skipped: true };
  const parent = await getThread(parentId, env);
  if (!parent) throw policyError("thread_resource_parent_not_found", 409);
  const lineage = await threadLineage(parent, env);
  const declaredScopes = Object.fromEntries(Object.keys(THREAD_RESOURCE_PERMISSIONS).map((resourceType) => [resourceType, declaredChildScopeEntries(childThread, resourceType)]));
  const updated = await mutateState(env, (state) => {
    const snapshotRecorded = Object.keys(THREAD_RESOURCE_PERMISSIONS).every((resourceType) =>
      state.policies.some((item) => item.threadId === childId && item.resourceType === resourceType && item.inheritanceMode === "snapshot_ceiling")
    );
    if (snapshotRecorded) return { noChange: true, result: { captured: 0, existing: true } };
    const candidates = new Map();
    for (const cursor of lineage) {
      for (const grant of state.grants.filter((item) => !item.revokedAt && item.threadId === cursor.id)) {
        const resource = state.resources.find((item) => item.resourceType === grant.resourceType && item.id === grant.resourceId);
        if (resource?.status === "active" && !resource.retiredAt) candidates.set(`${resource.resourceType}:${resource.id}`, resource);
      }
    }
    const createdAt = nowIso(); const captured = [];
    const childScopeGrants = [];
    for (const resource of candidates.values()) {
      const scopeEntries = declaredScopes[resource.resourceType] || [];
      const scopePermissions = scopeEntries.length ? declaredScopePermissions(scopeEntries, resource) : null;
      const permissions = [];
      for (const permission of THREAD_RESOURCE_PERMISSIONS[resource.resourceType] || []) {
        if (effectiveGrantForLineage(state, lineage, resource, permission) && (!scopeEntries.length || scopePermissions?.has(permission))) permissions.push(permission);
      }
      if (!permissions.length) continue;
      captured.push({ threadId: childId, resourceType: resource.resourceType, resourceId: resource.id, permissions, parentThreadId: parent.id, createdAt });
      if (scopeEntries.length) childScopeGrants.push(normalizeGrant({ threadId: childId, resourceType: resource.resourceType, resourceId: resource.id, resourceKey: resource.resourceKey, ownerUserId: resource.ownerUserId, boundaryId: resource.boundaryId, permissions, revision: state.revision + 1, source: "child_scope", reason: "declared_child_scope" }, env));
    }
    state.ceilings.push(...captured);
    state.grants.push(...childScopeGrants.filter(Boolean));
    for (const resourceType of Object.keys(THREAD_RESOURCE_PERMISSIONS)) {
      const prior = state.policies.find((item) => item.threadId === childId && item.resourceType === resourceType) || null;
      const policy = {
        threadId: childId,
        resourceType,
        revision: prior?.revision || 0,
        explicitEmpty: prior?.explicitEmpty === true,
        inheritanceMode: "snapshot_ceiling",
        parentSnapshotRevision: state.revision,
        createdAt: prior?.createdAt || createdAt,
        updatedAt: createdAt,
      };
      state.policies = state.policies.filter((item) => !(item.threadId === childId && item.resourceType === resourceType));
      state.policies.push(policy);
    }
    return { captured: captured.length };
  });
  if (updated.result.captured) await appendEvent({ type: "thread_resource_child_ceiling_captured", threadId: childId, parentThreadId: parentId, captured: updated.result.captured, policyRevision: updated.state.revision }, env).catch(() => undefined);
  return { ok: true, ...updated.result, policyRevision: updated.state.revision };
}

export async function threadResourcePolicySummary(threadId = "", principal = null, env = process.env) {
  const state = await readState(env); const grants = threadId ? state.grants.filter((grant) => grant.threadId === clean(threadId) && !grant.revokedAt) : [];
  const policies = threadId ? state.policies.filter((policy) => policy.threadId === clean(threadId)) : [];
  return { version: state.version, revision: state.revision, threadId: clean(threadId) || null, explicitGrantCount: grants.length, grantsByType: Object.fromEntries(Object.keys(THREAD_RESOURCE_PERMISSIONS).map((type) => [type, grants.filter((grant) => grant.resourceType === type).map((grant) => grant.resourceKey)])), policies: Object.fromEntries(policies.map((policy) => [policy.resourceType, { revision: policy.revision, explicitEmpty: policy.explicitEmpty, inheritanceMode: policy.inheritanceMode, parentSnapshotRevision: policy.parentSnapshotRevision }])), modes: Object.fromEntries(Object.keys(THREAD_RESOURCE_PERMISSIONS).map((type) => [type, threadResourceAccessMode(type, env)])), principalRole: clean(principal?.role) || null };
}
