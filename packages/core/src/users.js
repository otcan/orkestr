import { dataPaths, ensureDataDirs, userDataPaths } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { authProvider } from "./auth-config.js";

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

export function normalizeEmail(value = "") {
  return String(value || "").trim().toLowerCase();
}

export function normalizePhoneNumber(value = "") {
  return String(value || "").trim();
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
    email: normalizeEmail(env.ORKESTR_ADMIN_EMAIL || ""),
    phoneNumber: normalizePhoneNumber(env.ORKESTR_ADMIN_PHONE || ""),
    authProvider: authProvider(env),
    status: "active",
    limits: defaultUserLimits("admin"),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
}

function normalizeIdentity(identity = {}) {
  const source = String(identity.source || identity.assignmentSource || (identity.autoProvisioned ? "auto" : "")).trim().toLowerCase();
  return {
    provider: String(identity.provider || "").trim().toLowerCase(),
    accountId: String(identity.accountId || "").trim(),
    externalId: String(identity.externalId || identity.senderId || identity.participantId || identity.email || "").trim(),
    chatId: String(identity.chatId || identity.waChatId || identity.whatsappChatId || "").trim(),
    displayName: String(identity.displayName || "").trim(),
    source: source === "manual" || source === "auto" ? source : "",
    linkedAt: String(identity.linkedAt || "").trim() || nowIso(),
  };
}

export function normalizeUser(user = {}, env = process.env) {
  const role = normalizeRole(user.role);
  const id = normalizeUserId(user.id || user.userId || user.email || (role === "admin" ? defaultAdminUser(env).id : ""));
  return {
    id,
    role,
    displayName: String(user.displayName || user.name || id).trim(),
    email: normalizeEmail(user.email || ""),
    phoneNumber: normalizePhoneNumber(user.phoneNumber || user.phone || ""),
    authProvider: String(user.authProvider || authProvider(env)).trim() || "browser_pairing",
    status: normalizeStatus(user.status),
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
    email: normalized.email,
    phoneNumber: normalized.phoneNumber,
    authProvider: normalized.authProvider,
    status: normalized.status,
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
  assertLoginContactComplete(user);
  assertEmailUnique(users, user);
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
  const rawId = String(input.id || input.userId || input.email || "").trim();
  if (!rawId) throw userError("user_email_required", 400);
  const user = normalizeUser({
    ...input,
    id: rawId,
    role: normalizeRole(input.role || "user"),
    status: normalizeStatus(input.status || "active"),
  }, env);
  const users = await listUsers(env);
  assertLoginContactComplete(user);
  assertEmailUnique(users, user, { allowSameUser: false });
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
    email: input.email === undefined || input.email === null ? existing.email : input.email,
    phoneNumber: input.phoneNumber === undefined && input.phone === undefined ? existing.phoneNumber : input.phoneNumber ?? input.phone,
    authProvider: input.authProvider === undefined || input.authProvider === null || input.authProvider === "" ? existing.authProvider : input.authProvider,
    role: input.role === undefined || input.role === null || input.role === "" ? existing.role : input.role,
    status: input.status === undefined || input.status === null || input.status === "" ? existing.status : input.status,
    limits: input.limits && typeof input.limits === "object" ? { ...existing.limits, ...input.limits } : existing.limits,
    updatedAt: now,
  }, env);
  assertLoginContactComplete(merged);
  assertEmailUnique(users, merged);
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

export async function findUserByIdentity(identity = {}, env = process.env) {
  const { provider, accountId = "", externalId = "" } = identity;
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  const normalizedAccountId = String(accountId || "").trim();
  const normalizedExternalId = String(externalId || "").trim();
  const normalizedChatId = String(identity.chatId || identity.waChatId || identity.whatsappChatId || "").trim();
  if (!normalizedProvider || (!normalizedExternalId && !normalizedChatId)) return null;
  const users = await listUsers(env);
  for (const user of users) {
    const identities = await readUserPrivateIdentities(user.id, env);
    const match = identities.find((identity) =>
      identity.provider === normalizedProvider &&
      identityAccountCompatible(identity, normalizedAccountId) &&
      identityRouteMatches(identity, { externalId: normalizedExternalId, chatId: normalizedChatId })
    );
    if (match) return user;
  }
  return null;
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
  }, env);
  const paths = userDataPaths(user.id, env);
  await ensureDataDirs(env);
  await addUserPrivateIdentity(user.id, { ...normalizedIdentity, source: normalizedIdentity.source || "auto" }, env);
  await appendEvent({ type: "external_user_provisioned", userId: user.id, provider: normalizedIdentity.provider }, env).catch(() => {});
  return {
    ...user,
    dataPaths: paths,
  };
}

function assertEmailUnique(users = [], candidate = {}, { allowSameUser = true } = {}) {
  const email = normalizeEmail(candidate.email || "");
  if (!email) return;
  const existing = users.find((user) =>
    normalizeEmail(user.email || "") === email &&
    (!allowSameUser || user.id !== candidate.id)
  );
  if (existing) throw userError("user_email_already_exists", 409);
}

function assertLoginContactComplete(user = {}) {
  if (normalizeEmail(user.email || "") && !normalizePhoneNumber(user.phoneNumber || "")) {
    throw userError("user_phone_required", 400);
  }
}

export async function readUserPrivateIdentities(userId, env = process.env) {
  const paths = userDataPaths(userId, env);
  const identities = await readJson(paths.identities, []);
  return Array.isArray(identities)
    ? identities.map(normalizeIdentity).filter((identity) => identity.provider && (identity.externalId || identity.chatId))
    : [];
}

export async function linkUserPrivateIdentity(userId, identity = {}, { env = process.env, actorUserId = "system", migrate = false } = {}) {
  const user = await getUser(userId, env);
  if (!user) throw userError("user_not_found", 404);
  const normalized = normalizeIdentity({ ...identity, source: identity.source || "manual" });
  if (!normalized.provider || (!normalized.externalId && !normalized.chatId)) {
    throw userError("external_identity_required", 400);
  }
  const users = await listUsers(env);
  const conflicts = [];
  for (const other of users) {
    const identities = await readUserPrivateIdentities(other.id, env);
    if (!identities.some((item) => identityConflicts(item, normalized))) continue;
    if (other.id === user.id) continue;
    if (other.status === "disabled") continue;
    conflicts.push(other);
  }
  if (conflicts.length && !migrate) throw userError(identityConflictError(normalized.provider), 409);
  for (const conflict of conflicts) {
    await removeUserPrivateIdentities(conflict.id, (item) => identityConflicts(item, normalized), env);
    await appendEvent({
      type: "user_identity_migrated",
      provider: normalized.provider,
      fromUserId: conflict.id,
      toUserId: user.id,
      actorUserId,
    }, env).catch(() => {});
  }
  await removeUserPrivateIdentities(user.id, (item) => identityConflicts(item, normalized), env);
  await addUserPrivateIdentity(user.id, normalized, env);
  await appendEvent({
    type: "user_identity_linked",
    userId: user.id,
    provider: normalized.provider,
    accountId: normalized.accountId || null,
    externalId: normalized.externalId || null,
    chatId: normalized.chatId || null,
    source: normalized.source || "manual",
    actorUserId,
  }, env).catch(() => {});
  return readUserPrivateIdentities(user.id, env);
}

export async function unlinkUserPrivateIdentity(userId, identity = {}, { env = process.env, actorUserId = "system" } = {}) {
  const user = await getUser(userId, env);
  if (!user) throw userError("user_not_found", 404);
  const normalized = normalizeIdentity(identity);
  const removed = await removeUserPrivateIdentities(user.id, (item) => identityConflicts(item, normalized), env);
  if (!removed.length) throw userError("user_identity_not_found", 404);
  await appendEvent({
    type: "user_identity_unlinked",
    userId: user.id,
    provider: normalized.provider,
    accountId: normalized.accountId || null,
    externalId: normalized.externalId || null,
    chatId: normalized.chatId || null,
    actorUserId,
  }, env).catch(() => {});
  return readUserPrivateIdentities(user.id, env);
}

async function addUserPrivateIdentity(userId, identity = {}, env = process.env) {
  const normalized = normalizeIdentity(identity);
  const paths = userDataPaths(userId, env);
  await ensureDataDirs(env);
  const identities = await readUserPrivateIdentities(userId, env);
  let replaced = false;
  const next = identities.map((item) => {
    const matches = item.provider === normalized.provider &&
      item.accountId === normalized.accountId &&
      item.externalId === normalized.externalId &&
      item.chatId === normalized.chatId;
    if (!matches) return item;
    replaced = true;
    return { ...item, ...normalized, source: normalized.source || item.source, linkedAt: item.linkedAt || normalized.linkedAt };
  });
  if (!replaced) next.push(normalized);
  await writeJson(paths.identities, next);
  return next;
}

async function removeUserPrivateIdentities(userId, predicate, env = process.env) {
  const paths = userDataPaths(userId, env);
  await ensureDataDirs(env);
  const identities = await readUserPrivateIdentities(userId, env);
  const removed = identities.filter(predicate);
  if (!removed.length) return [];
  await writeJson(paths.identities, identities.filter((identity) => !predicate(identity)));
  return removed;
}

function identityAccountCompatible(identity = {}, accountId = "") {
  return !accountId || !identity.accountId || identity.accountId === accountId;
}

function identityRouteMatches(identity = {}, route = {}) {
  const externalId = String(route.externalId || "").trim();
  const chatId = String(route.chatId || "").trim();
  return Boolean((externalId && identity.externalId === externalId) || (chatId && identity.chatId === chatId));
}

function identityConflicts(left = {}, right = {}) {
  if (left.provider !== right.provider) return false;
  if (left.accountId && right.accountId && left.accountId !== right.accountId) return false;
  return Boolean((left.externalId && right.externalId && left.externalId === right.externalId) || (left.chatId && right.chatId && left.chatId === right.chatId));
}

function identityConflictError(provider = "") {
  const normalizedProvider = String(provider || "").trim().toLowerCase();
  return `${normalizedProvider || "external"}_identity_already_assigned`;
}
