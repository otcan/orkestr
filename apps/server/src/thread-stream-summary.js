function positiveNumber(value, fallback, minimum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}

function summaryStreamMaxBufferedBytes(env = process.env) {
  return positiveNumber(env.ORKESTR_SUMMARY_STREAM_MAX_BUFFERED_BYTES, 1024 * 1024, 64 * 1024);
}

export function summaryStreamMaxBackpressureMs(env = process.env) {
  return positiveNumber(env.ORKESTR_SUMMARY_STREAM_MAX_BACKPRESSURE_MS, 60_000, 10_000);
}

export function summaryStreamClientBackpressured(ws = {}, env = process.env) {
  const pendingBytes = Math.max(Number(ws.bufferedAmount || 0), Number(ws._socket?.writableLength || 0));
  return pendingBytes >= summaryStreamMaxBufferedBytes(env);
}

function stableRuntimeSummary(runtime) {
  if (!runtime || typeof runtime !== "object") return runtime || null;
  const {
    heartbeatAt,
    updatedAt,
    operatorRolloutSyncedAt,
    progress,
    liveness,
    deliveryRecovery,
    ...stable
  } = runtime;
  const stableLiveness = liveness && typeof liveness === "object"
    ? (({ lastEvidenceAt, updatedAt, ...value }) => value)(liveness)
    : liveness;
  const stableDeliveryRecovery = deliveryRecovery && typeof deliveryRecovery === "object"
    ? (({ checkedAt, ...value }) => value)(deliveryRecovery)
    : deliveryRecovery;
  const normalized = {
    ...stable,
    ...(stableLiveness ? { liveness: stableLiveness } : {}),
    ...(stableDeliveryRecovery ? { deliveryRecovery: stableDeliveryRecovery } : {}),
  };
  if (!progress || typeof progress !== "object") return normalized;
  const { capturedAt, sampledAtMs, ...stableProgress } = progress;
  return { ...normalized, progress: stableProgress };
}

export function stableSummaryBody(payload = {}) {
  const threads = (payload.threads || []).map((thread) => {
    const { updatedAt, threadUpdatedAt, runtime, progress, progressCapturedAt, ...stable } = thread;
    if (!progress || typeof progress !== "object") return { ...stable, runtime: stableRuntimeSummary(runtime) };
    const { capturedAt, sampledAtMs, ...stableProgress } = progress;
    return { ...stable, progress: stableProgress, runtime: stableRuntimeSummary(runtime) };
  });
  return JSON.stringify(threads);
}
