import { executeSettingsCommand, parseSettingsCommand } from "./codex-settings-command-control.js";
import { settingsOperationKey } from "./codex-settings-operations.js";
import { updateThreadMessage } from "./threads.js";
import { resourceOwnerUserId } from "./policy.js";

// Compatibility drain only: preserve the old user record, never append an
// assistant message or project a runtime final. New ingress must intercept first.
export async function completeLegacySettingsCommand(thread, message, env, handleWhatsAppSettingsCommand) {
  const parsed = parseSettingsCommand(message.text);
  if (!parsed) return null;
  const external = message.connector === "whatsapp" || message.source === "whatsapp_inbound";
  const result = external
    ? await handleWhatsAppSettingsCommand({ thread, text: message.text,
      senderEffectiveRole: message.senderEffectiveRole || "unknown",
      accountId: message.accountId || "", chatId: message.chatId || "",
      canonicalEventId: String(message.externalId || message.sourceEventId || message.id).replace(/^(?:true|false)_/, ""),
      hasAttachments: Boolean(message.promptFile || message.attachments?.length) }, env)
    : await executeSettingsCommand({ thread, text: message.text, surface: "webui",
      principal: ["ui", "ui_input"].includes(message.source)
        ? { kind: "user", userId: resourceOwnerUserId(thread, env) } : null,
      sourceOperationKey: settingsOperationKey(["legacy-settings", resourceOwnerUserId(thread, env), thread.id, message.id]),
      hasAttachments: Boolean(message.promptFile || message.attachments?.length) }, env);
  const completed = await updateThreadMessage(thread.id, message.id, {
    state: "completed", deliveryState: "delivered", observedVia: "settings_control_legacy",
    deliveredAt: new Date().toISOString(), error: result.ok ? null : result.replyText,
  }, env);
  return { messageId: completed.id, message: completed, applied: result.ok };
}
