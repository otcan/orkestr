const clean = (value = "") => String(value || "").trim();

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.floor(parsed)));
}

// Pump cadence belongs to the delivery worker rather than listener routing so
// deployments can inspect and tune the worker without loading listener logic.
export function mailboxThreadDeliveryPumpIntervalMs(env = process.env) {
  return boundedInteger(env.ORKESTR_MAILBOX_THREAD_DELIVERY_PUMP_INTERVAL_MS, 5_000, 1_000, 5 * 60_000);
}

export function mailboxThreadDeliveryPumpLimit(env = process.env) {
  return boundedInteger(env.ORKESTR_MAILBOX_THREAD_DELIVERY_PUMP_LIMIT, 25, 1, 100);
}

export function mailboxThreadDeliveryPumpLeaseMs(env = process.env) {
  return boundedInteger(env.ORKESTR_MAILBOX_THREAD_DELIVERY_PUMP_LEASE_MS, 30_000, 5_000, 5 * 60_000);
}

export function mailboxPumpRunKey(env = process.env) {
  return clean(env.ORKESTR_THREAD_RESOURCE_POLICY_DB || env.ORKESTR_HOME || "default");
}
