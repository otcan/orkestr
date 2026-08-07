import { appendEvent } from "../../storage/src/store.js";
import { canAccessOwner, isAdminPrincipal } from "./policy.js";
import { listTenantVms } from "./tenant-vm-registry.js";
import { authorizeThreadResourceAccess, threadResourceAccessMode } from "./thread-resource-grants.js";
import { emitShadowBoundaryChatWarning } from "./shadow-boundary-chat-warning.js";
import { adminUserId, normalizeUserId } from "./users.js";

function clean(value = "") {
  return String(value || "").trim();
}

function cleanLower(value = "") {
  return clean(value).toLowerCase();
}

function targetResolverError(message, statusCode = 400, resolution = null) {
  const error = new Error(message);
  error.statusCode = statusCode;
  if (resolution) error.resolution = resolution;
  return error;
}

function publicReason(value = "") {
  return cleanLower(value).replace(/[^a-z0-9_.-]+/g, "_").slice(0, 120) || "target_resolution_failed";
}

function targetId(value = "") {
  return clean(value).replace(/[^a-zA-Z0-9_.:-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 160);
}

function normalizeTargetCandidate(candidate = {}, targetType = "instance", env = process.env) {
  const id = targetId(candidate.id || candidate.instanceId || candidate.tenantVmId || candidate.slug);
  if (!id) return null;
  const ownerUserId = normalizeUserId(candidate.ownerUserId || candidate.userId || env.ORKESTR_ADMIN_USER_ID || adminUserId);
  const status = cleanLower(candidate.status || candidate.state || "");
  const deleted = candidate.deleted === true || Boolean(candidate.deletedAt) || status === "deleted" || status === "deleting";
  const enabled = candidate.enabled !== false && !["disabled", "suspended", "revoked"].includes(status);
  const healthy = candidate.healthy !== undefined
    ? candidate.healthy === true
    : !deleted && enabled && !["error", "failed", "stopped", "inactive", "unknown"].includes(status);
  const eligible = candidate.eligible !== undefined ? candidate.eligible === true : !deleted && enabled && healthy;
  return {
    id,
    type: cleanLower(candidate.type || candidate.instanceType || targetType || "instance") || "instance",
    ownerUserId,
    status,
    enabled,
    healthy,
    eligible,
    selectionLabel: clean(candidate.selectionLabel || candidate.label || candidate.displayName || id).slice(0, 120),
    reason: publicReason(candidate.reason || (eligible ? "eligible" : "target_stale")),
    resource: candidate.resource || candidate,
  };
}

export function publicTargetCandidate(candidate = {}) {
  return {
    id: clean(candidate.id),
    type: cleanLower(candidate.type || "instance"),
    ownerUserId: normalizeUserId(candidate.ownerUserId || ""),
    status: cleanLower(candidate.status || ""),
    enabled: candidate.enabled === true,
    healthy: candidate.healthy === true,
    eligible: candidate.eligible === true,
    reason: publicReason(candidate.reason || ""),
  };
}

function publicResolution(result = {}) {
  return {
    ok: result.ok === true,
    targetType: cleanLower(result.targetType || "instance"),
    selectedInstanceId: clean(result.selectedTarget?.id || ""),
    selectedInstanceType: cleanLower(result.selectedTarget?.type || result.targetType || "instance"),
    ownerUserId: normalizeUserId(result.selectedTarget?.ownerUserId || result.ownerUserId || ""),
    selectionSource: cleanLower(result.selectionSource || ""),
    ambiguityResult: cleanLower(result.ambiguityResult || ""),
    error: cleanLower(result.error || ""),
    candidateCount: Number(result.candidates?.length || 0),
    authorizedCandidateCount: Number(result.authorizedCandidateCount || 0),
    shadowBoundaryWarning: {
      eligible: result.shadowBoundaryWarning?.eligible === true,
      emitted: result.shadowBoundaryWarning?.emitted === true,
      resourceType: cleanLower(result.shadowBoundaryWarning?.resourceType || result.targetType || ""),
      mode: cleanLower(result.shadowBoundaryWarning?.mode || ""),
      reason: cleanLower(result.shadowBoundaryWarning?.reason || "not_evaluated"),
      notificationId: clean(result.shadowBoundaryWarning?.notificationId || ""),
    },
  };
}

async function auditResolution(result = {}, input = {}, env = process.env) {
  const payload = {
    type: result.ok ? "target_instance_resolved" : "target_instance_resolution_failed",
    action: clean(input.action || "target.resolve"),
    targetType: cleanLower(result.targetType || input.targetType || "instance"),
    actorUserId: clean(input.principal?.userId || input.principal?.id || ""),
    ownerUserId: normalizeUserId(result.ownerUserId || input.ownerUserId || input.principal?.userId || ""),
    selectedInstanceId: clean(result.selectedTarget?.id || ""),
    selectedInstanceType: cleanLower(result.selectedTarget?.type || input.targetType || "instance"),
    selectionSource: cleanLower(result.selectionSource || ""),
    ambiguityResult: cleanLower(result.ambiguityResult || ""),
    candidateCount: Number(result.candidates?.length || 0),
    authorizedCandidateCount: Number(result.authorizedCandidateCount || 0),
    error: cleanLower(result.error || ""),
    requestId: clean(input.requestId || ""),
    idempotencyKey: clean(input.idempotencyKey || ""),
    overrideReason: clean(input.overrideReason || ""),
  };
  await appendEvent(payload, env).catch(() => {});
  return payload;
}

function failure(input = {}, candidates = [], authorized = [], error = "instance_selection_required", statusCode = 409, extra = {}) {
  return {
    ok: false,
    targetType: cleanLower(input.targetType || "instance"),
    ownerUserId: normalizeUserId(input.ownerUserId || input.principal?.userId || ""),
    selectedTarget: null,
    candidates: candidates.map(publicTargetCandidate),
    authorizedCandidateCount: authorized.length,
    selectionSource: cleanLower(extra.selectionSource || input.selectionSource || "missing_target"),
    ambiguityResult: cleanLower(extra.ambiguityResult || error),
    error,
    statusCode,
    terminal: true,
  };
}

function success(input = {}, candidates = [], authorized = [], selectedTarget, extra = {}) {
  return {
    ok: true,
    targetType: cleanLower(input.targetType || selectedTarget.type || "instance"),
    ownerUserId: selectedTarget.ownerUserId,
    selectedTarget,
    candidates: candidates.map(publicTargetCandidate),
    authorizedCandidateCount: authorized.length,
    selectionSource: cleanLower(extra.selectionSource || input.selectionSource || "explicit_request"),
    ambiguityResult: cleanLower(extra.ambiguityResult || "explicit_match"),
    error: "",
    statusCode: 200,
    terminal: false,
  };
}

export async function resolveTargetInstance(input = {}, env = process.env) {
  const targetType = cleanLower(input.targetType || "instance");
  const principal = input.principal || {};
  const explicitTargetId = targetId(input.explicitTargetId || input.targetId || input.instanceId || input.tenantVmId);
  const candidates = (Array.isArray(input.candidates) ? input.candidates : [])
    .map((candidate) => normalizeTargetCandidate(candidate, targetType, env))
    .filter(Boolean);
  const owner = clean(input.ownerUserId) ? normalizeUserId(input.ownerUserId) : "";
  const ownerScoped = owner ? candidates.filter((candidate) => candidate.ownerUserId === owner) : candidates;
  const ownerAuthorized = ownerScoped.filter((candidate) => canAccessOwner(principal, candidate.ownerUserId, env));
  // A caller that supplies a thread is selecting a thread-scoped resource. In
  // shadow rollout we evaluate and audit the same decision but preserve legacy
  // selection; only enforce mode may remove ungranted candidates.
  const resourceType = cleanLower(input.resourceType || targetType);
  const threadScopeMode = threadResourceAccessMode(resourceType, env);
  const threadScoped = Boolean(clean(input.threadId || input.thread?.id)) && ["desktop", "oxrm", "mailbox"].includes(resourceType) && threadScopeMode !== "off";
  const decisions = threadScoped
    ? await Promise.all(ownerAuthorized.map(async (candidate) => [candidate.id, await authorizeThreadResourceAccess({
      principal,
      threadId: input.threadId || input.thread?.id,
      resourceType,
      resourceId: candidate.id,
      resourceKey: candidate.id,
      ownerUserId: candidate.ownerUserId,
      permission: input.permission || input.resourcePermission || "execute",
      breakGlass: input.breakGlass === true,
      breakGlassReason: input.breakGlassReason || input.overrideReason,
      breakGlassChangeRef: input.breakGlassChangeRef || input.changeRef || input.changeReference,
      recentAuthAt: input.recentAuthAt,
    }, env)]))
    : [];
  const decisionById = new Map(decisions);
  const authorized = threadScoped && threadScopeMode === "enforce"
    ? ownerAuthorized.filter((candidate) => decisionById.get(candidate.id)?.granted === true)
    : ownerAuthorized;
  let result;

  const finalize = async (resolution) => {
    resolution.shadowBoundaryWarning = await emitShadowBoundaryChatWarning({
      resolution,
      input: { ...input, resourceType },
      decision: decisionById.get(resolution.selectedTarget?.id) || null,
    }, env);
    await auditResolution(resolution, input, env);
    return resolution;
  };

  if (explicitTargetId) {
    const candidate = ownerScoped.find((item) => item.id === explicitTargetId);
    if (!candidate) result = failure(input, ownerScoped, authorized, "target_not_found", 404, { selectionSource: "explicit_request", ambiguityResult: "not_found" });
    else if (!canAccessOwner(principal, candidate.ownerUserId, env) || !authorized.some((item) => item.id === candidate.id)) result = failure(input, ownerScoped, authorized, "target_unauthorized", 403, { selectionSource: "explicit_request", ambiguityResult: "unauthorized" });
    else if (!candidate.eligible) result = failure(input, ownerScoped, authorized, "target_stale", 409, { selectionSource: "explicit_request", ambiguityResult: "stale" });
    else result = success(input, ownerScoped, authorized, candidate, {
      selectionSource: isAdminPrincipal(principal) && input.adminOverride === true
        ? "admin_override"
        : cleanLower(input.selectionSource || "explicit_request"),
      ambiguityResult: "explicit_match",
    });
    return finalize(result);
  }

  const eligible = authorized.filter((candidate) => candidate.eligible);
  if (!eligible.length) {
    result = failure(input, ownerScoped, authorized, "target_not_found", 404, { selectionSource: "missing_target", ambiguityResult: "zero_match" });
  } else if (eligible.length === 1 && input.allowSingleInference !== false) {
    result = success(input, ownerScoped, authorized, eligible[0], {
      selectionSource: cleanLower(input.selectionSource || "single_authorized_target"),
      ambiguityResult: "single_match",
    });
  } else {
    result = failure(input, ownerScoped, authorized, "instance_selection_required", 409, { selectionSource: "missing_target", ambiguityResult: "multiple_match" });
  }
  return finalize(result);
}

export async function requireResolvedTargetInstance(input = {}, env = process.env) {
  const resolution = await resolveTargetInstance(input, env);
  if (resolution.ok) return resolution;
  throw targetResolverError(resolution.error, resolution.statusCode, resolution);
}

function tenantVmCandidate(vm = {}, { requireRunning = true } = {}) {
  const status = cleanLower(vm.status || "");
  const deleted = Boolean(vm.deletedAt) || status === "deleted" || status === "deleting";
  const running = status === "running";
  return normalizeTargetCandidate({
    id: vm.id,
    type: "tenant_vm",
    ownerUserId: vm.ownerUserId,
    status,
    enabled: !deleted,
    healthy: !deleted && (!requireRunning || running),
    eligible: !deleted && (!requireRunning || running),
    reason: deleted ? "target_deleted" : requireRunning && !running ? "target_not_running" : "eligible",
    resource: vm,
  }, "tenant_vm");
}

export async function resolveTenantVmTarget(input = {}, env = process.env) {
  const tenantVmId = targetId(input.tenantVmId || input.explicitTargetId || input.targetId || input.instanceId);
  const vms = await listTenantVms(env);
  const candidates = vms
    .map((vm) => tenantVmCandidate(vm, { requireRunning: input.requireRunning !== false }))
    .filter(Boolean);
  return requireResolvedTargetInstance({
    ...input,
    targetType: "tenant_vm",
    explicitTargetId: tenantVmId,
    candidates,
  }, env);
}

export function targetResolutionMetadata(resolution = {}) {
  return publicResolution(resolution);
}
