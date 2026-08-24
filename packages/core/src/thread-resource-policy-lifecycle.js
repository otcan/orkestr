import { appendEvent } from "../../storage/src/store.js";
import { isAdminPrincipal, policyError, resourceOwnerUserId } from "./policy.js";
import { getThread, listThreads } from "./threads.js";
import {
  requireUnifiedThreadResourceWriteMode,
  threadResourceWriteMode,
  threadResourceWritePlan,
} from "./thread-resource-rollout.js";
import { normalizeUserId } from "./users.js";
import { recordThreadResourceInvalidationMetric } from "./observability.js";
import {
  THREAD_RESOURCE_PERMISSIONS,
  THREAD_RESOURCE_TYPES,
  declaredChildScopeEntries,
  declaredScopePermissions,
  effectiveThreadResourceGrantForLineage,
  exactGrantPermissions,
  normalizeGrant,
  normalizeResource,
  normalizeThreadResourceType,
  safeThreadResourceSegment,
  threadResourceAccessMode,
  threadResourceAccessModeFor,
  threadResourceBoundaryId,
} from "./thread-resource-policy-model.js";
import {
  mutateThreadResourcePolicy,
  readThreadResourcePolicy,
  threadResourceThreadLineage,
} from "./thread-resource-policy-access.js";

const clean = (value = "") => String(value || "").trim();
const nowIso = () => new Date().toISOString();

function requireUnifiedWriteMode(resourceType = "", env = process.env) {
  return requireUnifiedThreadResourceWriteMode(resourceType, policyError, env);
}

function invalidateResourceSessions(state, matches, reason, timestamp = nowIso()) {
  state.resourceSessions = (state.resourceSessions || []).map((session) =>
    session.state === "active" && matches(session)
      ? { ...session, state: "invalidated", epoch: Number(session.epoch || 1) + 1, invalidatedAt: timestamp, invalidationReason: reason, updatedAt: timestamp }
      : session
  );
}

function isDescendantThread(threadId = "", ancestorThreadId = "", threadsById = new Map()) {
  let cursor = threadsById.get(clean(threadId)) || null;
  const seen = new Set();
  while (cursor?.parentThreadId) {
    if (seen.has(cursor.id)) return false;
    seen.add(cursor.id);
    const parentId = clean(cursor.parentThreadId);
    if (parentId === clean(ancestorThreadId)) return true;
    cursor = threadsById.get(parentId) || null;
  }
  return false;
}

export async function registerThreadResource(input = {}, options = {}, env = process.env) {
  const principal = options.principal || input.principal || null;
  const resourceType = normalizeThreadResourceType(input.resourceType || input.type);
  if (!resourceType) throw policyError("thread_resource_type_invalid", 400);
  const writePlan = requireUnifiedWriteMode(resourceType, env);
  if (!isAdminPrincipal(principal || {})) throw policyError("thread_resource_registration_admin_required", 403);
  const requestedStatus = clean(input.status || "active").toLowerCase();
  if (!["active", "suspended", "retired"].includes(requestedStatus)) throw policyError("thread_resource_status_invalid", 400);
  const resource = normalizeResource({ ...input, resourceType, status: requestedStatus }, env);
  if (!resource) throw policyError("thread_resource_registration_invalid", 400);
  const idempotencyKey = clean(options.idempotencyKey || options.requestId || input.idempotencyKey || input.requestId);
  const updated = await mutateThreadResourcePolicy((state) => {
    const action = `resources.upsert:${resource.resourceType}:${resource.id}`;
    const prior = idempotencyKey ? state.mutations.find((item) => item.action === action && item.idempotencyKey === idempotencyKey) : null;
    if (prior?.result?.resource) return { noChange: true, result: { ...prior.result, idempotent: true } };
    const existing = state.resources.find((item) => item.resourceType === resource.resourceType && item.id === resource.id) || null;
    if (existing && (existing.nativeId !== resource.nativeId || existing.ownerUserId !== resource.ownerUserId || existing.boundaryId !== resource.boundaryId)) {
      throw policyError("thread_resource_identity_conflict", 409);
    }
    const timestamp = nowIso();
    const next = existing ? {
      ...existing, resourceKey: resource.resourceKey, backend: resource.backend, status: resource.status,
      generation: Math.max(existing.generation, resource.generation), retiredAt: resource.status === "retired" ? (resource.retiredAt || timestamp) : null, updatedAt: timestamp,
    } : { ...resource, createdAt: timestamp, updatedAt: timestamp, retiredAt: resource.status === "retired" ? (resource.retiredAt || timestamp) : null };
    state.resources = state.resources.filter((item) => !(item.resourceType === resource.resourceType && item.id === resource.id));
    state.resources.push(next);
    if (existing && (existing.generation !== next.generation || existing.status !== next.status || existing.retiredAt !== next.retiredAt)) {
      invalidateResourceSessions(state, (session) => session.resourceType === next.resourceType && session.resourceId === next.id, "resource_lifecycle_changed", timestamp);
    }
    const result = { resource: next, transactionalAudit: { action: "resource_registered", resourceType, actorUserId: clean(principal?.userId || "system"), outcome: "allowed", reason: next.status } };
    if (idempotencyKey) state.mutations.push({ action, idempotencyKey, result, policyRevision: state.revision + 1, createdAt: timestamp });
    return result;
  }, env);
  if (updated.result.idempotent !== true) await appendEvent({ type: "thread_resource_registered", resourceType, resourceId: updated.result.resource.id, ownerUserId: updated.result.resource.ownerUserId, boundaryId: updated.result.resource.boundaryId, resourceGeneration: updated.result.resource.generation, status: updated.result.resource.status, actorUserId: clean(principal?.userId || "system") }, env).catch(() => undefined);
  return { ok: true, resource: updated.result.resource, policyRevision: updated.state.revision, writePlan, idempotent: updated.result.idempotent === true };
}

export async function setThreadResourceGrants(threadId = "", resourceType = "", entries = [], options = {}, env = process.env) {
  const type = normalizeThreadResourceType(resourceType);
  const principal = options.principal || null;
  if (!type) throw policyError("thread_resource_type_invalid", 400);
  const writePlan = requireUnifiedWriteMode(type, env);
  if (!isAdminPrincipal(principal || {})) throw policyError("thread_resource_grant_admin_required", 403);
  const [thread, threads] = await Promise.all([getThread(threadId, env), listThreads(env)]);
  if (!thread) throw policyError("thread_not_found", 404);
  const threadsById = new Map(threads.map((item) => [item.id, item]));
  const ownerUserId = resourceOwnerUserId(thread, env);
  const boundaryId = threadResourceBoundaryId(env);
  const scopedMode = threadResourceAccessModeFor(type, { threadId: thread.id }, env);
  const legacyDesktopCatalogCompatibility = type === THREAD_RESOURCE_TYPES.desktop && scopedMode !== "enforce";
  const normalizedMap = new Map((Array.isArray(entries) ? entries : []).map((entry) => typeof entry === "string" ? { resourceKey: entry } : entry || {}).map((entry) => {
    const nativeId = safeThreadResourceSegment(entry.nativeId || entry.resourceNativeId || entry.resourceId || entry.id || entry.resourceKey || entry.key || entry.slug || entry.desktopSlug || entry.mailboxId || entry.instanceId, "");
    return { nativeId, resourceKey: safeThreadResourceSegment(entry.resourceKey || entry.key || entry.slug || entry.desktopSlug || entry.mailboxId || entry.instanceId || nativeId, ""), permissions: exactGrantPermissions(type, entry), reason: clean(entry.reason || options.reason), generation: entry.generation || entry.resourceGeneration };
  }).filter((entry) => entry.resourceKey && entry.nativeId).map((entry) => [entry.nativeId, entry]));
  const normalized = [...normalizedMap.values()];
  const actorUserId = clean(principal?.userId || "system");
  const updated = await mutateThreadResourcePolicy((state) => {
    const idempotencyKey = clean(options.idempotencyKey || options.requestId);
    const prior = idempotencyKey ? state.mutations.find((item) => item.action === `grants.replace:${thread.id}:${type}` && item.idempotencyKey === idempotencyKey) : null;
    if (prior?.result?.grants) return { noChange: true, result: { ...prior.result, idempotent: true } };
    const priorPolicy = state.policies.find((item) => item.threadId === thread.id && item.resourceType === type) || null;
    if (options.expectedPolicyRevision !== undefined && Number(options.expectedPolicyRevision) !== Number(priorPolicy?.revision || 0)) throw policyError("thread_resource_policy_revision_conflict", 409);
    const timestamp = nowIso();
    const affectedResourceIds = new Set(state.grants.filter((grant) => grant.threadId === thread.id && grant.resourceType === type && !grant.revokedAt).map((grant) => grant.resourceId));
    state.grants = state.grants.map((grant) => grant.threadId === thread.id && grant.resourceType === type && !grant.revokedAt ? { ...grant, revokedAt: timestamp, revokedBy: actorUserId, updatedAt: timestamp } : grant);
    if (type === THREAD_RESOURCE_TYPES.mailbox) {
      state.mailboxDeliveries = (state.mailboxDeliveries || []).map((delivery) =>
        delivery.threadId === thread.id && ["pending", "claimed"].includes(delivery.state)
          ? { ...delivery, state: "revoked", epoch: Number(delivery.epoch || 1) + 1, claimToken: null, claimExpiresAt: null, reason: "mailbox_grant_replaced", updatedAt: timestamp }
          : delivery,
      );
    }
    const created = normalized.map((entry) => {
      const candidate = normalizeResource({ resourceType: type, nativeId: entry.nativeId, resourceKey: entry.resourceKey, ownerUserId, boundaryId, generation: entry.generation }, env);
      let resource = state.resources.find((item) => item.id === candidate.id && item.resourceType === type) || null;
      // Grants never provision resources in strict mode. Retain the desktop
      // catalog bridge only while off/shadow rollout compatibility is enabled;
      // enforce mode requires the desktop lifecycle to register its generation.
      if (!resource && legacyDesktopCatalogCompatibility) { resource = candidate; state.resources.push(resource); }
      if (!resource) throw policyError("thread_resource_not_registered", 404);
      if (resource.ownerUserId !== ownerUserId || resource.boundaryId !== boundaryId || resource.status !== "active") throw policyError("thread_resource_instance_unavailable", 409);
      const grant = normalizeGrant({ threadId: thread.id, resourceType: type, resourceId: resource.id, resourceKey: resource.resourceKey, ownerUserId, boundaryId, permissions: entry.permissions, revision: state.revision + 1, source: clean(options.source || "admin"), reason: entry.reason }, env);
      state.grants.push(grant); return grant;
    });
    for (const grant of created) affectedResourceIds.add(grant.resourceId);
    const policy = { threadId: thread.id, resourceType: type, revision: Number(priorPolicy?.revision || 0) + 1, explicitEmpty: created.length === 0, inheritanceMode: priorPolicy?.inheritanceMode === "snapshot_ceiling" ? "snapshot_ceiling" : "explicit", parentSnapshotRevision: priorPolicy?.parentSnapshotRevision || 0, createdAt: priorPolicy?.createdAt || timestamp, updatedAt: timestamp };
    state.policies = state.policies.filter((item) => !(item.threadId === thread.id && item.resourceType === type));
    state.policies.push(policy);
    // A direct grant on a child is still lineage-dependent: its snapshot
    // ceiling and every parent grant remain part of the effective decision.
    // Replacing a parent grant must therefore invalidate affected descendants
    // even when their session source points at a direct child grant.
    invalidateResourceSessions(state, (session) => session.resourceType === type && (session.threadId === thread.id || (affectedResourceIds.has(session.resourceId) && (session.grantThreadId === thread.id || isDescendantThread(session.threadId, thread.id, threadsById)))), "grant_replaced", timestamp);
    const result = { grants: created, policy, transactionalAudit: { action: "grants_replaced", resourceType: type, actorUserId, outcome: "allowed", reason: created.length ? "explicit_grants" : "explicit_empty_policy" } };
    if (idempotencyKey) state.mutations.push({ action: `grants.replace:${thread.id}:${type}`, idempotencyKey, result, policyRevision: state.revision + 1, createdAt: timestamp });
    return result;
  }, env);
  const grants = updated.result.grants || [];
  if (updated.result.idempotent !== true) recordThreadResourceInvalidationMetric({ resourceType: type, subject: type === "desktop" ? "session_share" : "resource", reason: "grant_replaced" });
  if (updated.result.idempotent !== true) await appendEvent({ type: "thread_resource_grants_replaced", threadId: thread.id, ownerUserId, actorUserId, resourceType: type, resourceIds: grants.map((grant) => grant.resourceId), policyRevision: updated.state.revision, resourcePolicyRevision: updated.result.policy?.revision || 0, idempotencyKey: clean(options.idempotencyKey || options.requestId) }, env).catch(() => undefined);
  return { ok: true, mode: scopedMode, writePlan, policyRevision: updated.state.revision, resourcePolicyRevision: updated.result.policy?.revision || 0, threadId: thread.id, resourceType: type, grants, idempotent: updated.result.idempotent === true };
}

export async function advanceThreadResourceGeneration(resourceType = "", resourceKey = "", ownerUserId = "", options = {}, env = process.env) {
  const type = normalizeThreadResourceType(resourceType); const key = safeThreadResourceSegment(resourceKey, ""); const owner = normalizeUserId(ownerUserId || env.ORKESTR_ADMIN_USER_ID || "admin");
  if (!type || !key) throw policyError("thread_resource_not_found", 404);
  const writePlan = requireUnifiedWriteMode(type, env);
  const candidate = normalizeResource({ resourceType: type, nativeId: options.nativeId || options.resourceNativeId || options.resourceId || key, resourceKey: key, ownerUserId: owner, boundaryId: options.boundaryId || threadResourceBoundaryId(env) }, env);
  const id = candidate.id;
  const updated = await mutateThreadResourcePolicy((state) => {
    let resource = state.resources.find((item) => item.id === id && item.resourceType === type) || null;
    if (!resource && type === "desktop") { resource = candidate; state.resources.push(resource); }
    if (!resource) throw policyError("thread_resource_not_registered", 404);
    const timestamp = nowIso();
    resource.generation += 1; resource.updatedAt = timestamp;
    invalidateResourceSessions(state, (session) => session.resourceType === type && session.resourceId === resource.id, "resource_generation_advanced", timestamp);
    return { resource, transactionalAudit: { action: "resource_generation_advanced", resourceType: type, actorUserId: clean(options.principal?.userId || "system"), outcome: "allowed", reason: clean(options.reason || "resource_runtime_replaced") } };
  }, env);
  const resource = updated.result.resource;
  recordThreadResourceInvalidationMetric({ resourceType: type, subject: type === "desktop" ? "session_share" : "resource", reason: "generation_advanced" });
  await appendEvent({ type: "thread_resource_generation_advanced", resourceType: type, resourceId: resource.id, resourceKey: resource.resourceKey, ownerUserId: resource.ownerUserId, boundaryId: resource.boundaryId, resourceGeneration: resource.generation, reason: clean(options.reason || "resource_runtime_replaced") }, env).catch(() => undefined);
  return { ok: true, resource, writePlan, policyRevision: updated.state.revision };
}

export async function captureChildThreadResourceCeiling(childThread = {}, env = process.env) {
  const childId = clean(childThread.id); const parentId = clean(childThread.parentThreadId);
  if (!childId || !parentId) return { ok: true, captured: 0, skipped: true };
  const parent = await getThread(parentId, env);
  if (!parent) throw policyError("thread_resource_parent_not_found", 409);
  const lineage = await threadResourceThreadLineage(parent, env);
  const declaredScopes = Object.fromEntries(Object.keys(THREAD_RESOURCE_PERMISSIONS).map((resourceType) => [resourceType, declaredChildScopeEntries(childThread, resourceType)]));
  const updated = await mutateThreadResourcePolicy((state) => {
    const snapshotRecorded = Object.keys(THREAD_RESOURCE_PERMISSIONS).every((resourceType) => state.policies.some((item) => item.threadId === childId && item.resourceType === resourceType && item.inheritanceMode === "snapshot_ceiling"));
    if (snapshotRecorded) return { noChange: true, result: { captured: 0, existing: true } };
    const candidates = new Map();
    for (const cursor of lineage) {
      for (const grant of state.grants.filter((item) => !item.revokedAt && item.threadId === cursor.id)) {
        const resource = state.resources.find((item) => item.resourceType === grant.resourceType && item.id === grant.resourceId);
        if (resource?.status === "active" && !resource.retiredAt) candidates.set(`${resource.resourceType}:${resource.id}`, resource);
      }
    }
    const createdAt = nowIso(); const captured = []; const childScopeGrants = [];
    for (const resource of candidates.values()) {
      const scopeEntries = declaredScopes[resource.resourceType] || [];
      const scopePermissions = scopeEntries.length ? declaredScopePermissions(scopeEntries, resource) : null;
      const permissions = [];
      for (const permission of THREAD_RESOURCE_PERMISSIONS[resource.resourceType] || []) {
        if (effectiveThreadResourceGrantForLineage(state, lineage, resource, permission) && (!scopeEntries.length || scopePermissions?.has(permission))) permissions.push(permission);
      }
      if (!permissions.length) continue;
      captured.push({ threadId: childId, resourceType: resource.resourceType, resourceId: resource.id, permissions, parentThreadId: parent.id, createdAt });
      if (scopeEntries.length) childScopeGrants.push(normalizeGrant({ threadId: childId, resourceType: resource.resourceType, resourceId: resource.id, resourceKey: resource.resourceKey, ownerUserId: resource.ownerUserId, boundaryId: resource.boundaryId, permissions, revision: state.revision + 1, source: "child_scope", reason: "declared_child_scope" }, env));
    }
    state.ceilings.push(...captured);
    state.grants.push(...childScopeGrants.filter(Boolean));
    const directScopeTypes = new Set(childScopeGrants.filter(Boolean).map((grant) => grant.resourceType));
    for (const resourceType of Object.keys(THREAD_RESOURCE_PERMISSIONS)) {
      const prior = state.policies.find((item) => item.threadId === childId && item.resourceType === resourceType) || null;
      const policy = { threadId: childId, resourceType, revision: directScopeTypes.has(resourceType) ? Math.max(1, Number(prior?.revision || 0) + 1) : Number(prior?.revision || 0), explicitEmpty: prior?.explicitEmpty === true, inheritanceMode: "snapshot_ceiling", parentSnapshotRevision: state.revision, createdAt: prior?.createdAt || createdAt, updatedAt: createdAt };
      state.policies = state.policies.filter((item) => !(item.threadId === childId && item.resourceType === resourceType));
      state.policies.push(policy);
    }
    return { captured: captured.length, ...(captured.length ? { transactionalAudit: { action: "child_snapshot_ceiling_captured", actorUserId: "system", outcome: "allowed", reason: "parent_snapshot_ceiling" } } : {}) };
  }, env);
  if (updated.result.captured) await appendEvent({ type: "thread_resource_child_ceiling_captured", threadId: childId, parentThreadId: parentId, captured: updated.result.captured, policyRevision: updated.state.revision }, env).catch(() => undefined);
  return { ok: true, ...updated.result, policyRevision: updated.state.revision };
}

export async function threadResourcePolicySummary(threadId = "", principal = null, env = process.env) {
  const state = await readThreadResourcePolicy(env); const grants = threadId ? state.grants.filter((grant) => grant.threadId === clean(threadId) && !grant.revokedAt) : [];
  const policies = threadId ? state.policies.filter((policy) => policy.threadId === clean(threadId)) : [];
  return { version: state.version, revision: state.revision, threadId: clean(threadId) || null, explicitGrantCount: grants.length, grantsByType: Object.fromEntries(Object.keys(THREAD_RESOURCE_PERMISSIONS).map((type) => [type, grants.filter((grant) => grant.resourceType === type).map((grant) => grant.resourceKey)])), policies: Object.fromEntries(policies.map((policy) => [policy.resourceType, { revision: policy.revision, explicitEmpty: policy.explicitEmpty, inheritanceMode: policy.inheritanceMode, parentSnapshotRevision: policy.parentSnapshotRevision }])), modes: Object.fromEntries(Object.keys(THREAD_RESOURCE_PERMISSIONS).map((type) => [type, threadResourceAccessMode(type, env)])), writeModes: Object.fromEntries(Object.keys(THREAD_RESOURCE_PERMISSIONS).map((type) => [type, threadResourceWritePlan(type, env)])), principalRole: clean(principal?.role) || null };
}

export { threadResourceWriteMode, threadResourceWritePlan };
