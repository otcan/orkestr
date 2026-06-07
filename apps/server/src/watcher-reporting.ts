import { recordWatcherAlert } from "../../../packages/core/src/watcher-alerts.js";
import { deliverWhatsAppReplies } from "../../../packages/connectors/src/whatsapp.js";

export type WatcherServerErrorInput = {
  source: string;
  code?: string;
  message?: string;
  error?: unknown;
  method?: string;
  route?: string;
  statusCode?: number;
  threadId?: string;
  messageId?: string;
  routerTraceId?: string;
  details?: Record<string, unknown>;
};

export function reportServerError(env = process.env, input: WatcherServerErrorInput, options: { deliverWatcher?: boolean; mirrorWatcher?: boolean } = {}) {
  const mirrorToConnector = options.mirrorWatcher !== undefined
    ? options.mirrorWatcher
    : options.deliverWatcher !== false;
  void recordWatcherAlert({
    severity: "error",
    ...input,
    mirrorToConnector,
    details: {
      ...(input.details || {}),
      ...(input.statusCode ? { statusCode: input.statusCode } : {}),
    },
  }, env)
    .then((result: any) => {
      if (options.deliverWatcher === false) return null;
      if (!result?.message || String(result.message.connector || "").toLowerCase() !== "whatsapp") return null;
      return deliverWhatsAppReplies(env).catch(() => null);
    })
    .catch(() => null);
}

export function reportWhatsAppDeliveryAnomalies(env = process.env, source: string, result: any) {
  const failed = Array.isArray(result?.failed) ? result.failed : [];
  const skipped = Array.isArray(result?.skipped) ? result.skipped : [];
  const skippedReasons = result?.skippedSummary?.reasons && typeof result.skippedSummary.reasons === "object"
    ? result.skippedSummary.reasons
    : null;
  const badReasons = new Set([
    "missing_outbound_intent",
    "missing_chat_id",
    "missing_text",
    "mirroring_disabled",
    "stale_untracked_reply",
  ]);
  const badSkipped = skipped.filter((item: any) => {
    const reason = String(item?.reason || item?.error || "").toLowerCase();
    return badReasons.has(reason);
  });
  const badSkippedCount = skippedReasons
    ? Object.entries(skippedReasons).reduce((sum, [reason, count]) =>
      sum + (badReasons.has(String(reason).toLowerCase()) ? Number(count || 0) : 0), 0)
    : badSkipped.length;
  if (!failed.length && !badSkippedCount) return;
  const first = failed[0] || badSkipped[0] || {};
  const reason = String(first.error || first.reason || "delivery_anomaly");
  reportServerError(env, {
    source,
    code: failed.length ? "whatsapp_delivery_failed" : "whatsapp_delivery_skipped",
    message: `WhatsApp delivery anomaly: ${reason}`,
    threadId: String(first.threadId || ""),
    messageId: String(first.messageId || ""),
    details: {
      failedCount: failed.length,
      skippedCount: badSkippedCount,
      skippedSampleCount: badSkipped.length,
      reason,
      kind: first.kind || "",
      agentId: first.agentId || "",
      chatIdPresent: Boolean(first.chatId),
    },
  }, { deliverWatcher: false });
}
