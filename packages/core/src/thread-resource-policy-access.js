import { randomUUID } from "node:crypto";
import { appendEvent } from "../../storage/src/store.js";
import { canAccessOwner, isAdminPrincipal, policyError, resourceOwnerUserId } from "./policy.js";
import { getThread } from "./threads.js";
import {
  readThreadResourcePolicyState,
  withThreadResourcePolicyDeliveryFence,
  withThreadResourcePolicyTransaction,
} from "./thread-resource-policy-store.js";
import {
  effectiveThreadResourceGrant,
  normalizeResource,
  normalizeThreadResourcePolicyState,
  normalizeThreadResourceType,
  permissionForThreadResource,
  threadResourceAccessMode,
  threadResourceBoundaryId,
} from "./thread-resource-policy-model.js";
import { normalizeUserId } from "./users.js";
import { recordThreadResourceAccessMetric, recordThreadResourceBreakGlassMetric } from "./observability.js";

const clean = (value = "") => String(value || "").trim();
const nowIso = () => new Date().toISOString();

async function readState(env = process.env) {
  return normalizeThreadResourcePolicyState(await readThreadResourcePolicyState(env), env);
}

async function mutateState(env, operation) {
  return withThreadResourcePolicyTransaction((stored) => {
    const state = normalizeThreadResourcePolicyState(stored, env);
    const result = operation(state);
    if (result?.noChange === true) return { result: result.result, state, persist: false };
    const auditOutboxUpserts = [...(Array.isArray(result?.auditOutboxUpserts) ? result.auditOutboxUpserts : [])];
    if (result?.transactionalAudit) {
      const audit = result.transactionalAudit;
      const record = {
        id: randomUUID(),
        action: clean(audit.action || "thread_resource_policy_mutation"),
        resourceType: normalizeThreadResourceType(audit.resourceType),
        resourceId: clean(audit.resourceId),
        threadId: clean(audit.threadId),
        permission: clean(audit.permission).toLowerCase(),
        boundaryId: clean(audit.boundaryId),
        ownerUserId: clean(audit.ownerUserId),
        changeRef: clean(audit.changeRef || audit.breakGlassChangeRef || audit.changeReference),
        outcome: clean(audit.outcome || "allowed"),
        actorUserId: clean(audit.actorUserId || "system"),
        reason: clean(audit.reason || "").slice(0, 160),
        expiresAt: clean(audit.expiresAt || "") || null,
        policyRevision: state.revision + (result?.skipPolicyEpoch === true ? 0 : 1),
        state: "pending",
        claimToken: null,
        claimExpiresAt: null,
        deliveredAt: null,
        createdAt: nowIso(),
      };
      state.policyAuditOutbox = [...(state.policyAuditOutbox || []), record];
      auditOutboxUpserts.push(record);
    }
    // Delivery/session bookkeeping opts out of the policy epoch. Resource
    // sessions are invalidated by the mutation that actually affects their
    // grant source or resource, rather than by unrelated global revisions.
    if (result?.skipPolicyEpoch !== true) state.revision += 1;
    state.updatedAt = nowIso();
    return { result, state, auditOutboxUpserts };
  }, env);
}

// Mailbox delivery uses the same transaction and policy revision as grants.
// Keep this narrowly exported so the mailbox dispatcher cannot acquire a
// process-local side store or accidentally bypass CAS invalidation.
export async function readThreadResourcePolicy(env = process.env) {
  return readState(env);
}

export async function mutateThreadResourcePolicy(operation, env = process.env) {
  return mutateState(env, operation);
}

export async function fenceThreadResourcePolicyDelivery(operation, env = process.env) {
  return withThreadResourcePolicyDeliveryFence((stored) => operation(normalizeThreadResourcePolicyState(stored, env)), env);
}

export async function threadResourceThreadLineage(thread = {}, env = process.env) {
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

function denial(base, reason) {
  const denied = { ...base, reason };
  return base.mode === "shadow" ? { ...denied, allowed: true, shadowDenied: true } : denied;
}

async function evaluateThreadResourceAccess(input = {}, env = process.env) {
  const resourceType = normalizeThreadResourceType(input.resourceType || input.type);
  const mode = threadResourceAccessMode(resourceType, env);
  const principal = input.principal || null;
  const threadId = clean(input.threadId || input.thread?.id);
  const resolvedThread = threadId ? await getThread(threadId, env) : null;
  const requestedOwner = normalizeUserId(input.ownerUserId || resolvedThread?.ownerUserId || input.thread?.ownerUserId || principal?.userId || env.ORKESTR_ADMIN_USER_ID || "admin");
  let resource = normalizeResource({
    resourceType, resourceId: input.resourceId || input.id, resourceKey: input.resourceKey || input.key || input.slug || input.desktopSlug || input.mailboxId || input.instanceId,
    ownerUserId: requestedOwner, boundaryId: input.boundaryId, generation: input.resourceGeneration || input.generation || input.desktopGeneration,
  }, env);
  const permission = permissionForThreadResource(resourceType, input.permission || input.action);
  const base = {
    allowed: false, granted: false, mode, permission, threadId, resourceType, resourceId: resource?.id || "", resourceKey: resource?.resourceKey || "",
    ...(resourceType === "desktop" ? { desktopSlug: resource?.resourceKey || "", desktopId: resource?.id || "", desktopGeneration: resource?.generation || 1 } : {}),
    ownerUserId: requestedOwner, boundaryId: threadResourceBoundaryId(env), actorUserId: clean(principal?.userId), grant: null,
    grantRevision: 0, policyRevision: 0, resourceGeneration: resource?.generation || 1, shadowDenied: false,
    breakGlass: false, breakGlassReason: "", breakGlassChangeRef: "", breakGlassExpiresAt: "", authorizationBinding: null,
    reason: `${resourceType || "resource"}_access_denied`,
  };
  if (!permission) {
    const decision = { ...base, reason: `${resourceType || "resource"}_permission_invalid` };
    await auditDecision(decision, env);
    return decision;
  }
  if (!resourceType || !resource) { const decision = denial(base, `${resourceType || "resource"}_not_found`); await auditDecision(decision, env); return decision; }
  if (resource.boundaryId !== base.boundaryId) { const decision = denial(base, `${resourceType}_boundary_denied`); await auditDecision(decision, env); return decision; }
  if (mode === "off") return { ...base, allowed: true, granted: true, reason: `${resourceType}_access_disabled`, authorizationBinding: { resourceType, resourceId: resource.id, policyRevision: 0, grantRevision: 0, resourceGeneration: resource.generation } };
  const state = await readState(env);
  base.policyRevision = state.revision;
  let stored = state.resources.find((item) => item.id === resource.id && item.resourceType === resourceType) || null;
  // Legacy desktop records may have a pre-canonical resource ID. Their slug,
  // owner, and boundary remain the compatibility identity; non-desktop types
  // never receive this fallback.
  if (!stored && resourceType === "desktop") {
    stored = state.resources.find((item) => item.resourceType === "desktop" && item.resourceKey === resource.resourceKey && item.ownerUserId === resource.ownerUserId && item.boundaryId === resource.boundaryId) || null;
    if (stored) {
      resource = stored;
      base.resourceId = stored.id;
      base.resourceKey = stored.resourceKey;
      base.desktopId = stored.id;
      base.desktopSlug = stored.resourceKey;
    }
  }
  if (!stored) { const decision = denial(base, `${resourceType}_resource_not_registered`); await auditDecision(decision, env); return decision; }
  if (stored.ownerUserId !== resource.ownerUserId || stored.boundaryId !== resource.boundaryId || stored.nativeId !== resource.nativeId) {
    const decision = denial(base, `${resourceType}_resource_identity_denied`); await auditDecision(decision, env); return decision;
  }
  if (stored.status !== "active" || stored.retiredAt) { const decision = denial(base, `${resourceType}_resource_inactive`); await auditDecision(decision, env); return decision; }
  base.resourceGeneration = stored.generation;
  if (resourceType === "desktop") base.desktopGeneration = stored.generation;
  const thread = resolvedThread;
  const ownerUserId = normalizeUserId(thread?.ownerUserId || requestedOwner);
  base.ownerUserId = ownerUserId;
  if (threadId && !thread) { const decision = denial(base, `${resourceType}_thread_not_found`); await auditDecision(decision, env); return decision; }
  if (thread && principal && !canAccessOwner(principal, ownerUserId, env)) { const decision = denial(base, `${resourceType}_thread_owner_denied`); await auditDecision(decision, env); return decision; }
  if (ownerUserId !== resource.ownerUserId) { const decision = denial(base, `${resourceType}_owner_scope_denied`); await auditDecision(decision, env); return decision; }
  const reason = clean(input.breakGlassReason || input.reason);
  const changeRef = clean(input.breakGlassChangeRef || input.changeReference || input.changeRef);
  // Do not accept a caller-supplied reauthentication timestamp. Browser/API
  // callers carry a verified session principal whose authentication time is
  // the only eligible recent-authentication evidence.
  const recentAuthAt = Date.parse(clean(principal?.recentAuthAt || principal?.authenticatedAt));
  const recentAuthWindowMs = Math.max(1_000, Math.min(15 * 60_000, Number(env.ORKESTR_THREAD_RESOURCE_BREAK_GLASS_RECENT_AUTH_MS || 15 * 60_000) || 15 * 60_000));
  const recentAuth = Number.isFinite(recentAuthAt) && recentAuthAt >= Date.now() - recentAuthWindowMs && recentAuthAt <= Date.now() + 60_000;
  if (input.breakGlass === true && (!threadId || !isAdminPrincipal(principal || {}) || !reason || !changeRef || !recentAuth)) {
    const decision = { ...base, reason: `${resourceType}_break_glass_requirements_missing` };
    await auditDecision(decision, env); return decision;
  }
  if (input.breakGlass === true) {
    const maxMs = Math.max(1_000, Math.min(15 * 60_000, Number(env.ORKESTR_THREAD_RESOURCE_BREAK_GLASS_TTL_MS || 5 * 60_000) || 5 * 60_000));
    const expiresAt = new Date(Date.now() + maxMs).toISOString();
    const decision = { ...base, allowed: true, granted: true, breakGlass: true, breakGlassReason: reason, breakGlassChangeRef: changeRef, breakGlassExpiresAt: expiresAt, reason: `${resourceType}_admin_break_glass`, authorizationBinding: { resourceType, resourceId: resource.id, policyRevision: state.revision, grantRevision: 0, resourceGeneration: base.resourceGeneration, expiresAt } };
    // Break-glass is usable only after its immutable audit has been committed.
    await recordThreadResourcePolicyAudit({ action: "break_glass", resourceType, actorUserId: clean(principal?.userId || "system"), resourceId: decision.resourceId, threadId: decision.threadId, permission: decision.permission, boundaryId: decision.boundaryId, ownerUserId: decision.ownerUserId, changeRef, outcome: "allowed", reason, expiresAt }, env);
    await auditDecision(decision, env);
    recordThreadResourceBreakGlassMetric({ resourceType, outcome: "allowed" });
    return decision;
  }
  const grant = thread ? await effectiveThreadResourceGrant(state, thread, resource, permission, env) : null;
  if (grant) return { ...base, allowed: true, granted: true, grant, grantRevision: grant.revision, reason: grant.inheritedByThreadId ? `${resourceType}_grant_inherited` : `${resourceType}_grant_allowed`, authorizationBinding: { resourceType, resourceId: resource.id, policyRevision: state.revision, grantRevision: grant.revision, resourceGeneration: base.resourceGeneration } };
  const decision = denial(base, threadId ? `${resourceType}_grant_required` : `${resourceType}_thread_scope_required`);
  await auditDecision(decision, env);
  return decision;
}

export async function authorizeThreadResourceAccess(input = {}, env = process.env) {
  const startedAt = Date.now();
  try {
    const decision = await evaluateThreadResourceAccess(input, env);
    recordThreadResourceAccessMetric({ ...decision, durationMs: Date.now() - startedAt });
    return decision;
  } catch (error) {
    recordThreadResourceAccessMetric({ resourceType: input.resourceType || input.type, permission: input.permission || input.action, mode: threadResourceAccessMode(input.resourceType || input.type, env), granted: false, durationMs: Date.now() - startedAt });
    throw error;
  }
}

export async function recordThreadResourcePolicyAudit(input = {}, env = process.env) {
  const audit = {
    action: clean(input.action || "thread_resource_policy_mutation"), resourceType: normalizeThreadResourceType(input.resourceType),
    resourceId: clean(input.resourceId || input.resource_id), threadId: clean(input.threadId || input.thread_id), permission: clean(input.permission).toLowerCase(),
    boundaryId: clean(input.boundaryId || input.boundary_id), ownerUserId: clean(input.ownerUserId || input.owner_user_id),
    changeRef: clean(input.changeRef || input.change_ref || input.breakGlassChangeRef || input.changeReference), outcome: clean(input.outcome || "allowed"),
    actorUserId: clean(input.actorUserId || "system"), reason: clean(input.reason || "").slice(0, 160), expiresAt: clean(input.expiresAt || "") || null,
  };
  const updated = await mutateState(env, () => ({ transactionalAudit: audit, skipPolicyEpoch: true }));
  return updated.result;
}

export async function assertThreadResourceAccess(input = {}, env = process.env) {
  const decision = await authorizeThreadResourceAccess(input, env);
  if (!decision.allowed) throw policyError(decision.reason, decision.reason.endsWith("_thread_not_found") ? 404 : 403);
  return decision;
}

export async function validateThreadResourceAuthorizationBinding(binding = {}, input = {}, env = process.env) {
  const expected = binding && typeof binding === "object" ? binding : {};
  const decision = await authorizeThreadResourceAccess({ ...input, resourceType: expected.resourceType || input.resourceType, resourceId: expected.resourceId || input.resourceId, permission: input.permission || input.action }, env);
  const current = decision.authorizationBinding || {};
  const matches = decision.granted === true && current.resourceType === expected.resourceType && current.resourceId === expected.resourceId && Number(current.policyRevision) === Number(expected.policyRevision) && Number(current.grantRevision) === Number(expected.grantRevision) && Number(current.resourceGeneration) === Number(expected.resourceGeneration);
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
