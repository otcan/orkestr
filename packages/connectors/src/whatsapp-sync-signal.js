import { clearWhatsAppDeliveryIdleCache } from "./whatsapp.js";

export function whatsAppDeliveryFollowUpDelayMs(env = process.env) {
  const parsed = Number(env.ORKESTR_WHATSAPP_DELIVERY_MIN_INTERVAL_MS || 0);
  const minIntervalMs = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
  return Math.max(1500, Math.min(30000, minIntervalMs + 500));
}

/**
 * @param {{
 *   env?: NodeJS.ProcessEnv;
 *   runRuntimeSync: (options?: { forceWhatsapp?: boolean; recoveryCause?: string }) => Promise<any>;
 *   whatsappDeliveryScheduler: { schedule: (delayMs?: number) => void };
 *   followUpDelayMs?: number;
 *   clearIdleCache?: () => void;
 *   reportError?: (env: NodeJS.ProcessEnv, payload: Record<string, unknown>, options?: Record<string, unknown>) => void;
 * }} options
 */
export function createConnectorRuntimeSyncSignalHandler({
  env = process.env,
  runRuntimeSync,
  whatsappDeliveryScheduler,
  followUpDelayMs = whatsAppDeliveryFollowUpDelayMs(env),
  clearIdleCache = clearWhatsAppDeliveryIdleCache,
  reportError = () => {},
} = {}) {
  if (typeof runRuntimeSync !== "function") throw new Error("runtime_sync_runner_required");
  if (!whatsappDeliveryScheduler || typeof whatsappDeliveryScheduler.schedule !== "function") {
    throw new Error("whatsapp_delivery_scheduler_required");
  }
  let deliveryFollowUpTimer = null;
  let runtimeFollowUpTimer = null;
  const delayMs = Math.max(0, Math.floor(Number(followUpDelayMs) || 0));
  const unrefTimer = (timer) => {
    if (typeof timer.unref === "function") timer.unref();
  };
  const kickRuntimeSync = () => {
    runRuntimeSync({ forceWhatsapp: true }).catch((error) => {
      reportError(env, {
        source: "server.connectorRuntimeSyncSignal",
        code: "connector_runtime_sync_failed",
        message: error?.message || String(error),
        error,
      }, { deliverWatcher: false });
    });
  };
  const scheduleDeliveryFollowUp = () => {
    clearIdleCache();
    if (deliveryFollowUpTimer) clearTimeout(deliveryFollowUpTimer);
    deliveryFollowUpTimer = setTimeout(() => {
      deliveryFollowUpTimer = null;
      whatsappDeliveryScheduler.schedule();
    }, delayMs);
    unrefTimer(deliveryFollowUpTimer);
  };
  const scheduleRuntimeFollowUp = () => {
    if (runtimeFollowUpTimer) clearTimeout(runtimeFollowUpTimer);
    runtimeFollowUpTimer = setTimeout(() => {
      runtimeFollowUpTimer = null;
      kickRuntimeSync();
    }, delayMs);
    unrefTimer(runtimeFollowUpTimer);
  };
  return {
    handleSignal() {
      clearIdleCache();
      whatsappDeliveryScheduler.schedule();
      kickRuntimeSync();
      scheduleDeliveryFollowUp();
      scheduleRuntimeFollowUp();
    },
    close() {
      if (deliveryFollowUpTimer) clearTimeout(deliveryFollowUpTimer);
      if (runtimeFollowUpTimer) clearTimeout(runtimeFollowUpTimer);
      deliveryFollowUpTimer = null;
      runtimeFollowUpTimer = null;
    },
  };
}
