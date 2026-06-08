import { randomUUID } from "node:crypto";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { readJson, writeJson } from "../../storage/src/store.js";
import { assertOwnerAccess, canAccessOwner, isAdminPrincipal, policyError, resourceOwnerUserId } from "../../core/src/policy.js";
import { adminUserId, normalizeUserId } from "../../core/src/users.js";
import {
  canonicalWhatsAppAccountId,
  isWhatsAppPlaceholderAccountId,
  whatsappAccountPhoneIdentity,
  whatsappLegacyRoleNames,
} from "./whatsapp-account-identity.js";

function clean(value) {
  return String(value || "").trim();
}

function accountIdError(message = "wa_account_id_invalid", statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function validWhatsAppConnectorAccountId(value = "") {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(clean(value));
}

export function assertWhatsAppConnectorAccountId(value = "") {
  const accountId = clean(value);
  if (!validWhatsAppConnectorAccountId(accountId)) throw accountIdError("wa_account_id_invalid", 400);
  return accountId;
}

function nowIso() {
  return new Date().toISOString();
}

function accountIdFromInput(input = {}) {
  return assertWhatsAppConnectorAccountId(clean(input.accountId || input.id || input.runtimeAccountId) || `wa-${randomUUID().slice(0, 8)}`);
}

function isLegacyRoleAccountId(accountId = "", env = process.env) {
  return whatsappLegacyRoleNames(env).has(clean(accountId).toLowerCase());
}

function defaultOwnerUserId(input = {}, env = process.env) {
  return normalizeUserId(input.ownerUserId || input.userId || env.ORKESTR_ADMIN_USER_ID || adminUserId);
}

function normalizeCapabilities(value = []) {
  const source = Array.isArray(value) && value.length ? value : ["status", "send", "receive", "pair"];
  const seen = new Set();
  const result = [];
  for (const item of source) {
    const text = clean(item).toLowerCase();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function normalizeConnectorAccount(input = {}, prior = null, env = process.env) {
  const rawAccountId = accountIdFromInput({ ...prior, ...input });
  const phoneIdentity = whatsappAccountPhoneIdentity(input) || whatsappAccountPhoneIdentity(prior || {});
  const accountId = phoneIdentity && isWhatsAppPlaceholderAccountId(rawAccountId, env)
    ? assertWhatsAppConnectorAccountId(phoneIdentity)
    : rawAccountId;
  const createdAt = clean(prior?.createdAt) || nowIso();
  const displayName = clean(input.displayName || input.label || input.name || prior?.displayName || prior?.label || accountId);
  const legacyCompatibilityAlias = input.legacyCompatibilityAlias === true ||
    prior?.legacyCompatibilityAlias === true ||
    isLegacyRoleAccountId(rawAccountId, env) ||
    isLegacyRoleAccountId(clean(input.runtimeAccountId || prior?.runtimeAccountId), env);
  return {
    id: accountId,
    accountId,
    connector: "whatsapp",
    kind: "connector_account",
    ownerUserId: defaultOwnerUserId(input.ownerUserId || input.userId ? input : prior || input, env),
    displayName,
    label: clean(input.label || input.displayName || prior?.label || displayName),
    runtimeAccountId: clean(input.runtimeAccountId || prior?.runtimeAccountId || (accountId !== rawAccountId ? rawAccountId : accountId)),
    sessionRef: clean(input.sessionRef || prior?.sessionRef) || `whatsapp:${accountId}`,
    autostart: input.autostart === undefined ? Boolean(prior?.autostart) : input.autostart === true,
    capabilities: normalizeCapabilities(input.capabilities || prior?.capabilities),
    status: clean(input.status || prior?.status || "configured"),
    legacyCompatibilityAlias,
    createdAt,
    updatedAt: nowIso(),
  };
}

async function readWhatsAppState(env = process.env) {
  const paths = dataPaths(env);
  return readJson(paths.whatsapp, {});
}

async function writeWhatsAppState(state = {}, env = process.env) {
  const paths = await ensureDataDirs(env);
  await writeJson(paths.whatsapp, state);
  return state;
}

function activeAccounts(state = {}) {
  return (Array.isArray(state.connectorAccounts) ? state.connectorAccounts : [])
    .filter((account) => account && typeof account === "object" && !account.deletedAt);
}

function accountError(message, statusCode = 400) {
  return accountIdError(message, statusCode);
}

function accountOwnerUserId(account = {}, env = process.env) {
  return resourceOwnerUserId(account, env);
}

function requirePrincipalOwner(principal = {}) {
  const rawUserId = clean(principal.userId);
  if (!rawUserId) throw policyError("wa_account_owner_required", 403);
  const ownerUserId = normalizeUserId(rawUserId);
  if (!ownerUserId) throw policyError("wa_account_owner_required", 403);
  return ownerUserId;
}

function findAccount(accounts = [], accountId = "") {
  const id = clean(accountId);
  return accounts.find((account) => clean(account.accountId || account.id) === id && !account.deletedAt) || null;
}

export async function readWhatsAppConnectorAccounts(env = process.env) {
  const state = await readWhatsAppState(env);
  return activeAccounts(state);
}

export function listWhatsAppConnectorAccountsForPrincipal(accounts = [], principal = {}, env = process.env) {
  if (isAdminPrincipal(principal)) return accounts;
  return accounts.filter((account) => canAccessOwner(principal, accountOwnerUserId(account, env), env));
}

export function assertWhatsAppConnectorAccountAccess(account = {}, principal = {}, action = "wa_account_access", env = process.env) {
  assertOwnerAccess(principal, accountOwnerUserId(account, env), action, env);
  return true;
}

export async function upsertWhatsAppConnectorAccount(input = {}, env = process.env) {
  const rawAccountId = accountIdFromInput(input);
  const accountId = canonicalWhatsAppAccountId({ ...input, accountId: rawAccountId }, env) || rawAccountId;
  const state = await readWhatsAppState(env);
  const accounts = Array.isArray(state.connectorAccounts) ? state.connectorAccounts : [];
  const index = accounts.findIndex((account) => clean(account.accountId || account.id) === accountId);
  const prior = index >= 0 ? accounts[index] : null;
  const account = normalizeConnectorAccount({ ...input, accountId }, prior, env);
  const nextAccounts = index >= 0
    ? accounts.map((item, itemIndex) => itemIndex === index ? account : item)
    : [...accounts, account];
  await writeWhatsAppState({
    ...state,
    connectorAccounts: nextAccounts,
    updatedAt: nowIso(),
  }, env);
  return account;
}

export async function upsertWhatsAppConnectorAccountForPrincipal(input = {}, principal = {}, env = process.env) {
  const accountId = accountIdFromInput(input);
  const accounts = await readWhatsAppConnectorAccounts(env);
  const prior = findAccount(accounts, accountId);
  if (!prior && isLegacyRoleAccountId(accountId, env)) throw accountError("wa_account_legacy_role_id_reserved", 400);
  if (prior) assertWhatsAppConnectorAccountAccess(prior, principal, "wa_account_update", env);
  const ownerUserId = isAdminPrincipal(principal)
    ? defaultOwnerUserId(input, env)
    : requirePrincipalOwner(principal);
  return upsertWhatsAppConnectorAccount({ ...input, accountId, ownerUserId }, env);
}

export async function updateWhatsAppConnectorAccount(accountId, patch = {}, env = process.env) {
  const id = clean(accountId);
  const accounts = await readWhatsAppConnectorAccounts(env);
  const prior = accounts.find((account) => clean(account.accountId || account.id) === id);
  if (!prior) {
    const error = new Error("wa_account_missing");
    error.statusCode = 404;
    throw error;
  }
  return upsertWhatsAppConnectorAccount({ ...prior, ...patch, accountId: id }, env);
}

export async function updateWhatsAppConnectorAccountForPrincipal(accountId, patch = {}, principal = {}, env = process.env) {
  const id = clean(accountId);
  const accounts = await readWhatsAppConnectorAccounts(env);
  const prior = findAccount(accounts, id);
  if (!prior) throw accountError("wa_account_missing", 404);
  assertWhatsAppConnectorAccountAccess(prior, principal, "wa_account_update", env);
  const ownerUserId = isAdminPrincipal(principal) ? patch.ownerUserId || patch.userId || prior.ownerUserId : prior.ownerUserId;
  const safePatch = { ...patch, ownerUserId };
  delete safePatch.userId;
  return updateWhatsAppConnectorAccount(id, safePatch, env);
}

export async function deleteWhatsAppConnectorAccount(accountId, env = process.env) {
  const id = clean(accountId);
  const state = await readWhatsAppState(env);
  const accounts = Array.isArray(state.connectorAccounts) ? state.connectorAccounts : [];
  let deleted = null;
  const nextAccounts = accounts.map((account) => {
    if (clean(account.accountId || account.id) !== id || account.deletedAt) return account;
    deleted = {
      ...account,
      deletedAt: nowIso(),
      updatedAt: nowIso(),
    };
    return deleted;
  });
  if (!deleted) {
    const error = new Error("wa_account_missing");
    error.statusCode = 404;
    throw error;
  }
  await writeWhatsAppState({
    ...state,
    connectorAccounts: nextAccounts,
    updatedAt: nowIso(),
  }, env);
  return deleted;
}

export async function deleteWhatsAppConnectorAccountForPrincipal(accountId, principal = {}, env = process.env) {
  const id = clean(accountId);
  const accounts = await readWhatsAppConnectorAccounts(env);
  const prior = findAccount(accounts, id);
  if (!prior) throw accountError("wa_account_missing", 404);
  assertWhatsAppConnectorAccountAccess(prior, principal, "wa_account_delete", env);
  return deleteWhatsAppConnectorAccount(id, env);
}
