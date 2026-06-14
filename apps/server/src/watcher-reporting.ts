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

function clean(value: unknown): string {
  return String(value || "").trim();
}

function lower(value: unknown): string {
  return clean(value).toLowerCase();
}

function deliveryAnomalyReason(item: any = {}): string {
  const value = item?.error || item?.reason || item?.message || "";
  if (!value) return "delivery_anomaly";
  if (typeof value === "string") return value.trim() || "delivery_anomaly";
  if (value instanceof Error) return value.message || String(value);
  if (typeof value !== "object") return String(value || "").trim() || "delivery_anomaly";
  const code = clean(value.code || value.errorCode || value.reason || value.status);
  const message = clean(value.message || value.error || value.detail || value.details || value.description);
  if (code && message && code !== message) return `${code}: ${message}`;
  return message || code || JSON.stringify(value);
}

function retryableBridgeReason(reason = ""): boolean {
  const normalized = lower(reason);
  return normalized.includes("not_ready") ||
    normalized.includes("bridge_not_ready") ||
    normalized.includes("whatsapp_local_bridge_not_ready") ||
    normalized.includes("detached frame") ||
    normalized.includes("target closed") ||
    normalized.includes("session closed") ||
    normalized.includes("fetch failed") ||
    normalized.includes("econnrefused") ||
    normalized.includes("timeout");
}

function mutationNoticePseudoMessageId(messageId = ""): boolean {
  return /:(?:edit|delete)_notice:/i.test(clean(messageId));
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
    const reason = lower(deliveryAnomalyReason(item));
    if (reason === "missing_outbound_intent" && mutationNoticePseudoMessageId(item?.messageId)) return false;
    return badReasons.has(reason);
  });
  const badSkippedCount = skipped.length
    ? badSkipped.length
    : skippedReasons
    ? Object.entries(skippedReasons).reduce((sum, [reason, count]) =>
      sum + (badReasons.has(String(reason).toLowerCase()) ? Number(count || 0) : 0), 0)
    : badSkipped.length;
  const failedReasons = failed.map((item: any) => deliveryAnomalyReason(item));
  if (
    failed.length > 0 &&
    failedReasons.every((reason: string) => retryableBridgeReason(reason)) &&
    badSkippedCount === 0
  ) {
    return;
  }
  if (!failed.length && !badSkippedCount) return;
  const first = failed[0] || badSkipped[0] || {};
  const reason = deliveryAnomalyReason(first);
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
