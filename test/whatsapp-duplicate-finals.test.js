import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendThreadMessage, createThread, listThreadMessages } from "../packages/core/src/threads.js";
import { deliverWhatsAppReplies, routeWhatsAppInbound } from "../packages/connectors/src/whatsapp.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";

function response(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() {
      return payload;
    },
  };
}

function externalBridgeEnv(home, extra = {}) {
  return {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1",
    ORKESTR_WHATSAPP_DEBUG_FOOTER: "0",
    ORKESTR_WHATSAPP_API_AGENT_AUTORUN: "0",
    ...extra,
  };
}

test("whatsapp delivery sends repeated final text for separate user turns", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-repeat-final-"));
  const env = externalBridgeEnv(home);
  await createThread({
    id: "repeat-final-thread",
    name: "Repeat Final Thread",
    binding: {
      connector: "whatsapp",
      chatId: "chat-repeat-final",
      enabled: true,
      outboundAccountId: "wa-1",
    },
  }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-repeat-final": "repeat-final-thread" },
  }, env);

  const first = await routeWhatsAppInbound({ eventId: "wa-repeat-final-1", chatId: "chat-repeat-final", text: "first" }, env);
  await appendThreadMessage("repeat-final-thread", {
    role: "assistant",
    source: "api-agent",
    phase: "final_answer",
    state: "completed",
    text: "I couldn't complete this request right now. Please try again in a moment.",
    parentMessageId: first.message.id,
    connector: "whatsapp",
    chatId: "chat-repeat-final",
  }, env);

  const calls = [];
  const firstDelivery = await deliverWhatsAppReplies(env, async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return response({ ok: true, ids: ["sent-repeat-final-1"] });
  });
  let messages = await listThreadMessages("repeat-final-thread", env);
  assert.equal(firstDelivery.delivered.length, 1);
  assert.equal(messages.find((message) => message.id === first.message.id)?.deliveryState, "delivered");

  const second = await routeWhatsAppInbound({ eventId: "wa-repeat-final-2", chatId: "chat-repeat-final", text: "second" }, env);
  await appendThreadMessage("repeat-final-thread", {
    role: "assistant",
    source: "api-agent",
    phase: "final_answer",
    state: "completed",
    text: "I couldn't complete this request right now. Please try again in a moment.",
    parentMessageId: second.message.id,
    connector: "whatsapp",
    chatId: "chat-repeat-final",
  }, env);

  const secondDelivery = await deliverWhatsAppReplies(env, async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return response({ ok: true, ids: ["sent-repeat-final-2"] });
  });
  messages = await listThreadMessages("repeat-final-thread", env);

  assert.equal(secondDelivery.delivered.length, 1);
  assert.equal(secondDelivery.delivered[0].parentMessageId, second.message.id);
  assert.equal(messages.find((message) => message.id === second.message.id)?.deliveryState, "delivered");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.text), [
    "I couldn't complete this request right now. Please try again in a moment.",
    "I couldn't complete this request right now. Please try again in a moment.",
  ]);
});
