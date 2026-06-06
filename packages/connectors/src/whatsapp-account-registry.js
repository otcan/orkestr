import { randomUUID } from "node:crypto";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { readJson, writeJson } from "../../storage/src/store.js";
import { adminUserId, normalizeUserId } from "../../core/src/users.js";

function clean(value) {
  return String(value || "").trim();
}

function nowIso() {
  return new Date().toISOString();
}

function accountIdFromInput(input = {}) {
  return clean(input.accountId || input.id || input.runtimeAccountId) || `wa-${randomUUID().slice(0, 8)}`;
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
  const accountId = accountIdFromInput({ ...prior, ...input });
  const createdAt = clean(prior?.createdAt) || nowIso();
  const displayName = clean(input.displayName || input.label || input.name || prior?.displayName || prior?.label || accountId);
  return {
    id: accountId,
    accountId,
    connector: "whatsapp",
    kind: "connector_account",
    ownerUserId: defaultOwnerUserId(input.ownerUserId || input.userId ? input : prior || input, env),
    displayName,
    label: clean(input.label || input.displayName || prior?.label || displayName),
    runtimeAccountId: clean(input.runtimeAccountId || prior?.runtimeAccountId || accountId),
    sessionRef: clean(input.sessionRef || prior?.sessionRef) || `whatsapp:${accountId}`,
    autostart: input.autostart === undefined ? Boolean(prior?.autostart) : input.autostart === true,
    capabilities: normalizeCapabilities(input.capabilities || prior?.capabilities),
    status: clean(input.status || prior?.status || "configured"),
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

export async function readWhatsAppConnectorAccounts(env = process.env) {
  const state = await readWhatsAppState(env);
  return activeAccounts(state);
}

export async function upsertWhatsAppConnectorAccount(input = {}, env = process.env) {
  const accountId = accountIdFromInput(input);
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
