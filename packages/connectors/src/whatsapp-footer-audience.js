// The WhatsApp debug footer (layer identities, quota, load) is an owner-only
// aid. It never reaches a chat with a non-owner member, never rides on a reply
// to a member-authored input, and never decorates a notice.

const clean = (value) => String(value ?? "").trim();
const lower = (value) => clean(value).toLowerCase();
const list = (value) => (Array.isArray(value) ? value : [value]).map(clean).filter(Boolean);

function binding(thread) {
  return thread?.binding && typeof thread.binding === "object" ? thread.binding : {};
}

// A membership census (or the owner) marks a chat that contains a verified
// non-owner member the binding itself does not name.
const NON_OWNER_MEMBER_FLAGS = ["whatsappNonOwnerMembers", "hasNonOwnerMembers", "thirdPartyMembers"];

// Any participant the binding admits besides the owner's own identities makes
// the chat shared. Unknown owner identities fail closed: no footer.
export function threadHasNonOwnerMembers(thread = {}) {
  const b = binding(thread);
  if (NON_OWNER_MEMBER_FLAGS.some((key) => b[key] === true)) return true;
  const owner = new Set([...list(b.ownerContactIds), ...list(b.ownerContactId)]);
  const admitted = [
    ...list(b.authorizedContactIds),
    ...list(b.authorizedContactId),
    ...(b.additionalParticipantsEnabled === false ? [] : list(b.additionalParticipantIds)),
  ];
  return admitted.some((id) => !owner.has(id));
}

// Inputs admitted for a participant carry the participant policy markers
// (see whatsapp-group-participant-author.js and the scoped relay).
export function memberAuthoredInput(input = {}) {
  if (!input || lower(input.role) !== "user") return false;
  if (input.originOwner === false) return true;
  if (lower(input.senderPolicyMode) === "this-thread-only") return true;
  return ["trusted", "participant", "member", "guest"].includes(lower(input.senderEffectiveRole))
    || ["trusted", "participant", "member", "guest"].includes(lower(input.senderTrustLevel));
}

// The input a reply answers: its local parent, or the remote original input.
function answeredInputs(message = {}, messages = []) {
  if (!Array.isArray(messages) || !messages.length) return [];
  const parentId = clean(message.parentMessageId);
  const remoteInput = clean(message.remoteOriginalInputId);
  const remoteParent = clean(message.remoteParentMessageId);
  return messages.filter((peer) => peer && lower(peer.role) === "user" && (
    (parentId && clean(peer.id) === parentId)
    || (remoteInput && clean(peer.remoteMessageId) === remoteInput)
    || (remoteParent && clean(peer.remoteMessageId) === remoteParent)
  ));
}

export function replyToMemberInput(message = {}, messages = []) {
  return answeredInputs(message, messages).some(memberAuthoredInput);
}

export function noticeMessage(message = {}, deliveryType = "") {
  return lower(message?.remoteLayer) === "notice"
    || lower(message?.remoteKind) === "notice"
    || lower(message?.kind) === "notice"
    || lower(deliveryType) === "delivery_error";
}

export function footerAudienceAllowed({ message = {}, thread = null, messages = [], deliveryType = "" } = {}) {
  if (noticeMessage(message, deliveryType)) return false;
  if (thread && threadHasNonOwnerMembers(thread)) return false;
  if (replyToMemberInput(message, messages)) return false;
  return true;
}
