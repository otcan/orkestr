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

test("a stored send with a late server ack is treated as sent and never resent", async () => {
  const client = degradedHistoryClient({ acks: [0] });
  const sent = await sendWhatsAppTextWithConfirmation({ client, chatId: "chat@g.us", text: "report", maxAttempts: 2, retryDelayMs: 0, env: FAST });
  assert.equal(client.calls.send, 1, "a message already handed to WhatsApp must not be sent twice");
  assert.equal(sent.ack, 0);
});

test("a send missing from the store keeps the retry for false-positive sends", async () => {
  const client = degradedHistoryClient();
  client.getMessageById = async () => { throw new Error("r"); };
  await assert.rejects(
    sendWhatsAppTextWithConfirmation({ client, chatId: "chat@g.us", text: "report", maxAttempts: 2, retryDelayMs: 0, env: { ...FAST, ORKESTR_WHATSAPP_RESEND_UNCONFIRMED: "1" } }),
    /whatsapp_send_not_confirmed/,
  );
  assert.equal(client.calls.send, 2);
});

test("by default an unverifiable send with a message id is not resent", async () => {
  const client = degradedHistoryClient();
  client.getMessageById = async () => { throw new Error("r"); };
  const sent = await sendWhatsAppTextWithConfirmation({ client, chatId: "chat@g.us", text: "report", maxAttempts: 2, retryDelayMs: 0, env: FAST });
  assert.equal(client.calls.send, 1);
  assert.match(sent.id._serialized, /SENT1$/);
});

test("id confirmation distinguishes unavailable, missing, failed and pending lookups", async () => {
  assert.deepEqual(await confirmSentMessageById({}, { id: { _serialized: "x" } }, FAST), { unknown: true, reason: "lookup_unavailable" });
  const pending = degradedHistoryClient({ acks: [0] });
  const result = await confirmSentMessageById(pending, { id: { _serialized: "x" } }, FAST);
  assert.equal(result.reason, "ack_pending");
  assert.ok(result.stored);
  assert.equal(pending.calls.lookups, 4);
  const broken = { async getMessageById() { throw new TypeError("r"); } };
  const failedLookup = await confirmSentMessageById(broken, { id: { _serialized: "x" } }, FAST);
  assert.equal(failedLookup.reason, "lookup_failed");
  assert.match(failedLookup.lookupError, /TypeError: r/);
  const missing = await confirmSentMessageById({ async getMessageById() { return null; } }, { id: { _serialized: "x" } }, FAST);
  assert.equal(missing.reason, "not_found");
  const foreign = degradedHistoryClient({ acks: [3], fromMe: false });
  assert.equal((await confirmSentMessageById(foreign, { id: { _serialized: "x" } }, FAST)).unknown, true);
});

// Production shape: sendMessage returns only { fromMe, remote, id } and the
// message is found through the WhatsApp Web store by its local id.
function localIdOnlyClient({ ack = 1 } = {}) {
  const calls = { send: 0, storeLookups: 0 };
  return {
    calls,
    async sendMessage(chatId) {
      calls.send += 1;
      return { id: { fromMe: true, remote: chatId, id: `3EB0LOCAL${calls.send}` } };
    },
    async getChatById() { return { async fetchMessages() { return []; } }; },
    pupPage: {
      async evaluate(_fn, first, second) {
        if (String(first).startsWith("3EB0LOCAL")) {
          calls.storeLookups += 1;
          return { id: { id: first, _serialized: `true_${second}_${first}`, remote: second }, fromMe: true, ack, body: "report" };
        }
        return { found: true, unreadCount: 0, messages: [] };
      },
    },
  };
}

test("a send returning only a local id is confirmed through the browser store", async () => {
  const acked = localIdOnlyClient({ ack: 1 });
  const sent = await sendWhatsAppTextWithConfirmation({ client: acked, chatId: "chat@g.us", text: "report", maxAttempts: 2, retryDelayMs: 0, env: FAST });
  assert.equal(acked.calls.send, 1);
  assert.ok(acked.calls.storeLookups >= 1);
  assert.equal(sent.ack, 1);

  const pending = localIdOnlyClient({ ack: 0 });
  await sendWhatsAppTextWithConfirmation({ client: pending, chatId: "chat@g.us", text: "report", maxAttempts: 2, retryDelayMs: 0, env: FAST });
  assert.equal(pending.calls.send, 1, "stored but unacked must not be resent");
});
