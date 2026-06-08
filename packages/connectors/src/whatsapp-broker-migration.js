import { adminUserId, normalizeUserId } from "../../core/src/users.js";
import { listThreads, updateThread } from "../../core/src/threads.js";
import { recordWatcherAlert } from "../../core/src/watcher-alerts.js";
import {
  ensureWhatsAppScopedTokens,
  publicWhatsAppScopedTokenRecord,
  readWhatsAppScopedTokenRecords,
} from "../../core/src/whatsapp-scoped-tokens.js";
import { bindingAccountIds } from "./whatsapp-inbound-routing.js";
import { localWhatsAppAccountIdsForEnv, localWhatsAppBridgeBasePath } from "./whatsapp-local-bridge.js";
import { normalizeWhatsAppBindingLevel } from "./whatsapp-binding-registry.js";
import { bindingAcl } from "./whatsapp-binding-acl.js";
import {
  readWhatsAppConnectorAccounts,
  upsertWhatsAppConnectorAccount,
} from "./whatsapp-account-registry.js";
import {
  canonicalWhatsAppAccountId,
  isWhatsAppPlaceholderAccountId,
} from "./whatsapp-account-identity.js";

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

function truthy(value = "") {
  const raw = pickString(value).toLowerCase();
  return Boolean(raw && !["0", "false", "no", "off"].includes(raw));
}

function nowIso() {
  return new Date().toISOString();
}

function ownerUserIdForEnv(env = process.env) {
  return normalizeUserId(env.ORKESTR_WHATSAPP_OWNER_USER_ID || env.ORKESTR_ADMIN_USER_ID || adminUserId);
}

function statusAccountMap(status = {}) {
  return new Map((Array.isArray(status.accounts) ? status.accounts : [])
    .map((account) => [canonicalWhatsAppAccountId(account) || pickString(account.accountId, account.id), account])
    .filter(([accountId]) => accountId));
}

function configuredAccountIds(status = {}, env = process.env, registryAccounts = [], threads = []) {
  const localMode = pickString(status.mode) === "local" ||
    pickString(status.bridgeUrl) === localWhatsAppBridgeBasePath ||
    (!pickString(status.mode) && !pickString(status.bridgeUrl));
  const fromStatus = Array.isArray(status.accounts)
    ? status.accounts.map((account) => pickString(account.accountId, account.id))
    : [];
  const fromRegistry = Array.isArray(registryAccounts)
    ? registryAccounts.map((account) => pickString(account.accountId, account.id))
    : [];
  const fromEnv = splitList(env.ORKESTR_WHATSAPP_ACCOUNT_IDS || env.WHATSAPP_LOCAL_ACCOUNT_IDS);
  const fromDefault = pickString(env.ORKESTR_WHATSAPP_DEFAULT_RESPONDER_ACCOUNT_ID || env.WHATSAPP_LOCAL_DEFAULT_ACCOUNT_ID);
  const fromThreads = [];
  for (const thread of threads) {
    const binding = thread?.binding && typeof thread.binding === "object" ? thread.binding : {};
    if (!isWhatsAppThread(thread)) continue;
    fromThreads.push(
      binding.responderConnectorAccountId,
      binding.responderAccountId,
      binding.outboundAccountId,
      binding.targetAccountId,
      binding.accountId,
      ...bindingAccountIds(binding),
    );
  }
  const localDefaults = localMode ? localWhatsAppAccountIdsForEnv(env) : [];
  return unique([...fromStatus, ...fromRegistry, ...fromEnv, fromDefault, ...fromThreads, ...localDefaults]);
}

function autostartAccountIds(env = process.env) {
  const explicit = splitList(env.ORKESTR_WHATSAPP_AUTOSTART_ACCOUNT_IDS || env.WHATSAPP_LOCAL_AUTOSTART_ACCOUNT_IDS);
  if (explicit.length) return explicit;
  return truthy(env.ORKESTR_WHATSAPP_AUTOSTART || env.WHATSAPP_LOCAL_AUTOSTART)
    ? localWhatsAppAccountIdsForEnv(env)
    : [];
}

function accountAutostart(accountId = "", current = {}, statusAccount = {}, env = process.env) {
  if (current.autostart === true || statusAccount.autostart === true) return true;
  const selected = autostartAccountIds(env).map((item) => item.toLowerCase());
  return selected.includes(pickString(accountId).toLowerCase());
}

function legacyRoleNames(env = process.env) {
  return {
    sender: pickString(env.ORKESTR_WHATSAPP_SENDER_ROLE, env.WHATSAPP_SENDER_ROLE, "sender"),
    responder: pickString(env.ORKESTR_WHATSAPP_RESPONDER_ROLE, env.WHATSAPP_RESPONDER_ROLE, "responder"),
  };
}

function legacyAliasesForAccount(accountId = "", env = process.env) {
  const roles = legacyRoleNames(env);
  return Object.entries(roles)
    .filter(([, value]) => value && value === accountId)
    .map(([role]) => role);
}

function accountDraft(accountId = "", current = {}, statusAccount = {}, env = process.env) {
  const rawAccountId = pickString(statusAccount.accountId, statusAccount.id, accountId);
  const canonicalAccountId = canonicalWhatsAppAccountId({ ...statusAccount, accountId: rawAccountId, id: rawAccountId }, env) || accountId;
  return {
    accountId: canonicalAccountId,
    displayName: pickString(current.displayName, current.label, statusAccount.displayName, statusAccount.label, statusAccount.phoneNumber, canonicalAccountId),
    label: pickString(current.label, current.displayName, statusAccount.label, statusAccount.displayName, statusAccount.phoneNumber, canonicalAccountId),
    ownerUserId: normalizeUserId(current.ownerUserId || statusAccount.ownerUserId || ownerUserIdForEnv(env)),
    runtimeAccountId: pickString(current.runtimeAccountId, statusAccount.runtimeAccountId, canonicalAccountId !== rawAccountId || isWhatsAppPlaceholderAccountId(rawAccountId, env) ? rawAccountId : "", canonicalAccountId),
    sessionRef: pickString(current.sessionRef, statusAccount.sessionRef) || `whatsapp:${canonicalAccountId}`,
    autostart: accountAutostart(canonicalAccountId, current, statusAccount, env),
  };
}

function accountNeedsUpdate(current = {}, draft = {}) {
  if (!current || !Object.keys(current).length) return true;
  return [
    "displayName",
    "label",
    "ownerUserId",
    "runtimeAccountId",
    "sessionRef",
    "autostart",
  ].some((key) => current[key] !== draft[key]);
}

function isWhatsAppThread(thread = {}) {
  const binding = thread?.binding && typeof thread.binding === "object" ? thread.binding : {};
  return pickString(binding.connector).toLowerCase() === "whatsapp" || Boolean(pickString(binding.chatId));
}

function canonicalBindingForThread(thread = {}, env = process.env) {
  if (!isWhatsAppThread(thread)) return null;
  const current = thread.binding && typeof thread.binding === "object" ? thread.binding : {};
  const responderAccountId = pickString(
    current.replyAccountId,
    current.bridgeAccountId,
    current.receivingAccountId,
    current.responderConnectorAccountId,
    current.responderAccountId,
    current.outboundAccountId,
    current.accountId,
    env.ORKESTR_WHATSAPP_DEFAULT_RESPONDER_ACCOUNT_ID,
  );
  if (!responderAccountId) return null;
  const id = pickString(current.id, current.bindingId) || (thread.id ? `thread:${thread.id}:whatsapp` : "");
  const next = {
    ...current,
    connector: "whatsapp",
    id,
    bindingId: id,
    level: normalizeWhatsAppBindingLevel(current.level || "thread", { ...current, threadId: thread.id }),
    responderConnectorAccountId: responderAccountId,
    responderAccountId,
    outboundAccountId: responderAccountId,
    replyAccountId: responderAccountId,
    bridgeAccountId: responderAccountId,
  };
  return next;
}

function changedBindingKeys(current = {}, next = {}) {
  const keys = [
    "connector",
    "id",
    "bindingId",
    "level",
    "responderConnectorAccountId",
    "responderAccountId",
    "outboundAccountId",
  ];
  return keys.filter((key) => current[key] !== next[key]);
}

function bindingResult(thread = {}, current = {}, next = {}, action = "unchanged", changedKeys = []) {
  const acl = next && Object.keys(next).length ? bindingAcl(next) : null;
  return {
    action,
    threadId: pickString(thread.id),
    threadName: pickString(thread.name, thread.bindingName, thread.title),
    bindingId: pickString(next.id, next.bindingId, current.id, current.bindingId),
    chatId: pickString(next.chatId, current.chatId),
    responderAccountId: pickString(next.responderConnectorAccountId, next.responderAccountId),
    changedKeys,
    ...(acl ? { acl } : {}),
    previousBinding: rollbackBinding(current),
    nextBinding: rollbackBinding(next),
  };
}

function rollbackBinding(binding = {}) {
  if (!binding || typeof binding !== "object" || !Object.keys(binding).length) return null;
  const keys = [
    "connector",
    "id",
    "bindingId",
    "level",
    "chatId",
    "displayName",
    "ownerUserId",
    "userId",
    "instanceId",
    "targetAccountId",
    "accountId",
    "senderAccountId",
    "responderConnectorAccountId",
    "responderAccountId",
    "outboundAccountId",
    "inboundAccountId",
    "enabled",
    "routeEligible",
    "mirrorToWhatsApp",
    "acl",
  ];
  return Object.fromEntries(keys
    .filter((key) => binding[key] !== undefined)
    .map((key) => [key, binding[key]]));
}

function rollbackPayload(accountResults = [], bindingResults = []) {
  return {
    safeRestore: true,
    instructions: [
      "Use the rollback.accounts records to delete newly-created connector accounts or restore previous neutral account metadata.",
      "Use the rollback.threadBindings records to restore previous binding objects with the thread update API.",
      "Restore scoped token environment variables or secret-store values from the operator backup; migration output never contains token values.",
      "Do not restore old role-naming code paths; keep neutral account ids and scoped binding fields in application code.",
    ],
    accounts: accountResults
      .filter((account) => account.action !== "unchanged")
      .map((account) => ({
        accountId: account.accountId,
        action: account.action === "create" ? "delete_created_account" : "restore_previous_account_metadata",
        previousAccount: account.previousAccount || null,
      })),
    threadBindings: bindingResults
      .filter((binding) => binding.action === "update")
      .map((binding) => ({
        threadId: binding.threadId,
        bindingId: binding.bindingId,
        previousBinding: binding.previousBinding,
      })),
  };
}

function parseJsonTokenRecords(value, defaults = {}) {
  const raw = pickString(value);
  if (!raw) return [];
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const entries = Array.isArray(parsed)
    ? parsed.map((entry, index) => [String(entry?.id || entry?.name || index), entry])
    : Object.entries(parsed || {});
  return entries.map(([key, entry]) => {
    const record = typeof entry === "string" ? { token: entry } : { ...(entry || {}) };
    if (!record.token && !record.value && !record.secret && !record.tokenHash && !record.hash) return null;
    return {
      id: pickString(record.id, record.tokenId, key),
      scopes: unique([...(Array.isArray(record.scopes) ? record.scopes : splitList(record.scopes || record.scope || record.capabilities)), ...(defaults.scopes || [])]),
      principalKind: pickString(record.principalKind, record.kind, defaults.principalKind, "external_instance"),
      principalId: pickString(record.principalId, record.userId, record.ownerUserId, record.instanceId, defaults.principalId),
      ownerUserId: normalizeUserId(record.ownerUserId || record.userId || defaults.ownerUserId || ""),
      instanceId: pickString(record.instanceId, record.instance, defaults.instanceId),
      accountId: pickString(record.accountId, defaults.accountId),
      bindingId: pickString(record.bindingId, defaults.bindingId),
      chatId: pickString(record.chatId, defaults.chatId),
      tokenConfigured: true,
      token: "[redacted]",
    };
  }).filter(Boolean);
}

async function configuredScopedTokenRecords(env = process.env) {
  return [
    ...parseJsonTokenRecords(env.ORKESTR_WHATSAPP_SCOPED_TOKENS_JSON),
    ...parseJsonTokenRecords(env.WHATSAPP_SCOPED_TOKENS_JSON),
    ...parseJsonTokenRecords(env.ORKESTR_WHATSAPP_INBOUND_SCOPED_TOKENS_JSON, { scopes: ["whatsapp:inbound"] }),
    ...parseJsonTokenRecords(env.WHATSAPP_INBOUND_SCOPED_TOKENS_JSON, { scopes: ["whatsapp:inbound"] }),
    ...parseJsonTokenRecords(env.ORKESTR_WHATSAPP_INBOUND_TOKEN_JSON, { scopes: ["whatsapp:inbound"] }),
    ...parseJsonTokenRecords(env.ORKESTR_WHATSAPP_BRIDGE_SCOPED_TOKENS_JSON, { scopes: ["whatsapp:bridge"] }),
    ...parseJsonTokenRecords(env.WHATSAPP_BRIDGE_SCOPED_TOKENS_JSON, { scopes: ["whatsapp:bridge"] }),
    ...parseJsonTokenRecords(env.ORKESTR_WHATSAPP_BRIDGE_TOKEN_JSON, { scopes: ["whatsapp:bridge"] }),
    ...(await readWhatsAppScopedTokenRecords(env)).map(publicWhatsAppScopedTokenRecord),
  ];
}

function tokenHasScope(record = {}, scope = "") {
  const scopes = Array.isArray(record.scopes) ? record.scopes.map((item) => pickString(item).toLowerCase()) : [];
  const required = pickString(scope).toLowerCase();
  return scopes.includes("*") ||
    scopes.includes("whatsapp:*") ||
    scopes.includes(required) ||
    (required.startsWith("whatsapp:bridge:") && scopes.includes("whatsapp:bridge"));
}

function tokenMatchesPlan(record = {}, plan = {}) {
  if (!tokenHasScope(record, plan.requiredScope)) return false;
  for (const key of ["accountId", "bindingId", "chatId"]) {
    const expected = pickString(plan[key]);
    const actual = pickString(record[key]);
    if (expected && actual && expected !== actual) return false;
  }
  return true;
}

function tokenPlansForBinding(binding = {}, env = process.env, configuredTokens = []) {
  if (!binding || !pickString(binding.bindingId, binding.id)) return [];
  const bindingId = pickString(binding.bindingId, binding.id);
  const accountId = pickString(binding.responderConnectorAccountId, binding.responderAccountId, binding.outboundAccountId);
  const chatId = pickString(binding.chatId);
  const base = {
    accountId,
    bindingId,
    chatId,
    token: "[redacted]",
    ownerUserId: normalizeUserId(binding.ownerUserId || binding.userId || env.ORKESTR_ADMIN_USER_ID || adminUserId),
  };
  const plans = [
    {
      ...base,
      tokenId: `wa-inbound-${bindingId}`,
      routeKind: "whatsapp_inbound",
      requiredScope: "whatsapp:inbound",
      scopes: ["whatsapp:inbound"],
      purpose: "receive inbound WhatsApp events for this binding",
    },
    {
      ...base,
      tokenId: `wa-bridge-send-${bindingId}`,
      routeKind: "whatsapp_bridge",
      requiredScope: "whatsapp:bridge:send",
      scopes: ["whatsapp:bridge:send"],
      purpose: "send WhatsApp replies for this binding",
    },
    {
      ...base,
      tokenId: `wa-bridge-read-${bindingId}`,
      routeKind: "whatsapp_bridge",
      requiredScope: "whatsapp:bridge:read",
      scopes: ["whatsapp:bridge:read"],
      purpose: "read WhatsApp status for this binding",
    },
  ];
  return plans.map((plan) => ({
    ...plan,
    tokenConfigured: configuredTokens.some((record) => tokenMatchesPlan(record, plan)),
  }));
}

function compatibilityWarnings(accountResults = [], bindingResults = [], env = process.env) {
  const warnings = [];
  for (const account of accountResults) {
    const aliases = legacyAliasesForAccount(account.accountId, env);
    if (!aliases.length) continue;
    warnings.push({
      severity: "warning",
      code: "whatsapp_legacy_account_alias_in_use",
      accountId: account.accountId,
      aliases,
      message: `WhatsApp account ${account.accountId} still depends on legacy alias ${aliases.join(", ")}.`,
    });
  }
  for (const binding of bindingResults) {
    const previous = binding.previousBinding || {};
    const next = binding.nextBinding || {};
    const legacyFields = ["senderAccountId", "responderAccountId", "outboundAccountId"]
      .filter((key) => pickString(previous[key]));
    if (!legacyFields.length) continue;
    warnings.push({
      severity: "warning",
      code: "whatsapp_legacy_binding_fields_in_use",
      threadId: binding.threadId,
      bindingId: binding.bindingId,
      fields: legacyFields,
      responderAccountId: pickString(next.responderConnectorAccountId, binding.responderAccountId),
      message: `WhatsApp binding ${binding.bindingId} still carries compatibility fields: ${legacyFields.join(", ")}.`,
    });
  }
  return warnings;
}

async function recordMigrationWarnings(warnings = [], env = process.env) {
  if (!warnings.length) return [];
  const aliases = unique(warnings.flatMap((warning) => warning.aliases || []));
  const result = await recordWatcherAlert({
    severity: "warning",
    source: "server.whatsappBrokerMigration",
    code: "whatsapp_legacy_alias_in_use",
    message: `${warnings.length} WhatsApp broker migration compatibility warnings remain.`,
    details: {
      warningCount: warnings.length,
      aliasCount: aliases.length,
      threadWarningCount: warnings.filter((warning) => warning.threadId).length,
      accountWarningCount: warnings.filter((warning) => warning.accountId).length,
    },
  }, env);
  return [result].filter(Boolean).map((item) => ({
    ok: item.ok === true,
    skipped: item.skipped === true,
    reason: pickString(item.reason),
    alertId: pickString(item.alert?.id),
    watcherThreadId: pickString(item.alert?.watcherThreadId),
    watcherMessageId: pickString(item.alert?.watcherMessageId),
  }));
}

export async function migrateWhatsAppBrokerConfig(options = {}, env = process.env) {
  const dryRun = options.dryRun === true;
  const status = options.status && typeof options.status === "object" ? options.status : {};
  const generatedAt = nowIso();
  const threads = Array.isArray(options.threads) ? options.threads : await listThreads(env);
  const configuredTokens = await configuredScopedTokenRecords(env);
  const registryAccounts = await readWhatsAppConnectorAccounts(env);
  const statusById = statusAccountMap(status);
  const registryById = new Map(registryAccounts
    .map((account) => [pickString(account.accountId, account.id), account])
    .filter(([accountId]) => accountId));

  const accountResults = [];
  for (const accountId of configuredAccountIds(status, env, registryAccounts, threads)) {
    const current = registryById.get(accountId) || {};
    const draft = accountDraft(accountId, current, statusById.get(accountId) || {}, env);
    const action = !registryById.has(accountId)
      ? "create"
      : accountNeedsUpdate(current, draft)
        ? "update"
        : "unchanged";
    if (!dryRun && action !== "unchanged") {
      const account = await upsertWhatsAppConnectorAccount(draft, env);
      registryById.set(accountId, account);
    }
    accountResults.push({
      action,
      accountId,
      displayName: draft.displayName,
      runtimeAccountId: draft.runtimeAccountId,
      sessionRef: draft.sessionRef,
      autostart: draft.autostart,
      legacyRoleAliases: legacyAliasesForAccount(accountId, env),
      previousAccount: Object.keys(current).length ? {
        accountId: pickString(current.accountId, current.id),
        displayName: pickString(current.displayName, current.label),
        ownerUserId: normalizeUserId(current.ownerUserId || ""),
        runtimeAccountId: pickString(current.runtimeAccountId),
        sessionRef: pickString(current.sessionRef),
        autostart: current.autostart === true,
      } : null,
    });
  }

  const bindingResults = [];
  const tokenPlans = [];
  for (const thread of threads) {
    if (!isWhatsAppThread(thread)) continue;
    const current = thread.binding && typeof thread.binding === "object" ? thread.binding : {};
    const next = canonicalBindingForThread(thread, env);
    if (!next) {
      bindingResults.push(bindingResult(thread, current, {}, "skipped", []));
      continue;
    }
    const changedKeys = changedBindingKeys(current, next);
    if (!changedKeys.length) {
      bindingResults.push(bindingResult(thread, current, next, "unchanged", []));
      continue;
    }
    if (!dryRun) {
      await updateThread(thread.id, {
        binding: {
          ...next,
          updatedAt: generatedAt,
        },
      }, env);
    }
    const result = bindingResult(thread, current, next, "update", changedKeys);
    bindingResults.push(result);
    tokenPlans.push(...tokenPlansForBinding(next, env, configuredTokens));
  }
  for (const binding of bindingResults) {
    if (binding.action !== "unchanged") continue;
    tokenPlans.push(...tokenPlansForBinding(binding.nextBinding, env, configuredTokens));
  }

  const counts = {
    accountsTotal: accountResults.length,
    accountsCreated: accountResults.filter((item) => item.action === "create").length,
    accountsUpdated: accountResults.filter((item) => item.action === "update").length,
    accountsUnchanged: accountResults.filter((item) => item.action === "unchanged").length,
    threadBindingsTotal: bindingResults.length,
    threadBindingsUpdated: bindingResults.filter((item) => item.action === "update").length,
    threadBindingsSkipped: bindingResults.filter((item) => item.action === "skipped").length,
    threadBindingsUnchanged: bindingResults.filter((item) => item.action === "unchanged").length,
    tokenPlansTotal: tokenPlans.length,
    tokenPlansConfigured: tokenPlans.filter((item) => item.tokenConfigured).length,
    tokenPlansMissing: tokenPlans.filter((item) => !item.tokenConfigured).length,
  };
  const warnings = compatibilityWarnings(accountResults, bindingResults, env);
  const tokenProvisioning = dryRun
    ? { ok: true, created: 0, reused: 0, tokens: [] }
    : await ensureWhatsAppScopedTokens(tokenPlans.filter((item) => !item.tokenConfigured), env);
  const finalTokenPlans = tokenProvisioning.created
    ? tokenPlans.map((plan) => plan.tokenConfigured ? plan : { ...plan, tokenConfigured: true, tokenProvisioned: true })
    : tokenPlans;
  const finalCounts = {
    ...counts,
    tokenPlansConfigured: finalTokenPlans.filter((item) => item.tokenConfigured).length,
    tokenPlansMissing: finalTokenPlans.filter((item) => !item.tokenConfigured).length,
    scopedTokensCreated: Number(tokenProvisioning.created || 0),
    scopedTokensReused: Number(tokenProvisioning.reused || 0),
  };
  const migrated = counts.accountsCreated + counts.accountsUpdated + counts.threadBindingsUpdated + Number(tokenProvisioning.created || 0);
  const watcherAlerts = dryRun || options.reportWarnings === false
    ? []
    : await recordMigrationWarnings(warnings, env);
  return {
    ok: true,
    dryRun,
    generatedAt,
    migrated,
    counts: finalCounts,
    accounts: accountResults,
    threadBindings: bindingResults,
    tokenPlans: finalTokenPlans,
    tokenProvisioning,
    warnings,
    watcherAlerts,
    rollback: rollbackPayload(accountResults, bindingResults),
  };
}
