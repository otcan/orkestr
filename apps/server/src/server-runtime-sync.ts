import {
  consumeThreadConnectorDeliverySignalCount,
  drainAllPendingThreadInputs,
  safeResetThreadRuntime,
  syncRuntimeLeases,
} from "../../../packages/core/src/runtime-leases.js";
import { markDueTimers } from "../../../packages/core/src/timers.js";
import { runDueGmailNotifications } from "../../../packages/core/src/gmail-notifications.js";
import { recoverStaleCodexAppServerTurns } from "../../../packages/core/src/codex-app-server.js";
import { deployDrainActiveSync } from "../../../packages/core/src/deploy-drain.js";
import { deliverWhatsAppReplies, syncWhatsAppTypingIndicators } from "../../../packages/connectors/src/whatsapp.js";
import {
  recoverConfiguredLocalWhatsAppAccounts,
  recoverUnreadLocalWhatsAppMessages,
} from "../../../packages/connectors/src/whatsapp-local-bridge.js";
import { reportServerError, reportWhatsAppDeliveryAnomalies } from "./watcher-reporting.js";

export function runtimeMonitorIntervalMs() {
  const parsed = Number(process.env.ORKESTR_RUNTIME_MONITOR_INTERVAL_MS || 5000);
  return Number.isFinite(parsed) ? Math.max(5000, parsed) : 5000;
}

export function paneProgressMonitorIntervalMs() {
  const parsed = Number(process.env.ORKESTR_PANE_PROGRESS_INTERVAL_MS || 1000);
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
  if (deployDrainActiveSync(env)) {
    return { deferred: true, reason: "deploy_draining" };
  }
  await drainAllPendingThreadInputs(env).catch(() => []);
  return syncRuntimeAndDeliverWhatsApp(env, { forceWhatsapp: true, recoveryCause: "orkestr_restart" });
}

export async function runTimerLoop(
  env = process.env,
  syncImpl: (options?: { forceWhatsapp?: boolean; recoveryCause?: string }) => Promise<any> =
    (options = {}) => syncRuntimeAndDeliverWhatsApp(env, options),
) {
  const dueTimers = await markDueTimers(env);
  const gmailNotificationRuns = await runDueGmailNotifications(env);
  const drained = await drainAllPendingThreadInputs(env);
  const deliveredCount = drained.reduce((count: number, result: any) => count + Number(result?.delivered?.length || 0), 0);
  const gmailDeliveredCount = gmailNotificationRuns.reduce((count: number, result: any) => count + Number(result?.run?.delivered?.length || 0), 0);
  if (dueTimers.length || gmailDeliveredCount > 0 || deliveredCount > 0 || drained.length > 0) {
    await syncImpl({ forceWhatsapp: true });
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

async function syncRuntimeAndDeliverWhatsApp(env = process.env, options: { forceWhatsapp?: boolean; recoveryCause?: string } = {}) {
  const pendingConnectorDeliveries = consumeThreadConnectorDeliverySignalCount();
  const synced = await syncRuntimeLeases(env);
  const recovered = await recoverStaleCodexAppServerTurns(env, {
    noticeCause: options.recoveryCause,
    autoSafeResetThread: (threadId: string, context: Record<string, unknown> = {}) =>
      safeResetThreadRuntime(threadId, { reason: String(context.reason || "stale_turn_auto_safe_reset") }, env),
  }).catch((error) => {
    reportServerError(env, {
      source: "server.recoverCodexAppServerTurns",
      code: "codex_app_server_recovery_failed",
      message: error?.message || String(error),
      error,
    });
    return { recovered: 0, appended: 0 };
  });
  await recoverConfiguredLocalWhatsAppAccounts(env).catch((error) => {
    reportServerError(env, {
      source: "server.recoverWhatsAppAccounts",
      code: "whatsapp_account_recovery_failed",
      message: error?.message || String(error),
      error,
    });
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
  if (options.forceWhatsapp || appended > 0 || connectorDeliveries > 0 || Number(unreadRecovery.routed || 0) > 0) {
    const delivery = await deliverWhatsAppReplies(env).catch((error) => {
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
  return { ...synced, appended, recoveredAppServerTurns: recovered.recovered || 0 };
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
  const run = () => {
    if (running) {
      rerunRequested = true;
      return;
    }
    running = true;
    deliverWhatsAppReplies(env)
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
          scheduler.schedule(retryDelayMs);
        }
      })
      .catch((error) => {
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
