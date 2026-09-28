import { randomUUID } from "node:crypto";
import { parseThreadInputCommand } from "./thread-commands.js";
import { changeCodexModelControls, modelControlsReadOnlyReason } from "./codex-model-controls.js";
import { getThread } from "./threads.js";
import { canAccessOwner, resourceOwnerUserId } from "./policy.js";
import { runSettingsOperation, readSettingsOperation, settingsOperationKey } from "./codex-settings-operations.js";
import { threadUsesClaudeCode } from "./claude-code-runtime-policy.js";
import { executeClaudeSettingsCommand } from "./claude-settings-command.js";

export function parseSettingsCommand(text) {
  // Settings are never prompts, even on unsupported runtimes.
  const parsed = parseThreadInputCommand({ text });
  return ["model", "effort", "fast"].includes(parsed.command) ? parsed : null;
}

export async function executeSettingsCommand({ thread, text, principal = null, senderEffectiveRole = "",
  surface = "webui", sourceOperationKey = "", client = null, hasAttachments = false }, env = process.env) {
  const parsed = parseSettingsCommand(text);
  if (!parsed) return null;
  const current = thread?.id ? await getThread(thread.id, env) : null;
  const authorized = current && resourceOwnerUserId(current, env) === resourceOwnerUserId(thread, env) && (surface === "whatsapp"
    ? ["owner", "admin"].includes(senderEffectiveRole)
    : principal && canAccessOwner(principal, resourceOwnerUserId(current, env), env));
  // Never disclose a cached owner response to an untrusted sender.
  if (!authorized) return { ok: false, outcome: "denied", replyText: "Only the thread owner or an Orkestr admin can use model controls." };
  thread = current;
  const key = sourceOperationKey || settingsOperationKey([surface, resourceOwnerUserId(thread, env), thread.id, randomUUID()]);
  if (threadUsesClaudeCode(thread)) {
    if (env.ORKESTR_SETTINGS_COMMANDS_ENABLED === "0") {
      return { ok: false, outcome: "read_only", replyText: "Chat settings commands are disabled. Use model settings in the WebUI." };
    }
    return executeClaudeSettingsCommand(thread, parsed, { key, surface, hasAttachments }, env);
  }
  const reason = env.ORKESTR_SETTINGS_COMMANDS_ENABLED === "0"
    ? "Chat settings commands are disabled. Use model settings in the WebUI."
    : modelControlsReadOnlyReason(thread, env);
  if (reason || hasAttachments) {
    const refusal = {
      ok: false, outcome: reason ? "read_only" : "invalid",
      replyText: reason || "Settings commands cannot include attachments. Send attachments separately.",
    };
    if (await readSettingsOperation(key, env)) return refusal;
    return runSettingsOperation({ key, surface, command: parsed.command }, async () => refusal, env);
  }
  return changeCodexModelControls(thread, { ...parsed, principal: surface === "whatsapp" ? null : principal,
    authorized: surface === "whatsapp", sourceOperationKey: key, surface, client }, env);
}
