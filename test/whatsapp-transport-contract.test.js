import assert from "node:assert/strict";
import test from "node:test";
import {
  TransportContractError,
  assertSendResult,
  assertStatus,
  assertTransportShape,
  inboundDedupeKey,
  normalizeInboundEvent,
  validateSendRequest,
} from "../packages/connectors/src/whatsapp-transport/contract.js";
import { createFakeTransport } from "../packages/connectors/src/whatsapp-transport/fake-transport.js";

// Plan T1/T8 (docs/spec/whatsapp-docker-onboarding.md). Synthetic only.

test("contract rejects transports with a bad id, capabilities, or missing methods", () => {
  const good = createFakeTransport();
  assert.equal(assertTransportShape(good), good);
  assert.throws(() => assertTransportShape(null), TransportContractError);
  assert.throws(() => assertTransportShape({ ...good, id: "other" }), /transport_id_invalid/);
  assert.throws(() => assertTransportShape({ ...good, capabilities: { ...good.capabilities, media: "yes" } }), /transport_capability_invalid: media/);
  const { send, ...noSend } = good;
  assert.throws(() => assertTransportShape(noSend), /transport_method_missing: send/);
});

test("inbound events and send requests are validated", () => {
  const base = { transportId: "fake", accountId: "a", chatId: "c", senderId: "s", messageId: "m1", timestamp: 1 };
  assert.deepEqual(normalizeInboundEvent(base), { ...base, text: "", transportSeq: null });
  for (const key of ["accountId", "chatId", "senderId", "messageId"]) {
    assert.throws(() => normalizeInboundEvent({ ...base, [key]: "" }), new RegExp(`inbound_event_field_invalid: ${key}`));
  }
  assert.throws(() => normalizeInboundEvent({ ...base, timestamp: 0 }), /timestamp/);
  assert.equal(inboundDedupeKey(base), inboundDedupeKey({ ...base, text: "different", transportSeq: 9 }));
  assert.notEqual(inboundDedupeKey(base), inboundDedupeKey({ ...base, accountId: "b" }));
  assert.throws(() => validateSendRequest({ chatId: "c", text: "hi" }), /idempotencyKey/);
  assert.throws(() => validateSendRequest({ chatId: "c", text: "  ", idempotencyKey: "k" }), /text/);
  assert.throws(() => assertSendResult({ state: "maybe" }), /send_result_invalid/);
  assert.throws(() => assertStatus({ state: "weird" }), /status_invalid/);
});

test("start and stop are idempotent and pairing moves to ready", async () => {
  const transport = createFakeTransport({ accountId: "acct" });
  assertStatus(await transport.status());
  assert.equal((await transport.start()).state, "pairing");
  assert.equal((await transport.start()).state, "pairing", "second start is a no-op");
  assert.deepEqual(await transport.pairing(), { kind: "qr", data: "fake-qr:acct" });
  await transport.completePairing();
  assert.equal((await transport.status()).state, "ready");
  assert.deepEqual(await transport.pairing(), { kind: "none" });
  assert.equal((await transport.stop()).state, "stopped");
  assert.equal((await transport.stop()).state, "stopped");
  assert.equal((await transport.start()).state, "ready", "a paired account restarts without pairing again");
});

test("inbound is acked only after the handler succeeds and redelivery is deduped to one reply", async () => {
  const transport = createFakeTransport();
  await transport.start();
  await transport.completePairing();
  const seen = new Set();
  const replies = [];
  let failNext = true;
  transport.onInbound(async (event) => {
    if (failNext) {
      failNext = false;
      throw new Error("durable write failed");
    }
    const key = inboundDedupeKey(event);
    if (seen.has(key)) return; // duplicate: ack without replying again
    seen.add(key);
    replies.push(await transport.send({ chatId: event.chatId, text: `echo ${event.text}`, idempotencyKey: `reply:${key}` }));
  });
  const event = await transport.deliverInbound({ chatId: "chat-1", senderId: "owner", messageId: "wa-1", text: "hi" });
  assert.equal(transport.pendingInbound, 1, "handler failure leaves the event unacked");
  assert.equal(replies.length, 0);
  await transport.reconnect();
  assert.equal(transport.pendingInbound, 0);
  await transport.redeliver(event);
  await transport.redeliver({ ...event, transportSeq: 99 });
  assert.equal(replies.length, 1);
  assert.deepEqual(transport.outbox.map((item) => item.text), ["echo hi"]);
});

test("send is at most once per idempotency key and never resends uncertain sends", async () => {
  const transport = createFakeTransport();
  assert.equal((await transport.send({ chatId: "c", text: "x", idempotencyKey: "k0" })).state, "rejected", "not ready");
  await transport.start();
  await transport.completePairing();
  const first = await transport.send({ chatId: "c", text: "hello", idempotencyKey: "k1" });
  const again = await transport.send({ chatId: "c", text: "hello", idempotencyKey: "k1" });
  assert.deepEqual(again, first);
  assert.equal(transport.outbox.length, 1);
  transport.setSendBehaviour(() => "uncertain");
  assert.equal((await transport.send({ chatId: "c", text: "maybe", idempotencyKey: "k2" })).state, "uncertain");
  transport.setSendBehaviour(() => "sent");
  assert.equal((await transport.send({ chatId: "c", text: "maybe", idempotencyKey: "k2" })).state, "uncertain", "an uncertain send is not retried");
  assert.equal(transport.outbox.length, 1);
  await transport.disconnect();
  assert.equal((await transport.send({ chatId: "c", text: "later", idempotencyKey: "k3" })).state, "rejected");
});
