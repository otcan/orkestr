import { resourceOwnerUserId } from "../../core/src/policy.js";
import { adminUserId, getUser, normalizeUserId } from "../../core/src/users.js";
import { isAudioAttachment, transcribeVoiceNoteAttachments } from "../../core/src/voice-note-transcription.js";
import { buildTranscriptionGlossary } from "../../core/src/voice-transcription-glossary.js";
import { classifyWhatsAppInboundRequest } from "./whatsapp-inbound-security.js";
import { comparableParticipantId, participantIdSet } from "./whatsapp-inbound-routing.js";

// WhatsApp scope for voice-note transcription. Owner decision: own chats only.
// A binding flag `transcribeVoiceNotes` overrides (true forces on, false
// forces off); when unset, only the owner/self account in an owner-owned
// thread is transcribed, so friend/client chats stay off by default.

function clean(value) {
  return String(value ?? "").trim();
}

function splitIds(value = "") {
  return String(value || "").split(/[\s,]+/g).map(clean).filter(Boolean);
}

// Same owner user resolution as whatsapp-account-bindings.js ownerUserIdForAccount.
function whatsappOwnerUserId(env = process.env) {
  return normalizeUserId(env.ORKESTR_WHATSAPP_OWNER_USER_ID || env.ORKESTR_ADMIN_USER_ID || adminUserId);
}

/**
 * Owner/self sender: the message comes from the connected self account
 * (`fromMe`, the "verified_self_account" rule of whatsapp-participant-identity.js)
 * or from an owner admin number in ORKESTR_WHATSAPP_OWNER_CONTACT_IDS (the
 * explicit owner/self participant configuration used for group creation), and
 * the thread belongs to the WhatsApp owner user. Binding-level "owner" grants
 * alone are not enough: friend/client bundles record the external account
 * owner there.
 */
export function whatsappVoiceNoteSenderIsOwnerSelf({ inboundSecurity = {}, from = "", thread = {}, env = process.env } = {}) {
  if (resourceOwnerUserId(thread || {}, env) !== whatsappOwnerUserId(env)) return false;
  if (inboundSecurity?.participant?.fromMe === true) return true;
  const sender = comparableParticipantId(from);
  // ORKESTR_WHATSAPP_OWNER_ALIASES lists further ids of the same owner (in
  // groups WhatsApp sends a LID that cannot be matched to the phone number).
  // Unlike ORKESTR_WHATSAPP_OWNER_CONTACT_IDS it is never used as default
  // group participants.
  const owners = splitIds(env.ORKESTR_WHATSAPP_OWNER_CONTACT_IDS).concat(splitIds(env.ORKESTR_WHATSAPP_OWNER_ALIASES));
  return Boolean(sender && participantIdSet(owners).has(sender));
}

export function whatsappVoiceNoteTranscriptionAllowed({ binding = {}, inboundSecurity = {}, from = "", thread = {}, env = process.env } = {}) {
  if (binding?.transcribeVoiceNotes === false) return false;
  if (binding?.transcribeVoiceNotes === true) return true;
  return whatsappVoiceNoteSenderIsOwnerSelf({ inboundSecurity, from, thread, env });
}

async function ownerDisplayName(thread = {}, env = process.env) {
  const user = await getUser(resourceOwnerUserId(thread || {}, env), env).catch(() => null);
  return clean(user?.displayName);
}

/**
 * Router hook: returns `{ text, attachments }` with voice-note transcripts
 * applied, or the inputs unchanged when transcription does not apply.
 */
export async function applyWhatsAppVoiceNoteTranscription({
  thread = null,
  binding = {},
  inboundSecurity = {},
  from = "",
  chatId = "",
  text = "",
  attachments = [],
  env = process.env,
  fetchImpl = globalThis.fetch,
} = {}) {
  const unchanged = { text, attachments };
  if (!thread?.id || !Array.isArray(attachments) || !attachments.some(isAudioAttachment)) return unchanged;
  if (!whatsappVoiceNoteTranscriptionAllowed({ binding, inboundSecurity, from, thread, env })) return unchanged;
  const role = clean(inboundSecurity?.effectiveRole || inboundSecurity?.trustLevel);
  const glossary = buildTranscriptionGlossary({
    threadName: thread.name,
    bindingName: clean(thread.bindingName) || clean(binding?.displayName),
    ownerDisplayName: await ownerDisplayName(thread, env),
    env,
  });
  const result = await transcribeVoiceNoteAttachments({
    attachments,
    text,
    glossary,
    chatKey: `whatsapp:${chatId}`,
    tenantId: resourceOwnerUserId(thread, env),
    threadId: thread.id,
    sourceChannel: "whatsapp",
    // Non-owner senders were screened on their typed text only; screen the
    // spoken text with the same classifier before it reaches the agent.
    acceptTranscript: role === "owner" ? null : (spoken) => !classifyWhatsAppInboundRequest(spoken).malicious,
    env,
    fetchImpl,
  });
  return result ? { text: result.text, attachments: result.attachments } : unchanged;
}
