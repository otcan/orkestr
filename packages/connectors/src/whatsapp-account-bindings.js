import { defaultWhatsAppReplyPrefix } from "../../core/src/whatsapp-defaults.js";
import { resourceOwnerUserId } from "../../core/src/policy.js";
import { getThread, listThreads, updateThread } from "../../core/src/threads.js";
import { adminUserId, normalizeUserId } from "../../core/src/users.js";
import { bindingAccountIds, whatsappBindingIsRouteEligible } from "./whatsapp-inbound-routing.js";
import { readWhatsAppConnectorAccounts } from "./whatsapp-account-registry.js";
import { localWhatsAppAccountIdsForEnv, localWhatsAppBridgeBasePath } from "./whatsapp-local-bridge.js";
import {
  assertWhatsAppBridgeTokenContext,
  bindingAcl as normalizedBindingAcl,
  whatsappAclDeniedError,
  whatsappBindingAclAllows,
} from "./whatsapp-binding-acl.js";
import {
  normalizeWhatsAppBindingLevel,
  readWhatsAppBindingRecords,
  retireWhatsAppBindingRecord,
  updateWhatsAppBindingRecord,
  upsertWhatsAppBindingRecord,
  whatsappBindingLevelRank,
  whatsappBindingPrecedence,
} from "./whatsapp-binding-registry.js";

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

function truthyAutostart(value = "") {
  const raw = pickString(value).toLowerCase();
  return Boolean(raw && !["0", "false", "no", "off"].includes(raw));
}

function autostartAccountIdsForEnv(env = process.env) {
  const explicit = splitList(env.ORKESTR_WHATSAPP_AUTOSTART_ACCOUNT_IDS || env.WHATSAPP_LOCAL_AUTOSTART_ACCOUNT_IDS);
  if (explicit.length) return explicit;
  return truthyAutostart(env.ORKESTR_WHATSAPP_AUTOSTART || env.WHATSAPP_LOCAL_AUTOSTART)
    ? localWhatsAppAccountIdsForEnv(env)
    : [];
}

function accountAutostart(accountId = "", account = {}, env = process.env) {
  if (account.autostart === true) return true;
  const selected = autostartAccountIdsForEnv(env).map((item) => item.toLowerCase());
  return selected.includes(pickString(accountId).toLowerCase());
}

function configuredAccountIds(status = {}, env = process.env, registryAccounts = []) {
  const fromStatus = Array.isArray(status.accounts)
    ? status.accounts.map((account) => pickString(account.accountId, account.id))
    : [];
  const fromRegistry = Array.isArray(registryAccounts)
    ? registryAccounts.map((account) => pickString(account.accountId, account.id))
    : [];
  const fromEnv = splitList(env.ORKESTR_WHATSAPP_ACCOUNT_IDS || env.WHATSAPP_LOCAL_ACCOUNT_IDS);
  const localMode = pickString(status.mode) === "local" ||
    pickString(status.bridgeUrl) === localWhatsAppBridgeBasePath ||
    (!pickString(status.mode) && !pickString(status.bridgeUrl));
  const localDefaults = localMode ? localWhatsAppAccountIdsForEnv(env) : [];
  return unique([...fromStatus, ...fromRegistry, ...fromEnv, ...localDefaults]);
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

function accountReadiness(account = {}, status = {}, { runtimeConfigured = true } = {}) {
  if (!runtimeConfigured) {
    return {
      state: "not_configured",
      paired: false,
      authenticated: false,
      started: false,
      ready: false,
      commsReady: false,
      sendReady: false,
      inboundReady: false,
      qrAvailable: false,
      qrRequired: false,
      nextAction: "configure_runtime_account",
    };
  }
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
      : state === "pairing_code"
        ? "enter_pairing_code"
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
  const runtimeConfigured = account.runtimeConfigured !== false;
  const readiness = accountReadiness(account, status, { runtimeConfigured });
  return {
    id,
    accountId: id,
    connector: "whatsapp",
    kind: "connector_account",
    neutral: true,
    ownerUserId: normalizeUserId(account.ownerUserId || ownerUserIdForAccount(env)),
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
    pairingCode: pickString(account.pairingCode),
    pairingCodeUpdatedAt: pickString(account.pairingCodeUpdatedAt) || null,
    pairingPhoneNumber: pickString(account.pairingPhoneNumber),
    loadingPercent: account.loadingPercent ?? null,
    loadingMessage: pickString(account.loadingMessage),
    error: pickString(account.error),
    updatedAt: pickString(account.updatedAt) || null,
    capabilities: Array.isArray(account.capabilities) && account.capabilities.length ? account.capabilities : ["status", "send", "receive", "pair"],
    sessionRef: pickString(account.sessionRef) || (id ? `whatsapp:${id}` : ""),
    runtimeAccountId: pickString(account.runtimeAccountId, id),
    autostart: accountAutostart(id, account, env),
    createdAt: pickString(account.createdAt) || null,
    legacyRoleAliases: aliases,
    compatibilityOnly: aliases.length > 0,
    runtimeConfigured,
    nextAction: readiness.nextAction,
  };
}

export function listWhatsAppConnectorAccounts({ status = {}, env = process.env, registryAccounts = [] } = {}) {
  const accountById = statusAccountMap(status);
  const registryById = new Map((Array.isArray(registryAccounts) ? registryAccounts : [])
    .map((account) => [pickString(account.accountId, account.id), account])
    .filter(([accountId]) => accountId));
  const runtimeIds = new Set(configuredAccountIds(status, env));
  return configuredAccountIds(status, env, registryAccounts).map((accountId) => {
    const account = {
      ...(registryById.get(accountId) || {}),
      ...(accountById.get(accountId) || {}),
      accountId,
      runtimeConfigured: runtimeIds.has(accountId),
    };
    return normalizeWhatsAppConnectorAccount(accountId, account, { status, env });
  });
}

export async function listPersistentWhatsAppConnectorAccounts({ status = {}, env = process.env } = {}) {
  const registryAccounts = await readWhatsAppConnectorAccounts(env);
  return listWhatsAppConnectorAccounts({ status, env, registryAccounts });
}

function responderAccountIdForBinding(binding = {}) {
  return pickString(binding.responderConnectorAccountId, binding.responderAccountId, binding.outboundAccountId);
}

function bindingIdForThread(thread = {}, binding = {}) {
  return pickString(binding.id, binding.bindingId) || (thread.id ? `thread:${thread.id}:whatsapp` : "");
}

function bindingIdForRecord(binding = {}, thread = null) {
  if (thread) return bindingIdForThread(thread, binding);
  const id = pickString(binding.id, binding.bindingId);
  if (id) return id;
  const level = normalizeWhatsAppBindingLevel(binding.level, binding);
  const target = level === "chat"
    ? pickString(binding.chatId)
    : level === "thread"
      ? pickString(binding.threadId)
      : level === "instance"
        ? pickString(binding.instanceId)
        : level === "user"
          ? pickString(binding.ownerUserId, binding.userId)
          : pickString(binding.targetAccountId, binding.accountId, responderAccountIdForBinding(binding));
  return target ? `${level}:${target}:whatsapp` : "";
}

function bindingAcl(binding = {}) {
  return normalizedBindingAcl(binding);
}

function bindingDiagnostic({ binding = {}, responderAccount = null, routeEligible = false } = {}) {
  const level = normalizeWhatsAppBindingLevel(binding.level, binding);
  if ((level === "chat" || level === "thread") && !binding.chatId) return { state: "broken", reason: "binding_missing_chat", nextAction: "create_binding" };
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

function optionalBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function normalizeSendAcl(value, fallback = null) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const mode = pickString(value.mode, fallback?.mode, "owner-only");
    return {
      mode,
      users: Array.isArray(value.users) ? unique(value.users) : Array.isArray(fallback?.users) ? unique(fallback.users) : [],
    };
  }
  const text = pickString(value);
  if (text) return { mode: text, users: [] };
  if (fallback) return {
    mode: pickString(fallback.mode, "owner-only"),
    users: Array.isArray(fallback.users) ? unique(fallback.users) : [],
  };
  return { mode: "owner-only", users: [] };
}

function normalizeBindingAcl(input = {}, current = {}) {
  const currentAcl = bindingAcl(current);
  return {
    send: normalizeSendAcl(input.acl?.send || input.sendAcl, currentAcl.send),
    read: { mode: pickString(input.acl?.read?.mode, currentAcl.read?.mode, "owner-only") },
    receive: { mode: pickString(input.acl?.receive?.mode, currentAcl.receive?.mode, "thread") },
    manage: { mode: pickString(input.acl?.manage?.mode, currentAcl.manage?.mode, "owner-only") },
  };
}

function normalizeBindingPatch(thread = {}, input = {}) {
  const current = thread?.binding && typeof thread.binding === "object" ? thread.binding : {};
  const responderAccountId = pickString(
    input.responderConnectorAccountId,
    input.responderAccountId,
    input.outboundAccountId,
    input.accountId,
    current.responderConnectorAccountId,
    current.responderAccountId,
    current.outboundAccountId,
  );
  const displayName = pickString(input.displayName, input.name, current.displayName, thread.bindingName, thread.name, thread.id);
  const replyPrefix = pickString(input.replyPrefix, current.replyPrefix, defaultWhatsAppReplyPrefix());
  const chatId = pickString(input.chatId, input.chat, current.chatId);
  if (!chatId) {
    const error = new Error("wa_binding_chat_required");
    error.statusCode = 400;
    throw error;
  }
  if (!responderAccountId) {
    const error = new Error("wa_responder_account_required");
    error.statusCode = 400;
    throw error;
  }
  return {
    ...current,
    connector: "whatsapp",
    id: pickString(current.id) || (thread.id ? `thread:${thread.id}:whatsapp` : ""),
    level: normalizeWhatsAppBindingLevel(pickString(input.level, current.level, "thread"), { ...current, ...input, threadId: thread.id }),
    chatId,
    displayName,
    enabled: optionalBoolean(input.enabled, current.enabled !== false),
    routeEligible: optionalBoolean(input.routeEligible, current.routeEligible !== false),
    responderConnectorAccountId: responderAccountId,
    responderAccountId,
    outboundAccountId: responderAccountId,
    mirrorToWhatsApp: optionalBoolean(input.mirrorToWhatsApp, current.mirrorToWhatsApp !== false),
    replyPrefix,
    acl: normalizeBindingAcl(input, current),
    updatedAt: new Date().toISOString(),
  };
}

export async function upsertWhatsAppThreadBinding(input = {}, env = process.env) {
  const level = normalizeWhatsAppBindingLevel(input.level, input);
  if (level !== "thread") {
    const binding = await upsertWhatsAppBindingRecord(input, env);
    return { ok: true, thread: null, binding: normalizeWhatsAppBinding(binding, { accounts: [], env, source: "registry" }) };
  }
  const threadId = pickString(input.threadId, input.thread, input.target);
  if (!threadId) {
    const error = new Error("thread_id_required");
    error.statusCode = 400;
    throw error;
  }
  const thread = await getThread(threadId, env);
  if (!thread) {
    const error = new Error("thread_not_found");
    error.statusCode = 404;
    throw error;
  }
  const binding = normalizeBindingPatch(thread, input);
  const updated = await updateThread(thread.id, {
    binding,
    bindingName: binding.displayName,
  }, env);
  return { ok: true, thread: updated, binding: normalizeWhatsAppBinding(updated, { accounts: [], env }) };
}

export async function upsertWhatsAppBinding(input = {}, env = process.env) {
  return upsertWhatsAppThreadBinding(input, env);
}

export async function updateWhatsAppThreadBinding(bindingId, input = {}, env = process.env) {
  const existing = await getWhatsAppBindingStatus(bindingId, { env });
  if (existing.binding.source === "registry" || !existing.binding.threadId) {
    const binding = await updateWhatsAppBindingRecord(existing.binding.id, input, env);
    return { ok: true, thread: null, binding: normalizeWhatsAppBinding(binding, { accounts: [], env, source: "registry" }) };
  }
  return upsertWhatsAppThreadBinding({
    ...input,
    threadId: existing.binding.threadId,
  }, env);
}

export async function retireWhatsAppThreadBinding(bindingId, env = process.env) {
  const existing = await getWhatsAppBindingStatus(bindingId, { env });
  if (existing.binding.source === "registry" || !existing.binding.threadId) {
    const binding = await retireWhatsAppBindingRecord(existing.binding.id, env);
    return { ok: true, thread: null, binding: normalizeWhatsAppBinding(binding, { accounts: [], env, source: "registry" }) };
  }
  const thread = await getThread(existing.binding.threadId, env);
  if (!thread) {
    const error = new Error("thread_not_found");
    error.statusCode = 404;
    throw error;
  }
  const binding = {
    ...(thread.binding || {}),
    enabled: false,
    routeEligible: false,
    retired: true,
    retiredAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const updated = await updateThread(thread.id, {
    binding,
    bindingName: pickString(binding.displayName, thread.bindingName, thread.name),
  }, env);
  return { ok: true, thread: updated, binding: normalizeWhatsAppBinding(updated, { accounts: [], env }) };
}

export function normalizeWhatsAppBinding(input = {}, { accounts = [], env = process.env, thread = null, source = "" } = {}) {
  const evaluatedAt = new Date().toISOString();
  const sourceThread = input?.binding && typeof input.binding === "object" ? input : thread;
  const binding = sourceThread ? sourceThread.binding || {} : input;
  const level = normalizeWhatsAppBindingLevel(binding.level, {
    ...binding,
    threadId: pickString(binding.threadId, sourceThread?.id),
  });
  const responderAccountId = responderAccountIdForBinding(binding);
  const accountById = new Map(accounts.map((account) => [account.accountId, account]));
  const responderAccount = responderAccountId ? accountById.get(responderAccountId) || null : null;
  const routeEligible = whatsappBindingIsRouteEligible(binding);
  const diagnostic = bindingDiagnostic({ binding, responderAccount, routeEligible });
  const ownerUserId = normalizeUserId(binding.ownerUserId || binding.userId || (sourceThread ? resourceOwnerUserId(sourceThread, env) : env.ORKESTR_ADMIN_USER_ID || adminUserId));
  const threadId = pickString(binding.threadId, sourceThread?.id);
  const threadName = pickString(sourceThread?.name, sourceThread?.title, sourceThread?.bindingName, binding.threadName);
  const bindingId = bindingIdForRecord(binding, sourceThread);
  const legacySenderAccountId = pickString(binding.senderAccountId, binding.inboundAccountId);
  const legacyResponderAccountId = pickString(binding.responderAccountId);
  const legacyOutboundAccountId = pickString(binding.outboundAccountId);
  const reliesOnLegacyResponder = !pickString(binding.responderConnectorAccountId) && Boolean(legacyResponderAccountId || legacyOutboundAccountId);
  const reliesOnSeparateLegacySender = Boolean(legacySenderAccountId && legacySenderAccountId !== responderAccountId);
  return {
    id: bindingId,
    bindingId,
    connector: "whatsapp",
    level,
    source: source || (sourceThread ? "thread" : "registry"),
    enabled: binding.enabled !== false,
    routeEligible,
    state: diagnostic.state,
    reason: diagnostic.reason,
    nextAction: diagnostic.nextAction,
    ownerUserId,
    userId: pickString(binding.userId) || (level === "user" ? ownerUserId : ""),
    instanceId: pickString(binding.instanceId),
    targetAccountId: pickString(binding.targetAccountId, binding.accountId),
    threadId,
    threadName,
    chatId: pickString(binding.chatId),
    displayName: pickString(binding.displayName, sourceThread?.bindingName, sourceThread?.name),
    responderAccountId,
    responderConnectorAccountId: responderAccountId || null,
    accountIds: unique([...bindingAccountIds(binding), pickString(binding.targetAccountId, binding.accountId), responderAccountId]),
    legacyFields: {
      senderAccountId: legacySenderAccountId || null,
      responderAccountId: legacyResponderAccountId || null,
      outboundAccountId: legacyOutboundAccountId || null,
    },
    compatibilityOnly: Boolean(reliesOnLegacyResponder || reliesOnSeparateLegacySender),
    acl: bindingAcl(binding),
    mirrorToWhatsApp: binding.mirrorToWhatsApp !== false,
    replyPrefix: pickString(binding.replyPrefix),
    updatedAt: pickString(binding.updatedAt) || null,
    lastEvaluationAt: evaluatedAt,
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
  const accounts = await listPersistentWhatsAppConnectorAccounts({ status, env });
  const sourceThreads = Array.isArray(threads) ? threads : await listThreads(env);
  const [registryBindings] = await Promise.all([
    readWhatsAppBindingRecords(env),
  ]);
  const bindings = [
    ...registryBindings.map((binding) => normalizeWhatsAppBinding(binding, { accounts, env, source: "registry" })),
    ...whatsappThreads(sourceThreads).map((thread) => normalizeWhatsAppBinding(thread, { accounts, env, source: "thread" })),
  ].sort(compareWhatsAppBindings);
  return {
    accounts,
    bindings,
    precedence: whatsappBindingPrecedence,
    implementedLevels: whatsappBindingPrecedence,
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

function compareWhatsAppBindings(left = {}, right = {}) {
  const rank = whatsappBindingLevelRank(left.level) - whatsappBindingLevelRank(right.level);
  if (rank !== 0) return rank;
  return pickString(left.id).localeCompare(pickString(right.id));
}

function sameKey(value = "", wanted = "") {
  if (!wanted) return true;
  return pickString(value).toLowerCase() === pickString(wanted).toLowerCase();
}

function bindingMatchesAccount(binding = {}, accountKey = "") {
  if (!accountKey) return true;
  return (Array.isArray(binding.accountIds) ? binding.accountIds : []).some((accountId) => sameKey(accountId, accountKey));
}

function bindingMatchesContext(binding = {}, context = {}) {
  const level = normalizeWhatsAppBindingLevel(binding.level, binding);
  const { threadKey, chatKey, accountKey, instanceKey, userKey } = context;
  if (!bindingMatchesAccount(binding, accountKey)) return false;
  if (level === "chat") {
    if (!chatKey || !sameKey(binding.chatId, chatKey)) return false;
    if (threadKey && binding.threadId && !sameKey(binding.threadId, threadKey) && !sameKey(binding.threadName, threadKey)) return false;
    return true;
  }
  if (level === "thread") {
    if (!threadKey && !chatKey) return false;
    if (threadKey && !sameKey(binding.threadId, threadKey) && !sameKey(binding.threadName, threadKey)) return false;
    if (chatKey && binding.chatId && !sameKey(binding.chatId, chatKey)) return false;
    return true;
  }
  if (level === "instance") {
    if (!instanceKey || !sameKey(binding.instanceId, instanceKey)) return false;
    if (chatKey && binding.chatId && !sameKey(binding.chatId, chatKey)) return false;
    return true;
  }
  if (level === "user") {
    if (!userKey || (!sameKey(binding.ownerUserId, userKey) && !sameKey(binding.userId, userKey))) return false;
    if (chatKey && binding.chatId && !sameKey(binding.chatId, chatKey)) return false;
    return true;
  }
  if (level === "account-default") {
    if (accountKey) return bindingMatchesAccount(binding, accountKey);
    return !threadKey && !chatKey && !instanceKey && !userKey;
  }
  return false;
}

export async function resolveWhatsAppBinding({ thread = "", chatId = "", accountId = "", instanceId = "", userId = "", ownerUserId = "" } = {}, options = {}) {
  const threadKey = pickString(thread);
  const chatKey = pickString(chatId);
  const accountKey = pickString(accountId);
  const instanceKey = pickString(instanceId);
  const userKey = normalizeUserId(userId || ownerUserId || "");
  const payload = await listWhatsAppBindingStatuses(options);
  const candidates = payload.bindings
    .filter((binding) => bindingMatchesContext(binding, { threadKey, chatKey, accountKey, instanceKey, userKey }))
    .sort(compareWhatsAppBindings);
  const eligible = candidates.filter((binding) => binding.routeEligible && binding.enabled);
  if (!candidates.length) {
    return {
      ok: false,
      error: "wa_binding_missing",
      reason: "No WhatsApp binding matched the requested thread/chat/account.",
      recommendation: "Create a thread or chat binding, or provide a narrower selector that matches an existing binding.",
      selected: null,
      candidates: [],
      diagnostics: {
        decision: "missing",
        requested: { thread: threadKey, chatId: chatKey, accountId: accountKey, instanceId: instanceKey, userId: userKey },
      },
      precedence: payload.precedence,
      implementedLevels: payload.implementedLevels,
    };
  }
  const bestRank = eligible.length ? whatsappBindingLevelRank(eligible[0].level) : whatsappBindingLevelRank(candidates[0].level);
  const bestCandidates = (eligible.length ? eligible : candidates)
    .filter((binding) => whatsappBindingLevelRank(binding.level) === bestRank);
  if (bestCandidates.length > 1) {
    return {
      ok: false,
      error: "wa_binding_ambiguous",
      reason: "Multiple WhatsApp bindings matched at the same precedence level. Create a narrower binding or retire the duplicate.",
      recommendation: "Retire one duplicate binding or create a narrower chat/thread binding above the ambiguous level.",
      selected: null,
      candidates,
      diagnostics: {
        decision: "ambiguous",
        ambiguousLevel: bestCandidates[0]?.level || "",
        ambiguousBindingIds: bestCandidates.map((binding) => binding.id),
        requested: { thread: threadKey, chatId: chatKey, accountId: accountKey, instanceId: instanceKey, userId: userKey },
      },
      precedence: payload.precedence,
      implementedLevels: payload.implementedLevels,
    };
  }
  const selected = bestCandidates[0];
  const shadowed = candidates.filter((binding) => binding.id !== selected.id);
  return {
    ok: selected.state === "ready",
    error: selected.state === "ready" ? "" : selected.reason,
    selected,
    candidates,
    shadowed,
    diagnostics: {
      decision: selected.state === "ready" ? "selected" : "selected_not_ready",
      reason: `${selected.level}_binding_won`,
      selectedLevel: selected.level,
      selectedBindingId: selected.id,
      shadowedBindingIds: shadowed.map((binding) => binding.id),
      requested: { thread: threadKey, chatId: chatKey, accountId: accountKey, instanceId: instanceKey, userId: userKey },
    },
    precedence: payload.precedence,
    implementedLevels: payload.implementedLevels,
  };
}

export async function assertWhatsAppBridgeBindingAcl(action = "send", selector = {}, context = null, env = process.env) {
  if (!context || Object.keys(context).length === 0) return null;
  const bindingKey = pickString(selector.bindingId, selector.id);
  const threadKey = pickString(selector.threadId, selector.thread);
  const chatKey = pickString(selector.chatId, selector.to);
  const accountKey = pickString(selector.accountId);
  if (!bindingKey && !threadKey && !chatKey) return null;
  const payload = await listWhatsAppBindingStatuses({ env });
  const selected = payload.bindings.find((binding) => {
    if (bindingKey && binding.bindingId !== bindingKey && binding.id !== bindingKey) return false;
    if (threadKey && binding.threadId !== threadKey && binding.threadName !== threadKey) return false;
    if (chatKey && binding.chatId !== chatKey) return false;
    if (accountKey && binding.accountIds.length && !binding.accountIds.includes(accountKey)) return false;
    return true;
  }) || null;
  if (!selected) throw whatsappAclDeniedError(action, { bindingId: bindingKey, threadId: threadKey, chatId: chatKey, accountId: accountKey }, context);
  assertWhatsAppBridgeTokenContext(action, {
    bindingId: bindingKey,
    threadId: threadKey,
    chatId: chatKey,
    accountId: accountKey,
  }, context, selected, { requireScopedSelector: true });
  if (!whatsappBindingAclAllows(selected, action, context)) throw whatsappAclDeniedError(action, selected, context);
  return selected;
}
