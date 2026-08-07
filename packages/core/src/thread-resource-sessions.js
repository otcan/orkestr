import crypto, { randomBytes, randomUUID } from "node:crypto";
import { listThreads } from "./threads.js";
import { canAccessOwner } from "./policy.js";
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
export const connectorMcpResourceAudience = "orkestr-connectors-mcp";

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
    bearerHash: clean(auth.bearerHash),
    audience: clean(auth.audience),
    scopes: Array.isArray(auth.scopes) ? auth.scopes.map((scope) => clean(scope).toLowerCase()).filter(Boolean) : [],
    principalKind: clean(auth.principalKind) || "external_instance", principalId: clean(auth.principalId),
    ownerUserId: clean(auth.ownerUserId), instanceId: clean(auth.instanceId), accountId: clean(auth.accountId), accountService: clean(auth.accountService).toLowerCase(),
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
    Number.isInteger(value.resourceGeneration) && value.resourceGeneration > 0 && value.jtiHash && value.tokenIdHash && value.bearerHash &&
    value.audience === connectorMcpResourceAudience && value.issuedAt && value.expiresAt
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
  return session.jtiHash === value.jtiHash && session.tokenIdHash === value.tokenIdHash && session.bearerHash === value.bearerHash && session.audience === value.audience &&
    session.resourceType === value.resourceType && session.resourceId === value.resourceId &&
    sameActions(actions(session.actions, value.resourceType), value.actions) &&
    session.threadId === value.threadId && session.grantThreadId === value.grantThreadId && session.rootThreadId === value.rootThreadId && session.boundaryId === value.boundaryId &&
    Number(session.policyRevision) === value.policyRevision && Number(session.grantRevision) === value.grantRevision &&
    Number(session.resourceGeneration) === value.resourceGeneration && session.issuedAt === value.issuedAt && session.expiresAt === value.expiresAt;
}

function sourcePolicyRevision(state = {}, grantThreadId = "", resourceType = "") {
  return Number((state.policies || []).find((policy) => policy.threadId === grantThreadId && policy.resourceType === resourceType)?.revision || 0);
}

async function persistCurrentResourceSession(value = {}, threadsById = new Map(), env = process.env) {
  const timestamp = new Date().toISOString();
  const updated = await mutateThreadResourcePolicy((state) => {
    const existing = (state.resourceSessions || []).find((session) => session.jtiHash === value.jtiHash) || null;
    const resource = (state.resources || []).find((item) => item.resourceType === value.resourceType && item.id === value.resourceId) || null;
    if (existing && existing.state !== "active") {
      return { noChange: true, result: { valid: false, reason: existing?.state || "invalidated" } };
    }
    const grant = effectiveThreadResourceGrantFromSnapshot({
      state, threadsById, threadId: value.threadId, resourceType: value.resourceType,
      resourceId: value.resourceId, permission: value.permission,
    });
    if (!resource || resource.status !== "active" || resource.retiredAt || Number(resource.generation) !== value.resourceGeneration ||
      !grant || grant.threadId !== value.grantThreadId || Number(grant.revision) !== value.grantRevision ||
      sourcePolicyRevision(state, value.grantThreadId, value.resourceType) !== value.policyRevision) {
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
  if (value.audience !== connectorMcpResourceAudience) deny("resource_audience_denied", 401);
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
  const bound = { ...value, permission: requested.action, grantThreadId: clean(grant.threadId) };
  if (sourcePolicyRevision(state, bound.grantThreadId, bound.resourceType) !== bound.policyRevision || Number(grant.revision) !== bound.grantRevision || Number(resource.generation) !== bound.resourceGeneration) deny("resource_token_stale");
  await persistCurrentResourceSession(bound, threadsById, env);
  return auth;
}

function connectorScopes(value = []) {
  const raw = Array.isArray(value) ? value : clean(value).split(/[\s,]+/g);
  const normalized = [...new Set(raw.map((scope) => clean(scope).toLowerCase()).filter(Boolean))];
  return normalized.length ? normalized : ["connectors:read"];
}

function issuedAuth(session = {}) {
  return {
    tokenId: `issued-resource-${clean(session.jtiHash).slice(0, 24)}`,
    scopes: session.scopes || [], principalKind: session.principalKind || "external_instance", principalId: session.principalId || "",
    ownerUserId: session.ownerUserId || "", instanceId: session.instanceId || "", accountId: session.accountId || "", accountService: session.accountService || "",
    bindingId: "", chatId: "", allowedChatIds: [], allowedRecipients: [],
    resourceType: session.resourceType || "", resourceId: session.resourceId || "", resourceActions: session.actions || [],
    rootThreadId: session.rootThreadId || "", threadId: session.threadId || "", boundaryId: session.boundaryId || "",
    policyRevision: Number(session.policyRevision || 0), grantRevision: Number(session.grantRevision || 0), resourceGeneration: Number(session.resourceGeneration || 0),
    resourceJtiHash: session.jtiHash || "", tokenIdHash: session.tokenIdHash || "", bearerHash: session.bearerHash || "", audience: session.audience || "",
    issuedAt: session.issuedAt || "", expiresAt: session.expiresAt || "", operator: false,
  };
}

// Token lookup uses only a bearer hash stored with the session. The raw bearer
// is returned once by issuance and is never written to policy state or logs.
export async function authorizeIssuedConnectorResourceToken(token = "", env = process.env) {
  const bearerHash = hash(token);
  if (!clean(token)) return null;
  const state = await readThreadResourcePolicy(env).catch(() => null);
  const session = state?.resourceSessions?.find((item) =>
    item.state === "active" && item.bearerHash === bearerHash && Date.parse(item.expiresAt) > Date.now()
  ) || null;
  return session ? issuedAuth(session) : null;
}

// Runtime/API callers issue a one-action connector bearer only after the
// current effective grant has been resolved. Connector scope is independent
// upper-bound authority and cannot add another resource action.
export async function issueConnectorMcpResourceToken(input = {}, env = process.env) {
  const resourceType = normalizeThreadResourceType(input.resourceType || input.resource_type);
  const resourceId = clean(input.resourceId || input.resource_id);
  const permission = clean(input.resourceAction || input.resource_action || input.permission).toLowerCase();
  const threadId = clean(input.threadId || input.thread_id);
  const principal = input.principal || null;
  if (!resourceType || !resourceId || !threadId || !actions([permission], resourceType).includes(permission)) deny("resource_token_issue_target_invalid", 400);
  const requestedTtlMs = Number(input.ttlMs ?? input.ttl_ms ?? maxTokenLifetimeMs);
  if (!Number.isFinite(requestedTtlMs) || requestedTtlMs < 1_000 || requestedTtlMs > maxTokenLifetimeMs) deny("resource_token_ttl_invalid", 400);
  const [state, threads] = await Promise.all([readThreadResourcePolicy(env), listThreads(env)]);
  const threadsById = new Map(threads.map((thread) => [thread.id, thread]));
  const resource = state.resources.find((item) => item.resourceType === resourceType && item.id === resourceId) || null;
  if (!resource || resource.status !== "active" || resource.retiredAt || !canAccessOwner(principal || {}, resource.ownerUserId, env)) deny("resource_token_issue_forbidden");
  const rootThreadId = rootForThread(threadId, threadsById);
  if (!rootThreadId || resource.boundaryId !== threadResourceBoundaryId(env)) deny("resource_token_issue_target_denied");
  const grant = effectiveThreadResourceGrantFromSnapshot({ state, threadsById, threadId, resourceType, resourceId, permission });
  if (!grant) deny("resource_grant_required");
  const grantThreadId = clean(grant.threadId);
  const policyRevision = sourcePolicyRevision(state, grantThreadId, resourceType);
  if (!grantThreadId || !policyRevision) deny("resource_token_issue_stale");
  const issuedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + requestedTtlMs).toISOString();
  const bearer = `rt_${randomBytes(32).toString("base64url")}`;
  const jti = randomUUID();
  const value = {
    jtiHash: hash(jti), tokenIdHash: hash(`issued:${jti}`), bearerHash: hash(bearer), audience: connectorMcpResourceAudience,
    scopes: connectorScopes(input.scopes), principalKind: clean(input.principalKind || input.principal_kind) || "external_instance",
    principalId: clean(input.principalId || input.principal_id || principal?.userId), ownerUserId: resource.ownerUserId,
    instanceId: clean(input.instanceId || input.instance_id), accountId: clean(input.accountId || input.account_id), accountService: clean(input.accountService || input.account_service).toLowerCase(),
    resourceType, resourceId, actions: [permission], threadId, grantThreadId, rootThreadId, boundaryId: resource.boundaryId,
    policyRevision, grantRevision: Number(grant.revision), resourceGeneration: Number(resource.generation), permission, issuedAt, expiresAt,
  };
  const session = await persistCurrentResourceSession(value, threadsById, env);
  return { token: bearer, expiresAt, authorization: issuedAuth(session) };
}
