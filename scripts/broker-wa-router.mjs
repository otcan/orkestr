import { encryptBrokerClientPayload } from "../packages/core/src/broker-instance-registry.js";

function clean(value = "") {
  return String(value || "").trim();
}

export function brokerBaseUrlFromSetup(setup = {}) {
  return clean(setup?.registration?.brokerBaseUrl);
}

export async function brokerInstanceWhatsAppRequest(setup, route, payload, { env = process.env, fetchImpl = fetch } = {}) {
  const brokerBaseUrl = brokerBaseUrlFromSetup(setup);
  const instanceId = clean(setup?.instanceId || setup?.registration?.instanceId);
  if (!brokerBaseUrl || !instanceId) throw new Error("broker_instance_registration_required");
  const body = await encryptBrokerClientPayload(payload, setup.registration, env);
  const url = new URL(`/api/broker/instances/${encodeURIComponent(instanceId)}/whatsapp/${route}`, brokerBaseUrl);
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) {
    const error = new Error(data?.error || data?.message || `broker_whatsapp_${route}_failed_${response.status}`);
    error.statusCode = response.status;
    error.payload = data;
    throw error;
  }
  return data;
}
