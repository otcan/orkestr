// Delayed recovery for inbound WhatsApp media that failed its inline download.
//
// Phone-uploaded media is often not downloadable from the linked session for a
// few minutes (or until the phone re-uploads it). Instead of letting the 10s
// unread/recent scan re-run the whole download cycle for every replay, a
// failed cycle schedules delayed attempts (default ~1, 5 and 15 minutes after
// the first failure). The schedule lives in the persisted media state file, so
// it survives a service restart; the bridge's periodic scan calls
// `runDueInboundMediaRetries`, which is clock-injectable for tests.

import { appendEvent } from "../../storage/src/store.js";
import {
  deferInboundMediaRetry,
  dueInboundMediaRetries,
  inboundMediaStatePath,
  readInboundMediaState,
  recordInboundMediaFailedCycle,
  settleInboundMediaRetrySkipped,
} from "./whatsapp-inbound-media-state.js";
import { recordWhatsAppInboundMediaFailure, recordWhatsAppInboundMediaRecovered } from "./whatsapp-inbound-media-failures.js";

const runsInFlight = new Map();

function clean(value = "") {
  return String(value || "").trim();
}

function deferDelayMs(env = process.env) {
  const parsed = Number(env.ORKESTR_WHATSAPP_INBOUND_MEDIA_RETRY_DEFER_MS || 60_000);
  return Number.isFinite(parsed) ? Math.max(1_000, Math.min(30 * 60_000, Math.floor(parsed))) : 60_000;
}

// Records a failed processing cycle and decides between "retry later" and the
// terminal user notice. The resend notice is only posted once the delayed
// attempts are exhausted (or delayed retries are disabled).
export async function settleInboundMediaDownloadFailure(input = {}, env = process.env, { nowMs = Date.now(), recordWarning = recordWhatsAppInboundMediaFailure } = {}) {
  const accountId = clean(input.accountId);
  const eventId = clean(input.eventId);
  const chatId = clean(input.chatId);
  const messageType = clean(input.messageType).toLowerCase();
  let entry = null;
  let previous = null;
  try {
    ({ entry, previous } = await recordInboundMediaFailedCycle({
      accountId,
      eventId,
      chatId,
      messageType,
      scheduledAttempt: Number(input.scheduledAttempt || 0) || 0,
      diagnostics: input.diagnostics || null,
    }, env, { nowMs }));
  } catch (error) {
    await appendEvent({
      type: "whatsapp_local_inbound_media_state_write_failed",
      accountId,
      eventId,
      chatId,
      error: error?.message || String(error),
    }, env).catch(() => {});
  }
  if (entry?.state === "pending_retry") {
    await appendEvent({
      type: "whatsapp_local_inbound_media_retry_scheduled",
      accountId,
      eventId,
      chatId,
      messageType,
      attempt: Number(entry.attempt || 0) + 1,
      nextAt: entry.nextAt,
    }, env).catch(() => {});
    return { state: "pending_retry", attempt: Number(entry.attempt || 0), nextAt: entry.nextAt, warning: null };
  }
  const firstFailedMs = Date.parse(entry?.firstFailedAt || "") || nowMs;
  if (entry && previous?.state !== "failed_terminal") {
    await appendEvent({
      type: "whatsapp_local_inbound_media_retry_exhausted",
      accountId,
      eventId,
      chatId,
      messageType,
      attempts: Number(entry.attempt || 0),
      retriedForMs: Math.max(0, nowMs - firstFailedMs),
    }, env).catch(() => {});
  }
  const warning = await recordWarning({
    accountId,
    eventId,
    chatId,
    messageType,
    retriedForMs: Math.max(0, nowMs - firstFailedMs),
  }, env).catch(() => ({ recorded: false, reason: "warning_record_failed" }));
  return { state: entry?.state || "failed_terminal", attempt: Number(entry?.attempt || 0), nextAt: null, warning };
}

function routedSuccessfully(result = {}) {
  if (!result || result.error) return false;
  if (result.forwarded === true) return true;
  return Boolean(result.routed && result.routed.duplicate !== true && !result.routed.ignoredDisabledBinding);
}

async function runOnce({
  env = process.env,
  nowMs = Date.now(),
  limit = 5,
  loadMessage,
  requestReupload = null,
  processMessage,
  recordRecovered = recordWhatsAppInboundMediaRecovered,
} = {}) {
  const due = await dueInboundMediaRetries(env, { nowMs, limit });
  const results = [];
  for (const entry of due) {
    const { accountId, eventId, chatId } = entry;
    const attempt = (Number(entry.attempt || 0) || 0) + 1;
    let loaded;
    try {
      loaded = await loadMessage(entry);
    } catch (error) {
      loaded = { message: null, error };
    }
    if (loaded?.deferred) {
      await deferInboundMediaRetry({ accountId, eventId, delayMs: deferDelayMs(env), reason: loaded.reason }, env, { nowMs }).catch(() => {});
      await appendEvent({
        type: "whatsapp_local_inbound_media_retry_deferred",
        accountId,
        eventId,
        chatId,
        attempt,
        reason: clean(loaded.reason),
      }, env).catch(() => {});
      results.push({ eventId, attempt, outcome: "deferred", reason: clean(loaded.reason) });
      continue;
    }
    let reupload = null;
    if (loaded?.message && typeof requestReupload === "function") {
      reupload = await Promise.resolve(requestReupload(entry, loaded))
        .catch((error) => ({ requested: false, reason: "reupload_failed", error: error?.message || String(error) }));
    }
    await appendEvent({
      type: "whatsapp_local_inbound_media_retry_started",
      accountId,
      eventId,
      chatId,
      attempt,
      messageFound: Boolean(loaded?.message),
      reupload,
    }, env).catch(() => {});
    if (!loaded?.message) {
      const settled = await settleInboundMediaDownloadFailure({
        accountId,
        eventId,
        chatId,
        messageType: entry.messageType,
        scheduledAttempt: attempt,
        diagnostics: { error: { message: "whatsapp_inbound_media_retry_message_not_found", detail: clean(loaded?.error?.message) } },
      }, env, { nowMs });
      results.push({ eventId, attempt, outcome: settled.state, reason: "message_not_found" });
      continue;
    }
    let result;
    try {
      result = await processMessage(entry, loaded, attempt);
    } catch (error) {
      result = { error: error?.message || String(error) };
    }
    const current = await readInboundMediaState(accountId, eventId, env).catch(() => null);
    if (current?.state === "delivered") {
      const delivered = routedSuccessfully(result);
      const notice = delivered
        ? await recordRecovered({
          accountId,
          eventId,
          chatId,
          messageType: entry.messageType,
          threadId: result?.routed?.threadId || "",
          attempt,
        }, env).catch(() => ({ recorded: false, reason: "recovered_notice_failed" }))
        : null;
      await appendEvent({
        type: "whatsapp_local_inbound_media_retry_recovered",
        accountId,
        eventId,
        chatId,
        attempt,
        routed: delivered,
        noticeRecorded: notice?.recorded === true,
      }, env).catch(() => {});
      results.push({ eventId, attempt, outcome: "recovered", routed: delivered, notice });
      continue;
    }
    if (current?.state === "pending_retry" && (Number(current.attempt || 0) || 0) < attempt) {
      // The cycle ended before reaching the media download (echo, empty,
      // status, ...): settle instead of retrying forever.
      const reason = clean(result?.skipped || result?.error || "not_processed");
      await settleInboundMediaRetrySkipped({ accountId, eventId, reason }, env, { nowMs }).catch(() => {});
      results.push({ eventId, attempt, outcome: "skipped", reason });
      continue;
    }
    results.push({ eventId, attempt, outcome: current?.state || "unknown" });
  }
  return { due: due.length, results };
}

export async function runDueInboundMediaRetries(options = {}) {
  const env = options.env || process.env;
  if (typeof options.loadMessage !== "function" || typeof options.processMessage !== "function") {
    return { due: 0, results: [], skipped: "missing_handlers" };
  }
  const key = inboundMediaStatePath(env);
  if (runsInFlight.has(key)) return runsInFlight.get(key);
  const run = runOnce({ ...options, env }).finally(() => {
    runsInFlight.delete(key);
  });
  runsInFlight.set(key, run);
  return run;
}
