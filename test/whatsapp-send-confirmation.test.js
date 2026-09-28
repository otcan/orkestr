import assert from "node:assert/strict";
import test from "node:test";
import { sendWhatsAppTextWithConfirmation } from "../packages/connectors/src/whatsapp-local-bridge.js";
import { confirmSentMessageById } from "../packages/connectors/src/whatsapp-send-confirmation.js";

const FAST = {
  ORKESTR_WHATSAPP_SEND_ACK_ATTEMPTS: "4",
  ORKESTR_WHATSAPP_SEND_ACK_DELAY_MS: "0",
  ORKESTR_WHATSAPP_SEND_CONFIRMATION_ATTEMPTS: "1",
  ORKESTR_WHATSAPP_SEND_CONFIRMATION_DELAY_MS: "0",
};

// Chat history that only ever returns an unrelated newest message, like the
// degraded WhatsApp Web history reads seen in production.
function degradedHistoryClient({ acks = [1], fromMe = true } = {}) {
  const calls = { send: 0, lookups: 0 };
  return {
    calls,
    async sendMessage(chatId, text) {
      calls.send += 1;
      return { id: { _serialized: `true_${chatId}_SENT${calls.send}` }, body: text, fromMe: true, ack: 0 };
    },
    async getMessageById(id) {
      const ack = acks[Math.min(calls.lookups, acks.length - 1)];
      calls.lookups += 1;
      return { id: { _serialized: id }, fromMe, ack };
    },
    async getChatById() {
      return { async fetchMessages() { return [{ fromMe: false, body: "someone else", timestamp: Math.floor(Date.now() / 1000) }]; } };
    },
  };
}

test("a server-acked send is confirmed by id even when chat history is degraded", async () => {
  const client = degradedHistoryClient({ acks: [0, 0, 1] });
  const sent = await sendWhatsAppTextWithConfirmation({ client, chatId: "chat@g.us", text: "report", retryDelayMs: 0, env: FAST });
  assert.equal(client.calls.send, 1, "must not resend a message the server acknowledged");
  assert.equal(sent.ack, 1);
  assert.match(sent.id._serialized, /SENT1$/);
});

test("an errored ack is not confirmed and keeps the existing retry behaviour", async () => {
  const client = degradedHistoryClient({ acks: [-1] });
  await assert.rejects(
    sendWhatsAppTextWithConfirmation({ client, chatId: "chat@g.us", text: "report", maxAttempts: 2, retryDelayMs: 0, env: FAST }),
    /whatsapp_send_not_confirmed/,
  );
  assert.equal(client.calls.send, 2);
});

test("id confirmation reports unknown without a lookup API or a server ack", async () => {
  assert.deepEqual(await confirmSentMessageById({}, { id: { _serialized: "x" } }, FAST), { unknown: true, reason: "lookup_unavailable" });
  const pending = degradedHistoryClient({ acks: [0] });
  const result = await confirmSentMessageById(pending, { id: { _serialized: "x" } }, FAST);
  assert.equal(result.unknown, true);
  assert.equal(result.reason, "ack_not_received");
  assert.equal(pending.calls.lookups, 4);
  const foreign = degradedHistoryClient({ acks: [3], fromMe: false });
  assert.equal((await confirmSentMessageById(foreign, { id: { _serialized: "x" } }, FAST)).unknown, true);
});
