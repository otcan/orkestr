import crypto from "node:crypto";
import { readWhatsAppScopedTokenRecords } from "../../core/src/whatsapp-scoped-tokens.js";

function clean(value = "") {
  return String(value || "").trim();
}

function list(value = []) {
  const values = Array.isArray(value) ? value : clean(value).split(/[\s,]+/g);
  return [...new Set(values.map((item) => clean(item)).filter(Boolean))];
}

function scopeList(value = []) {
  return list(value).map((item) => item.toLowerCase());
}

function hash(value = "") {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function secretMatches(record = {}, token = "") {
  if (!token) return false;
  const expected = clean(record.token) ? hash(record.token) : clean(record.tokenHash || record.hash).toLowerCase();
  const actual = hash(token);
  if (!expected || expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

function parseTokenRecords(value = "") {
  const raw = clean(value);
  if (!raw) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const entries = Array.isArray(parsed)
    ? parsed.map((record, index) => [clean(record?.id || index), record])
    : Object.entries(parsed || {});
  return entries.map(([id, value]) => {
    const record = typeof value === "string" ? { token: value } : value || {};
    return normalizeRecord({ id, ...record });
  }).filter((record) => record.token || record.tokenHash);
}

function normalizeRecord(record = {}) {
  const accountId = clean(record.accountId);
  return {
    id: clean(record.id || record.tokenId),
    token: clean(record.token || record.value || record.secret),
    tokenHash: clean(record.tokenHash || record.hash).toLowerCase(),
    scopes: scopeList(record.scopes || record.scope || record.capabilities),
    principalKind: clean(record.principalKind || record.kind || "external_instance"),
    principalId: clean(record.principalId || record.instanceId || record.ownerUserId || record.userId),
    ownerUserId: clean(record.ownerUserId || record.userId),
    instanceId: clean(record.instanceId || record.instance),
    threadId: clean(record.threadId),
    accountId,
    accountService: clean(record.accountService || record.service || (accountId ? "whatsapp" : "")).toLowerCase(),
    bindingId: clean(record.bindingId),
    chatId: clean(record.chatId),
    allowedChatIds: list(record.allowedChatIds || record.allowedChats || record.chatIds),
    allowedRecipients: list(record.allowedRecipients || record.allowedRecipientIds || record.recipientIds),
    expiresAt: clean(record.expiresAt),
    disabled: record.disabled === true || record.enabled === false,
    operator: record.operator === true,
  };
}

function publicRecord(record = {}) {
  return {
    tokenId: record.id || "",
    scopes: record.scopes || [],
    principalKind: record.principalKind || "",
    principalId: record.principalId || "",
    ownerUserId: record.ownerUserId || "",
    instanceId: record.instanceId || "",
    threadId: record.threadId || "",
    accountId: record.accountId || "",
    accountService: record.accountService || "",
    bindingId: record.bindingId || "",
    chatId: record.chatId || "",
    allowedChatIds: record.allowedChatIds || [],
    allowedRecipients: record.allowedRecipients || [],
    operator: record.operator === true,
  };
}

function operatorRecord(env = process.env) {
  const token = clean(env.ORKESTR_CONNECTORS_MCP_TOKEN);
  if (!token) return null;
  return normalizeRecord({
    id: "configured-operator",
    token,
    scopes: ["*"],
    principalKind: "operator",
    principalId: clean(env.ORKESTR_ADMIN_USER_ID || "admin"),
    ownerUserId: clean(env.ORKESTR_ADMIN_USER_ID || "admin"),
    operator: true,
  });
}

export async function connectorMcpTokenRecords(env = process.env) {
  const configured = parseTokenRecords(env.ORKESTR_CONNECTORS_MCP_TOKENS_JSON);
  const existingWhatsApp = await readWhatsAppScopedTokenRecords(env).catch(() => []);
  return [
    operatorRecord(env),
    ...configured,
    ...existingWhatsApp.map(normalizeRecord),
  ].filter(Boolean);
}

export async function authorizeConnectorMcpToken(token = "", env = process.env) {
  const value = clean(token);
  if (!value) {
    const error = new Error("connector_mcp_token_required");
    error.statusCode = 401;
    throw error;
  }
  const records = await connectorMcpTokenRecords(env);
  if (!records.length) {
    const error = new Error("connector_mcp_token_unconfigured");
    error.statusCode = 503;
    throw error;
  }
  const record = records.find((candidate) => secretMatches(candidate, value));
  if (!record || record.disabled || (record.expiresAt && Date.parse(record.expiresAt) <= Date.now())) {
    const error = new Error("connector_mcp_token_invalid");
    error.statusCode = 401;
    throw error;
  }
  return publicRecord(record);
}

export async function authorizeConnectorMcpRequest(request, env = process.env) {
  const header = clean(request?.headers?.authorization || request?.headers?.Authorization);
  const match = header.match(/^Bearer\s+(.+)$/i);
  return authorizeConnectorMcpToken(match?.[1] || "", env);
}

function includesComparable(values = [], actual = "") {
  const value = clean(actual).toLowerCase();
  return values.some((candidate) => {
    const allowed = clean(candidate).toLowerCase();
    return allowed === "*" || allowed === value;
  });
}

function requiredScopes(tool = "", action = "", service = "") {
  if (tool === "orkestr_runtime") {
    return ["*", "runtime:*", "runtime:write", "connectors:manage"];
  }
  const read = action === "status" || ["list", "history", "participants"].includes(action);
  const kind = tool === "orkestr_messaging" ? "send" : read ? "read" : "manage";
  return [
    "*",
    "connectors:*",
    `connectors:${kind}`,
    `${service}:*`,
    `${service}:${kind}`,
    ...(service === "whatsapp" && kind === "send" ? ["whatsapp:bridge", "whatsapp:bridge:send"] : []),
    ...(service === "whatsapp" && kind === "read" ? ["whatsapp:bridge", "whatsapp:bridge:read"] : []),
    ...(service === "whatsapp" && kind === "manage" ? ["whatsapp:bridge", "whatsapp:bridge:manage"] : []),
  ];
}

function scopeDenied(reason = "scope_denied") {
  const error = new Error(`connector_mcp_${reason}`);
  error.statusCode = 403;
  throw error;
}

export function assertConnectorMcpScope(auth = {}, tool = "", input = {}) {
  const service = clean(input.service).toLowerCase();
  const action = clean(input.action).toLowerCase();
  const scopes = scopeList(auth.scopes);
  if (!requiredScopes(tool, action, service).some((scope) => scopes.includes(scope))) scopeDenied("scope_denied");
  if (auth.instanceId && clean(input.instance_id) && auth.instanceId !== clean(input.instance_id)) scopeDenied("instance_scope_denied");
  if (auth.ownerUserId && clean(input.user_id) && auth.ownerUserId !== clean(input.user_id)) scopeDenied("user_scope_denied");
  if (auth.threadId && clean(input.thread_id) && auth.threadId !== clean(input.thread_id)) scopeDenied("thread_scope_denied");
  const accountScopeApplies = Boolean(auth.accountId) && (!auth.accountService || auth.accountService === service);
  if (accountScopeApplies && clean(input.account_id) && auth.accountId !== clean(input.account_id)) scopeDenied("account_scope_denied");

  const conversationId = clean(input.conversation_id);
  const allowed = [...list(auth.allowedChatIds), ...list(auth.allowedRecipients), ...list(auth.chatId)];
  if (conversationId && !auth.operator && !includesComparable(allowed, conversationId)) scopeDenied("conversation_scope_denied");
  return {
    ...auth,
    service,
    action,
    accountId: accountScopeApplies ? auth.accountId : clean(input.account_id),
    instanceId: auth.instanceId || clean(input.instance_id),
    ownerUserId: auth.ownerUserId || clean(input.user_id),
    threadId: auth.threadId || clean(input.thread_id),
    conversationId,
  };
}
