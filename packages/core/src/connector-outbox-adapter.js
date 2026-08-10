let ensureJob = null;

export function setConnectorOutboxJobAdapter(handler = null) {
  ensureJob = typeof handler === "function" ? handler : null;
}

export async function ensureConnectorOutboxJobThroughAdapter(input = {}, env = process.env) {
  if (!ensureJob) throw Object.assign(new Error("connector_outbox_adapter_unavailable"), { statusCode: 503 });
  return ensureJob(input, env);
}
