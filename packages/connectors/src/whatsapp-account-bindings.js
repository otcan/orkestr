import { resourceOwnerUserId } from "../../core/src/policy.js";
import { listThreads } from "../../core/src/threads.js";
import { adminUserId, normalizeUserId } from "../../core/src/users.js";
import { bindingAccountIds, whatsappBindingIsRouteEligible } from "./whatsapp-inbound-routing.js";
import { localWhatsAppAccountIdsForEnv, localWhatsAppBridgeBasePath } from "./whatsapp-local-bridge.js";

function pickString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function splitList(value) {
  return String(value || "")
    .split(/[\s,]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function unique(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = pickString(value);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function ownerUserIdForAccount(env = process.env) {
  return normalizeUserId(env.ORKESTR_WHATSAPP_OWNER_USER_ID || env.ORKESTR_ADMIN_USER_ID || adminUserId);
}

function legacyRoleNames(env = process.env) {
  return {
    sender: pickString(env.ORKESTR_WHATSAPP_SENDER_ROLE, env.WHATSAPP_SENDER_ROLE, "sender"),
    responder: pickString(env.ORKESTR_WHATSAPP_RESPONDER_ROLE, env.WHATSAPP_RESPONDER_ROLE, "responder"),
  };
}

function legacyRoleAliases(accountId = "", env = process.env) {
  const roles = legacyRoleNames(env);
  return Object.entries(roles)
    .filter(([, value]) => value && value === accountId)
    .map(([role]) => role);
}

function configuredAccountIds(status = {}, env = process.env) {
  const fromStatus = Array.isArray(status.accounts)
    ? status.accounts.map((account) => pickString(account.accountId, account.id))
    : [];
  const fromEnv = splitList(env.ORKESTR_WHATSAPP_ACCOUNT_IDS || env.WHATSAPP_LOCAL_ACCOUNT_IDS);
  const localMode = pickString(status.mode) === "local" ||
    pickString(status.bridgeUrl) === localWhatsAppBridgeBasePath ||
    (!pickString(status.mode) && !pickString(status.bridgeUrl));
  const localDefaults = localMode ? localWhatsAppAccountIdsForEnv(env) : [];
  return unique([...fromStatus, ...fromEnv, ...localDefaults]);
}

function statusAccountMap(status = {}) {
  const entries = Array.isArray(status.accounts) ? status.accounts : [];
  return new Map(entries
    .map((account) => [pickString(account.accountId, account.id), account])
    .filter(([accountId]) => accountId));
}

function accountState(account = {}, status = {}) {
  const raw = pickString(account.state, account.status, account.ready ? "ready" : "");
  if (account.ready) return "ready";
  if (account.qrAvailable) return "qr_required";
  if (account.authenticated) return "authenticated";
  if (account.started && (!raw || raw === "idle")) return "connecting";
  if (raw) return raw;
  if (status.state === "paired") return "paired";
  if (status.state === "qr_needed") return "qr_required";
  return "inactive";
}

function accountReadiness(account = {}, status = {}) {
  const state = accountState(account, status);
  const authenticated = Boolean(account.authenticated || account.ready || state === "authenticated" || state === "ready" || state === "paired");
  const ready = Boolean(account.ready || state === "ready" || (status.state === "paired" && authenticated));
  const qrAvailable = Boolean(account.qrAvailable || state === "qr_required");
  return {
    state,
    paired: authenticated || ready,
    authenticated,
    started: Boolean(account.started || ready || authenticated),
    ready,
    commsReady: ready,
    sendReady: ready,
    inboundReady: ready,
    qrAvailable,
    qrRequired: qrAvailable || state === "qr_required",
    nextAction: ready
      ? "none"
      : qrAvailable || state === "qr_required"
        ? "pair_account"
        : authenticated
          ? "wait_for_whatsapp_web_ready"
          : "start_or_pair_account",
  };
}

export function normalizeWhatsAppConnectorAccount(accountId, account = {}, { status = {}, env = process.env } = {}) {
  const id = pickString(accountId, account.accountId, account.id);
  const aliases = legacyRoleAliases(id, env);
  const readiness = accountReadiness(account, status);
  return {
    id,
    accountId: id,
    connector: "whatsapp",
    kind: "connector_account",
    neutral: true,
    ownerUserId: ownerUserIdForAccount(env),
    displayName: pickString(account.displayName, account.label, account.name, id),
    label: pickString(account.label, account.displayName, account.name, id),
    state: readiness.state,
    ready: readiness.ready,
    authenticated: readiness.authenticated,
    paired: readiness.paired,
    started: readiness.started,
    commsReady: readiness.commsReady,
    sendReady: readiness.sendReady,
    inboundReady: readiness.inboundReady,
    qrAvailable: readiness.qrAvailable,
    qrRequired: readiness.qrRequired,
    qrUrl: pickString(account.qrUrl),
    pairingCodeUpdatedAt: pickString(account.pairingCodeUpdatedAt) || null,
    loadingPercent: account.loadingPercent ?? null,
    loadingMessage: pickString(account.loadingMessage),
    error: pickString(account.error),
    updatedAt: pickString(account.updatedAt) || null,
    capabilities: ["status", "send", "receive", "pair"],
    sessionRef: id ? `whatsapp:${id}` : "",
    legacyRoleAliases: aliases,
    compatibilityOnly: aliases.length > 0,
    nextAction: readiness.nextAction,
  };
}

export function listWhatsAppConnectorAccounts({ status = {}, env = process.env } = {}) {
  const accountById = statusAccountMap(status);
  return configuredAccountIds(status, env).map((accountId) =>
    normalizeWhatsAppConnectorAccount(accountId, accountById.get(accountId) || { accountId }, { status, env })
  );
}

function responderAccountIdForBinding(binding = {}) {
  return pickString(binding.responderConnectorAccountId, binding.responderAccountId, binding.outboundAccountId);
}

function bindingIdForThread(thread = {}, binding = {}) {
  return pickString(binding.id, binding.bindingId) || (thread.id ? `thread:${thread.id}:whatsapp` : "");
}

function bindingAcl(binding = {}) {
  const sendAcl = binding.sendAcl && typeof binding.sendAcl === "object" && !Array.isArray(binding.sendAcl)
    ? binding.sendAcl
    : null;
  const additional = Array.isArray(binding.additionalParticipantIds) ? binding.additionalParticipantIds.filter(Boolean) : [];
  const sendMode = sendAcl?.mode ||
    (binding.allowOtherPeople === true || binding.allowOtherPeopleConfirmed === true
      ? "all-users"
      : additional.length && binding.additionalParticipantsEnabled === true
        ? "users"
        : "owner-only");
  return {
    send: {
      mode: sendMode,
      users: sendMode === "users" ? additional : [],
    },
    read: { mode: "owner-only" },
    receive: { mode: "thread" },
    manage: { mode: "owner-only" },
  };
}

function bindingDiagnostic({ binding = {}, responderAccount = null, routeEligible = false } = {}) {
  if (!binding.chatId) return { state: "broken", reason: "binding_missing_chat", nextAction: "create_binding" };
  if (!routeEligible) return { state: "disabled", reason: "binding_not_route_eligible", nextAction: "enable_binding" };
  if (!responderAccount) return { state: "broken", reason: "responder_account_missing", nextAction: "choose_responder_account" };
  if (!responderAccount.ready) {
    return {
      state: "inactive",
      reason: "responder_account_inactive",
      nextAction: responderAccount.nextAction || "pair_or_reconnect_account",
    };
  }
  return { state: "ready", reason: "ready", nextAction: "none" };
}

export function normalizeWhatsAppBinding(thread = {}, { accounts = [], env = process.env } = {}) {
  const binding = thread?.binding && typeof thread.binding === "object" ? thread.binding : {};
  const responderAccountId = responderAccountIdForBinding(binding);
  const accountById = new Map(accounts.map((account) => [account.accountId, account]));
  const responderAccount = responderAccountId ? accountById.get(responderAccountId) || null : null;
  const routeEligible = whatsappBindingIsRouteEligible(binding);
  const diagnostic = bindingDiagnostic({ binding, responderAccount, routeEligible });
  const ownerUserId = resourceOwnerUserId(thread, env);
  return {
    id: bindingIdForThread(thread, binding),
    bindingId: bindingIdForThread(thread, binding),
    connector: "whatsapp",
    level: "thread",
    enabled: binding.enabled !== false,
    routeEligible,
    state: diagnostic.state,
    reason: diagnostic.reason,
    nextAction: diagnostic.nextAction,
    ownerUserId,
    threadId: pickString(thread.id),
    threadName: pickString(thread.name, thread.title, thread.bindingName),
    chatId: pickString(binding.chatId),
    displayName: pickString(binding.displayName, thread.bindingName, thread.name),
    responderAccountId,
    responderConnectorAccountId: responderAccountId || null,
    accountIds: [...bindingAccountIds(binding)],
    legacyFields: {
      senderAccountId: pickString(binding.senderAccountId, binding.inboundAccountId) || null,
      responderAccountId: pickString(binding.responderAccountId) || null,
      outboundAccountId: pickString(binding.outboundAccountId) || null,
    },
    compatibilityOnly: Boolean(binding.senderAccountId || binding.outboundAccountId),
    acl: bindingAcl(binding),
    mirrorToWhatsApp: binding.mirrorToWhatsApp !== false,
    replyPrefix: pickString(binding.replyPrefix),
    updatedAt: pickString(binding.updatedAt) || null,
    account: responderAccount,
  };
}

function whatsappThreads(threads = []) {
  return threads.filter((thread) => {
    const binding = thread?.binding || {};
    if (!binding || typeof binding !== "object") return false;
    return pickString(binding.chatId) || pickString(binding.connector).toLowerCase() === "whatsapp";
  });
}

export async function listWhatsAppBindingStatuses({ env = process.env, status = {}, threads = null } = {}) {
  const accounts = listWhatsAppConnectorAccounts({ status, env });
  const sourceThreads = Array.isArray(threads) ? threads : await listThreads(env);
  const bindings = whatsappThreads(sourceThreads).map((thread) => normalizeWhatsAppBinding(thread, { accounts, env }));
  return {
    accounts,
    bindings,
    precedence: ["chat", "thread", "instance", "user", "account-default"],
    implementedLevels: ["thread"],
    generatedAt: new Date().toISOString(),
  };
}

export async function getWhatsAppBindingStatus(bindingId, options = {}) {
  const id = pickString(bindingId);
  const payload = await listWhatsAppBindingStatuses(options);
  const binding = payload.bindings.find((item) => item.id === id || item.threadId === id || item.chatId === id);
  if (!binding) {
    const error = new Error("wa_binding_missing");
    error.statusCode = 404;
    throw error;
  }
  return { ...payload, binding };
}

export async function resolveWhatsAppBinding({ thread = "", chatId = "", accountId = "" } = {}, options = {}) {
  const threadKey = pickString(thread);
  const chatKey = pickString(chatId);
  const accountKey = pickString(accountId);
  const payload = await listWhatsAppBindingStatuses(options);
  const candidates = payload.bindings.filter((binding) => {
    if (threadKey && binding.threadId !== threadKey && binding.threadName !== threadKey) return false;
    if (chatKey && binding.chatId !== chatKey) return false;
    if (accountKey && binding.accountIds.length && !binding.accountIds.includes(accountKey)) return false;
    return true;
  });
  const eligible = candidates.filter((binding) => binding.routeEligible && binding.enabled);
  if (!candidates.length) {
    return {
      ok: false,
      error: "wa_binding_missing",
      reason: "No WhatsApp binding matched the requested thread/chat/account.",
      selected: null,
      candidates: [],
      precedence: payload.precedence,
      implementedLevels: payload.implementedLevels,
    };
  }
  if (!threadKey && eligible.length > 1) {
    return {
      ok: false,
      error: "wa_binding_ambiguous",
      reason: "Multiple WhatsApp bindings matched. Resolve with a thread id or create a narrower binding.",
      selected: null,
      candidates,
      precedence: payload.precedence,
      implementedLevels: payload.implementedLevels,
    };
  }
  const selected = eligible[0] || candidates[0];
  return {
    ok: selected.state === "ready",
    error: selected.state === "ready" ? "" : selected.reason,
    selected,
    candidates,
    precedence: payload.precedence,
    implementedLevels: payload.implementedLevels,
  };
}
