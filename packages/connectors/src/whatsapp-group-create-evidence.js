import crypto from "node:crypto";

function clean(value = "") {
  return String(value || "").trim();
}

function safeIdentifier(value = "", limit = 120) {
  return clean(value).replace(/[^a-z0-9_.:-]/gi, "_").slice(0, limit);
}

function safeOutcome(value = "") {
  const outcome = clean(value);
  return ["created", "not_created", "outcome_unknown", "pending"].includes(outcome) ? outcome : "outcome_unknown";
}

function completeGroupId(value = "") {
  const text = clean(value);
  return /^[A-Za-z0-9._-]{1,180}@g\.us$/i.test(text) ? text : "";
}

function groupIdFromValue(value, source = "result") {
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") {
    const groupId = completeGroupId(value);
    return groupId ? { groupId, source } : null;
  }
  if (!value || typeof value !== "object") return null;
  const serialized = ["_serialized", "serialized", "id", "gid", "chatId", "groupId", "$1"];
  for (const key of serialized) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const nested = groupIdFromValue(value[key], `${source}.${key}`);
    if (nested) return nested;
  }
  const user = clean(value.user);
  const server = clean(value.server).toLowerCase();
  if (user && server === "g.us") {
    const groupId = completeGroupId(`${user}@${server}`);
    return groupId ? { groupId, source: `${source}.user_server` } : null;
  }
  return null;
}

function stableFingerprint(value) {
  let serialized = "";
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = Object.prototype.toString.call(value);
  }
  return crypto.createHash("sha256").update(serialized || typeof value).digest("hex");
}

function resultKind(result, resolved) {
  if (resolved) return "group_id";
  if (typeof result === "string") return "sdk_string";
  if (!result || typeof result !== "object" || Array.isArray(result)) return "malformed_result";
  if (clean(result.error || result.message || result.reason)) return "sdk_error_object";
  if (result.gid || result.id || result.chatId || result.groupId || result.$1) return "unrecognized_group_id";
  return "malformed_result";
}

export function adaptWhatsAppGroupCreateResult(result) {
  const resolved = groupIdFromValue(result);
  const kind = resultKind(result, resolved);
  return {
    ok: Boolean(resolved?.groupId),
    groupId: resolved?.groupId || "",
    resultKind: kind,
    idSource: resolved?.source || "",
    externalOutcome: resolved?.groupId ? "created" : "outcome_unknown",
    resultFingerprint: stableFingerprint(result),
  };
}

export function whatsappGroupCreateFailureEnvelope({
  operationId = "",
  stage = "external_create",
  result = undefined,
  error = null,
  clientVersion = "",
  correlationId = "",
} = {}) {
  const evidence = adaptWhatsAppGroupCreateResult(result);
  const explicitCode = clean(error?.code || error?.message || error);
  const code = /^whatsapp_[a-z0-9_:-]{1,120}$/i.test(explicitCode)
    ? explicitCode
    : evidence.resultKind === "sdk_string"
      ? "whatsapp_group_sdk_string_result"
      : evidence.resultKind === "unrecognized_group_id"
        ? "whatsapp_group_id_unrecognized"
        : "whatsapp_group_create_outcome_unknown";
  return {
    operationId: clean(operationId),
    operation: "whatsapp_group_provisioning",
    stage: clean(stage) || "external_create",
    code,
    resultKind: evidence.resultKind,
    externalOutcome: evidence.externalOutcome,
    retryable: false,
    nextAction: "reconcile_operation",
    correlationId: clean(correlationId),
    clientVersion: clean(clientVersion).slice(0, 120),
    resultFingerprint: evidence.resultFingerprint,
  };
}

export function publicWhatsAppGroupCreateFailure(error = {}) {
  const envelope = error?.groupCreateFailure && typeof error.groupCreateFailure === "object"
    ? error.groupCreateFailure
    : null;
  if (!envelope) return null;
  return {
    operationId: safeIdentifier(envelope.operationId, 180),
    operation: "whatsapp_group_provisioning",
    stage: safeIdentifier(envelope.stage, 80),
    code: safeIdentifier(envelope.code, 120),
    resultKind: safeIdentifier(envelope.resultKind, 80),
    externalOutcome: safeOutcome(envelope.externalOutcome),
    retryable: envelope.retryable === true,
    nextAction: safeIdentifier(envelope.nextAction, 120),
    correlationId: safeIdentifier(envelope.correlationId, 180),
    clientVersion: safeIdentifier(envelope.clientVersion, 120),
    resultFingerprint: /^[a-f0-9]{64}$/i.test(clean(envelope.resultFingerprint)) ? clean(envelope.resultFingerprint).toLowerCase() : "",
  };
}
