// Who gets the WhatsApp debug footer (layer identities, quota, load): every
// chat whose footer is enabled, owner-only and shared groups alike, including
// replies to a member's input (owner decision 2026-10-28). Tenant isolation and
// the per-thread/chat footer-off switch are checked by the formatter. A notice
// (system post, alert, queue or delivery notice) has no run, so it gets only
// the compact quota/load footer. The member helpers below stay for callers
// that classify chats or inputs; they no longer gate the footer.

import { whatsappBindingParticipantSets } from "./whatsapp-inbound-security.js";

const clean = (value) => String(value ?? "").trim();
const lower = (value) => clean(value).toLowerCase();

function binding(thread) {
  return thread?.binding && typeof thread.binding === "object" ? thread.binding : {};
}

// A membership census (or the owner) marks a chat that contains a verified
// non-owner member the binding itself does not name.
const NON_OWNER_MEMBER_FLAGS = ["whatsappNonOwnerMembers", "hasNonOwnerMembers", "thirdPartyMembers"];

// A trusted participant (inbound security's own classification: explicit
// trusted ids, or additionalParticipantIds when enabled) that is not one of the
// owner identities makes the chat shared. Ids compare normalized, so @c.us vs
// @s.whatsapp.net or a leading "+" do not create a phantom member.
export function threadHasNonOwnerMembers(thread = {}) {
  const b = binding(thread);
  if (NON_OWNER_MEMBER_FLAGS.some((key) => b[key] === true)) return true;
  const { owners, trusted } = whatsappBindingParticipantSets(b);
  return [...trusted].some((id) => !owners.has(id));
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

const NOTICE_DELIVERY_TYPES = new Set(["delivery_error", "queue_notice", "mode_queued", "router_update"]);

export function noticeMessage(message = {}, deliveryType = "") {
  return lower(message?.remoteLayer) === "notice"
    || lower(message?.remoteKind) === "notice"
    || lower(message?.kind) === "notice"
    || NOTICE_DELIVERY_TYPES.has(lower(deliveryType));
}

// `allowNotice` admits a notice for the compact footer; without it a notice is
// refused, as before. Members in the chat, or a member-authored input, no
// longer refuse the footer.
export function footerAudienceAllowed({ message = {}, deliveryType = "", allowNotice = false } = {}) {
  if (!allowNotice && noticeMessage(message, deliveryType)) return false;
  return true;
}
