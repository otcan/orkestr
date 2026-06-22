import {
  comparableParticipantId,
  generatedSingleAccountGroupBindingCanTrustGroupBoundary,
  participantIdSet,
} from "./whatsapp-inbound-routing.js";

function pickString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function optionalBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function listValues(...values) {
  return values.flatMap((value) => Array.isArray(value) ? value : [value]).map((value) => pickString(value)).filter(Boolean);
}

function comparableSet(values = []) {
  return participantIdSet(listValues(values));
}

function senderMatches(values = [], sender = "") {
  const comparable = comparableParticipantId(sender);
  return Boolean(comparable && comparableSet(values).has(comparable));
}

function bindingId(binding = {}) {
  return pickString(binding.bindingId, binding.id);
}

function inboundSecurityPolicy(binding = {}, env = process.env) {
  const explicit = binding.inboundSecurity && typeof binding.inboundSecurity === "object" && !Array.isArray(binding.inboundSecurity)
    ? binding.inboundSecurity
    : {};
  const legacyBlocked = Array.isArray(binding.blockedParticipantIds) ? binding.blockedParticipantIds : [];
  const ownerParticipantIds = listValues(
    explicit.ownerParticipantIds,
    explicit.ownerParticipants,
    binding.senderContactId,
    binding.ownerContactId,
    binding.authorizedContactId,
  );
  const trustedParticipantIds = listValues(
    explicit.trustedParticipantIds,
    explicit.trustedParticipants,
    binding.additionalParticipantsEnabled === true || binding.allowOtherPeopleConfirmed === true ? binding.additionalParticipantIds : [],
  );
  const blockedParticipantIds = listValues(
    explicit.blockedParticipantIds,
    explicit.blockedParticipants,
    legacyBlocked,
  );
  const hasExplicitPolicy = Object.keys(explicit).length > 0;
  const defaultMode = ownerParticipantIds.length || binding.generated === true || pickString(binding.senderAccountId, binding.inboundAccountId)
    ? "owner-only"
    : "legacy-open";
  const mode = pickString(explicit.mode, binding.inboundSecurityMode) || defaultMode;
  const autoBlockEnabled = optionalBoolean(
    explicit.autoBlockEnabled ?? explicit.autoBlock,
    optionalBoolean(env.ORKESTR_WHATSAPP_INBOUND_AUTO_BLOCK, false),
  );
  return {
    mode: mode.toLowerCase().replace(/_/g, "-"),
    hasExplicitPolicy,
    ownerParticipantIds,
    trustedParticipantIds,
    blockedParticipantIds,
    autoBlockEnabled,
  };
}

function stateBlockedParticipantIds(state = {}, { binding = {}, chatId = "" } = {}) {
  const records = Array.isArray(state?.inboundSecurity?.blockedParticipants)
    ? state.inboundSecurity.blockedParticipants
    : [];
  const id = bindingId(binding);
  return records
    .filter((record) => {
      const recordBindingId = pickString(record.bindingId);
      const recordChatId = pickString(record.chatId);
      return (!recordBindingId || !id || recordBindingId === id) && (!recordChatId || !chatId || recordChatId === chatId);
    })
    .map((record) => pickString(record.participantId, record.senderId, record.from))
    .filter(Boolean);
}

export function classifyWhatsAppInboundRequest(text = "") {
  const normalized = String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
  if (!normalized) return { malicious: false, reason: "" };
  const rules = [
    ["prompt_injection", /\b(ignore|forget|bypass|override)\b.{0,80}\b(previous|prior|system|developer|instruction|policy|guardrail)s?\b/],
    ["secret_exfiltration", /\b(show|print|dump|reveal|send|exfiltrate)\b.{0,80}\b(secret|token|api key|apikey|password|cookie|session|credential|env|\.env)\b/],
    ["cross_context_access", /\b(other|another|different)\b.{0,60}\b(chat|thread|session|person|client|customer|workspace)\b/],
    ["identity_abuse", /\b(send|message|reply|call)\b.{0,80}\b(as oğuzcan|as oguzcan|on behalf of|from oğuzcan|from oguzcan)\b/],
    ["router_takeover", /\b(switch|rebind|assign|wake|sleep|reset)\b.{0,80}\b(router|thread|session|binding|codex|agent)\b/],
    ["host_execution", /\b(run|execute|shell|terminal|sudo|chmod|curl|wget|rm -rf|ssh|scp|kubectl|docker)\b/],
  ];
  for (const [reason, pattern] of rules) {
    if (pattern.test(normalized)) return { malicious: true, reason };
  }
  return { malicious: false, reason: "" };
}

export function evaluateWhatsAppInboundSecurity({
  binding = {},
  input = {},
  state = {},
  thread = {},
  env = process.env,
} = {}) {
  const chatId = pickString(input.chatId, input.chat?.id, input.fromChatId, binding.chatId);
  const from = pickString(input.from, input.sender, input.author);
  const fromMe = input.fromMe === true ||
    input.from_me === true ||
    String(input.fromMe || input.from_me || "").toLowerCase() === "true";
  const text = pickString(input.text, input.body, input.message);
  const policy = inboundSecurityPolicy(binding, env);
  const blockedIds = [
    ...policy.blockedParticipantIds,
    ...stateBlockedParticipantIds(state, { binding, chatId }),
  ];
  const classified = classifyWhatsAppInboundRequest(text);
  const participant = {
    connector: "whatsapp",
    accountId: pickString(input.accountId, binding.senderAccountId, binding.inboundAccountId),
    chatId,
    senderId: from,
    participantId: from,
    fromMe,
    bindingId: bindingId(binding),
    threadId: pickString(thread.id, binding.threadId),
  };

  if (senderMatches(blockedIds, from)) {
    return {
      allowed: false,
      action: "deny",
      reason: "blocked_participant",
      trustLevel: "blocked",
      policyMode: policy.mode,
      participant,
      classified,
      safeMessage: "This WhatsApp sender is blocked for this Orkestr chat.",
    };
  }

  if (fromMe || senderMatches(policy.ownerParticipantIds, from)) {
    return { allowed: true, trustLevel: "owner", policyMode: policy.mode, participant, classified };
  }

  if (generatedSingleAccountGroupBindingCanTrustGroupBoundary(binding, chatId, from)) {
    return { allowed: true, trustLevel: "trusted", policyMode: policy.mode, participant, classified };
  }

  if (senderMatches(policy.trustedParticipantIds, from)) {
    if (classified.malicious) {
      return {
        allowed: false,
        action: policy.autoBlockEnabled ? "block" : "deny",
        reason: classified.reason || "suspicious_trusted_request",
        trustLevel: "trusted",
        policyMode: policy.mode,
        participant,
        classified,
        safeMessage: "This WhatsApp request was denied because it is outside the allowed Orkestr context.",
      };
    }
    return { allowed: true, trustLevel: "trusted", policyMode: policy.mode, participant, classified };
  }

  if (["all", "allow-all", "public", "all-users"].includes(policy.mode)) {
    if (!classified.malicious) return { allowed: true, trustLevel: "unknown", policyMode: policy.mode, participant, classified };
    return {
      allowed: false,
      action: policy.autoBlockEnabled ? "block" : "deny",
      reason: classified.reason,
      trustLevel: "unknown",
      policyMode: policy.mode,
      participant,
      classified,
      safeMessage: "This WhatsApp request was denied because it is outside the allowed Orkestr context.",
    };
  }

  if (policy.mode === "monitor") {
    return { allowed: true, trustLevel: "unknown", policyMode: policy.mode, participant, classified };
  }

  if (policy.mode === "legacy-open" && !policy.hasExplicitPolicy) {
    if (!classified.malicious) return { allowed: true, trustLevel: "unknown", policyMode: policy.mode, participant, classified };
    return {
      allowed: false,
      action: policy.autoBlockEnabled ? "block" : "deny",
      reason: classified.reason,
      trustLevel: "unknown",
      policyMode: policy.mode,
      participant,
      classified,
      safeMessage: "This WhatsApp request was denied because it is outside the allowed Orkestr context.",
    };
  }

  return {
    allowed: false,
    action: classified.malicious && policy.autoBlockEnabled ? "block" : "deny",
    reason: classified.malicious ? classified.reason : "unknown_sender",
    trustLevel: "unknown",
    policyMode: policy.mode,
    participant,
    classified,
    safeMessage: "This WhatsApp sender is not allowed to control this Orkestr chat.",
  };
}

export function addWhatsAppInboundSecurityBlock(state = {}, decision = {}, now = new Date().toISOString()) {
  const senderId = pickString(decision.participant?.senderId, decision.participant?.participantId);
  if (!senderId) return state;
  const comparable = comparableParticipantId(senderId);
  const prior = state.inboundSecurity && typeof state.inboundSecurity === "object" && !Array.isArray(state.inboundSecurity)
    ? state.inboundSecurity
    : {};
  const records = Array.isArray(prior.blockedParticipants) ? prior.blockedParticipants : [];
  const exists = records.some((record) =>
    comparableParticipantId(pickString(record.participantId, record.senderId, record.from)) === comparable &&
    pickString(record.chatId) === pickString(decision.participant?.chatId) &&
    pickString(record.bindingId) === pickString(decision.participant?.bindingId)
  );
  if (exists) return state;
  return {
    ...state,
    inboundSecurity: {
      ...prior,
      blockedParticipants: [
        ...records,
        {
          participantId: senderId,
          chatId: pickString(decision.participant?.chatId),
          bindingId: pickString(decision.participant?.bindingId),
          reason: pickString(decision.reason),
          blockedAt: now,
          blockedBy: "whatsapp-inbound-security",
        },
      ],
      updatedAt: now,
    },
  };
}
