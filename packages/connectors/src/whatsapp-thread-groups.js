import { defaultWhatsAppReplyPrefix } from "../../core/src/whatsapp-defaults.js";
import { updateThread } from "../../core/src/threads.js";
import { readConnectorConfig } from "../../storage/src/config.js";
import { configuredWhatsAppBridgeUrl, whatsappBridgeEndpointUrl } from "./whatsapp.js";
import { createLocalWhatsAppChat, normalizeGroupParticipantIds } from "./whatsapp-local-bridge.js";

function clean(value) {
  return String(value || "").trim();
}

function optionalBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function threadGroupDisplayName(thread = {}, options = {}) {
  return clean(options.name || options.displayName || thread.binding?.displayName || thread.bindingName || thread.name || thread.title || thread.id);
}

function threadGroupBinding(thread = {}, group = {}, options = {}) {
  const current = thread.binding && typeof thread.binding === "object" ? thread.binding : {};
  const displayName = threadGroupDisplayName(thread, options);
  return {
    ...current,
    connector: "whatsapp",
    chatId: clean(group.chat?.id || group.chatId || current.chatId),
    displayName,
    enabled: optionalBoolean(options.enabled, current.enabled !== false),
    allowOtherPeople: optionalBoolean(options.allowOtherPeople, current.allowOtherPeople !== false),
    additionalParticipantsEnabled: false,
    additionalParticipantIds: [],
    additionalParticipantLabels: {},
    mirrorToWhatsApp: optionalBoolean(options.mirrorToWhatsApp, current.mirrorToWhatsApp !== false),
    replyPrefix: clean(options.replyPrefix || current.replyPrefix) || defaultWhatsAppReplyPrefix(),
    senderAccountId: clean(options.senderAccountId || group.senderAccountId || current.senderAccountId) || null,
    responderAccountId: clean(options.responderAccountId || options.outboundAccountId || group.responderAccountId || current.responderAccountId || current.outboundAccountId) || null,
    outboundAccountId: clean(options.outboundAccountId || options.responderAccountId || group.responderAccountId || current.outboundAccountId || current.responderAccountId) || null,
    senderContactId: clean(group.senderContactId || options.senderContactId || current.senderContactId) || null,
    responderContactId: clean(group.responderContactId || options.responderContactId || current.responderContactId) || null,
    generated: true,
    ownerAuthorTags: Array.isArray(current.ownerAuthorTags) ? current.ownerAuthorTags : [],
    trustedOverrideAuthorTags: Array.isArray(current.trustedOverrideAuthorTags) ? current.trustedOverrideAuthorTags : [],
    updatedAt: new Date().toISOString(),
  };
}

async function createExternalWhatsAppChat(options = {}, env = process.env, fetchImpl = fetch) {
  const bridgeUrl = await configuredWhatsAppBridgeUrl(env);
  if (!bridgeUrl) return null;
  const config = await readConnectorConfig("whatsapp", env);
  const apiToken = clean(env.WHATSAPP_BRIDGE_TOKEN || env.WA_HTTP_TOKEN || config.apiToken);
  const headers = { "content-type": "application/json" };
  if (apiToken) headers.authorization = `Bearer ${apiToken}`;
  const response = await fetchImpl(whatsappBridgeEndpointUrl(bridgeUrl, "/chats"), {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: clean(options.name),
      senderAccountId: clean(options.senderAccountId),
      responderAccountId: clean(options.responderAccountId),
      participantIds: normalizeGroupParticipantIds(options.participantIds || []),
      adminParticipantIds: normalizeGroupParticipantIds(options.adminParticipantIds || []),
      promoteParticipantsAsAdmins: optionalBoolean(options.promoteParticipantsAsAdmins, false),
      generatePicture: optionalBoolean(options.generatePicture, true),
    }),
    signal: AbortSignal.timeout(Number(env.WHATSAPP_CHAT_CREATE_TIMEOUT_MS || 30_000)),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.ok === false) {
    const error = new Error(payload?.error || `whatsapp_chat_create_failed_${response.status}`);
    error.statusCode = response.status || 502;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export async function createAndBindWhatsAppThreadGroup(thread, options = {}, env = process.env, dependencies = {}) {
  if (!thread?.id) {
    const error = new Error("thread_not_found");
    error.statusCode = 404;
    throw error;
  }
  const displayName = threadGroupDisplayName(thread, options);
  if (!displayName) {
    const error = new Error("whatsapp_chat_name_required");
    error.statusCode = 400;
    throw error;
  }
  const current = thread.binding && typeof thread.binding === "object" ? thread.binding : {};
  const forceNew = options.forceNew === true;
  if (clean(current.chatId) && !forceNew) {
    const binding = threadGroupBinding(thread, { chat: { id: current.chatId }, senderAccountId: current.senderAccountId, responderAccountId: current.responderAccountId }, options);
    const updated = await (dependencies.updateThread || updateThread)(thread.id, { binding, bindingName: binding.displayName }, env);
    return {
      ok: true,
      created: false,
      reused: true,
      thread: updated,
      chat: { id: binding.chatId, name: binding.displayName, isGroup: /@g\.us$/i.test(binding.chatId), generated: current.generated === true },
      binding,
    };
  }
  const participantIds = normalizeGroupParticipantIds(options.participantIds || options.participants || []);
  const createChat = dependencies.createChat || (await configuredWhatsAppBridgeUrl(env) ? async (input) => createExternalWhatsAppChat(input, env, dependencies.fetchImpl || fetch) : createLocalWhatsAppChat);
  const group = await createChat({
    name: displayName,
    senderAccountId: clean(options.senderAccountId || current.senderAccountId || ""),
    responderAccountId: clean(options.responderAccountId || options.outboundAccountId || current.responderAccountId || current.outboundAccountId || ""),
    participantIds,
    adminParticipantIds: normalizeGroupParticipantIds(options.adminParticipantIds || []),
    promoteParticipantsAsAdmins: optionalBoolean(options.promoteParticipantsAsAdmins, participantIds.length > 0),
    generatePicture: optionalBoolean(options.generatePicture, true),
    env,
  });
  const binding = threadGroupBinding(thread, group, options);
  if (!binding.chatId) {
    const error = new Error("whatsapp_chat_create_failed");
    error.statusCode = 502;
    throw error;
  }
  const updated = await (dependencies.updateThread || updateThread)(thread.id, { binding, bindingName: binding.displayName }, env);
  return {
    ok: true,
    created: true,
    reused: false,
    thread: updated,
    chat: group.chat || { id: binding.chatId, name: binding.displayName },
    binding,
    senderAccountId: binding.senderAccountId,
    responderAccountId: binding.responderAccountId,
    participantIds,
  };
}
