import {
  consumeThreadConnectorDeliverySignalCount,
  deliverPendingThreadInputs,
  drainAllPendingThreadInputs,
  recoverStalePendingThreadInputs,
  safeResetThreadRuntime,
  syncRuntimeLeases,
} from "../../../packages/core/src/runtime-leases.js";
import { markDueTimers } from "../../../packages/core/src/timers.js";
import { runDueGmailNotifications } from "../../../packages/core/src/gmail-notifications.js";
import { runDueGmailJobsAutomation } from "../../../packages/connectors/src/gmail-jobs-queue.js";
import { connectorAuthStatus } from "../../../packages/connectors/src/connector-auth.js";
import { recoverStaleCodexAppServerTurns } from "../../../packages/core/src/codex-app-server.js";
import { deployDrainActiveSync } from "../../../packages/core/src/deploy-drain.js";
import { deliverWhatsAppReplies, syncWhatsAppTypingIndicators } from "../../../packages/connectors/src/whatsapp.js";
import { recoverTwilioVoiceCalleCallbacks } from "../../../packages/connectors/src/twilio-voice-assistant.js";
import {
  recoverConfiguredLocalWhatsAppAccounts,
  recoverUnreadLocalWhatsAppMessages,
} from "../../../packages/connectors/src/whatsapp-local-bridge.js";
import {
  readyRecoveredWhatsAppAccountIds,
  retryRecoverableWhatsAppOutboxJobsForAccounts,
} from "../../../packages/connectors/src/whatsapp-outbox-recovery.js";
import { appendEvent } from "../../../packages/storage/src/store.js";
import { reportServerError, reportWhatsAppDeliveryAnomalies } from "./watcher-reporting.js";
import {
  recordServerStartup,
  recoveryCauseForStartup,
} from "./server-lifecycle.js";
import {
  recordBackgroundLoopMetrics,
  recordWhatsAppDeliveryMetrics,
} from "../../../packages/core/src/observability.js";

export function runtimeMonitorIntervalMs() {
  const parsed = Number(process.env.ORKESTR_RUNTIME_MONITOR_INTERVAL_MS || 5000);
  return Number.isFinite(parsed) ? Math.max(5000, parsed) : 5000;
}

export function paneProgressMonitorIntervalMs() {
  const parsed = Number(process.env.ORKESTR_PANE_PROGRESS_INTERVAL_MS || 5000);
  return Number.isFinite(parsed) ? Math.max(1000, parsed) : 1000;
}

export function timerLoopIntervalMs() {
  const parsed = Number(process.env.ORKESTR_TIMER_LOOP_INTERVAL_MS || 30_000);
  return Number.isFinite(parsed) ? Math.max(5000, parsed) : 30_000;
}

export function startupRecoveryDelayMs() {
  const parsed = Number(process.env.ORKESTR_STARTUP_RECOVERY_DELAY_MS || 1000);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 1000;
}

export function scheduleStartupRecovery(env = process.env) {
  if (env.ORKESTR_STARTUP_RECOVERY === "0") return null;
  const timer = setTimeout(() => {
    recoverAfterStartup(env).catch((error) => {
      reportServerError(env, {
        source: "server.startupRecovery",
        code: "startup_recovery_failed",
        message: error?.message || String(error),
        error,
      });
    });
  }, startupRecoveryDelayMs());
  timer.unref?.();
  return timer;
}

export async function recoverAfterStartup(env = process.env) {
  const lifecycle = await recordServerStartup(env).catch(() => null);
  const recoveryCause = recoveryCauseForStartup(lifecycle);
  await appendEvent({
    type: "server_startup_recovery_started",
    startupCause: lifecycle?.startupCause || null,
    recoveryCause,
    bootId: lifecycle?.bootId || null,
    previousBootId: lifecycle?.previous?.bootId || null,
    previousActiveThreadCount: lifecycle?.previous?.activeThreadCount || lifecycle?.previous?.activeThreads?.length || 0,
  }, env).catch(() => {});
  if (deployDrainActiveSync(env)) {
    await appendEvent({
      type: "server_startup_recovery_deferred",
      reason: "deploy_draining",
      startupCause: lifecycle?.startupCause || null,
      recoveryCause,
    }, env).catch(() => {});
    return { deferred: true, reason: "deploy_draining", startupCause: lifecycle?.startupCause || null };
  }
  await drainAllPendingThreadInputs(env).catch(() => []);
  const twilioVoiceCallbacks = await recoverTwilioVoiceCalleCallbacks(env).catch((error) => {
    reportServerError(env, {
      source: "server.recoverTwilioVoiceCallbacks",
      code: "twilio_voice_callback_recovery_failed",
      message: error?.message || String(error),
      error,
    });
    return { ok: false, error: error?.message || String(error) };
  });
  const result = await syncRuntimeAndDeliverWhatsApp(env, { forceWhatsapp: true, recoveryCause });
  await appendEvent({
    type: "server_startup_recovery_completed",
    startupCause: lifecycle?.startupCause || null,
    recoveryCause,
    recoveredAppServerTurns: result?.recoveredAppServerTurns || 0,
    appended: result?.appended || 0,
    twilioVoiceCallbacks: {
      started: Array.isArray((twilioVoiceCallbacks as any)?.started) ? (twilioVoiceCallbacks as any).started.length : 0,
      reconciled: Array.isArray((twilioVoiceCallbacks as any)?.reconciled) ? (twilioVoiceCallbacks as any).reconciled.length : 0,
      failed: Array.isArray((twilioVoiceCallbacks as any)?.failed) ? (twilioVoiceCallbacks as any).failed.length : 0,
      timedOut: Array.isArray((twilioVoiceCallbacks as any)?.timedOut) ? (twilioVoiceCallbacks as any).timedOut.length : 0,
      skipped: Boolean((twilioVoiceCallbacks as any)?.skipped),
    },
  }, env).catch(() => {});
  return { ...result, startupCause: lifecycle?.startupCause || null, recoveryCause, twilioVoiceCallbacks };
}

export async function runTimerLoop(
  env = process.env,
  syncImpl: (options?: { forceWhatsapp?: boolean; recoveryCause?: string }) => Promise<any> =
    (options = {}) => syncRuntimeAndDeliverWhatsApp(env, options),
) {
  const startedAt = Date.now();
  const counts: Record<string, number> = {};
  try {
    const dueTimers = await markDueTimers(env, new Date(), {
      connectorStatusProvider: (provider: string, actualEnv: NodeJS.ProcessEnv, options: any = {}) =>
        connectorAuthStatus(provider, actualEnv, options),
    });
    const gmailNotificationRuns = await runDueGmailNotifications(env);
    const jobsRuns = await runDueGmailJobsAutomation(env);
    const drained = await drainAllPendingThreadInputs(env);
    const deliveredCount = drained.reduce((count: number, result: any) => count + Number(result?.delivered?.length || 0), 0);
    const gmailDeliveredCount = gmailNotificationRuns.reduce((count: number, result: any) => count + Number(result?.run?.delivered?.length || 0), 0);
    const jobsPresentedCount = jobsRuns.reduce((count: number, result: any) => count + Number(result?.presentation?.presented?.length || 0), 0);
    Object.assign(counts, {
      due_timers: dueTimers.length,
      gmail_notification_runs: gmailNotificationRuns.length,
      gmail_delivered: gmailDeliveredCount,
      jobs_runs: jobsRuns.length,
      jobs_presented: jobsPresentedCount,
      drained_threads: drained.length,
      drained_inputs: deliveredCount,
    });
    if (dueTimers.length || gmailDeliveredCount > 0 || jobsPresentedCount > 0 || deliveredCount > 0 || drained.length > 0) {
      await syncImpl({ forceWhatsapp: true });
    }
    recordBackgroundLoopMetrics({ loop: "timer_loop", result: "completed", durationMs: Date.now() - startedAt, counts });
  } catch (error) {
    recordBackgroundLoopMetrics({ loop: "timer_loop", result: "failed", durationMs: Date.now() - startedAt, counts });
    throw error;
  }
}

function mergeRuntimeSyncOptions(current: { forceWhatsapp?: boolean; recoveryCause?: string } | null, next: { forceWhatsapp?: boolean; recoveryCause?: string } = {}) {
  return {
    forceWhatsapp: Boolean(current?.forceWhatsapp || next.forceWhatsapp),
    recoveryCause: current?.recoveryCause || next.recoveryCause,
  };
}

export function createRuntimeWhatsAppSyncRunner(env = process.env) {
  let inFlight: Promise<any> | null = null;
  let queuedOptions: { forceWhatsapp?: boolean; recoveryCause?: string } | null = null;
  const run = (options: { forceWhatsapp?: boolean; recoveryCause?: string } = {}) => {
    if (inFlight) {
      queuedOptions = mergeRuntimeSyncOptions(queuedOptions, options);
      recordBackgroundLoopMetrics({ loop: "runtime_sync", result: "queued_behind_active", durationMs: 0 });
      return inFlight.then(() => ({ ok: true, queuedBehindActiveSync: true }));
    }
    inFlight = syncRuntimeAndDeliverWhatsApp(env, options)
      .finally(() => {
        inFlight = null;
        if (queuedOptions) {
          const next = queuedOptions;
          queuedOptions = null;
          void run(next).catch((error) => {
            reportServerError(env, {
              source: "server.runtimeSyncQueued",
              code: "runtime_sync_queued_failed",
              message: error?.message || String(error),
              error,
            });
          });
        }
      });
    return inFlight;
  };
  return run;
}

async function recoverWhatsAppAccountsAndOutbox(env = process.env, reason = "runtime_sync") {
  const recovery = await recoverConfiguredLocalWhatsAppAccounts(env);
  const accountIds = readyRecoveredWhatsAppAccountIds(recovery);
  const outbox = accountIds.length
    ? await retryRecoverableWhatsAppOutboxJobsForAccounts({ accountIds, reason }, env)
    : { ok: true, retried: [], skipped: [] };
  return { recovery, outbox };
}

async function syncRuntimeAndDeliverWhatsApp(env = process.env, options: { forceWhatsapp?: boolean; recoveryCause?: string } = {}) {
  const startedAt = Date.now();
  const counts: Record<string, number> = {};
  try {
    const pendingConnectorDeliveries = consumeThreadConnectorDeliverySignalCount();
    const synced = await syncRuntimeLeases(env);
    const recoveredPendingInputs = await recoverStalePendingThreadInputs(env).catch((error) => {
      reportServerError(env, {
        source: "server.recoverStalePendingThreadInputs",
        code: "stale_pending_input_recovery_failed",
        message: error?.message || String(error),
        error,
      });
      return [];
    });
    const recovered = await recoverStaleCodexAppServerTurns(env, {
      noticeCause: options.recoveryCause,
      recoverySource: options.recoveryCause ? "startup_recovery" : "",
      autoSafeResetThread: (threadId: string, context: Record<string, unknown> = {}) =>
        safeResetThreadRuntime(threadId, { reason: String(context.reason || "stale_turn_auto_safe_reset") }, env),
      continueThreadInput: (threadId: string) => deliverPendingThreadInputs(threadId, env, { processApiAgent: true }),
    }).catch((error) => {
      reportServerError(env, {
        source: "server.recoverCodexAppServerTurns",
        code: "codex_app_server_recovery_failed",
        message: error?.message || String(error),
        error,
      });
      return { recovered: 0, appended: 0 };
    });
    const whatsappRecovery = await recoverWhatsAppAccountsAndOutbox(env, "runtime_sync_whatsapp_recovery").catch((error) => {
      reportServerError(env, {
        source: "server.recoverWhatsAppAccounts",
        code: "whatsapp_account_recovery_failed",
        message: error?.message || String(error),
        error,
      });
      return { recovery: { recovered: [], skipped: [{ reason: error?.message || String(error) }] }, outbox: { retried: [], skipped: [] } };
    });
    const unreadRecovery = await recoverUnreadLocalWhatsAppMessages(env).catch((error) => {
      reportServerError(env, {
        source: "server.recoverUnreadWhatsApp",
        code: "whatsapp_unread_recovery_failed",
        message: error?.message || String(error),
        error,
      });
      return { routed: 0 };
    });
    await syncWhatsAppTypingIndicators(env).catch((error) => {
      reportServerError(env, {
        source: "server.syncWhatsAppTyping",
        code: "whatsapp_typing_sync_failed",
        message: error?.message || String(error),
        error,
      }, { deliverWatcher: false });
    });
    const connectorDeliveries = pendingConnectorDeliveries + consumeThreadConnectorDeliverySignalCount();
    const appended = (synced.appended || 0) + (recovered.appended || 0);
    const recoveredWhatsAppAccounts = Array.isArray(whatsappRecovery?.recovery?.recovered) ? whatsappRecovery.recovery.recovered.length : 0;
    const retriedWhatsAppOutbox = Array.isArray(whatsappRecovery?.outbox?.retried) ? whatsappRecovery.outbox.retried.length : 0;
    Object.assign(counts, {
      runtime_appended: Number(synced.appended || 0),
      total_appended: appended,
      recovered_app_server_turns: Number(recovered.recovered || 0),
      recovered_pending_inputs: recoveredPendingInputs.length,
      recovered_whatsapp_accounts: recoveredWhatsAppAccounts,
      retried_whatsapp_outbox: retriedWhatsAppOutbox,
      unread_whatsapp_routed: Number(unreadRecovery.routed || 0),
      connector_deliveries: connectorDeliveries,
    });
    if (options.forceWhatsapp || appended > 0 || connectorDeliveries > 0 || recoveredPendingInputs.length > 0 || Number(unreadRecovery.routed || 0) > 0 || recoveredWhatsAppAccounts > 0 || retriedWhatsAppOutbox > 0) {
      const deliveryStartedAt = Date.now();
      const delivery = await deliverWhatsAppReplies(env).then((result) => {
        recordWhatsAppDeliveryMetrics({ source: "runtime_sync", result, durationMs: Date.now() - deliveryStartedAt });
        return result;
      }).catch((error) => {
        recordWhatsAppDeliveryMetrics({ source: "runtime_sync", error, durationMs: Date.now() - deliveryStartedAt });
        reportServerError(env, {
          source: "server.deliverWhatsAppReplies",
          code: "whatsapp_reply_delivery_failed",
          message: error?.message || String(error),
          error,
        }, { deliverWatcher: false });
        return null;
      });
      reportWhatsAppDeliveryAnomalies(env, "server.deliverWhatsAppReplies", delivery);
    }
    recordBackgroundLoopMetrics({ loop: "runtime_sync", result: "completed", durationMs: Date.now() - startedAt, counts });
    return {
      ...synced,
      appended,
      recoveredAppServerTurns: recovered.recovered || 0,
      recoveredPendingInputs,
      recoveredWhatsAppAccounts,
      retriedWhatsAppOutbox,
    };
  } catch (error) {
    recordBackgroundLoopMetrics({ loop: "runtime_sync", result: "failed", durationMs: Date.now() - startedAt, counts });
    throw error;
  }
}

export function createWhatsAppDeliveryScheduler(env = process.env) {
  let timer: NodeJS.Timeout | null = null;
  let running = false;
  let rerunRequested = false;
  const retryDelayMs = whatsAppDeliveryRetryDelayMs();
  const shouldRetry = (result: any) => {
    if (!result || !Array.isArray(result.failed) || !result.failed.length) return false;
    return result.failed.some((failure: any) => {
      const reason = String(failure?.error || failure?.reason || failure?.message || "").toLowerCase();
      return reason.includes("not_ready") ||
        reason.includes("bridge_not_ready") ||
        reason.includes("detached frame") ||
        reason.includes("target closed") ||
        reason.includes("session closed") ||
        reason.includes("fetch failed") ||
        reason.includes("econnrefused") ||
        reason.includes("timeout");
    });
  };
  const recoverBeforeRetry = async (reason: string) => {
    const recovery = await recoverWhatsAppAccountsAndOutbox(env, reason).catch((error) => {
      reportServerError(env, {
        source: "server.whatsappDeliveryScheduler.recover",
        code: "whatsapp_account_recovery_failed",
        message: error?.message || String(error),
        error,
      }, { deliverWatcher: false });
      return null;
    });
    return recovery;
  };
  const run = () => {
    if (running) {
      rerunRequested = true;
      return;
    }
    running = true;
    const startedAt = Date.now();
    deliverWhatsAppReplies(env)
      .then((result) => {
        recordWhatsAppDeliveryMetrics({ source: "delivery_scheduler", result, durationMs: Date.now() - startedAt });
        return result;
      })
      .then(async (result) => {
        await syncWhatsAppTypingIndicators(env).catch((error) => {
          reportServerError(env, {
            source: "server.whatsappDeliveryScheduler.typingAfter",
            code: "whatsapp_typing_sync_failed",
            message: error?.message || String(error),
            error,
          }, { deliverWatcher: false });
        });
        return result;
      })
      .then((result) => {
        reportWhatsAppDeliveryAnomalies(env, "server.whatsappDeliveryScheduler", result);
        if (shouldRetry(result)) {
          return recoverBeforeRetry("delivery_scheduler_retry")
            .finally(() => scheduler.schedule(retryDelayMs));
        }
        return null;
      })
      .catch((error) => {
        recordWhatsAppDeliveryMetrics({ source: "delivery_scheduler", error, durationMs: Date.now() - startedAt });
        reportServerError(env, {
          source: "server.whatsappDeliveryScheduler",
          code: "whatsapp_delivery_scheduler_failed",
          message: error?.message || String(error),
          error,
        }, { deliverWatcher: false });
        scheduler.schedule(retryDelayMs);
      })
      .finally(() => {
        running = false;
        if (rerunRequested) {
          rerunRequested = false;
          scheduler.schedule();
        }
      });
  };
  const scheduler = {
    schedule(delayMs = 0) {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        run();
      }, Math.max(0, delayMs));
      if (typeof timer.unref === "function") timer.unref();
    },
    close() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
  return scheduler;
}

function whatsAppDeliveryRetryDelayMs() {
  const parsed = Number(process.env.ORKESTR_WHATSAPP_DELIVERY_RETRY_MS || 10_000);
  return Number.isFinite(parsed) ? Math.max(1000, parsed) : 10_000;
}
