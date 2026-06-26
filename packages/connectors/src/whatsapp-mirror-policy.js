import { isNoReplyAssistantMessage } from "../../core/src/no-reply.js";

function clean(value) {
  return String(value || "").trim();
}

function cleanKey(value) {
  return clean(value).toLowerCase();
}

function booleanEnabled(value) {
  const normalized = cleanKey(value);
  return value === true || ["1", "true", "yes", "on"].includes(normalized);
}

function booleanDisabled(value) {
  const normalized = cleanKey(value);
  return value === false || ["0", "false", "no", "off"].includes(normalized);
}

function own(object = {}, key = "") {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function envListMatches(env = process.env, keys = [], candidates = []) {
  const candidateSet = new Set(candidates.map(cleanKey).filter(Boolean));
  if (!candidateSet.size) return false;
  for (const key of keys) {
    const values = String(env?.[key] || "")
      .split(/[\n,]+/)
      .map(cleanKey)
      .filter(Boolean);
    if (values.some((value) => candidateSet.has(value))) return true;
  }
  return false;
}

function threadBinding(thread = {}) {
  return thread?.binding && typeof thread.binding === "object" ? thread.binding : {};
}

function threadCandidates(thread = {}, chatId = "") {
  const binding = threadBinding(thread);
  return [
    chatId,
    binding.chatId,
    binding.displayName,
    binding.name,
    thread.id,
    thread.name,
  ];
}

function bindingHasEnabledFlag(binding = {}, keys = []) {
  return keys.some((key) => own(binding, key) && booleanEnabled(binding[key]));
}

function bindingHasDisabledFlag(binding = {}, keys = []) {
  return keys.some((key) => own(binding, key) && booleanDisabled(binding[key]));
}

export function codexAssistantSource(message = {}) {
  return ["codex-rollout", "codex-app-server", "codex-app-server-import"].includes(clean(message?.source));
}

export function codexAssistantPhase(message = {}) {
  return clean(message?.phase || "final_answer").toLowerCase();
}

export function internalAssistantSource(message = {}) {
  return ["watcher-alert", "watcher-alert-lifecycle"].includes(clean(message?.source));
}

const codexProgressPhases = new Set(["commentary", "awaiting_approval"]);
const codexSuppressedPhases = new Set(["context_compaction"]);

export function shouldMirrorWhatsAppReply(message = {}) {
  if (isNoReplyAssistantMessage(message)) return false;
  if (internalAssistantSource(message)) return false;
  if (codexAssistantSource(message)) {
    const phase = codexAssistantPhase(message);
    return !codexProgressPhases.has(phase) && !codexSuppressedPhases.has(phase);
  }
  return true;
}

export function shouldMirrorWhatsAppProgress(message = {}, env = process.env) {
  if (isNoReplyAssistantMessage(message)) return false;
  if (internalAssistantSource(message)) return false;
  if (!codexAssistantSource(message)) return false;
  const phase = codexAssistantPhase(message);
  return codexProgressPhases.has(phase) && !codexSuppressedPhases.has(phase);
}

export function threadSuppressesWhatsAppUpdates(thread = {}, chatId = "", env = process.env) {
  const binding = threadBinding(thread);
  if (bindingHasEnabledFlag(binding, [
    "suppressWhatsAppUpdates",
    "suppressWhatsAppUpdateMessages",
    "suppressUpdateMessages",
    "whatsappSuppressUpdates",
    "whatsappSuppressUpdateMessages",
  ])) return true;
  if (bindingHasDisabledFlag(binding, [
    "mirrorWhatsAppUpdates",
    "mirrorWhatsAppProgress",
    "mirrorUpdateMessages",
    "whatsappMirrorUpdates",
  ])) return true;
  return envListMatches(env, [
    "ORKESTR_WHATSAPP_SUPPRESS_UPDATE_CHATS",
    "ORKESTR_WHATSAPP_SUPPRESS_UPDATE_THREADS",
    "WA_SUPPRESS_UPDATE_CHATS",
  ], threadCandidates(thread, chatId));
}

export function threadSuppressesWhatsAppDebugFooter(thread = {}, chatId = "", env = process.env) {
  const binding = threadBinding(thread);
  if (bindingHasEnabledFlag(binding, [
    "suppressWhatsAppDebugFooter",
    "suppressDebugFooter",
    "whatsappSuppressDebugFooter",
  ])) return true;
  if (bindingHasDisabledFlag(binding, [
    "whatsappDebugFooter",
    "appendWhatsAppDebugFooter",
  ])) return true;
  return envListMatches(env, [
    "ORKESTR_WHATSAPP_SUPPRESS_DEBUG_FOOTER_CHATS",
    "ORKESTR_WHATSAPP_SUPPRESS_DEBUG_FOOTER_THREADS",
    "WA_SUPPRESS_DEBUG_FOOTER_CHATS",
  ], threadCandidates(thread, chatId));
}
