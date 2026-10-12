// In-memory WhatsApp transport for tests and demos. It never talks to
// WhatsApp or the network. It models the behaviours the real transports must
// share: idempotent start/stop, pairing, at-least-once inbound with ack, and
// at-most-once send per idempotency key.
import {
  TransportContractError,
  assertTransportShape,
  normalizeInboundEvent,
  validateSendRequest,
} from "./contract.js";

export function createFakeTransport({ accountId = "fake-account", pairingKind = "qr", now = () => Date.now() } = {}) {
  let state = "idle";
  let since = now();
  let handler = null;
  let paired = false;
  let seq = 0;
  const pending = []; // inbound events not yet acked by the handler
  const sent = new Map(); // idempotencyKey -> result
  const outbox = []; // what "WhatsApp" received, in order
  let sendBehaviour = () => "sent";

  function setState(next) {
    if (state !== next) since = now();
    state = next;
  }

  async function drain() {
    if (!handler || state !== "ready") return;
    while (pending.length) {
      const event = pending[0];
      try {
        await handler(event);
      } catch {
        return; // not acked; redelivered on the next drain
      }
      pending.shift();
    }
  }

  const transport = {
    id: "fake",
    capabilities: { qrPairing: pairingKind === "qr", phonePairing: pairingKind === "code", groups: false, media: false, history: false },
    async status() {
      return { state, accountId, since };
    },
    async start() {
      if (state === "ready" || state === "pairing" || state === "starting") return transport.status();
      setState(paired ? "ready" : "pairing");
      await drain();
      return transport.status();
    },
    async stop() {
      if (state !== "stopped") setState("stopped");
      return transport.status();
    },
    async pairing() {
      if (state !== "pairing") return { kind: "none" };
      return pairingKind === "qr" ? { kind: "qr", data: `fake-qr:${accountId}` } : { kind: pairingKind };
    },
    onInbound(next) {
      if (typeof next !== "function") throw new TransportContractError("inbound_handler_invalid");
      handler = next;
    },
    async send(request) {
      const { chatId, text, idempotencyKey } = validateSendRequest(request);
      if (sent.has(idempotencyKey)) return sent.get(idempotencyKey);
      if (state !== "ready") return { state: "rejected", reason: `transport_${state}` };
      const outcome = sendBehaviour({ chatId, text, idempotencyKey });
      const result = outcome === "sent" || outcome === "stored"
        ? { state: outcome, messageId: `fake-out-${outbox.length + 1}` }
        : { state: outcome };
      if (outcome === "sent" || outcome === "stored") outbox.push({ chatId, text, idempotencyKey, messageId: result.messageId });
      sent.set(idempotencyKey, result);
      return result;
    },

    // ---- Test controls (not part of the contract) ------------------------
    async completePairing() {
      paired = true;
      if (state === "pairing") setState("ready");
      await drain();
    },
    async disconnect() {
      setState("disconnected");
    },
    async reconnect() {
      setState(paired ? "ready" : "pairing");
      await drain();
    },
    async deliverInbound(fields) {
      seq += 1;
      const event = normalizeInboundEvent({ transportId: "fake", accountId, timestamp: now(), transportSeq: seq, ...fields });
      pending.push(event);
      await drain();
      return event;
    },
    // Re-sends an already acked event, as a gateway or reconnect might.
    async redeliver(event) {
      pending.push(event);
      await drain();
    },
    setSendBehaviour(next) {
      sendBehaviour = next;
    },
    get outbox() {
      return outbox.slice();
    },
    get pendingInbound() {
      return pending.length;
    },
  };
  return assertTransportShape(transport);
}
