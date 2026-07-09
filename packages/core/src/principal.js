import { defaultAdminUser, getUser, normalizeUserId } from "./users.js";

function clean(value = "") {
  return String(value || "").trim();
}

function isAdminLikePrincipal(principal = {}) {
  return principal?.kind === "system" || clean(principal?.role).toLowerCase() === "admin";
}

function isTenantScopedRuntime(env = process.env) {
  return Boolean(
    clean(env.ORKESTR_TENANT_VM_ID) ||
      clean(env.ORKESTR_TENANT_SLICE_ID) ||
      clean(env.ORKESTR_TENANT_BOUNDARY) === "tenant-vm",
  );
}

export function systemPrincipal() {
  return {
    kind: "system",
    userId: "system",
    role: "admin",
    source: "system",
    displayName: "System",
  };
}

export function adminPrincipal(user = defaultAdminUser()) {
  const resolved = typeof user === "string" ? { id: user, role: "admin", displayName: "Admin" } : user || defaultAdminUser();
  return {
    kind: "user",
    userId: normalizeUserId(resolved.id || "admin"),
    role: "admin",
    source: "admin",
    displayName: String(resolved.displayName || "Admin"),
  };
}

export function userPrincipal(user = {}) {
  const role = String(user.role || "").trim().toLowerCase() === "admin" ? "admin" : "user";
  return {
    kind: "user",
    userId: normalizeUserId(user.id || ""),
    role,
    source: String(user.source || "session").trim() || "session",
    displayName: String(user.displayName || user.name || user.id || "").trim(),
    identities: [],
  };
}

export function principalFromSecuritySession(session = {}, env = process.env) {
  const role = String(session.role || "").trim().toLowerCase() === "user" ? "user" : "admin";
  const userId = normalizeUserId(session.userId || (role === "admin" ? defaultAdminUser(env).id : ""));
  return {
    kind: "user",
    userId,
    role,
    source: "browser-session",
    sessionId: String(session.id || "").trim(),
    displayName: String(session.displayName || (role === "admin" ? "Admin" : userId)).trim(),
  };
}

export async function principalForUserId(userId, env = process.env) {
  const user = await getUser(userId, env);
  if (!user) return null;
  return userPrincipal({ ...user, source: "lookup" });
}

export function requestPrincipal(request, env = process.env) {
  const principal = request?.orkestrPrincipal || request?.principal || null;
  if (principal?.userId) return principal;
  return adminPrincipal(defaultAdminUser(env));
}

export function tenantOwnerPrincipalForLocalAdmin(principal = null, env = process.env) {
  if (!isTenantScopedRuntime(env) || !isAdminLikePrincipal(principal)) return principal;
  const ownerUserId = clean(env.ORKESTR_ADMIN_USER_ID);
  if (!ownerUserId) return principal;
  return userPrincipal({
    id: ownerUserId,
    role: "user",
    source: "tenant-owner",
    displayName: ownerUserId,
  });
}

export function requestPrincipalForTenantOwner(request, env = process.env) {
  const principal = requestPrincipal(request, env);
  if (request?.orkestrMachineAuth === "broker_proxy") return principal;
  return tenantOwnerPrincipalForLocalAdmin(principal, env);
}

export function publicPrincipal(principal = null) {
  if (!principal) return null;
  return {
    kind: principal.kind || "user",
    userId: principal.userId || null,
    role: principal.role || "user",
    source: principal.source || null,
    displayName: principal.displayName || null,
  };
}
