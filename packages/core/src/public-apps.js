import crypto from "node:crypto";
import path from "node:path";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeSecretJson } from "../../storage/src/store.js";
import { withStorageFileLock } from "../../storage/src/storage-lock.js";
import { isAdminPrincipal } from "./policy.js";
import { publicUrlConfig } from "./public-url-config.js";

// A stable launcher is an application boundary, not a generic redirect. Keep
// each supported surface explicit so a grant to the Orkestr UI cannot be
// mistaken for a desktop or oXRM grant (and vice versa).
const appTypes = new Set(["orkestr-ui", "desktop", "oxrm"]);
const appStatuses = new Set(["active", "disabled"]);
const grantKinds = new Set(["subject", "group", "role"]);
const appRoles = new Set(["viewer", "editor", "admin"]);
const roleRank = new Map([["viewer", 1], ["editor", 2], ["admin", 3]]);

function nowIso() {
  return new Date().toISOString();
}

function clean(value = "") {
  return String(value || "").trim();
}

function enabled(value = "") {
  return ["1", "true", "yes", "on", "enabled"].includes(clean(value).toLowerCase());
}

function statePath(env = process.env) {
  return env.ORKESTR_PUBLIC_APPS_FILE || path.join(dataPaths(env).secrets, "public-apps.json");
}

function publicAppError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomBytes(18).toString("base64url")}`;
}

function normalizeSlug(value = "") {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function normalizeOpaqueRef(value = "", field = "reference") {
  const normalized = clean(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(normalized)) {
    throw publicAppError(`invalid_${field}`, 400);
  }
  return normalized;
}

function normalizeClaimValue(value = "", field = "grant_value") {
  const normalized = clean(value);
  if (!normalized || normalized.length > 320 || /[\r\n\0]/.test(normalized)) {
    throw publicAppError(`invalid_${field}`, 400);
  }
  return normalized;
}

function normalizeStringList(value = []) {
  const source = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(source.map((item) => clean(item)).filter((item) => item && item.length <= 200))].sort();
}

function sameOpaque(left = "", right = "") {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function assertAdmin(principal = {}) {
  if (isAdminPrincipal(principal)) return;
  throw publicAppError("public_app_admin_required", 403);
}

async function readState(env = process.env) {
  const state = await readJson(statePath(env), { apps: [], grants: [] });
  return {
    apps: Array.isArray(state.apps) ? state.apps : [],
    grants: Array.isArray(state.grants) ? state.grants : [],
  };
}

async function writeState(state = {}, env = process.env) {
  await ensureDataDirs(env);
  await writeSecretJson(statePath(env), {
    apps: Array.isArray(state.apps) ? state.apps : [],
    grants: Array.isArray(state.grants) ? state.grants : [],
    updatedAt: nowIso(),
  });
}

// Registry mutations are control-plane writes: a process-local queue is not
// sufficient because an operator API may be served by more than one process.
// The storage lease lock gives JSON-backed OSS installs the same read-modify-
// write fencing used by the other file registries.
async function mutateState(env = process.env, operation) {
  return withStorageFileLock(statePath(env), async () => {
    const state = await readState(env);
    const result = await operation(state);
    await writeState(state, env);
    return result;
  }, {
    timeoutMs: Number(env.ORKESTR_PUBLIC_APPS_LOCK_TIMEOUT_MS || 30_000),
    staleMs: Number(env.ORKESTR_PUBLIC_APPS_LOCK_STALE_MS || 120_000),
    heartbeatMs: Number(env.ORKESTR_PUBLIC_APPS_LOCK_HEARTBEAT_MS || 10_000),
  });
}

function normalizeApp(input = {}, existing = {}) {
  const slug = normalizeSlug(input.slug ?? existing.slug);
  if (!slug) throw publicAppError("public_app_slug_required", 400);
  const type = clean(input.type ?? existing.type ?? "oxrm").toLowerCase();
  if (!appTypes.has(type)) throw publicAppError("public_app_type_unsupported", 400);
  const status = clean(input.status ?? existing.status ?? "active").toLowerCase();
  if (!appStatuses.has(status)) throw publicAppError("public_app_status_invalid", 400);
  const tenantRef = normalizeOpaqueRef(input.tenantRef ?? existing.tenantRef, "tenant_ref");
  const targetRef = normalizeOpaqueRef(input.targetRef ?? existing.targetRef, "target_ref");
  const createdAt = clean(existing.createdAt) || nowIso();
  return {
    id: clean(existing.id) || randomId("app"),
    slug,
    type,
    status,
    title: clean(input.title ?? existing.title ?? slug.replace(/-/g, " ")).slice(0, 160),
    description: clean(input.description ?? existing.description).slice(0, 500),
    icon: clean(input.icon ?? existing.icon).replace(/[^a-z0-9_-]/gi, "").slice(0, 48),
    // These bindings are intentionally persisted only in secret state. They are
    // never projected into normal APIs, URLs, events, or browser sessions.
    tenantRef,
    targetRef,
    createdAt,
    updatedAt: nowIso(),
  };
}

function normalizeGrant(input = {}, app = {}, existing = {}) {
  const kind = clean(input.kind ?? existing.kind).toLowerCase();
  if (!grantKinds.has(kind)) throw publicAppError("public_app_grant_kind_invalid", 400);
  const value = normalizeClaimValue(input.value ?? existing.value);
  const role = clean(input.role ?? existing.role ?? "viewer").toLowerCase();
  if (!appRoles.has(role)) throw publicAppError("public_app_grant_role_invalid", 400);
  return {
    id: clean(existing.id) || randomId("grant"),
    appId: app.id,
    kind,
    value,
    role,
    status: "active",
    createdAt: clean(existing.createdAt) || nowIso(),
    updatedAt: nowIso(),
  };
}

function publicApp(app = {}, env = process.env) {
  const base = clean(publicUrlConfig(env).appUrl).replace(/\/+$/, "");
  const slug = clean(app.slug);
  return {
    id: clean(app.id),
    slug,
    type: clean(app.type),
    status: clean(app.status),
    title: clean(app.title),
    description: clean(app.description),
    icon: clean(app.icon),
    path: slug ? `/apps/${encodeURIComponent(slug)}` : "",
    ...(base && slug ? { url: `${base}/apps/${encodeURIComponent(slug)}` } : {}),
  };
}

function publicGrant(grant = {}) {
  // Subject and group values remain control-plane data. The admin listing only
  // exposes the grant shape and a stable opaque grant id.
  return {
    id: clean(grant.id),
    appId: clean(grant.appId),
    kind: clean(grant.kind),
    role: clean(grant.role),
    status: clean(grant.status),
    createdAt: clean(grant.createdAt),
    updatedAt: clean(grant.updatedAt),
  };
}

function authorizationContext(principal = {}, session = {}) {
  return {
    subject: clean(session?.oidcSubject),
    groups: normalizeStringList(session?.oidcGroups || []),
    roles: normalizeStringList(session?.oidcRoles || []),
    actorUserId: clean(principal?.userId),
  };
}

function grantMatches(grant = {}, context = {}) {
  if (clean(grant.status || "active") !== "active") return false;
  if (grant.kind === "subject") return Boolean(context.subject) && sameOpaque(grant.value, context.subject);
  if (grant.kind === "group") return context.groups.includes(grant.value);
  if (grant.kind === "role") return context.roles.includes(grant.value);
  return false;
}

function accessForApp(app = {}, grants = [], principal = {}, session = {}) {
  const context = authorizationContext(principal, session);
  let role = "";
  for (const grant of grants) {
    if (grant.appId !== app.id || !grantMatches(grant, context)) continue;
    if ((roleRank.get(grant.role) || 0) > (roleRank.get(role) || 0)) role = grant.role;
  }
  return role;
}

async function recordAccess(type, app = null, principal = {}, extra = {}, env = process.env) {
  await appendEvent({
    type,
    appId: app?.id || null,
    appSlug: app?.slug || null,
    actorUserId: clean(principal?.userId) || null,
    ...extra,
  }, env).catch(() => {});
}

export function publicAppsEnabled(env = process.env) {
  return enabled(env.ORKESTR_PUBLIC_APPS);
}

export async function createPublicApp(input = {}, { env = process.env, principal = null } = {}) {
  assertAdmin(principal);
  const app = await mutateState(env, async (state) => {
    const next = normalizeApp(input);
    if (state.apps.some((item) => item.slug === next.slug)) throw publicAppError("public_app_slug_exists", 409);
    state.apps.push(next);
    return next;
  });
  await recordAccess("public_app_created", app, principal, {}, env);
  return { ok: true, app: publicApp(app, env) };
}

export async function updatePublicApp(appId, input = {}, { env = process.env, principal = null } = {}) {
  assertAdmin(principal);
  const id = clean(appId);
  const app = await mutateState(env, async (state) => {
    const existing = state.apps.find((item) => item.id === id);
    if (!existing) throw publicAppError("public_app_not_found", 404);
    const next = normalizeApp(input, existing);
    if (state.apps.some((item) => item.id !== id && item.slug === next.slug)) throw publicAppError("public_app_slug_exists", 409);
    state.apps = state.apps.map((item) => item.id === id ? next : item);
    return next;
  });
  await recordAccess("public_app_updated", app, principal, {}, env);
  return { ok: true, app: publicApp(app, env) };
}

export async function listPublicApps({ env = process.env, principal = null } = {}) {
  assertAdmin(principal);
  const state = await readState(env);
  return {
    apps: state.apps.map((app) => publicApp(app, env)),
    grants: state.grants.map(publicGrant),
  };
}

export async function createPublicAppGrant(appId, input = {}, { env = process.env, principal = null } = {}) {
  assertAdmin(principal);
  const { app, grant } = await mutateState(env, async (state) => {
    const nextApp = state.apps.find((item) => item.id === clean(appId));
    if (!nextApp) throw publicAppError("public_app_not_found", 404);
    const nextGrant = normalizeGrant(input, nextApp);
    const duplicate = state.grants.some((item) => item.appId === nextApp.id && item.kind === nextGrant.kind && item.value === nextGrant.value && item.status === "active");
    if (duplicate) throw publicAppError("public_app_grant_exists", 409);
    state.grants.push(nextGrant);
    return { app: nextApp, grant: nextGrant };
  });
  await recordAccess("public_app_grant_created", app, principal, { grantId: grant.id, grantKind: grant.kind, grantRole: grant.role }, env);
  return { ok: true, grant: publicGrant(grant) };
}

export async function revokePublicAppGrant(appId, grantId, { env = process.env, principal = null } = {}) {
  assertAdmin(principal);
  const { app, revoked } = await mutateState(env, async (state) => {
    const nextApp = state.apps.find((item) => item.id === clean(appId));
    const existing = state.grants.find((item) => item.id === clean(grantId) && item.appId === nextApp?.id);
    if (!nextApp || !existing) throw publicAppError("public_app_grant_not_found", 404);
    const nextGrant = { ...existing, status: "revoked", updatedAt: nowIso() };
    state.grants = state.grants.map((item) => item.id === nextGrant.id ? nextGrant : item);
    return { app: nextApp, revoked: nextGrant };
  });
  await recordAccess("public_app_grant_revoked", app, principal, { grantId: revoked.id, grantKind: revoked.kind }, env);
  return { ok: true, grant: publicGrant(revoked) };
}

export async function listPublicAppsForSession({ env = process.env, principal = null, session = null } = {}) {
  const state = await readState(env);
  const apps = state.apps
    .filter((app) => app.status === "active")
    .map((app) => ({ app, role: accessForApp(app, state.grants, principal, session) }))
    .filter((item) => item.role)
    .map((item) => ({ ...publicApp(item.app, env), role: item.role }));
  return { apps };
}

export async function resolvePublicAppForSession(slug, { env = process.env, principal = null, session = null } = {}) {
  const normalizedSlug = normalizeSlug(slug);
  const state = await readState(env);
  const app = state.apps.find((item) => item.slug === normalizedSlug && item.status === "active") || null;
  if (!app) {
    await recordAccess("public_app_access_denied", null, principal, { reason: "not_found" }, env);
    throw publicAppError("public_app_not_found", 404);
  }
  const role = accessForApp(app, state.grants, principal, session);
  if (!role) {
    await recordAccess("public_app_access_denied", app, principal, { reason: "grant_denied" }, env);
    throw publicAppError("public_app_not_found", 404);
  }
  await recordAccess("public_app_accessed", app, principal, { role }, env);
  return {
    app,
    role,
    projection: { ...publicApp(app, env), role },
  };
}
