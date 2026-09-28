// Confirms a WhatsApp Web text send by the id that sendMessage returned.
//
// The history-scan confirmation (re-reading recent chat messages and matching
// our own text) fails when WhatsApp Web chat-history reads are degraded, e.g.
// when fetchMessages returns only the newest message. The send is then
// reported as not confirmed and retried, which posts the same text twice.
// Looking the sent message up by id and reading its ack avoids both: an ack of
// ACK_SERVER (1) or higher means WhatsApp's server accepted the message.

const ACK_ERROR = -1;
const ACK_SERVER = 1;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function sentMessageId(message = {}) {
  const id = message?.id;
  if (typeof id === "string") return id;
  return String(id?._serialized || "").trim();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sendAckConfirmationAttempts(env = process.env) {
  return Math.max(1, positiveInteger(env.ORKESTR_WHATSAPP_SEND_ACK_ATTEMPTS, 8));
}

export function sendAckConfirmationDelayMs(env = process.env) {
  return positiveInteger(env.ORKESTR_WHATSAPP_SEND_ACK_DELAY_MS, 500);
}

// Returns { confirmed: message } when the server acked the message,
// { failed: true } when WhatsApp marked it as an error, and { unknown: true }
// when the id cannot be looked up or the ack never arrived.
export async function confirmSentMessageById(client, sentMessage, env = process.env) {
  const id = sentMessageId(sentMessage);
  if (!id || typeof client?.getMessageById !== "function") return { unknown: true, reason: "lookup_unavailable" };
  const attempts = sendAckConfirmationAttempts(env);
  const delayMs = sendAckConfirmationDelayMs(env);
  let lastAck = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const stored = await client.getMessageById(id).catch(() => null);
    const ack = Number(stored?.ack ?? sentMessage?.ack);
    if (Number.isFinite(ack)) lastAck = ack;
    if (stored && stored.fromMe !== false && Number.isFinite(ack)) {
      if (ack >= ACK_SERVER) return { confirmed: stored, ack };
      if (ack === ACK_ERROR) return { failed: true, ack };
    }
    if (attempt < attempts && delayMs > 0) await wait(delayMs);
  }
  return { unknown: true, reason: "ack_not_received", ack: lastAck };
}
