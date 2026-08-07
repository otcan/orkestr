import assert from "node:assert/strict";
import test from "node:test";
import { buildMessageIndex } from "../packages/core/src/router-doctor-indexes.js";

function clean(value = "") {
  return String(value || "").trim();
}

function lower(value = "") {
  return clean(value).toLowerCase();
}

function user(id, chatId, createdAt) {
  return { id, role: "user", connector: "whatsapp", chatId, createdAt, state: "completed" };
}

function assistant(id, chatId, createdAt) {
  return { id, role: "assistant", connector: "whatsapp", chatId, createdAt, state: "completed" };
}

function deliveredAssistant(message = {}) {
  return message.role === "assistant" &&
    lower(message.deliveryState) !== "failed" &&
    (["completed", "delivered", ""].includes(lower(message.state)) ||
      ["completed", "delivered", ""].includes(lower(message.deliveryState)));
}

function whatsappUser(message = {}) {
  return message.role === "user" && (
    lower(message.connector) === "whatsapp" ||
    ["whatsapp", "whatsapp_inbound", "whatsapp_client"].includes(lower(message.source)) ||
    lower(message.originSurface) === "whatsapp"
  );
}

function sameChat(left = {}, right = {}) {
  const leftChat = clean(left.chatId);
  const rightChat = clean(right.chatId);
  return !leftChat || !rightChat || leftChat === rightChat;
}

function exactChat(left = {}, right = {}) {
  const leftChat = clean(left.chatId);
  const rightChat = clean(right.chatId);
  return leftChat && rightChat && leftChat === rightChat;
}

function blankChat(message = {}) {
  return !clean(message.chatId);
}

function referenceIndex(messages = []) {
  return {
    newerAssistant(message = {}) {
      const start = messages.indexOf(message);
      const later = start >= 0 ? messages.slice(start + 1) : [];
      if (!clean(message.chatId)) return later.find(deliveredAssistant) || null;
      return later.find((item) => deliveredAssistant(item) && exactChat(item, message)) ||
        later.find((item) => deliveredAssistant(item) && blankChat(item)) ||
        null;
    },
    olderAssistant(message = {}) {
      const start = messages.indexOf(message);
      const prior = start >= 0 ? messages.slice(0, start).reverse() : [];
      if (!clean(message.chatId)) return prior.find(deliveredAssistant) || null;
      return prior.find((item) => deliveredAssistant(item) && exactChat(item, message)) ||
        prior.find((item) => deliveredAssistant(item) && blankChat(item)) ||
        null;
    },
    newerWhatsAppUser(message = {}) {
      const start = messages.indexOf(message);
      const later = start >= 0 ? messages.slice(start + 1) : [];
      if (!clean(message.chatId)) return later.find(whatsappUser) || null;
      return later.find((item) => whatsappUser(item) && exactChat(item, message)) ||
        later.find((item) => whatsappUser(item) && blankChat(item)) ||
        null;
    },
  };
}

function assertEquivalent(messages) {
  const actual = buildMessageIndex(messages);
  const expected = referenceIndex(messages);
  for (const message of messages) {
    assert.equal(actual.newerAssistant(message)?.id || null, expected.newerAssistant(message)?.id || null, `newerAssistant for ${message.id}`);
    assert.equal(actual.olderAssistant(message)?.id || null, expected.olderAssistant(message)?.id || null, `olderAssistant for ${message.id}`);
    assert.equal(actual.newerWhatsAppUser(message)?.id || null, expected.newerWhatsAppUser(message)?.id || null, `newerWhatsAppUser for ${message.id}`);
  }
}

test("router doctor message index preserves persisted-order assistant fallback semantics", () => {
  const target = user("user-1", "chat-a", "2026-06-01T10:00:00.000Z");
  const firstLater = assistant("assistant-first-later", "chat-a", "2026-06-01T10:00:10.000Z");
  const nearestLater = assistant("assistant-nearest-later", "chat-a", "2026-06-01T10:00:01.000Z");
  const lastPrior = assistant("assistant-last-prior", "chat-a", "2026-06-01T09:59:00.000Z");
  const nearestPrior = assistant("assistant-nearest-prior", "chat-a", "2026-06-01T09:59:59.000Z");
  const messages = [nearestPrior, lastPrior, target, firstLater, nearestLater];
  const index = buildMessageIndex(messages);

  assert.equal(index.newerAssistant(target), firstLater);
  assert.equal(index.olderAssistant(target), lastPrior);
  assertEquivalent(messages);
});

test("router doctor message index keeps exact chat before blank-chat fallback", () => {
  const target = user("user-chat", "chat-a", "2026-06-01T10:00:00.000Z");
  const blankLater = assistant("assistant-blank-later", "", "2026-06-01T10:00:01.000Z");
  const exactLater = assistant("assistant-exact-later", "chat-a", "2026-06-01T10:00:02.000Z");
  const blankTarget = user("user-blank", "", "2026-06-01T10:00:00.000Z");
  const otherLater = assistant("assistant-other-later", "chat-b", "2026-06-01T10:00:03.000Z");
  const messages = [target, blankLater, exactLater, blankTarget, otherLater];
  const index = buildMessageIndex(messages);

  assert.equal(index.newerAssistant(target), exactLater);
  assert.equal(index.newerAssistant(blankTarget), otherLater);
  assert.equal(sameChat(blankLater, target), true);
  assertEquivalent(messages);
});

test("router doctor message index preserves newer WhatsApp user persisted-order semantics", () => {
  const target = user("user-target", "chat-a", "2026-06-01T10:00:00.000Z");
  const firstLater = user("user-first-later", "chat-a", "2026-06-01T10:00:10.000Z");
  const nearestLater = user("user-nearest-later", "chat-a", "2026-06-01T10:00:01.000Z");
  const messages = [target, firstLater, nearestLater];
  const index = buildMessageIndex(messages);

  assert.equal(index.newerWhatsAppUser(target), firstLater);
  assertEquivalent(messages);
});

test("router doctor message index does not collide same-object lookups with empty or duplicate ids", () => {
  const first = user("", "chat-a", "2026-06-01T10:00:00.000Z");
  const second = user("", "chat-a", "2026-06-01T10:00:01.000Z");
  const duplicateA = user("duplicate", "chat-a", "2026-06-01T10:00:02.000Z");
  const duplicateB = user("duplicate", "chat-a", "2026-06-01T10:00:03.000Z");
  const messages = [first, second, duplicateA, duplicateB];
  const index = buildMessageIndex(messages);

  assert.equal(index.newerWhatsAppUser(first), second);
  assert.equal(index.newerWhatsAppUser(second), duplicateA);
  assert.equal(index.newerWhatsAppUser(duplicateA), duplicateB);
  assert.equal(index.newerWhatsAppUser(duplicateB), null);
  assertEquivalent(messages);
});

test("router doctor message index matches randomized persisted-order reference", () => {
  const chats = ["", "chat-a", "chat-b", "chat-c"];
  const roles = ["user", "assistant"];
  let seed = 123456789;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };

  for (let round = 0; round < 80; round += 1) {
    const messages = [];
    for (let index = 0; index < 45; index += 1) {
      const role = roles[Math.floor(random() * roles.length)];
      const chatId = chats[Math.floor(random() * chats.length)];
      const id = random() < 0.12 ? "" : random() < 0.2 ? "duplicate" : `${role}-${round}-${index}`;
      const createdAt = new Date(Date.UTC(2026, 5, 1, 10, Math.floor(random() * 10), Math.floor(random() * 60))).toISOString();
      const message = role === "assistant" ? assistant(id, chatId, createdAt) : user(id, chatId, createdAt);
      if (role === "user" && random() < 0.25) message.source = "whatsapp_inbound";
      if (role === "assistant" && random() < 0.08) message.deliveryState = "failed";
      messages.push(message);
    }
    assertEquivalent(messages);
  }
});
