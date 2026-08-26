import crypto from "node:crypto";

function clean(value = "") {
  return String(value || "").trim();
}

function list(value = "") {
  return String(value || "")
    .split(/[\s,]+/g)
    .map((item) => clean(item).toLowerCase())
    .filter(Boolean);
}

function digest(value = "") {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function resolvedAccountId(input = {}, auth = {}) {
  return clean(auth.accountId || input.account_id || "sender");
}

function automatedDeliveryAllowed(auth = {}) {
  const scopes = Array.isArray(auth.scopes) ? auth.scopes.map((scope) => clean(scope).toLowerCase()) : [];
  return scopes.some((scope) => [
    "connectors:send:automated",
    "whatsapp:send:automated",
    "whatsapp:bridge:automated",
  ].includes(scope));
}

export function attendedOutboundAccountIds(env = process.env) {
  return new Set(list(
    env.ORKESTR_WHATSAPP_ATTENDED_SEND_ACCOUNT_IDS ||
    env.ORKESTR_WHATSAPP_PERSONAL_ACCOUNT_IDS ||
    "",
  ));
}

export function outboundMessageApprovalRequired(input = {}, auth = {}, env = process.env) {
  if (clean(input.service).toLowerCase() !== "whatsapp" || clean(input.action).toLowerCase() === "set_typing") return false;
  if (automatedDeliveryAllowed(auth)) return false;
  const accounts = attendedOutboundAccountIds(env);
  return accounts.has("*") || accounts.has(resolvedAccountId(input, auth).toLowerCase());
}

export function outboundMessageIntent(input = {}, auth = {}, action = "") {
  const attachmentRefs = Array.isArray(input.attachment_refs)
    ? input.attachment_refs.map(clean).filter(Boolean)
    : [];
  return {
    connectorMcpAction: clean(action),
    accountId: resolvedAccountId(input, auth),
    conversationId: clean(input.conversation_id),
    messageSha256: digest(typeof input.text === "string" ? input.text : ""),
    attachmentRefsSha256: digest(JSON.stringify(attachmentRefs)),
    attachmentCount: String(attachmentRefs.length),
    idempotencyKey: clean(input.idempotency_key),
  };
}

export function outboundMessageApprovalPreview(input = {}, auth = {}) {
  const recipient = clean(input.conversation_id);
  const visibleRecipient = recipient.length > 8
    ? `${recipient.slice(0, 3)}…${recipient.slice(-4)}`
    : recipient;
  return {
    accountId: resolvedAccountId(input, auth),
    service: clean(input.service),
    recipient: visibleRecipient,
    messageSha256: digest(typeof input.text === "string" ? input.text : ""),
    attachmentCount: Array.isArray(input.attachment_refs) ? input.attachment_refs.length : 0,
    idempotencyKey: clean(input.idempotency_key),
  };
}
