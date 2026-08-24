import crypto, { randomBytes, randomUUID } from "node:crypto";
import { appendEvent } from "../../storage/src/store.js";
import { getThread, listThreads } from "../../core/src/threads.js";
import { assertDesktopAccess, desktopAccessMode } from "../../core/src/desktop-access.js";
import {
  effectiveThreadResourceGrantFromSnapshot,
  threadResourceBoundaryId,
} from "../../core/src/thread-resource-policy-model.js";
import {
  mutateThreadResourcePolicy,
  readThreadResourcePolicy,
  threadResourceThreadLineage,
} from "../../core/src/thread-resource-policy-access.js";
import { assertDesktopLeaseForOperation } from "./desktop-leases.js";

const AUDIENCE = "orkestr-desktop-broker";
const SCOPES = new Set(["observe", "lifecycle", "visible_interaction"]);
const MAX_TTL_MS = 60_000;
const DEFAULT_ATTESTATION_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const clean = (value = "") => String(value || "").trim();
const hash = (value = "") => crypto.createHash("sha256").update(String(value || "")).digest("hex");

function brokerError(reason, statusCode = 403) {
  const error = new Error(reason);
  error.statusCode = statusCode;
  return error;
}

function principalId(principal = {}) {
  return clean(principal?.userId || principal?.id);
}

function configuredAttestations(env = process.env) {
  const raw = clean(env.ORKESTR_DESKTOP_ACCOUNT_ATTESTATIONS_JSON);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function verifiedAttestation(resource = {}, env = process.env) {
  const configured = configuredAttestations(env);
  if (!configured) throw brokerError("desktop_account_attestation_config_invalid", 503);
  const record = configured[resource.id];
  if (!record || typeof record !== "object" || Array.isArray(record)) throw brokerError("desktop_account_attestation_required");
  const verifiedAt = Date.parse(clean(record.verifiedAt));
  const expiresAt = Date.parse(clean(record.expiresAt));
  const configuredMaxAgeMs = Number(env.ORKESTR_DESKTOP_ATTESTATION_MAX_AGE_MS);
  const maxAgeMs = Number.isFinite(configuredMaxAgeMs) && configuredMaxAgeMs >= 1_000
    ? configuredMaxAgeMs
    : DEFAULT_ATTESTATION_MAX_AGE_MS;
  const canonicalAccountRefHash = clean(record.canonicalAccountRefHash);
  const isolationEvidenceHash = clean(record.isolationEvidenceHash);
  if (
    clean(record.status).toLowerCase() !== "verified" ||
    clean(record.resourceId) !== resource.id ||
    clean(record.ownerUserId) !== resource.ownerUserId ||
    clean(record.boundaryId) !== resource.boundaryId ||
    !clean(record.attestationId) || !clean(record.verifier) ||
    !/^[a-f0-9]{32,128}$/i.test(canonicalAccountRefHash) ||
    !/^[a-f0-9]{32,128}$/i.test(isolationEvidenceHash) ||
    record.isolationAttested !== true ||
    !Number.isFinite(verifiedAt) || !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now() || verifiedAt > Date.now() || Date.now() - verifiedAt > maxAgeMs
  ) throw brokerError("desktop_account_attestation_invalid");
  return {
    id: clean(record.attestationId),
    canonicalAccountRefHash,
    isolationEvidenceHash,
    verifier: clean(record.verifier),
    verifiedAt: new Date(verifiedAt).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    brokerVersion: clean(record.brokerVersion || "desktop-broker.v1"),
    requiresVisibleNoVnc: record.requiresVisibleNoVnc === true,
  };
}

function scope(value = "") {
  const normalized = clean(value).toLowerCase();
  if (!SCOPES.has(normalized)) throw brokerError("desktop_capability_scope_invalid", 400);
  return normalized;
}

function requestedTtl(value) {
  const ttl = Number(value ?? 30_000);
  if (!Number.isFinite(ttl) || ttl < 1_000 || ttl > MAX_TTL_MS) throw brokerError("desktop_capability_ttl_invalid", 400);
  return Math.floor(ttl);
}

function rootThreadId(lineage = []) {
  return clean(lineage[0]?.id);
}

function runtimeIdentity(thread = {}, lease = {}) {
  return clean(lease.runId || lease.codexThreadId || thread.runtime?.activeTurnId || thread.executor?.codexThreadId || `lease:${lease.id}`);
}

function sourcePolicyRevision(state = {}, grantThreadId = "", resourceType = "desktop") {
  return Number((state.policies || []).find((policy) => policy.threadId === grantThreadId && policy.resourceType === resourceType)?.revision || 0);
}

function exactDesktopGrant(state = {}, threadsById = new Map(), threadId = "", ownerUserId = "", permission = "operate", env = process.env) {
  const candidates = (state.resources || [])
    .filter((resource) => resource.resourceType === "desktop" && resource.status === "active" && !resource.retiredAt)
    .filter((resource) => resource.ownerUserId === ownerUserId && resource.boundaryId === threadResourceBoundaryId(env))
    .map((resource) => ({ resource, grant: effectiveThreadResourceGrantFromSnapshot({
      state,
      threadsById,
      threadId,
      resourceType: "desktop",
      resourceId: resource.id,
      permission,
    }) }))
    .filter((item) => item.grant);
  if (!candidates.length) throw brokerError("desktop_grant_required");
  if (candidates.length !== 1) throw brokerError("desktop_grant_ambiguous", 409);
  return candidates[0];
}

async function audit(event = {}, env = process.env) {
  try {
    await appendEvent({ type: "desktop_broker_decision", ...event }, env);
  } catch {
    throw brokerError("desktop_audit_unavailable", 503);
  }
}

async function deny(reason, input = {}, env = process.env, statusCode = 403) {
  await audit({
    outcome: "denied",
    reason,
    actorUserId: principalId(input.principal),
    threadId: clean(input.threadId),
    resourceType: "desktop",
    requestedScope: clean(input.scope),
    audience: clean(input.audience),
  }, env);
  throw brokerError(reason, statusCode);
}

export function desktopCapabilityRequired(env = process.env, input = {}) {
  return desktopAccessMode(env, input) === "enforce";
}

export async function resolveExactDesktopGrant(input = {}, env = process.env) {
  const threadId = clean(input.threadId);
  const principal = input.principal || null;
  if (!threadId) await deny("desktop_thread_scope_required", input, env);
  if (!principalId(principal)) await deny("desktop_runtime_principal_required", input, env, 401);
  const thread = await getThread(threadId, env);
  if (!thread) await deny("desktop_thread_not_found", input, env, 404);
  const [state, threads, lineage] = await Promise.all([
    readThreadResourcePolicy(env),
    listThreads(env),
    threadResourceThreadLineage(thread, env),
  ]);
  const threadsById = new Map(threads.map((item) => [item.id, item]));
  const permission = clean(input.permission || "operate").toLowerCase();
  let selection;
  try {
    selection = exactDesktopGrant(state, threadsById, threadId, clean(thread.ownerUserId), permission, env);
  } catch (error) {
    await deny(clean(error?.message) || "desktop_grant_required", input, env, Number(error?.statusCode || 403));
  }
  let decision;
  try {
    decision = await assertDesktopAccess({
      principal,
      threadId,
      desktopSlug: selection.resource.resourceKey,
      desktopId: selection.resource.id,
      ownerUserId: selection.resource.ownerUserId,
      permission,
    }, env);
  } catch (error) {
    await deny(clean(error?.message) || "desktop_grant_required", input, env, Number(error?.statusCode || 403));
  }
  // Keep this exact thread snapshot for the mutation-time revalidation below.
  // Rebuilding it later would make inheritance validation depend on a different
  // caller-visible snapshot.
  return { thread, state, threadsById, lineage, selection, decision };
}

export async function issueDesktopCapability(input = {}, env = process.env) {
  if (!desktopCapabilityRequired(env, input)) return { required: false, capability: "", desktop: null };
  const requestedScope = scope(input.scope);
  const audience = clean(input.audience);
  if (!audience || !/^[a-z0-9_.:-]{3,120}$/i.test(audience)) await deny("desktop_capability_audience_required", input, env, 400);
  let resolved;
  try {
    resolved = await resolveExactDesktopGrant(input, env);
  } catch (error) {
    if (clean(error?.message) === "desktop_audit_unavailable") throw error;
    throw error;
  }
  const { thread, threadsById, selection, decision, lineage } = resolved;
  let lease;
  try {
    lease = await assertDesktopLeaseForOperation(selection.resource.resourceKey, env, {
      principal: input.principal,
      threadId: thread.id,
      ownerUserId: selection.resource.ownerUserId,
      fencingToken: clean(input.fencingToken),
    });
  } catch (error) {
    await deny(clean(error?.message) || "desktop_lease_required", input, env, Number(error?.statusCode || 403));
  }
  let attestation;
  try {
    attestation = verifiedAttestation(selection.resource, env);
  } catch (error) {
    await deny(clean(error?.message) || "desktop_account_attestation_required", input, env, Number(error?.statusCode || 403));
  }
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + requestedTtl(input.ttlMs)).toISOString();
  const token = randomBytes(32).toString("base64url");
  const jti = randomUUID();
  const runtimeId = runtimeIdentity(thread, lease);
  const principalUserId = principalId(input.principal);
  const session = {
    id: `desktop-cap-${jti}`,
    jtiHash: hash(jti),
    tokenIdHash: hash(`desktop-capability:${jti}`),
    bearerHash: hash(token),
    audience: `${AUDIENCE}:${audience}`,
    scopes: [requestedScope],
    principalKind: "authenticated_runtime",
    principalId: principalUserId,
    ownerUserId: selection.resource.ownerUserId,
    // Existing transactional session columns retain only opaque bindings.
    accountId: attestation.isolationEvidenceHash,
    accountService: "desktop_attestation",
    connectorService: "desktop_broker",
    connectorAccountId: attestation.canonicalAccountRefHash,
    connectorBindingId: String(lease.fencingVersion),
    connectorTargetThreadId: runtimeId,
    connectorOperationRef: lease.id,
    connectorTool: attestation.brokerVersion,
    connectorAction: attestation.requiresVisibleNoVnc ? "visible_no_vnc" : "single_use",
    resourceType: "desktop",
    resourceId: selection.resource.id,
    actions: ["operate"],
    threadId: thread.id,
    grantThreadId: selection.grant.threadId,
    rootThreadId: rootThreadId(lineage),
    boundaryId: selection.resource.boundaryId,
    policyRevision: sourcePolicyRevision(resolved.state, selection.grant.threadId, "desktop"),
    grantRevision: Number(selection.grant.revision || decision.grantRevision || 0),
    resourceGeneration: Number(selection.resource.generation || decision.resourceGeneration || 0),
    state: "active",
    epoch: 1,
    issuedAt: issuedAt.toISOString(),
    expiresAt,
    lastUsedAt: null,
    createdAt: issuedAt.toISOString(),
    updatedAt: issuedAt.toISOString(),
    invalidatedAt: null,
    invalidationReason: null,
  };
  const persisted = await mutateThreadResourcePolicy((state) => {
    const resource = state.resources.find((item) => item.resourceType === "desktop" && item.id === session.resourceId);
    const grant = resource && effectiveThreadResourceGrantFromSnapshot({
      state,
      threadsById,
      threadId: session.threadId,
      resourceType: "desktop",
      resourceId: session.resourceId,
      permission: "operate",
    });
    if (
      !resource || resource.status !== "active" || resource.retiredAt || Number(resource.generation) !== session.resourceGeneration ||
      !grant || grant.threadId !== session.grantThreadId || Number(grant.revision) !== session.grantRevision ||
      sourcePolicyRevision(state, grant.threadId, "desktop") !== session.policyRevision
    ) {
      return { noChange: true, result: { ok: false, reason: "desktop_capability_resource_stale" } };
    }
    state.resourceSessions = [...(state.resourceSessions || []), session];
    return {
      ok: true,
      skipPolicyEpoch: true,
      transactionalAudit: {
        action: "desktop_capability_issued",
        resourceType: "desktop",
        resourceId: session.resourceId,
        threadId: session.threadId,
        permission: "operate",
        boundaryId: session.boundaryId,
        ownerUserId: session.ownerUserId,
        actorUserId: session.principalId,
        outcome: "allowed",
        reason: `${requestedScope}:${audience}`,
        expiresAt: session.expiresAt,
      },
    };
  }, env);
  if (!persisted.result?.ok) await deny(persisted.result?.reason || "desktop_capability_issue_failed", input, env, 503);
  await audit({
    outcome: "allowed",
    reason: "desktop_capability_issued",
    actorUserId: principalUserId,
    threadId: thread.id,
    resourceType: "desktop",
    resourceId: selection.resource.id,
    grantRevision: session.grantRevision,
    policyRevision: session.policyRevision,
    resourceGeneration: session.resourceGeneration,
    leaseId: hash(lease.id),
    leaseFencingVersion: lease.fencingVersion,
    runtimeIdHash: hash(runtimeId),
    requestedScope,
    audience,
    accountAttestationIdHash: hash(attestation.id),
    accountEvidenceHash: attestation.canonicalAccountRefHash,
    isolationEvidenceHash: attestation.isolationEvidenceHash,
    brokerVersion: attestation.brokerVersion,
  }, env);
  return {
    required: true,
    capability: token,
    expiresAt,
    audience,
    scope: requestedScope,
    desktop: {
      slug: selection.resource.resourceKey,
      resourceId: selection.resource.id,
      grantRevision: session.grantRevision,
      resourceGeneration: session.resourceGeneration,
    },
  };
}

export async function consumeDesktopCapability(input = {}, env = process.env) {
  if (!desktopCapabilityRequired(env, input)) return { required: false, desktop: null };
  const token = clean(input.capability);
  const audience = clean(input.audience);
  const requestedScope = scope(input.scope);
  const callerThreadId = clean(input.threadId);
  if (!token || !audience) await deny("desktop_capability_required", input, env, 401);
  if (!callerThreadId) await deny("desktop_capability_thread_required", input, env, 403);
  const principalUserId = principalId(input.principal);
  const tokenHash = hash(token);
  const state = await readThreadResourcePolicy(env);
  const found = (state.resourceSessions || []).find((item) => item.bearerHash === tokenHash) || null;
  if (!found) await deny("desktop_capability_invalid", input, env, 401);
  if (found.state !== "active") {
    const reason = found.invalidationReason === "consumed" ? "desktop_capability_replayed" : "desktop_capability_resource_stale";
    await deny(reason, input, env, reason === "desktop_capability_replayed" ? 409 : 403);
  }
  if (found.audience !== `${AUDIENCE}:${audience}` || !found.scopes.includes(requestedScope)) await deny("desktop_capability_scope_denied", input, env, 403);
  if (found.principalId !== principalUserId) await deny("desktop_capability_principal_denied", input, env, 403);
  if (found.threadId !== callerThreadId) await deny("desktop_capability_thread_denied", input, env, 403);
  if (Date.parse(found.expiresAt) <= Date.now()) await deny("desktop_capability_expired", input, env, 401);
  const [thread, threads] = await Promise.all([getThread(found.threadId, env), listThreads(env)]);
  if (!thread) await deny("desktop_thread_not_found", input, env, 404);
  const threadsById = new Map(threads.map((item) => [item.id, item]));
  const resource = state.resources.find((item) => item.resourceType === "desktop" && item.id === found.resourceId) || null;
  if (!resource || resource.status !== "active" || resource.retiredAt || resource.boundaryId !== threadResourceBoundaryId(env)) await deny("desktop_capability_resource_stale", input, env, 403);
  if (clean(input.desktopSlug) && clean(input.desktopSlug) !== resource.resourceKey) await deny("desktop_capability_target_mismatch", input, env, 403);
  const currentAttestation = verifiedAttestation(resource, env);
  if (currentAttestation.canonicalAccountRefHash !== found.connectorAccountId || currentAttestation.isolationEvidenceHash !== found.accountId) await deny("desktop_account_attestation_stale", input, env, 403);
  await assertDesktopAccess({
    principal: input.principal,
    threadId: thread.id,
    desktopSlug: resource.resourceKey,
    desktopId: resource.id,
    ownerUserId: resource.ownerUserId,
    permission: "operate",
  }, env).catch((error) => deny(clean(error?.message) || "desktop_grant_required", input, env, Number(error?.statusCode || 403)));
  const lease = await assertDesktopLeaseForOperation(resource.resourceKey, env, {
    principal: input.principal,
    threadId: thread.id,
    ownerUserId: resource.ownerUserId,
    expectedLeaseId: found.connectorOperationRef,
    expectedFencingVersion: Number(found.connectorBindingId || 0),
  }).catch((error) => deny(clean(error?.message) || "desktop_lease_required", input, env, Number(error?.statusCode || 403)));
  if (runtimeIdentity(thread, lease) !== found.connectorTargetThreadId) await deny("desktop_capability_runtime_denied", input, env, 403);
  const consumedAt = new Date().toISOString();
  const consumed = await mutateThreadResourcePolicy((current) => {
    const session = (current.resourceSessions || []).find((item) => item.bearerHash === tokenHash) || null;
    if (!session || session.state !== "active") return { noChange: true, result: { ok: false, reason: "desktop_capability_replayed" } };
    const currentResource = (current.resources || []).find((item) => item.resourceType === "desktop" && item.id === session.resourceId) || null;
    const currentGrant = currentResource && effectiveThreadResourceGrantFromSnapshot({
      state: current,
      threadsById,
      threadId: session.threadId,
      resourceType: "desktop",
      resourceId: session.resourceId,
      permission: "operate",
    });
    if (
      !currentResource || currentResource.status !== "active" || currentResource.retiredAt ||
      Number(currentResource.generation) !== Number(session.resourceGeneration) ||
      !currentGrant || currentGrant.threadId !== session.grantThreadId ||
      Number(currentGrant.revision) !== Number(session.grantRevision) ||
      sourcePolicyRevision(current, currentGrant.threadId, "desktop") !== Number(session.policyRevision)
    ) {
      session.state = "invalidated";
      session.invalidatedAt = consumedAt;
      session.invalidationReason = "resource_stale";
      session.updatedAt = consumedAt;
      return { ok: false, reason: "desktop_capability_resource_stale", skipPolicyEpoch: true };
    }
    if (Date.parse(session.expiresAt) <= Date.now()) {
      session.state = "expired";
      session.invalidatedAt = consumedAt;
      session.invalidationReason = "expired";
      return { ok: false, reason: "desktop_capability_expired", skipPolicyEpoch: true };
    }
    session.state = "invalidated";
    session.invalidatedAt = consumedAt;
    session.invalidationReason = "consumed";
    session.lastUsedAt = consumedAt;
    session.updatedAt = consumedAt;
    return {
      ok: true,
      skipPolicyEpoch: true,
      transactionalAudit: {
        action: "desktop_capability_consumed",
        resourceType: "desktop",
        resourceId: session.resourceId,
        threadId: session.threadId,
        permission: "operate",
        boundaryId: session.boundaryId,
        ownerUserId: session.ownerUserId,
        actorUserId: session.principalId,
        outcome: "allowed",
        reason: `${requestedScope}:${audience}`,
      },
    };
  }, env);
  if (!consumed.result?.ok) await deny(consumed.result?.reason || "desktop_capability_replayed", input, env, 409);
  const finalAttestation = verifiedAttestation(resource, env);
  if (finalAttestation.canonicalAccountRefHash !== found.connectorAccountId || finalAttestation.isolationEvidenceHash !== found.accountId) {
    await deny("desktop_account_attestation_stale", input, env, 403);
  }
  await audit({
    outcome: "allowed",
    reason: "desktop_capability_consumed",
    actorUserId: principalUserId,
    threadId: found.threadId,
    resourceType: "desktop",
    resourceId: found.resourceId,
    grantRevision: found.grantRevision,
    policyRevision: found.policyRevision,
    resourceGeneration: found.resourceGeneration,
    leaseId: hash(found.connectorOperationRef),
    leaseFencingVersion: Number(found.connectorBindingId || 0),
    runtimeIdHash: hash(found.connectorTargetThreadId),
    requestedScope,
    audience,
    accountEvidenceHash: found.connectorAccountId,
    isolationEvidenceHash: found.accountId,
    brokerVersion: found.connectorTool,
  }, env);
  // A second lease read narrows the consume-to-connect race; the operator calls
  // this immediately before opening the broker-owned CDP channel.
  await assertDesktopLeaseForOperation(resource.resourceKey, env, {
    principal: input.principal,
    threadId: thread.id,
    ownerUserId: resource.ownerUserId,
    expectedLeaseId: found.connectorOperationRef,
    expectedFencingVersion: Number(found.connectorBindingId || 0),
  });
  return {
    required: true,
    desktop: {
      slug: resource.resourceKey,
      resourceId: resource.id,
      threadId: thread.id,
      requiresVisibleNoVnc: found.connectorAction === "visible_no_vnc",
    },
  };
}
