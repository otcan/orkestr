import { randomUUID } from "node:crypto";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { canAccessOwner, isAdminPrincipal, policyError, resourceOwnerUserId } from "./policy.js";
import { getThread, listThreads } from "./threads.js";
import { normalizeUserId } from "./users.js";

const DESKTOP_PERMISSIONS = new Set(["discover", "acquire", "operate", "share"]);
const mutationQueues = new Map();

function clean(value = "") {
  return String(value || "").trim();
}

function safeSegment(value = "", fallback = "local") {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function normalizePermissions(values = []) {
  const input = Array.isArray(values) ? values : clean(values).split(/[\s,]+/g);
  return [...new Set(input.map((value) => clean(value).toLowerCase()).filter((value) => DESKTOP_PERMISSIONS.has(value)))];
}

export function desktopAccessMode(env = process.env) {
  const configured = clean(env.ORKESTR_DESKTOP_ACCESS_MODE).toLowerCase();
  if (["off", "shadow", "enforce"].includes(configured)) return configured;
  if (["1", "true", "yes", "on"].includes(clean(env.ORKESTR_DESKTOP_ACCESS_ENFORCED).toLowerCase())) return "enforce";
  return "shadow";
}

export function desktopBoundaryId(env = process.env) {
  return safeSegment(
    env.ORKESTR_TENANT_VM_ID ||
    env.ORKESTR_BROKER_INSTANCE_ID ||
    env.ORKESTR_INSTANCE_ID ||
    env.ORKESTR_INSTALLATION_ID ||
    "local",
  );
}

export function desktopResourceId(slug = "", ownerUserId = "", env = process.env) {
  const desktopSlug = safeSegment(slug, "");
  if (!desktopSlug) return "";
  const owner = normalizeUserId(ownerUserId || env.ORKESTR_ADMIN_USER_ID || "admin");
  return `${desktopBoundaryId(env)}:${owner}:${desktopSlug}`;
}

function normalizeResource(raw = {}, env = process.env) {
  const slug = safeSegment(raw.slug || raw.desktopSlug, "");
  const ownerUserId = normalizeUserId(raw.ownerUserId || raw.userId || env.ORKESTR_ADMIN_USER_ID || "admin");
  const boundaryId = safeSegment(raw.boundaryId || raw.tenantVmId || desktopBoundaryId(env));
  if (!slug || !ownerUserId || !boundaryId) return null;
  return {
    id: clean(raw.id) || `${boundaryId}:${ownerUserId}:${slug}`,
    slug,
    ownerUserId,
    boundaryId,
    generation: Math.max(1, Number(raw.generation || 1) || 1),
    backend: clean(raw.backend || raw.type || "desktop") || "desktop",
    createdAt: clean(raw.createdAt) || nowIso(),
    updatedAt: clean(raw.updatedAt) || clean(raw.createdAt) || nowIso(),
    retiredAt: clean(raw.retiredAt) || null,
  };
}

function normalizeGrant(raw = {}, env = process.env) {
  const threadId = clean(raw.threadId);
  const desktopSlug = safeSegment(raw.desktopSlug || raw.slug, "");
  const ownerUserId = normalizeUserId(raw.ownerUserId || raw.userId || env.ORKESTR_ADMIN_USER_ID || "admin");
  const boundaryId = safeSegment(raw.boundaryId || raw.tenantVmId || desktopBoundaryId(env));
  const desktopId = clean(raw.desktopId || raw.resourceId) || desktopResourceId(desktopSlug, ownerUserId, { ...env, ORKESTR_TENANT_VM_ID: boundaryId });
  if (!threadId || !desktopSlug || !desktopId || !ownerUserId || !boundaryId) return null;
  const permissions = normalizePermissions(raw.permissions);
  return {
    id: clean(raw.id) || randomUUID(),
    threadId,
    desktopId,
    desktopSlug,
    ownerUserId,
    boundaryId,
    permissions: permissions.length ? permissions : [...DESKTOP_PERMISSIONS],
    revision: Math.max(1, Number(raw.revision || 1) || 1),
    source: clean(raw.source || "explicit") || "explicit",
    createdAt: clean(raw.createdAt) || nowIso(),
    updatedAt: clean(raw.updatedAt) || clean(raw.createdAt) || nowIso(),
    revokedAt: clean(raw.revokedAt) || null,
    revokedBy: clean(raw.revokedBy) || null,
    reason: clean(raw.reason) || null,
  };
}

function normalizeState(raw = {}, env = process.env) {
  const resources = Array.isArray(raw.resources) ? raw.resources.map((item) => normalizeResource(item, env)).filter(Boolean) : [];
  const grants = Array.isArray(raw.grants) ? raw.grants.map((item) => normalizeGrant(item, env)).filter(Boolean) : [];
  return {
    version: 2,
    revision: Math.max(0, Number(raw.revision || 0) || 0),
    resources,
    grants,
    updatedAt: clean(raw.updatedAt) || null,
  };
}

async function readState(env = process.env) {
  await ensureDataDirs(env);
  return normalizeState(await readJson(dataPaths(env).desktopAccess, {}), env);
}

async function mutateState(env, operation) {
  const filePath = dataPaths(env).desktopAccess;
  const previous = mutationQueues.get(filePath) || Promise.resolve();
  const run = previous.catch(() => undefined).then(async () => {
    const state = await readState(env);
    const result = await operation(state);
    state.version = 2;
    state.revision += 1;
    state.updatedAt = nowIso();
    await writeJson(filePath, state);
    return { result, state };
  });
  mutationQueues.set(filePath, run.then(() => undefined, () => undefined));
  return run;
}

function permissionForAction(action = "operate") {
  const normalized = clean(action).toLowerCase();
  if (["list", "status", "discover", "whereiam", "inventory"].includes(normalized)) return "discover";
  if (["acquire", "lease", "heartbeat", "release"].includes(normalized)) return "acquire";
  if (["share", "proxy", "open_share", "approve_share"].includes(normalized)) return "share";
  return "operate";
}

function activeGrantsForThread(state, threadId, resource) {
  return state.grants.filter((grant) =>
    !grant.revokedAt &&
    grant.threadId === threadId &&
    grant.desktopId === resource.id &&
    grant.ownerUserId === resource.ownerUserId &&
    grant.boundaryId === resource.boundaryId
  );
}

async function effectiveGrantForThread(state, thread, resource, permission, env = process.env, seen = new Set()) {
  if (!thread?.id || seen.has(thread.id)) return null;
  seen.add(thread.id);
  const direct = activeGrantsForThread(state, thread.id, resource);
  const directGrant = direct.find((grant) => grant.permissions.includes(permission)) || null;
  const parentId = clean(thread.parentThreadId);
  if (!parentId) return directGrant;
  const parent = await getThread(parentId, env);
  if (!parent) return null;
  const parentGrant = await effectiveGrantForThread(state, parent, resource, permission, env, seen);
  if (!parentGrant) return null;
  const hasExplicitChildPolicy = state.grants.some((grant) => grant.threadId === thread.id && !grant.revokedAt);
  if (!direct.length) {
    return hasExplicitChildPolicy
      ? null
      : { ...parentGrant, inheritedByThreadId: thread.id, inheritedFromThreadId: parentGrant.threadId };
  }
  if (!directGrant) return null;
  return {
    ...directGrant,
    inheritedByThreadId: thread.id,
    inheritedFromThreadId: parentGrant.threadId,
    revision: Math.max(parentGrant.revision, directGrant.revision),
  };
}

function accessError(reason, statusCode = 404) {
  return policyError(reason || "desktop_access_denied", statusCode);
}

async function auditDecision(decision, env = process.env) {
  if (decision.allowed && !decision.shadowDenied && !decision.breakGlass) return;
  if (
    decision.shadowDenied &&
    decision.permission === "discover" &&
    !["1", "true", "yes", "on"].includes(clean(env.ORKESTR_DESKTOP_ACCESS_AUDIT_DISCOVERY).toLowerCase())
  ) return;
  await appendEvent({
    type: decision.breakGlass ? "desktop_access_break_glass" : decision.shadowDenied ? "desktop_access_shadow_denied" : "desktop_access_denied",
    actorUserId: decision.actorUserId || "",
    ownerUserId: decision.ownerUserId || "",
    threadId: decision.threadId || "",
    desktopSlug: decision.desktopSlug || "",
    desktopId: decision.desktopId || "",
    boundaryId: decision.boundaryId || "",
    permission: decision.permission || "",
    mode: decision.mode || "",
    reason: decision.reason || "",
    breakGlassReason: decision.breakGlassReason || "",
    outcome: decision.allowed ? "allowed" : "blocked",
  }, env).catch(() => undefined);
}

export async function authorizeDesktopAccess(input = {}, env = process.env) {
  const mode = desktopAccessMode(env);
  const principal = input.principal || null;
  const threadId = clean(input.threadId || input.thread?.id);
  const desktopSlug = safeSegment(input.desktopSlug || input.slug, "");
  const permission = permissionForAction(input.permission || input.action);
  const boundaryId = desktopBoundaryId(env);
  const requestedOwner = normalizeUserId(input.ownerUserId || input.thread?.ownerUserId || principal?.userId || env.ORKESTR_ADMIN_USER_ID || "admin");
  const resource = normalizeResource({
    id: input.desktopId || input.resourceId,
    slug: desktopSlug,
    ownerUserId: requestedOwner,
    boundaryId: input.boundaryId || boundaryId,
    generation: input.desktopGeneration || input.generation,
  }, env);
  const base = {
    allowed: false,
    mode,
    permission,
    threadId,
    desktopSlug,
    desktopId: resource?.id || "",
    ownerUserId: requestedOwner,
    boundaryId,
    actorUserId: clean(principal?.userId),
    grant: null,
    grantRevision: 0,
    policyRevision: 0,
    desktopGeneration: resource?.generation || 1,
    shadowDenied: false,
    breakGlass: false,
    breakGlassReason: "",
    reason: "desktop_access_denied",
  };

  if (!desktopSlug || !resource) {
    const decision = { ...base, reason: "desktop_not_found" };
    await auditDecision(decision, env);
    return decision;
  }
  if (resource.boundaryId !== boundaryId) {
    const decision = { ...base, reason: "desktop_boundary_denied" };
    await auditDecision(decision, env);
    return decision;
  }
  if (mode === "off") return { ...base, allowed: true, reason: "desktop_access_disabled" };

  const state = await readState(env);
  base.policyRevision = state.revision;
  const storedResource = state.resources.find((item) => item.id === resource.id) || null;
  if (storedResource) base.desktopGeneration = storedResource.generation;
  const thread = threadId ? await getThread(threadId, env) : null;
  const ownerUserId = normalizeUserId(thread?.ownerUserId || requestedOwner);
  base.ownerUserId = ownerUserId;
  if (threadId && !thread) {
    const denied = { ...base, reason: "desktop_thread_not_found" };
    const decision = mode === "shadow" ? { ...denied, allowed: true, shadowDenied: true } : denied;
    await auditDecision(decision, env);
    return decision;
  }
  if (thread && principal && !canAccessOwner(principal, ownerUserId, env)) {
    const decision = { ...base, reason: "desktop_thread_owner_denied" };
    await auditDecision(decision, env);
    return decision;
  }
  if (ownerUserId !== resource.ownerUserId) {
    const decision = { ...base, reason: "desktop_owner_scope_denied" };
    await auditDecision(decision, env);
    return decision;
  }

  const breakGlassReason = clean(input.breakGlassReason || input.reason);
  if (input.breakGlass === true && isAdminPrincipal(principal || {}) && breakGlassReason) {
    const decision = { ...base, allowed: true, breakGlass: true, breakGlassReason, reason: "desktop_admin_break_glass" };
    await auditDecision(decision, env);
    return decision;
  }

  const grant = thread ? await effectiveGrantForThread(state, thread, resource, permission, env) : null;
  if (grant) {
    return {
      ...base,
      allowed: true,
      grant,
      grantRevision: grant.revision,
      reason: grant.inheritedByThreadId ? "desktop_grant_inherited" : "desktop_grant_allowed",
    };
  }

  const denied = { ...base, reason: threadId ? "desktop_grant_required" : "desktop_thread_scope_required" };
  const decision = mode === "shadow" ? { ...denied, allowed: true, shadowDenied: true } : denied;
  await auditDecision(decision, env);
  return decision;
}

export async function assertDesktopAccess(input = {}, env = process.env) {
  const decision = await authorizeDesktopAccess(input, env);
  if (!decision.allowed) throw accessError(decision.reason, decision.reason === "desktop_thread_not_found" ? 404 : 403);
  return decision;
}

export async function filterDesktopSessionsForThread(sessions = [], input = {}, env = process.env) {
  const output = [];
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const decision = await authorizeDesktopAccess({
      ...input,
      desktopSlug: session?.slug || session?.id,
      ownerUserId: session?.ownerUserId || input.ownerUserId,
      permission: "discover",
    }, env);
    if (decision.allowed) output.push({ ...session, desktopAccess: decision });
  }
  return output;
}

export async function listThreadDesktopGrants(threadId = "", principal = null, env = process.env) {
  const thread = await getThread(threadId, env);
  if (!thread) throw accessError("thread_not_found", 404);
  if (!canAccessOwner(principal || {}, resourceOwnerUserId(thread, env), env)) throw accessError("thread_access_forbidden", 403);
  const state = await readState(env);
  const grants = state.grants.filter((grant) => grant.threadId === thread.id && !grant.revokedAt);
  return {
    ok: true,
    mode: desktopAccessMode(env),
    policyRevision: state.revision,
    threadId: thread.id,
    grants,
    resources: state.resources.filter((resource) => grants.some((grant) => grant.desktopId === resource.id)),
  };
}

export async function setThreadDesktopGrants(threadId = "", entries = [], options = {}, env = process.env) {
  const principal = options.principal || null;
  if (!isAdminPrincipal(principal || {})) throw accessError("desktop_grant_admin_required", 403);
  const thread = await getThread(threadId, env);
  if (!thread) throw accessError("thread_not_found", 404);
  const ownerUserId = resourceOwnerUserId(thread, env);
  const boundaryId = desktopBoundaryId(env);
  const normalizedEntries = (Array.isArray(entries) ? entries : [])
    .map((entry) => typeof entry === "string" ? { desktopSlug: entry } : entry)
    .map((entry) => ({
      desktopSlug: safeSegment(entry.desktopSlug || entry.slug, ""),
      permissions: normalizePermissions(entry.permissions),
      reason: clean(entry.reason || options.reason),
    }))
    .filter((entry) => entry.desktopSlug);
  const actorUserId = clean(principal?.userId || "system");
  const updated = await mutateState(env, (state) => {
    const revokedAt = nowIso();
    state.grants = state.grants.map((grant) => grant.threadId === thread.id && !grant.revokedAt
      ? { ...grant, revokedAt, revokedBy: actorUserId, updatedAt: revokedAt }
      : grant);
    const created = [];
    for (const entry of normalizedEntries) {
      const id = desktopResourceId(entry.desktopSlug, ownerUserId, env);
      let resource = state.resources.find((item) => item.id === id) || null;
      if (!resource) {
        resource = normalizeResource({ id, slug: entry.desktopSlug, ownerUserId, boundaryId }, env);
        state.resources.push(resource);
      }
      const grant = normalizeGrant({
        threadId: thread.id,
        desktopId: resource.id,
        desktopSlug: resource.slug,
        ownerUserId,
        boundaryId,
        permissions: entry.permissions.length ? entry.permissions : [...DESKTOP_PERMISSIONS],
        revision: state.revision + 1,
        source: clean(options.source || "admin"),
        reason: entry.reason,
      }, env);
      state.grants.push(grant);
      created.push(grant);
    }
    return created;
  });
  await appendEvent({
    type: "desktop_grants_replaced",
    threadId: thread.id,
    ownerUserId,
    actorUserId,
    desktopSlugs: updated.result.map((grant) => grant.desktopSlug),
    policyRevision: updated.state.revision,
  }, env).catch(() => undefined);
  return {
    ok: true,
    mode: desktopAccessMode(env),
    policyRevision: updated.state.revision,
    threadId: thread.id,
    grants: updated.result,
  };
}

function explicitDesktopEntries(thread = {}) {
  const objects = [
    thread,
    thread.runtime,
    thread.binding,
    thread.executor?.metadata,
    thread.desktopAccess,
  ].filter((value) => value && typeof value === "object" && !Array.isArray(value));
  const entries = [];
  const configured = [
    ...(Array.isArray(thread.desktopGrants) ? thread.desktopGrants : []),
    ...(Array.isArray(thread.desktopAccess?.grants) ? thread.desktopAccess.grants : []),
    ...(Array.isArray(thread.desktopAccess?.desktops) ? thread.desktopAccess.desktops : []),
  ];
  for (const item of configured) entries.push(typeof item === "string" ? { desktopSlug: item } : item);
  for (const source of objects) {
    for (const key of ["desktopSlug", "browserSlug", "managedDesktopSlug", "manualInterventionDesktopSlug", "defaultDesktopSlug"]) {
      const desktopSlug = safeSegment(source[key], "");
      if (desktopSlug) entries.push({ desktopSlug });
    }
  }
  const deduplicated = new Map();
  for (const entry of entries) {
    const desktopSlug = safeSegment(entry?.desktopSlug || entry?.slug, "");
    if (!desktopSlug) continue;
    const permissions = normalizePermissions(entry?.permissions);
    deduplicated.set(desktopSlug, {
      desktopSlug,
      permissions: permissions.length ? permissions : [...DESKTOP_PERMISSIONS],
      reason: clean(entry?.reason || "explicit_thread_metadata_backfill"),
    });
  }
  return [...deduplicated.values()];
}

export async function backfillThreadDesktopGrants(options = {}, env = process.env) {
  const principal = options.principal || null;
  if (!isAdminPrincipal(principal || {})) throw accessError("desktop_grant_admin_required", 403);
  const state = await readState(env);
  const threads = await listThreads(env);
  const planned = [];
  const ambiguous = [];
  for (const thread of threads.filter((item) => !item.deletedAt)) {
    const active = state.grants.filter((grant) => grant.threadId === thread.id && !grant.revokedAt);
    if (active.length) continue;
    const entries = explicitDesktopEntries(thread);
    if (entries.length) planned.push({ threadId: thread.id, ownerUserId: resourceOwnerUserId(thread, env), entries });
    else ambiguous.push({ threadId: thread.id, ownerUserId: resourceOwnerUserId(thread, env), reason: "no_explicit_desktop_evidence" });
  }
  if (options.dryRun === true) {
    return { ok: true, dryRun: true, mode: desktopAccessMode(env), planned, ambiguous };
  }
  const applied = [];
  for (const item of planned) {
    const result = await setThreadDesktopGrants(item.threadId, item.entries, {
      principal,
      source: "migration",
      reason: "explicit_thread_metadata_backfill",
    }, env);
    applied.push({ threadId: item.threadId, desktopSlugs: result.grants.map((grant) => grant.desktopSlug) });
  }
  return { ok: true, dryRun: false, mode: desktopAccessMode(env), applied, ambiguous };
}

export async function desktopAccessPolicySummary(threadId = "", principal = null, env = process.env) {
  const state = await readState(env);
  const grants = threadId
    ? state.grants.filter((grant) => grant.threadId === threadId && !grant.revokedAt)
    : [];
  return {
    mode: desktopAccessMode(env),
    version: state.version,
    revision: state.revision,
    threadId: clean(threadId) || null,
    explicitGrantCount: grants.length,
    grantedDesktopSlugs: grants.map((grant) => grant.desktopSlug),
    principalRole: clean(principal?.role) || null,
  };
}
