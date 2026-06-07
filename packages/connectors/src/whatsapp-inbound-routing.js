import {
  whatsappAclDeniedError,
  whatsappBindingAclAllows,
} from "./whatsapp-binding-acl.js";

function pickString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

export function comparableParticipantId(value) {
  const raw = pickString(value).toLowerCase();
  const withoutPrefix = raw.replace(/^whatsapp:/, "");
  const withoutContactDomain = withoutPrefix.replace(/@(c\.us|s\.whatsapp\.net)$/i, "");
  const compactPhone = withoutContactDomain.replace(/[()\s.-]+/g, "");
  const phoneLike = compactPhone.match(/^\+?([0-9]{5,})$/);
  return phoneLike ? phoneLike[1] : raw;
}

export function participantIdSet(values = []) {
  if (!Array.isArray(values)) return new Set();
  return new Set(values.map(comparableParticipantId).filter(Boolean));
}

export function isWhatsAppGroupChatId(value) {
  return /@g\.us$/i.test(pickString(value));
}

export function bindingAccountIds(binding = {}) {
  return new Set([
    pickString(binding.senderAccountId, binding.inboundAccountId),
    pickString(binding.responderConnectorAccountId, binding.responderAccountId, binding.outboundAccountId),
    pickString(binding.targetAccountId, binding.accountId),
  ].filter(Boolean));
}

export function generatedSingleAccountGroupBindingCanTrustGroupBoundary(binding = {}, chatId = "", from = "") {
  const senderAccountId = pickString(binding.senderAccountId, binding.inboundAccountId);
  const responderAccountId = pickString(binding.responderAccountId, binding.outboundAccountId);
  if (!binding.generated || !isWhatsAppGroupChatId(chatId) || !senderAccountId || senderAccountId !== responderAccountId) return false;
  const responderContactId = pickString(binding.responderContactId);
  if (!from) return false;
  return !responderContactId || comparableParticipantId(from) !== comparableParticipantId(responderContactId);
}

export function whatsappAutoThreadBinding({ chatId = "", accountId = "", from = "", displayName = "" } = {}) {
  return {
    connector: "whatsapp",
    chatId,
    displayName,
    enabled: true,
    generated: true,
    allowOtherPeople: false,
    additionalParticipantsEnabled: false,
    additionalParticipantIds: [],
    mirrorToWhatsApp: true,
    senderAccountId: accountId || null,
    responderAccountId: accountId || null,
    outboundAccountId: accountId || null,
    senderContactId: from || null,
    updatedAt: new Date().toISOString(),
  };
}

export function whatsappBindingIsRouteEligible(binding = {}) {
  return binding.enabled !== false &&
    binding.routeEligible !== false &&
    binding.deprecated !== true &&
    binding.retired !== true;
}

export function whatsappDisplayName(input = {}, fallback = "") {
  return pickString(
    input.displayName,
    input.chatName,
    input.chat?.name,
    input.senderName,
    input.pushName,
    input.notifyName,
    input.contactName,
    fallback,
  );
}

export function whatsappInboundThreadMatchesBinding({ thread = {}, chatId = "", accountId = "", from = "", fromMe = false, aclContext = null } = {}) {
  const binding = thread?.binding || {};
  const senderAccountId = pickString(binding.senderAccountId, binding.inboundAccountId);
  const senderContactId = pickString(binding.senderContactId);
  const responderContactId = pickString(binding.responderContactId);
  if (senderAccountId) {
    if (accountId && !bindingAccountIds(binding).has(accountId)) return false;
    if (!fromMe) {
      if (responderContactId && comparableParticipantId(from) === comparableParticipantId(responderContactId)) return false;
      const senderContactMatches = senderContactId && comparableParticipantId(from) === comparableParticipantId(senderContactId);
      const trustGroupBoundary = generatedSingleAccountGroupBindingCanTrustGroupBoundary(binding, chatId, from);
      if (!senderContactMatches && !trustGroupBoundary) {
        const additionalParticipantsEnabled = binding.additionalParticipantsEnabled === true || binding.allowOtherPeopleConfirmed === true;
        if (!additionalParticipantsEnabled) return false;
        if (!participantIdSet(binding.additionalParticipantIds).has(comparableParticipantId(from))) return false;
      }
    }
  }
  const matched = whatsappBindingIsRouteEligible(binding) &&
    String(binding.connector || "whatsapp") === "whatsapp" &&
    String(binding.chatId || "").trim() === chatId;
  if (!matched) return false;
  if (aclContext && !whatsappBindingAclAllows({
    ...binding,
    bindingId: pickString(binding.id, binding.bindingId) || (thread.id ? `thread:${thread.id}:whatsapp` : ""),
    threadId: pickString(thread.id),
    ownerUserId: pickString(thread.ownerUserId),
  }, "receive", aclContext)) {
    throw whatsappAclDeniedError("receive", {
      ...binding,
      bindingId: pickString(binding.id, binding.bindingId) || (thread.id ? `thread:${thread.id}:whatsapp` : ""),
      threadId: pickString(thread.id),
      ownerUserId: pickString(thread.ownerUserId),
    }, aclContext);
  }
  return true;
}
