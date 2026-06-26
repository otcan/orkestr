import { randomUUID } from "node:crypto";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { readJson, writeJson } from "../../storage/src/store.js";
import { adminUserId, normalizeUserId } from "../../core/src/users.js";

export const whatsappBindingPrecedence = ["chat", "thread", "instance", "user", "account-default"];

function clean(value) {
  return String(value || "").trim();
}

function pickString(...values) {
  for (const value of values) {
    const text = clean(value);
    if (text) return text;
  }
  return "";
}

function nowIso() {
  return new Date().toISOString();
}

function optionalBoolean(value, fallback = true) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function unique(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = clean(value);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function listInput(value, fallback = []) {
  if (Array.isArray(value)) return unique(value);
  const split = String(value || "")
    .split(/[\s,]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
  if (split.length) return unique(split);
  return unique(fallback);
}

function normalizeLevelValue(value = "") {
  const text = clean(value).toLowerCase().replace(/_/g, "-");
  if (text === "account" || text === "default" || text === "account-default") return "account-default";
  if (whatsappBindingPrecedence.includes(text)) return text;
  return "";
}

export function normalizeWhatsAppBindingLevel(value = "", binding = {}) {
  const explicit = normalizeLevelValue(value || binding.level);
  if (explicit) return explicit;
  if (pickString(binding.chatId) && !pickString(binding.threadId)) return "chat";
  if (pickString(binding.threadId)) return "thread";
  if (pickString(binding.instanceId)) return "instance";
  if (pickString(binding.ownerUserId, binding.userId)) return "user";
  return "account-default";
}

export function whatsappBindingLevelRank(level = "") {
  const index = whatsappBindingPrecedence.indexOf(normalizeWhatsAppBindingLevel(level));
  return index >= 0 ? index : whatsappBindingPrecedence.length;
}

function responderAccountIdForInput(input = {}, prior = {}) {
  return pickString(
    input.responderConnectorAccountId,
    input.responderAccountId,
    input.outboundAccountId,
    input.accountId,
    prior.responderConnectorAccountId,
    prior.responderAccountId,
    prior.outboundAccountId,
    prior.accountId,
  );
}

function bindingTargetKey(level = "", binding = {}) {
  const normalized = normalizeWhatsAppBindingLevel(level, binding);
  if (normalized === "chat") return pickString(binding.chatId);
  if (normalized === "thread") return pickString(binding.threadId);
  if (normalized === "instance") return pickString(binding.instanceId);
  if (normalized === "user") return normalizeUserId(binding.ownerUserId || binding.userId || "");
  if (normalized === "account-default") return pickString(binding.targetAccountId, binding.accountId, binding.responderConnectorAccountId, binding.responderAccountId);
  return "";
}

function defaultBindingId(binding = {}) {
  const level = normalizeWhatsAppBindingLevel(binding.level, binding);
  const target = bindingTargetKey(level, binding);
  if (target) return `${level}:${target}:whatsapp`;
  return `whatsapp-binding-${randomUUID().slice(0, 8)}`;
}

function assertRequiredTarget(binding = {}) {
  const level = normalizeWhatsAppBindingLevel(binding.level, binding);
  const target = bindingTargetKey(level, binding);
  if (target) return;
  const error = new Error(`wa_${level.replace(/-/g, "_")}_binding_target_required`);
  error.statusCode = 400;
  throw error;
}

function normalizeBindingAcl(input = {}, prior = {}) {
  return {
    ...(prior.acl && typeof prior.acl === "object" && !Array.isArray(prior.acl) ? prior.acl : {}),
    ...(input.acl && typeof input.acl === "object" && !Array.isArray(input.acl) ? input.acl : {}),
  };
}

export function normalizeWhatsAppPersistentBinding(input = {}, prior = {}, env = process.env) {
  const level = normalizeWhatsAppBindingLevel(input.level || prior.level, { ...prior, ...input });
  const responderAccountId = responderAccountIdForInput(input, prior);
  if (!responderAccountId) {
    const error = new Error("wa_responder_account_required");
    error.statusCode = 400;
    throw error;
  }
  const ownerUserId = normalizeUserId(input.ownerUserId || input.userId || prior.ownerUserId || prior.userId || env.ORKESTR_ADMIN_USER_ID || adminUserId);
  const additionalParticipantsEnabled = optionalBoolean(input.additionalParticipantsEnabled, prior.additionalParticipantsEnabled === true);
  const binding = {
    ...prior,
    ...input,
    connector: "whatsapp",
    kind: "whatsapp_binding",
    level,
    ownerUserId,
    userId: level === "user" ? ownerUserId : pickString(input.userId, prior.userId) || undefined,
    instanceId: pickString(input.instanceId, prior.instanceId),
    threadId: pickString(input.threadId, prior.threadId),
    chatId: pickString(input.chatId, input.chat, prior.chatId),
    targetAccountId: pickString(input.targetAccountId, prior.targetAccountId, level === "account-default" ? input.accountId || prior.accountId || responderAccountId : ""),
    accountId: pickString(input.accountId, prior.accountId, level === "account-default" ? input.targetAccountId || prior.targetAccountId || responderAccountId : ""),
    responderConnectorAccountId: responderAccountId,
    responderAccountId,
    outboundAccountId: responderAccountId,
    senderContactId: pickString(input.senderContactId, prior.senderContactId),
    responderContactId: pickString(input.responderContactId, prior.responderContactId),
    ownerContactId: pickString(input.ownerContactId, prior.ownerContactId),
    ownerContactIds: listInput(input.ownerContactIds, prior.ownerContactIds || []),
    ownerContactAliases: listInput(input.ownerContactAliases, prior.ownerContactAliases || []),
    authorizedContactId: pickString(input.authorizedContactId, prior.authorizedContactId),
    authorizedContactIds: listInput(input.authorizedContactIds, prior.authorizedContactIds || []),
    authorizedContactAliases: listInput(input.authorizedContactAliases, prior.authorizedContactAliases || []),
    inboundSecurity: input.inboundSecurity && typeof input.inboundSecurity === "object" && !Array.isArray(input.inboundSecurity)
      ? input.inboundSecurity
      : prior.inboundSecurity && typeof prior.inboundSecurity === "object" && !Array.isArray(prior.inboundSecurity)
        ? prior.inboundSecurity
        : null,
    additionalParticipantsEnabled,
    additionalParticipantIds: additionalParticipantsEnabled ? listInput(input.additionalParticipantIds, prior.additionalParticipantIds || []) : [],
    additionalParticipantLabels: input.additionalParticipantLabels && typeof input.additionalParticipantLabels === "object" && !Array.isArray(input.additionalParticipantLabels)
      ? input.additionalParticipantLabels
      : prior.additionalParticipantLabels || {},
    enabled: optionalBoolean(input.enabled, prior.enabled !== false),
    routeEligible: optionalBoolean(input.routeEligible, prior.routeEligible !== false),
    mirrorToWhatsApp: optionalBoolean(input.mirrorToWhatsApp, prior.mirrorToWhatsApp !== false),
    suppressWhatsAppUpdates: optionalBoolean(input.suppressWhatsAppUpdates, prior.suppressWhatsAppUpdates === true),
    suppressWhatsAppDebugFooter: optionalBoolean(input.suppressWhatsAppDebugFooter, prior.suppressWhatsAppDebugFooter === true),
    displayName: pickString(input.displayName, input.name, prior.displayName, prior.name),
    acl: normalizeBindingAcl(input, prior),
    createdAt: pickString(prior.createdAt) || nowIso(),
    updatedAt: nowIso(),
  };
  assertRequiredTarget(binding);
  binding.id = pickString(input.id, input.bindingId, prior.id, prior.bindingId) || defaultBindingId(binding);
  binding.bindingId = binding.id;
  return binding;
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

function activeBindings(state = {}) {
  return (Array.isArray(state.bindings) ? state.bindings : [])
    .filter((binding) => binding && typeof binding === "object" && !binding.deletedAt);
}

export async function readWhatsAppBindingRecords(env = process.env) {
  const state = await readWhatsAppState(env);
  return activeBindings(state);
}

export async function upsertWhatsAppBindingRecord(input = {}, env = process.env) {
  const state = await readWhatsAppState(env);
  const bindings = Array.isArray(state.bindings) ? state.bindings : [];
  const draft = { ...input };
  const explicitId = pickString(draft.id, draft.bindingId);
  const candidate = explicitId
    ? bindings.find((binding) => pickString(binding.id, binding.bindingId) === explicitId)
    : null;
  const normalizedDraft = normalizeWhatsAppPersistentBinding(draft, candidate || {}, env);
  const id = normalizedDraft.id;
  const index = bindings.findIndex((binding) => pickString(binding.id, binding.bindingId) === id);
  const nextBindings = index >= 0
    ? bindings.map((binding, bindingIndex) => bindingIndex === index ? normalizedDraft : binding)
    : [...bindings, normalizedDraft];
  await writeWhatsAppState({
    ...state,
    bindings: nextBindings,
    updatedAt: nowIso(),
  }, env);
  return normalizedDraft;
}

export async function updateWhatsAppBindingRecord(bindingId, patch = {}, env = process.env) {
  const id = pickString(bindingId);
  const bindings = await readWhatsAppBindingRecords(env);
  const prior = bindings.find((binding) => pickString(binding.id, binding.bindingId) === id);
  if (!prior) {
    const error = new Error("wa_binding_missing");
    error.statusCode = 404;
    throw error;
  }
  return upsertWhatsAppBindingRecord({ ...prior, ...patch, id }, env);
}

export async function retireWhatsAppBindingRecord(bindingId, env = process.env) {
  const id = pickString(bindingId);
  const state = await readWhatsAppState(env);
  const bindings = Array.isArray(state.bindings) ? state.bindings : [];
  let retired = null;
  const nextBindings = bindings.map((binding) => {
    if (pickString(binding.id, binding.bindingId) !== id || binding.deletedAt) return binding;
    retired = {
      ...binding,
      enabled: false,
      routeEligible: false,
      retired: true,
      retiredAt: nowIso(),
      updatedAt: nowIso(),
    };
    return retired;
  });
  if (!retired) {
    const error = new Error("wa_binding_missing");
    error.statusCode = 404;
    throw error;
  }
  await writeWhatsAppState({
    ...state,
    bindings: nextBindings,
    updatedAt: nowIso(),
  }, env);
  return retired;
}
