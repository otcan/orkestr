import { appendEvent } from "../../storage/src/store.js";
import { appendThreadMessage, getThread } from "./threads.js";

function clean(value = "") {
  return String(value || "").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

function eligibleWhatsAppBinding(thread = {}) {
  const binding = thread?.binding && typeof thread.binding === "object" ? thread.binding : {};
  if (lower(binding.connector || "whatsapp") !== "whatsapp") return null;
  if (!clean(binding.chatId) || binding.enabled === false || binding.routeEligible === false || binding.deprecated === true || binding.retired === true) return null;
  if (binding.mirrorToWhatsApp === false || binding.mirrorReplies === false) return null;
  return {
    chatId: clean(binding.chatId),
    accountId: clean(binding.replyAccountId || binding.bridgeAccountId || binding.responderConnectorAccountId || binding.responderAccountId || binding.outboundAccountId),
  };
}

export function desktopAccessChatWarningsEnabled(env = process.env) {
  return !["0", "false", "no", "off", "disabled"].includes(lower(env.ORKESTR_DESKTOP_ACCESS_CHAT_WARNINGS));
}

/**
 * @param {{ threadId?: string, attemptId?: string, warnings?: any[] }} input
 * @param {Record<string, any>} env
 */
export async function emitDesktopAccessChatWarning({ threadId = "", attemptId = "", warnings = [] } = {}, env = process.env) {
  const scopedWarnings = Array.isArray(warnings) ? warnings.filter((item) => item && item.severity !== "info") : [];
  if (!desktopAccessChatWarningsEnabled(env)) return { eligible: false, emitted: false, reason: "feature_disabled" };
  if (!clean(threadId)) return { eligible: false, emitted: false, reason: "thread_scope_missing" };
  if (!scopedWarnings.length) return { eligible: false, emitted: false, reason: "no_warnings" };
  const thread = await getThread(clean(threadId), env);
  if (!thread) return { eligible: false, emitted: false, reason: "thread_not_found" };
  const notificationId = `desktop-access-warning:${clean(attemptId) || clean(scopedWarnings[0]?.attemptId)}`;
  const binding = eligibleWhatsAppBinding(thread);
  const text = [
    `Desktop warning: ${clean(scopedWarnings[0]?.message)}`,
    ...scopedWarnings.slice(1).map((item) => clean(item.message)).filter(Boolean),
    clean(scopedWarnings[0]?.recommendedAction),
  ].filter(Boolean).join("\n");
  try {
    const message = await appendThreadMessage(thread.id, {
      role: "assistant",
      source: "desktop-access-warning",
      phase: "notification",
      state: "completed",
      text,
      idempotencyKey: notificationId,
      dedupeAssistantByIdempotencyKey: true,
      desktopAccessWarnings: scopedWarnings,
      ...(binding ? { connector: "whatsapp", chatId: binding.chatId, accountId: binding.accountId } : {}),
    }, env);
    const emitted = !message.duplicate;
    if (emitted) await appendEvent({
      type: "desktop_access_warning_emitted",
      threadId: thread.id,
      desktopSlug: clean(scopedWarnings[0]?.desktopSlug),
      warningCodes: scopedWarnings.map((item) => clean(item.code)).filter(Boolean),
      mirroredToWhatsApp: Boolean(binding),
    }, env).catch(() => {});
    return { eligible: true, emitted, reason: emitted ? "warning_emitted" : "deduplicated", notificationId };
  } catch {
    return { eligible: true, emitted: false, reason: "notification_failed", notificationId };
  }
}
