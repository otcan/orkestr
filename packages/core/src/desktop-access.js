import { appendEvent } from "../../storage/src/store.js";
import { getThread, listThreads } from "./threads.js";
import { isAdminPrincipal, resourceOwnerUserId } from "./policy.js";
import { THREAD_RESOURCE_PERMISSIONS } from "./thread-resource-policy-constants.js";
import {
  advanceThreadResourceGeneration,
  assertThreadResourceAccess,
  authorizeThreadResourceAccess,
  filterThreadResources,
  listThreadResourceGrants,
  safeThreadResourceSegment,
  setThreadResourceGrants,
  threadResourceAccessMode,
  threadResourceBoundaryId,
  threadResourceId,
  threadResourcePolicySummary,
} from "./thread-resource-grants.js";

export const DESKTOP_PERMISSIONS = new Set(THREAD_RESOURCE_PERMISSIONS.desktop);

const clean = (value = "") => String(value || "").trim();

export function desktopAccessMode(env = process.env) { return threadResourceAccessMode("desktop", env); }
export function desktopBoundaryId(env = process.env) { return threadResourceBoundaryId(env); }
export function desktopResourceId(slug = "", ownerUserId = "", env = process.env) { return threadResourceId("desktop", slug, ownerUserId, env); }

function desktopEntry(entry = {}) {
  const source = typeof entry === "string" ? { desktopSlug: entry } : entry || {};
  const desktopSlug = safeThreadResourceSegment(source.desktopSlug || source.slug || source.resourceKey || source.resourceId || source.id, "");
  return { ...source, desktopSlug, resourceKey: desktopSlug };
}

function desktopGrant(grant = {}) {
  return {
    ...grant,
    desktopId: grant.desktopId || grant.resourceId,
    desktopSlug: grant.desktopSlug || grant.resourceKey,
  };
}

function desktopResource(resource = {}) {
  return {
    ...resource,
    id: resource.id || resource.resourceId,
    slug: resource.slug || resource.desktopSlug || resource.resourceKey,
    desktopSlug: resource.desktopSlug || resource.resourceKey,
  };
}

export async function authorizeDesktopAccess(input = {}, env = process.env) {
  const desktopSlug = safeThreadResourceSegment(input.desktopSlug || input.slug || input.resourceKey, "");
  const decision = await authorizeThreadResourceAccess({
    ...input,
    resourceType: "desktop",
    resourceKey: desktopSlug,
    resourceId: input.desktopId || input.resourceId,
    resourceGeneration: input.desktopGeneration || input.generation,
  }, env);
  return {
    ...decision,
    desktopSlug: decision.desktopSlug || desktopSlug,
    desktopId: decision.desktopId || decision.resourceId,
    desktopGeneration: decision.desktopGeneration || decision.resourceGeneration,
    grant: decision.grant ? desktopGrant(decision.grant) : null,
  };
}

export async function assertDesktopAccess(input = {}, env = process.env) {
  const decision = await assertThreadResourceAccess({
    ...input,
    resourceType: "desktop",
    resourceKey: input.desktopSlug || input.slug || input.resourceKey,
    resourceId: input.desktopId || input.resourceId,
    resourceGeneration: input.desktopGeneration || input.generation,
  }, env);
  return { ...decision, desktopSlug: decision.desktopSlug || decision.resourceKey, desktopId: decision.desktopId || decision.resourceId, desktopGeneration: decision.desktopGeneration || decision.resourceGeneration, grant: decision.grant ? desktopGrant(decision.grant) : null };
}

export async function filterDesktopSessionsForThread(sessions = [], input = {}, env = process.env) {
  const filtered = await filterThreadResources((Array.isArray(sessions) ? sessions : []).map((session) => ({
    ...session,
    resourceType: "desktop",
    resourceKey: session?.slug || session?.id,
    resourceId: session?.desktopId || session?.resourceId,
  })), { ...input, resourceType: "desktop", permission: "discover", resourceIdFromItemId: false }, env);
  return filtered.map(({ threadResourceAccess, ...session }) => ({ ...session, desktopAccess: { ...threadResourceAccess, grant: threadResourceAccess.grant ? desktopGrant(threadResourceAccess.grant) : null } }));
}

export async function listThreadDesktopGrants(threadId = "", principal = null, env = process.env) {
  const result = await listThreadResourceGrants(threadId, "desktop", principal, env);
  return { ...result, grants: result.grants.map(desktopGrant), resources: result.resources.map(desktopResource) };
}

export async function setThreadDesktopGrants(threadId = "", entries = [], options = {}, env = process.env) {
  const result = await setThreadResourceGrants(threadId, "desktop", (Array.isArray(entries) ? entries : []).map(desktopEntry), options, env);
  await appendEvent({
    type: "desktop_grants_replaced",
    threadId: result.threadId,
    ownerUserId: (await getThread(result.threadId, env))?.ownerUserId || "",
    actorUserId: clean(options.principal?.userId || "system"),
    desktopSlugs: result.grants.map((grant) => grant.resourceKey),
    policyRevision: result.policyRevision,
  }, env).catch(() => undefined);
  return { ...result, grants: result.grants.map(desktopGrant) };
}

export async function advanceDesktopResourceGeneration(desktopSlug = "", ownerUserId = "", options = {}, env = process.env) {
  const result = await advanceThreadResourceGeneration("desktop", desktopSlug, ownerUserId, options, env);
  return { ...result, resource: desktopResource(result.resource) };
}

function explicitDesktopEntries(thread = {}) {
  const objects = [thread, thread.runtime, thread.binding, thread.executor?.metadata, thread.desktopAccess].filter((value) => value && typeof value === "object" && !Array.isArray(value));
  const configured = [
    ...(Array.isArray(thread.desktopGrants) ? thread.desktopGrants : []),
    ...(Array.isArray(thread.desktopAccess?.grants) ? thread.desktopAccess.grants : []),
    ...(Array.isArray(thread.desktopAccess?.desktops) ? thread.desktopAccess.desktops : []),
  ];
  for (const source of objects) for (const key of ["desktopSlug", "browserSlug", "managedDesktopSlug", "manualInterventionDesktopSlug", "defaultDesktopSlug"]) {
    if (source[key]) configured.push({ desktopSlug: source[key] });
  }
  const entries = new Map();
  for (const configuredEntry of configured) {
    const entry = desktopEntry(configuredEntry);
    if (!entry.desktopSlug) continue;
    entries.set(entry.desktopSlug, { desktopSlug: entry.desktopSlug, permissions: Array.isArray(entry.permissions) && entry.permissions.length ? entry.permissions : [...DESKTOP_PERMISSIONS], reason: clean(entry.reason || "explicit_thread_metadata_backfill") });
  }
  return [...entries.values()];
}

export async function backfillThreadDesktopGrants(options = {}, env = process.env) {
  if (!isAdminPrincipal(options.principal || {})) {
    const error = new Error("desktop_grant_admin_required"); error.statusCode = 403; throw error;
  }
  const threads = await listThreads(env);
  const planned = []; const ambiguous = [];
  for (const thread of threads.filter((item) => !item.deletedAt)) {
    const current = await listThreadDesktopGrants(thread.id, options.principal, env);
    if (current.grants.length) continue;
    const entries = explicitDesktopEntries(thread);
    if (entries.length) planned.push({ threadId: thread.id, ownerUserId: resourceOwnerUserId(thread, env), entries });
    else ambiguous.push({ threadId: thread.id, ownerUserId: resourceOwnerUserId(thread, env), reason: "no_explicit_desktop_evidence" });
  }
  if (options.dryRun === true) return { ok: true, dryRun: true, mode: desktopAccessMode(env), planned, ambiguous };
  const applied = [];
  for (const item of planned) {
    const result = await setThreadDesktopGrants(item.threadId, item.entries, { principal: options.principal, source: "migration", reason: "explicit_thread_metadata_backfill" }, env);
    applied.push({ threadId: item.threadId, desktopSlugs: result.grants.map((grant) => grant.desktopSlug) });
  }
  return { ok: true, dryRun: false, mode: desktopAccessMode(env), applied, ambiguous };
}

export async function desktopAccessPolicySummary(threadId = "", principal = null, env = process.env) {
  const summary = await threadResourcePolicySummary(threadId, principal, env);
  const grantedDesktopSlugs = summary.grantsByType.desktop || [];
  return { mode: desktopAccessMode(env), version: summary.version, revision: summary.revision, threadId: summary.threadId, explicitGrantCount: grantedDesktopSlugs.length, grantedDesktopSlugs, principalRole: summary.principalRole };
}
