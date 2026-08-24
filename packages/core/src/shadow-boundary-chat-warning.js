import { randomUUID } from "node:crypto";
import { appendEvent } from "../../storage/src/store.js";
import { recordShadowBoundaryChatWarningMetric } from "./observability.js";
import { getThread, appendThreadMessage } from "./threads.js";

const resourceTypes = new Set(["desktop", "oxrm", "mailbox"]);
const informationalTerms = new Set(["discover", "discovery", "inventory", "status", "doctor", "dry-run", "dry_run", "preflight"]);

function clean(value = "") {
  return String(value || "").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

function truthy(value) {
  return value === true || ["1", "true", "yes", "on"].includes(lower(value));
}

export function shadowBoundaryChatWarningsEnabled(env = process.env) {
  return truthy(env.ORKESTR_SHADOW_BOUNDARY_CHAT_WARNINGS);
}

function informationalSelection(input = {}) {
  if (truthy(input.dryRun) || truthy(input.dry_run) || truthy(input.preflight)) return true;
  const values = [input.action, input.operation, input.selectionPurpose, input.purpose]
    .map(lower)
    .filter(Boolean);
  return values.some((value) => value.split(/[.:/_\s-]+/).some((term) => informationalTerms.has(term)));
}

function eligibleWhatsAppBinding(thread = {}) {
  const binding = thread?.binding && typeof thread.binding === "object" ? thread.binding : {};
  if (lower(binding.connector || "whatsapp") !== "whatsapp") return null;
  if (!clean(binding.chatId) || binding.enabled === false || binding.routeEligible === false || binding.deprecated === true || binding.retired === true) return null;
  if (binding.mirrorToWhatsApp === false || binding.mirrorReplies === false) return null;
  return {
    chatId: clean(binding.chatId),
    accountId: clean(
      binding.replyAccountId ||
      binding.bridgeAccountId ||
      binding.responderConnectorAccountId ||
      binding.responderAccountId ||
      binding.outboundAccountId,
    ),
  };
}

function warningText(resourceType = "resource") {
  return `Warning: this ${resourceType} target was selected under shadow authorization without an effective thread grant. Add an explicit grant before switching ${resourceType} access to enforce.`;
}

function metadata({ resourceType = "", mode = "", eligible = false, emitted = false, reason = "", notificationId = "" } = {}) {
  return {
    eligible: eligible === true,
    emitted: emitted === true,
    resourceType: lower(resourceType),
    mode: lower(mode),
    reason: lower(reason) || "not_applicable",
    notificationId: clean(notificationId),
  };
}

function selectionId(input = {}) {
  return clean(input.selectionId || input.logicalSelectionId || input.requestId || input.idempotencyKey) || randomUUID();
}

// This runs only after a resolver has successfully selected a concrete target.
// Keeping it outside the low-level authorizer avoids a chat message for each
// candidate/probe that a single selection needs to evaluate.
export async function emitShadowBoundaryChatWarning({ resolution = {}, input = {}, decision = null } = {}, env = process.env) {
  const resourceType = lower(input.resourceType || resolution.targetType);
  const mode = lower(decision?.mode);
  if (!resolution.ok) return metadata({ resourceType, mode, reason: "selection_denied" });
  if (!shadowBoundaryChatWarningsEnabled(env)) return metadata({ resourceType, mode, reason: "feature_disabled" });
  if (!resourceTypes.has(resourceType)) return metadata({ resourceType, mode, reason: "resource_type_not_supported" });
  if (mode !== "shadow") return metadata({ resourceType, mode, reason: "mode_not_shadow" });
  if (!decision?.shadowDenied || decision.granted === true || decision.grant) {
    return metadata({ resourceType, mode, reason: decision?.granted ? "effective_thread_grant" : "authorization_not_shadow_denied" });
  }
  if (informationalSelection(input)) return metadata({ resourceType, mode, reason: "informational_selection" });

  const threadId = clean(input.threadId || input.thread?.id || decision.threadId);
  if (!threadId) return metadata({ resourceType, mode, reason: "thread_scope_missing" });
  const thread = await getThread(threadId, env);
  if (!thread) return metadata({ resourceType, mode, reason: "thread_not_found" });

  const notificationId = `shadow-boundary-warning:${selectionId(input)}`;
  const warning = metadata({
    resourceType,
    mode,
    eligible: true,
    emitted: true,
    reason: "shadow_ungranted_target_selected",
    notificationId,
  });
  const binding = eligibleWhatsAppBinding(thread);
  try {
    const message = await appendThreadMessage(thread.id, {
      role: "assistant",
      source: "shadow-boundary-warning",
      phase: "notification",
      state: "completed",
      text: warningText(resourceType),
      idempotencyKey: notificationId,
      dedupeAssistantByIdempotencyKey: true,
      shadowBoundaryWarning: warning,
      ...(binding ? {
        connector: "whatsapp",
        chatId: binding.chatId,
        accountId: binding.accountId,
      } : {}),
    }, env);
    const emitted = !message.duplicate;
    const result = { ...warning, emitted };
    recordShadowBoundaryChatWarningMetric({ resourceType, outcome: emitted ? "emitted" : "deduplicated" });
    if (emitted) {
      await appendEvent({
        type: "shadow_boundary_chat_warning_emitted",
        resourceType,
        mode: "shadow",
        outcome: "emitted",
        mirroredToWhatsApp: Boolean(binding),
      }, env).catch(() => {});
    }
    return result;
  } catch {
    recordShadowBoundaryChatWarningMetric({ resourceType, outcome: "failed" });
    return metadata({
      resourceType,
      mode,
      eligible: true,
      reason: "notification_failed",
      notificationId,
    });
  }
}
