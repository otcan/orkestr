import { applyConnectorOutboxJobAction, listConnectorOutboxJobs } from "./connector-outbox.js";
import { appendEvent } from "../../storage/src/store.js";

function clean(value = "") {
  return String(value || "").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

function unique(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = clean(value);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

export function recoverableWhatsAppOutboxError(value = "") {
  const reason = lower(value);
  if (!reason) return false;
  return reason.includes("whatsapp_local_bridge_not_ready") ||
    reason.includes("whatsapp_local_bridge_stale_runtime") ||
    reason.includes("whatsapp_local_bridge_not_ready_recovered") ||
    reason.includes("stale_runtime") ||
    reason.includes("target closed") ||
    reason.includes("detached frame") ||
    reason.includes("session closed") ||
    reason.includes("runtime.addbinding") ||
    reason.includes("browser is already running") ||
    reason.includes("userdatadir") ||
    reason.includes("sendiq called before startcomms") ||
    reason.includes("whatsapp_send_message_timeout") ||
    reason.includes("whatsapp_send_media_timeout") ||
    reason.includes("whatsapp_send_not_confirmed");
}

function recoverableJob(job = {}) {
  if (lower(job.connector) !== "whatsapp") return false;
  if (lower(job.state) !== "failed_retryable") return false;
  if (job.metadata?.nonRetryable === true) return false;
  return recoverableWhatsAppOutboxError(job.error) ||
    recoverableWhatsAppOutboxError(job.metadata?.lastError) ||
    recoverableWhatsAppOutboxError(job.metadata?.failureReason);
}

/**
 * @param {{
 *   accountIds?: string[],
 *   reason?: string,
 *   operator?: string,
 *   limit?: number,
 * }} options
 */
export async function retryRecoverableWhatsAppOutboxJobsForAccounts({
  accountIds = [],
  reason = "whatsapp_account_recovered",
  operator = "whatsapp-auto-recovery",
  limit = 1000,
} = {}, env = process.env) {
  const accounts = unique(accountIds);
  if (!accounts.length) return { ok: true, retried: [], skipped: [{ reason: "no_accounts" }] };
  const accountSet = new Set(accounts.map((item) => item.toLowerCase()));
  const listed = await listConnectorOutboxJobs({
    connector: "whatsapp",
    state: "failed_retryable",
    limit,
  }, env);
  const retried = [];
  const skipped = [];
  for (const job of listed.jobs || []) {
    const accountId = clean(job.accountId);
    if (!accountSet.has(accountId.toLowerCase())) {
      skipped.push({ id: job.id, accountId, reason: "different_account" });
      continue;
    }
    if (!recoverableJob(job)) {
      skipped.push({ id: job.id, accountId, reason: "not_recoverable" });
      continue;
    }
    const result = await applyConnectorOutboxJobAction(job.id, "retry", {
      reason,
      operator,
    }, env);
    retried.push({
      id: result.job?.id || job.id,
      accountId,
      threadId: clean(job.threadId),
      chatId: clean(job.chatId),
      deliveryType: clean(job.deliveryType),
      previousState: clean(result.previousState || job.state),
      state: clean(result.job?.state),
    });
  }
  if (retried.length) {
    await appendEvent({
      type: "whatsapp_recoverable_outbox_auto_retry",
      accountIds: accounts,
      reason,
      retried: retried.length,
      skipped: skipped.length,
      jobIds: retried.map((job) => job.id),
    }, env).catch(() => {});
  }
  return { ok: true, retried, skipped };
}

/**
 * @param {{ recovered?: Array<{ accountId?: string, state?: string, ready?: boolean }> }} recovery
 * @returns {string[]}
 */
export function readyRecoveredWhatsAppAccountIds(recovery = {}) {
  return unique((Array.isArray(recovery.recovered) ? recovery.recovered : [])
    .filter((account) => account?.ready === true || lower(account?.state) === "ready")
    .map((account) => account.accountId));
}
