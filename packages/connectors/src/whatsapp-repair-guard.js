import { consumeDurableRateLimit, durableRateLimitKey, positiveIntegerEnv } from "../../core/src/durable-rate-limit.js";
import { appendEvent } from "../../storage/src/store.js";

// Abuse bounds for the WhatsApp repair action (ORK-513).
//
// Per-source and per-account attempt budgets are durable (file-backed) so a
// restart does not reset them. QR generation is additionally capped per
// process: one generation per account and a small global concurrency limit.
// Audit events carry hashed source keys only.

const inFlightAccounts = new Set();
let inFlightCount = 0;

function clean(value) {
  return String(value || "").trim();
}

function minutes(value) {
  return value * 60 * 1000;
}

export async function reserveWhatsAppRepairSourceAttempt(sourceKey = "", env = process.env) {
  return consumeDurableRateLimit({
    bucket: "whatsapp-repair-source",
    key: clean(sourceKey) || "unknown",
    limit: positiveIntegerEnv(env.ORKESTR_WHATSAPP_REPAIR_SOURCE_LIMIT, 10),
    windowMs: positiveIntegerEnv(env.ORKESTR_WHATSAPP_REPAIR_SOURCE_WINDOW_MS, minutes(15), 1_000),
  }, env);
}

export async function reserveWhatsAppRepairAccountAttempt(accountId = "", env = process.env) {
  return consumeDurableRateLimit({
    bucket: "whatsapp-repair-account",
    key: clean(accountId),
    limit: positiveIntegerEnv(env.ORKESTR_WHATSAPP_REPAIR_ACCOUNT_LIMIT, 3),
    windowMs: positiveIntegerEnv(env.ORKESTR_WHATSAPP_REPAIR_ACCOUNT_WINDOW_MS, minutes(30), 1_000),
  }, env);
}

/** Returns a release function, or null when a QR generation slot is not free. */
export function acquireWhatsAppRepairQrSlot(accountId = "", env = process.env) {
  const account = clean(accountId);
  const cap = positiveIntegerEnv(env.ORKESTR_WHATSAPP_REPAIR_QR_CONCURRENCY, 1);
  if (!account || inFlightAccounts.has(account) || inFlightCount >= cap) return null;
  inFlightAccounts.add(account);
  inFlightCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inFlightAccounts.delete(account);
    inFlightCount = Math.max(0, inFlightCount - 1);
  };
}

export function whatsappRepairQrInFlightForTest() {
  return { count: inFlightCount, accounts: [...inFlightAccounts] };
}

/**
 * Audit a rejected repair request. When one source crosses the alert
 * threshold inside the window, emit a single abuse alert for that window.
 */
export async function recordWhatsAppRepairRejection({ reason = "", sourceKey = "", accountId = "", intentId = "" } = {}, env = process.env) {
  const source = durableRateLimitKey(sourceKey || "unknown");
  await appendEvent({
    type: reason === "replayed" ? "whatsapp_repair_intent_replayed" : "whatsapp_repair_request_rejected",
    reason: clean(reason) || "rejected",
    source,
    ...(clean(accountId) ? { accountId: clean(accountId) } : {}),
    ...(clean(intentId) ? { intentId: clean(intentId) } : {}),
  }, env).catch(() => {});
  const windowMs = positiveIntegerEnv(env.ORKESTR_WHATSAPP_REPAIR_ALERT_WINDOW_MS, minutes(15), 1_000);
  const counted = await consumeDurableRateLimit({
    bucket: "whatsapp-repair-rejections",
    key: sourceKey || "unknown",
    limit: positiveIntegerEnv(env.ORKESTR_WHATSAPP_REPAIR_ALERT_THRESHOLD, 5),
    windowMs,
  }, env).catch(() => ({ ok: true }));
  if (counted.ok) return;
  const alert = await consumeDurableRateLimit({ bucket: "whatsapp-repair-alerts", key: sourceKey || "unknown", limit: 1, windowMs }, env)
    .catch(() => ({ ok: false }));
  if (alert.ok) {
    await appendEvent({ type: "whatsapp_repair_abuse_alert", source, windowMs }, env).catch(() => {});
  }
}
