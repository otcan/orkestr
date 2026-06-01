import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeOrkestrEvent,
  orkestrEventIdempotencyKey,
  turnLifecycleEventName,
} from "../packages/core/src/orkestr-events.js";

test("Orkestr event contract normalizes legacy and idempotent events", () => {
  assert.equal(turnLifecycleEventName("started"), "turn_lifecycle_started");
  assert.equal(turnLifecycleEventName(""), "turn_lifecycle_event");

  const event = {
    type: " whatsapp.mirror.delivered ",
    threadId: " thread-1 ",
    messageId: " message-1 ",
    turnId: " turn-1 ",
    connector: " whatsapp ",
    chatId: " chat-1 ",
    deliveryType: " final ",
  };

  assert.equal(
    orkestrEventIdempotencyKey(event),
    "whatsapp.mirror.delivered|thread-1|message-1|turn-1|whatsapp|chat-1|final",
  );
  assert.deepEqual(normalizeOrkestrEvent(event), {
    ...event,
    type: "whatsapp.mirror.delivered",
    threadId: "thread-1",
    messageId: "message-1",
    turnId: "turn-1",
    idempotencyKey: "whatsapp.mirror.delivered|thread-1|message-1|turn-1|whatsapp|chat-1|final",
  });
});
