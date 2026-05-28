import { adminUserId, defaultUserLimits, normalizeUserId } from "./users.js";

export function isAdminPrincipal(principal = {}) {
  return principal?.kind === "system" || String(principal?.role || "").trim().toLowerCase() === "admin";
}

export function resourceOwnerUserId(resource = {}, env = process.env) {
  return normalizeUserId(resource.ownerUserId || resource.userId || env.ORKESTR_ADMIN_USER_ID || adminUserId);
}

export function policyError(message = "forbidden", statusCode = 403) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function canAccessOwner(principal = {}, ownerUserId = "", env = process.env) {
  if (isAdminPrincipal(principal)) return true;
  const principalUserId = principal?.userId ? normalizeUserId(principal.userId) : "";
  const owner = normalizeUserId(ownerUserId || env.ORKESTR_ADMIN_USER_ID || adminUserId);
  return Boolean(principalUserId && principalUserId === owner);
}

export function assertOwnerAccess(principal = {}, ownerUserId = "", action = "access", env = process.env) {
  if (canAccessOwner(principal, ownerUserId, env)) return true;
  throw policyError(`${action}_forbidden`, 403);
}

export function assertResourceAccess(principal = {}, resource = {}, action = "access", env = process.env) {
  return assertOwnerAccess(principal, resourceOwnerUserId(resource, env), action, env);
}

export function maxThreadsForPrincipal(principal = {}, user = null) {
  if (isAdminPrincipal(principal)) return null;
  const limits = user?.limits && typeof user.limits === "object" ? user.limits : {};
  const value = Number(limits.maxThreads ?? principal.limits?.maxThreads ?? defaultUserLimits("user").maxThreads);
  return Number.isFinite(value) ? Math.max(0, value) : 1;
}

export function assertThreadLimit(principal = {}, threads = [], user = null) {
  const limit = maxThreadsForPrincipal(principal, user);
  if (limit === null) return true;
  const ownerUserId = principal?.userId ? normalizeUserId(principal.userId) : "";
  const ownedThreads = threads.filter((thread) => resourceOwnerUserId(thread) === ownerUserId && !thread.deletedAt);
  if (ownedThreads.length < limit) return true;
  throw policyError("thread_limit_reached", 403);
}

export function filterResourcesForPrincipal(resources = [], principal = {}, env = process.env) {
  if (isAdminPrincipal(principal)) return resources;
  return resources.filter((resource) => canAccessOwner(principal, resourceOwnerUserId(resource, env), env));
}
