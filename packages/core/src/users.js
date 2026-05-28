import { dataPaths, ensureDataDirs, userDataPaths } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";

export const adminUserId = "admin";

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
  const role = String(user.role || "").trim().toLowerCase() === "admin" ? "admin" : "user";
  const id = normalizeUserId(user.id || (role === "admin" ? defaultAdminUser(env).id : ""));
  return {
    id,
    role,
    displayName: String(user.displayName || user.name || id).trim(),
    status: String(user.status || "active").trim().toLowerCase(),
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
