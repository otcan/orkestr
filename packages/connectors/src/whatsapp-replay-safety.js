const partialCode = /(?:^|[^a-z0-9_])whatsapp_partial_delivery(?:$|[^a-z0-9_])/i;
const clean = value => String(value || "").trim().toLowerCase();

// Inspect diagnostic fields only, never outbound message text/attachments.
// Legacy errors may be HTTP-prefixed JSON, escaped JSON, or an Error object.
export function hasWhatsAppPartialDelivery(value) {
  const seen = new Set();
  function inspect(item, depth = 0) {
    if (typeof item === "string") return partialCode.test(item.slice(0, 131072));
    if (!item || typeof item !== "object" || depth > 4 || seen.has(item)) return false;
    seen.add(item);
    if (clean(item.state) === "partial_delivery" || (item.partialDelivery && typeof item.partialDelivery === "object")) return true;
    return ["error", "message", "code", "failureCode", "failureReason", "lastError", "metadata", "brokerAck", "payload", "cause", "bridgeFailure", "responseExcerpt"]
      .some(key => inspect(item[key], depth + 1));
  }
  return inspect(value);
}

export function whatsappOutboxQuarantine(job, nowMs = Date.now()) {
  if (clean(job?.connector) !== "whatsapp") return null;
  const state = clean(job.state);
  if (["delivered", "cancelled", "suppressed", "skipped", "skipped_policy", "partial_delivery", "delivery_uncertain"].includes(state)) return null;
  const partial = hasWhatsAppPartialDelivery(job);
  const expires = Date.parse(job.claimExpiresAt || "");
  const expiredSend = ["claimed", "sent_to_broker"].includes(state) && (!Number.isFinite(expires) || expires <= nowMs);
  if (!partial && !expiredSend) return null;
  const now = new Date(nowMs).toISOString();
  return { ...job, state: partial ? "partial_delivery" : "delivery_uncertain",
    error: partial ? "whatsapp_partial_delivery" : "whatsapp_send_not_confirmed_after_claim_expiry",
    claimedBy: "", claimedAt: "", claimExpiresAt: "", terminalAt: now, failedAt: now, updatedAt: now,
    metadata: { ...job.metadata, retrySuppressed: true, requiresFreshApproval: true,
      recoveryReason: partial ? "legacy_partial_delivery" : "expired_send_claim",
      ...(partial ? { nonRetryable: true } : { deliveryUncertain: true }) } };
}

export function protectWhatsAppOutboxUpdate(current, patch, approvedVersion = null) {
  if (clean(current?.connector) !== "whatsapp") return null;
  if (!["pending", "claimed", "sent_to_broker", "failed_retryable"].includes(clean(patch.state))) return null;
  const protectedJob = whatsappOutboxQuarantine(current) || current;
  if (hasWhatsAppPartialDelivery(protectedJob)) return protectedJob;
  if (clean(protectedJob.state) !== "delivery_uncertain" &&
      !(protectedJob.metadata?.deliveryUncertain && ["dead_letter", "suppressed", "cancelled"].includes(clean(protectedJob.state)))) return null;
  // Only the explicitly approved operator action may reopen this exact version.
  // Persisted override metadata is audit evidence, never reusable authority.
  return approvedVersion && approvedVersion === current.updatedAt ? null : protectedJob;
}

export function requiresWhatsAppUncertainOverride(job) {
  return clean(job?.state) === "delivery_uncertain" ||
    (clean(job?.connector) === "whatsapp" && job?.metadata?.deliveryUncertain === true) ||
    whatsappOutboxQuarantine(job)?.state === "delivery_uncertain";
}
