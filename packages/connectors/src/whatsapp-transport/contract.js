// WhatsApp transport contract shared by the self-hosted local bridge (mode A)
// and the invitation-only managed gateway (mode B). See
// docs/spec/whatsapp-docker-onboarding.md, section 3.1.
//
// Nothing is wired to this yet; adapters and the fake transport implement it
// so routing, outbox, dedupe and replay safety can be shared.

export const TRANSPORT_IDS = Object.freeze(["local-bridge", "gateway", "fake"]);

export const TRANSPORT_STATES = Object.freeze([
  "idle",
  "starting",
  "pairing",
  "ready",
  "disconnected",
  "degraded",
  "revoked",
  "failed",
  "stopped",
]);

// "stored" = handed to WhatsApp but not yet acknowledged; never resent.
// "uncertain" = may or may not have been sent; never resent automatically.
export const SEND_STATES = Object.freeze(["sent", "stored", "uncertain", "rejected"]);

export const PAIRING_KINDS = Object.freeze(["qr", "code", "token", "none"]);

const requiredMethods = ["status", "start", "stop", "pairing", "onInbound", "send"];
const capabilityKeys = ["qrPairing", "phonePairing", "groups", "media", "history"];

export class TransportContractError extends Error {
  constructor(code, detail = "") {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

// Structural check of a transport object; throws TransportContractError.
export function assertTransportShape(transport) {
  if (!transport || typeof transport !== "object") throw new TransportContractError("transport_invalid");
  if (!TRANSPORT_IDS.includes(transport.id)) throw new TransportContractError("transport_id_invalid", String(transport.id));
  const capabilities = transport.capabilities;
  if (!capabilities || typeof capabilities !== "object") throw new TransportContractError("transport_capabilities_missing");
  for (const key of capabilityKeys) {
    if (typeof capabilities[key] !== "boolean") throw new TransportContractError("transport_capability_invalid", key);
  }
  for (const method of requiredMethods) {
    if (typeof transport[method] !== "function") throw new TransportContractError("transport_method_missing", method);
  }
  return transport;
}

function nonEmpty(value, max = 512) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

// Normalizes and validates an inbound event before it enters routing.
export function normalizeInboundEvent(event) {
  if (!event || typeof event !== "object") throw new TransportContractError("inbound_event_invalid");
  for (const key of ["transportId", "accountId", "chatId", "senderId", "messageId"]) {
    if (!nonEmpty(event[key])) throw new TransportContractError("inbound_event_field_invalid", key);
  }
  const timestamp = Number(event.timestamp);
  if (!Number.isFinite(timestamp) || timestamp <= 0) throw new TransportContractError("inbound_event_field_invalid", "timestamp");
  const text = typeof event.text === "string" ? event.text : "";
  const transportSeq = Number.isInteger(event.transportSeq) && event.transportSeq >= 0 ? event.transportSeq : null;
  return {
    transportId: event.transportId,
    accountId: event.accountId,
    chatId: event.chatId,
    senderId: event.senderId,
    messageId: event.messageId,
    timestamp,
    text,
    ...(event.media ? { media: event.media } : {}),
    transportSeq,
  };
}

// Dedupe key for inbound events: the same WhatsApp message delivered twice
// (reconnect, gateway redelivery, restart) maps to the same key.
export function inboundDedupeKey(event) {
  return `${event.transportId}\u0000${event.accountId}\u0000${event.messageId}`;
}

export function validateSendRequest(request) {
  if (!request || typeof request !== "object") throw new TransportContractError("send_request_invalid");
  if (!nonEmpty(request.chatId)) throw new TransportContractError("send_request_field_invalid", "chatId");
  if (!nonEmpty(request.idempotencyKey, 200)) throw new TransportContractError("send_request_field_invalid", "idempotencyKey");
  if (typeof request.text !== "string" || !request.text.trim()) throw new TransportContractError("send_request_field_invalid", "text");
  return { chatId: request.chatId, text: request.text, idempotencyKey: request.idempotencyKey };
}

export function assertSendResult(result) {
  if (!result || !SEND_STATES.includes(result.state)) throw new TransportContractError("send_result_invalid", String(result?.state));
  return result;
}

export function assertStatus(status) {
  if (!status || !TRANSPORT_STATES.includes(status.state)) throw new TransportContractError("status_invalid", String(status?.state));
  return status;
}
