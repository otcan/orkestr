import { dataPaths, ensureDataDirs, userDataPaths } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";

export const adminUserId = "admin";
const userStatuses = new Set(["active", "disabled"]);

function nowIso() {
  return new Date().toISOString();
}

export function normalizeUserId(value = "") {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || adminUserId;
}

export function defaultUserLimits(role = "user") {
  return {
    maxThreads: role === "admin" ? null : 1,
  };
}

function normalizeRole(value = "user") {
  return String(value || "").trim().toLowerCase() === "admin" ? "admin" : "user";
}

function normalizeStatus(value = "active") {
  const status = String(value || "active").trim().toLowerCase();
  return userStatuses.has(status) ? status : "active";
}

function userError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function defaultAdminUser(env = process.env) {
  const id = normalizeUserId(env.ORKESTR_ADMIN_USER_ID || adminUserId);
  return {
    id,
    role: "admin",
    displayName: "Admin",
    status: "active",
    linkedIdentities: [],
    limits: defaultUserLimits("admin"),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function normalizeIdentity(identity = {}) {
  return {
    provider: String(identity.provider || "").trim().toLowerCase(),
    accountId: String(identity.accountId || "").trim(),
    externalId: String(identity.externalId || identity.chatId || identity.email || "").trim(),
    displayName: String(identity.displayName || "").trim(),
    linkedAt: String(identity.linkedAt || "").trim() || nowIso(),
  };
}

export function normalizeUser(user = {}, env = process.env) {
  const role = normalizeRole(user.role);
  const id = normalizeUserId(user.id || (role === "admin" ? defaultAdminUser(env).id : ""));
  return {
    id,
    role,
    displayName: String(user.displayName || user.name || id).trim(),
    status: normalizeStatus(user.status),
    linkedIdentities: Array.isArray(user.linkedIdentities)
      ? user.linkedIdentities.map(normalizeIdentity).filter((identity) => identity.provider && identity.externalId)
      : [],
    limits: {
      ...defaultUserLimits(role),
      ...(user.limits && typeof user.limits === "object" ? user.limits : {}),
    },
    createdAt: String(user.createdAt || "").trim() || nowIso(),
    updatedAt: String(user.updatedAt || "").trim() || nowIso(),
  };
}

export function publicUser(user = {}, env = process.env) {
  const normalized = normalizeUser(user, env);
  return {
    id: normalized.id,
    role: normalized.role,
    displayName: normalized.displayName,
    status: normalized.status,
    linkedIdentities: normalized.linkedIdentities.map((identity) => ({ ...identity })),
    limits: { ...normalized.limits },
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
  };
}

async function readUsersFile(env = process.env) {
  const paths = await ensureDataDirs(env);
  const users = await readJson(paths.users, []);
  return Array.isArray(users) ? users : [];
}

async function writeUsersFile(users, env = process.env) {
  const paths = dataPaths(env);
  await writeJson(paths.users, users);
}

export async function listUsers(env = process.env) {
  const users = (await readUsersFile(env)).map((user) => normalizeUser(user, env));
  const admin = defaultAdminUser(env);
  if (!users.some((user) => user.id === admin.id)) users.unshift(admin);
  return users;
}

export async function getUser(userId, env = process.env) {
  const id = normalizeUserId(userId);
  return (await listUsers(env)).find((user) => user.id === id) || null;
}

export async function upsertUser(input = {}, env = process.env) {
  const user = normalizeUser(input, env);
  const users = await listUsers(env);
  const now = nowIso();
  let existed = false;
  const next = users.map((item) => {
    if (item.id !== user.id) return item;
    existed = true;
    return normalizeUser({ ...item, ...user, createdAt: item.createdAt || user.createdAt, updatedAt: now }, env);
  });
  if (!existed) next.push(normalizeUser({ ...user, createdAt: now, updatedAt: now }, env));
  await writeUsersFile(next, env);
  await appendEvent({ type: existed ? "user_updated" : "user_created", userId: user.id, role: user.role }, env).catch(() => {});
  return (await getUser(user.id, env)) || user;
}

function activeAdminUsers(users = []) {
  return users.filter((user) => user.role === "admin" && user.status !== "disabled");
}

function assertLastAdminSafe(before, after) {
  const beforeAdmins = activeAdminUsers(before);
  const afterAdmins = activeAdminUsers(after);
  if (beforeAdmins.length > 0 && afterAdmins.length === 0) {
    throw userError("last_admin_required", 409);
  }
}

export async function createUser(input = {}, env = process.env) {
  const rawId = String(input.id || input.userId || "").trim();
  if (!rawId) throw userError("user_id_required", 400);
  const user = normalizeUser({
    ...input,
    id: rawId,
    role: normalizeRole(input.role || "user"),
    status: normalizeStatus(input.status || "active"),
  }, env);
  const users = await listUsers(env);
  if (users.some((item) => item.id === user.id)) throw userError("user_already_exists", 409);
  const now = nowIso();
  const next = [...users, normalizeUser({ ...user, createdAt: now, updatedAt: now }, env)];
  assertLastAdminSafe(users, next);
  await writeUsersFile(next, env);
  await appendEvent({ type: "user_created", userId: user.id, role: user.role }, env).catch(() => {});
  return (await getUser(user.id, env)) || user;
}

export async function updateUser(userId, input = {}, env = process.env) {
  const id = normalizeUserId(userId);
  if (!id) throw userError("user_id_required", 400);
  const users = await listUsers(env);
  const existing = users.find((item) => item.id === id);
  if (!existing) throw userError("user_not_found", 404);
  const now = nowIso();
  const merged = normalizeUser({
    ...existing,
    displayName: input.displayName ?? input.name ?? existing.displayName,
    role: input.role === undefined || input.role === null || input.role === "" ? existing.role : input.role,
    status: input.status === undefined || input.status === null || input.status === "" ? existing.status : input.status,
    limits: input.limits && typeof input.limits === "object" ? { ...existing.limits, ...input.limits } : existing.limits,
    linkedIdentities: Array.isArray(input.linkedIdentities) ? input.linkedIdentities : existing.linkedIdentities,
    updatedAt: now,
  }, env);
  const next = users.map((user) => user.id === id ? merged : user);
  assertLastAdminSafe(users, next);
  await writeUsersFile(next, env);
  await appendEvent({ type: "user_updated", userId: id, role: merged.role, status: merged.status }, env).catch(() => {});
  return (await getUser(id, env)) || merged;
}

export async function setUserStatus(userId, status, env = process.env) {
  return updateUser(userId, { status: normalizeStatus(status) }, env);
}

export async function disableUser(userId, env = process.env) {
  return setUserStatus(userId, "disabled", env);
}

export async function enableUser(userId, env = process.env) {
  return setUserStatus(userId, "active", env);
}

export async function updateUserLimits(userId, limits = {}, env = process.env) {
  const nextLimits = {};
  if (Object.prototype.hasOwnProperty.call(limits || {}, "maxThreads")) {
    const raw = limits.maxThreads;
    if (raw === null || raw === "" || raw === undefined) nextLimits.maxThreads = null;
    else {
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) throw userError("invalid_max_threads", 400);
      nextLimits.maxThreads = Math.floor(parsed);
    }
  }
  return updateUser(userId, { limits: nextLimits }, env);
}

export async function findUserByIdentity({ provider, accountId = "", externalId = "" } = {}, env = process.env) {
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  const normalizedAccountId = String(accountId || "").trim();
  const normalizedExternalId = String(externalId || "").trim();
  if (!normalizedProvider || !normalizedExternalId) return null;
  const users = await listUsers(env);
  return users.find((user) => (user.linkedIdentities || []).some((identity) =>
    identity.provider === normalizedProvider &&
    identity.externalId === normalizedExternalId &&
    (!normalizedAccountId || !identity.accountId || identity.accountId === normalizedAccountId)
  )) || null;
}

export async function findOrCreateExternalUser(identity = {}, env = process.env) {
  const normalizedIdentity = normalizeIdentity(identity);
  if (!normalizedIdentity.provider || !normalizedIdentity.externalId) {
    const error = new Error("external_identity_required");
    error.statusCode = 400;
    throw error;
  }
  const existing = await findUserByIdentity(normalizedIdentity, env);
  if (existing) return existing;
  const suffix = normalizedIdentity.accountId
    ? `${normalizedIdentity.accountId}-${normalizedIdentity.externalId}`
    : normalizedIdentity.externalId;
  const user = await upsertUser({
    id: normalizeUserId(`${normalizedIdentity.provider}-${suffix}`),
    role: "user",
    displayName: normalizedIdentity.displayName || normalizedIdentity.externalId,
    linkedIdentities: [normalizedIdentity],
  }, env);
  const paths = userDataPaths(user.id, env);
  await ensureDataDirs(env);
  await appendEvent({ type: "external_user_provisioned", userId: user.id, provider: normalizedIdentity.provider }, env).catch(() => {});
  return {
    ...user,
    dataPaths: paths,
  };
}
