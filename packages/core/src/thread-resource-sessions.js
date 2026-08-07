import crypto from "node:crypto";
import { listThreads } from "./threads.js";
import {
  effectiveThreadResourceGrantFromSnapshot,
  mutateThreadResourcePolicy,
  normalizeThreadResourcePermissions,
  normalizeThreadResourceType,
  readThreadResourcePolicy,
  threadResourceAccessMode,
  threadResourceBoundaryId,
} from "./thread-resource-grants.js";

const clean = (value = "") => String(value || "").trim();
const maxTokenLifetimeMs = 5 * 60_000;
const hash = (value = "") => crypto.createHash("sha256").update(String(value || "")).digest("hex");

function deny(reason, statusCode = 403) {
  const error = new Error(`connector_mcp_${reason}`);
  error.statusCode = statusCode;
  throw error;
}

function actions(value = [], resourceType = "") {
  const raw = Array.isArray(value) ? value : clean(value).split(/[\s,]+/g);
  return normalizeThreadResourcePermissions(resourceType, raw).sort();
}

function target(input = {}) {
  return {
    resourceType: clean(input.resource_type),
    resourceId: clean(input.resource_id),
    action: clean(input.resource_action).toLowerCase(),
    threadId: clean(input.thread_id),
  };
}

function claims(auth = {}) {
  const resourceType = normalizeThreadResourceType(auth.resourceType);
  return {
    resourceType,
    resourceId: clean(auth.resourceId),
    actions: actions(auth.resourceActions, resourceType),
    rootThreadId: clean(auth.rootThreadId),
    threadId: clean(auth.threadId),
    boundaryId: clean(auth.boundaryId),
    policyRevision: Number(auth.policyRevision || 0),
    grantRevision: Number(auth.grantRevision || 0),
    resourceGeneration: Number(auth.resourceGeneration || 0),
    jtiHash: clean(auth.resourceJtiHash),
    tokenIdHash: clean(auth.tokenIdHash),
    issuedAt: clean(auth.issuedAt),
    expiresAt: clean(auth.expiresAt),
  };
}

function resourceTokenDeclared(value = {}) {
  return Boolean(clean(value.resourceType) || clean(value.resourceId) || (Array.isArray(value.resourceActions) && value.resourceActions.length) || clean(value.resourceJtiHash));
}

function validClaimSet(value = {}) {
  return Boolean(
    value.resourceType && value.resourceId && value.actions.length && value.rootThreadId && value.threadId && value.boundaryId &&
    Number.isInteger(value.policyRevision) && value.policyRevision >= 0 && Number.isInteger(value.grantRevision) && value.grantRevision > 0 &&
    Number.isInteger(value.resourceGeneration) && value.resourceGeneration > 0 && value.jtiHash && value.tokenIdHash && value.issuedAt && value.expiresAt
  );
}

function validLifetime(value = {}, now = Date.now()) {
  const issuedAt = Date.parse(value.issuedAt);
  const expiresAt = Date.parse(value.expiresAt);
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || issuedAt > now + 30_000) return "resource_token_time_invalid";
  if (expiresAt <= now) return "resource_token_expired";
  if (expiresAt - issuedAt > maxTokenLifetimeMs) return "resource_token_ttl_invalid";
  return "";
}

function rootForThread(threadId = "", threadsById = new Map()) {
  let cursor = threadsById.get(threadId) || null;
  const seen = new Set();
  while (cursor?.id) {
    if (seen.has(cursor.id)) return "";
    seen.add(cursor.id);
    const parentId = clean(cursor.parentThreadId);
    if (!parentId) return cursor.id;
    cursor = threadsById.get(parentId) || null;
  }
  return "";
}

function sameActions(left = [], right = []) {
  return left.length === right.length && left.every((action, index) => action === right[index]);
}

function sessionMatches(session = {}, value = {}) {
  return session.jtiHash === value.jtiHash && session.tokenIdHash === value.tokenIdHash &&
    session.resourceType === value.resourceType && session.resourceId === value.resourceId &&
    sameActions(actions(session.actions, value.resourceType), value.actions) &&
    session.threadId === value.threadId && session.rootThreadId === value.rootThreadId && session.boundaryId === value.boundaryId &&
    Number(session.policyRevision) === value.policyRevision && Number(session.grantRevision) === value.grantRevision &&
    Number(session.resourceGeneration) === value.resourceGeneration && session.issuedAt === value.issuedAt && session.expiresAt === value.expiresAt;
}

async function persistCurrentResourceSession(value = {}, env = process.env) {
  const timestamp = new Date().toISOString();
  const updated = await mutateThreadResourcePolicy((state) => {
    const existing = (state.resourceSessions || []).find((session) => session.jtiHash === value.jtiHash) || null;
    const resource = (state.resources || []).find((item) => item.resourceType === value.resourceType && item.id === value.resourceId) || null;
    if (existing && existing.state !== "active") {
      return { noChange: true, result: { valid: false, reason: existing?.state || "invalidated" } };
    }
    if (Number(state.revision) !== value.policyRevision || !resource || resource.status !== "active" || resource.retiredAt || Number(resource.generation) !== value.resourceGeneration) {
      return { noChange: true, result: { valid: false, reason: "stale" } };
    }
    if (existing && !sessionMatches(existing, value)) return { noChange: true, result: { valid: false, reason: "claims" } };
    const session = existing
      ? { ...existing, lastUsedAt: timestamp, updatedAt: timestamp }
      : {
          id: `trs-${value.jtiHash.slice(0, 48)}`, ...value, state: "active", epoch: 1,
          lastUsedAt: timestamp, createdAt: timestamp, updatedAt: timestamp, invalidatedAt: null, invalidationReason: null,
        };
    state.resourceSessions = [...(state.resourceSessions || []).filter((item) => item.jtiHash !== value.jtiHash), session];
    return { session, valid: true, skipPolicyEpoch: true };
  }, env);
  if (!updated.result?.valid) deny(updated.result?.reason === "invalidated" ? "resource_session_invalidated" : "resource_token_stale");
  return updated.result.session;
}

// Connector calls are instance-scoped unless a real target is supplied. Once a
// resource target is declared in enforce mode, it has no legacy fallback: all
// target and epoch claims must be present and current.
export async function assertConnectorMcpResourceAccess(auth = {}, input = {}, env = process.env) {
  const requested = target(input);
  const value = claims(auth);
  const declared = resourceTokenDeclared(auth) || requested.resourceType || requested.resourceId || requested.action;
  if (!declared || auth.operator) return auth;
  const resourceType = normalizeThreadResourceType(requested.resourceType || value.resourceType);
  const mode = threadResourceAccessMode(resourceType, env);
  if (mode !== "enforce") return auth;
  if (!requested.resourceType || !requested.resourceId || !requested.action || !requested.threadId) deny("resource_target_required", 400);
  if (!resourceType || !actions([requested.action], resourceType).includes(requested.action)) deny("resource_target_invalid", 400);
  if (!validClaimSet(value)) deny("resource_claims_required", 401);
  const lifetimeError = validLifetime(value);
  if (lifetimeError) deny(lifetimeError, 401);
  if (requested.resourceType !== value.resourceType || requested.resourceId !== value.resourceId || !value.actions.includes(requested.action)) deny("resource_target_scope_denied");
  if (requested.threadId !== value.threadId) deny("resource_thread_scope_denied");
  if (threadResourceBoundaryId(env) !== value.boundaryId) deny("resource_boundary_denied");

  const [state, threads] = await Promise.all([readThreadResourcePolicy(env), listThreads(env)]);
  const threadsById = new Map(threads.map((thread) => [thread.id, thread]));
  if (rootForThread(value.threadId, threadsById) !== value.rootThreadId) deny("resource_root_scope_denied");
  const resource = state.resources.find((item) => item.resourceType === value.resourceType && item.id === value.resourceId) || null;
  if (!resource || resource.status !== "active" || resource.retiredAt || resource.boundaryId !== value.boundaryId || resource.ownerUserId !== clean(auth.ownerUserId)) deny("resource_target_denied");
  const grant = effectiveThreadResourceGrantFromSnapshot({
    state, threadsById, threadId: value.threadId, resourceType: value.resourceType,
    resourceId: value.resourceId, permission: requested.action,
  });
  if (!grant) deny("resource_grant_required");
  if (Number(state.revision) !== value.policyRevision || Number(grant.revision) !== value.grantRevision || Number(resource.generation) !== value.resourceGeneration) deny("resource_token_stale");
  await persistCurrentResourceSession(value, env);
  return auth;
}
