import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { appendThreadMessage, createThread } from "../packages/core/src/threads.js";
import { deliverWhatsAppReplies, routeWhatsAppInbound, syncWhatsAppTypingIndicators } from "../packages/connectors/src/whatsapp.js";
import {
  resetExternalWhatsAppTypingForTest,
  setExternalWhatsAppTyping,
  syncExternalWhatsAppTypingTargets,
} from "../packages/connectors/src/whatsapp-typing.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";

afterEach(() => resetExternalWhatsAppTypingForTest());

test("external WhatsApp typing refreshes desired targets and clears removed targets", async () => {
  const calls = [];
  const env = { ORKESTR_HOME: "/tmp/orkestr-typing-test", ORKESTR_CONNECTORS_MCP_URL: "http://mcp.test/mcp" };
  const callTool = async (tool, input) => {
    calls.push({ tool, input });
    const active = input.typing_state === "composing";
    return {
      status: active ? "active" : "inactive",
      scope: { account_id: input.account_id, conversation_id: input.conversation_id },
      data: { active },
    };
  };
  const target = { accountId: "sender", chatId: "jobs@g.us", threadId: "jobs" };

  const started = await syncExternalWhatsAppTypingTargets([target], env, { callTool });
  const kept = await syncExternalWhatsAppTypingTargets([target], env, { callTool });
  const stopped = await syncExternalWhatsAppTypingTargets([], env, { callTool });

  assert.equal(started.started.length, 1);
  assert.equal(kept.kept.length, 1);
  assert.equal(stopped.stopped.length, 1);
  assert.deepEqual(calls.map((call) => call.input.typing_state), ["composing", "composing", "paused"]);
  assert.equal(calls.every((call) => call.tool === "orkestr_messaging"), true);
  assert.equal(calls.every((call) => call.input.action === "set_typing"), true);
});

test("external WhatsApp typing failures are cosmetic and remain out of message delivery", async () => {
  const result = await setExternalWhatsAppTyping({
    accountId: "sender",
    chatId: "jobs@g.us",
    active: true,
    env: { ORKESTR_HOME: "/tmp/orkestr-typing-failure" },
  }, {
    callTool: async () => ({ status: "error", error: { code: "worker_unavailable" } }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "worker_unavailable");
});

test("external WhatsApp typing follows the routed turn lifecycle through MCP", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-external-typing-lifecycle-"));
  const env = {
    ORKESTR_HOME: home,
    WHATSAPP_BRIDGE_MODE: "external",
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1",
    ORKESTR_WHATSAPP_API_AGENT_AUTORUN: "0",
    ORKESTR_CONNECTORS_MCP_URL: "http://mcp.test/mcp",
  };
  await createThread({ id: "external-typing-thread", name: "External typing" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    threadRoutes: { "external-typing@g.us": "external-typing-thread" },
  }, env);
  const routed = await routeWhatsAppInbound({
    eventId: "external-typing-event",
    accountId: "sender",
    chatId: "external-typing@g.us",
    text: "work on this",
  }, env);
  const calls = [];
  const callTool = async (_tool, input) => {
    calls.push(input.typing_state);
    const active = input.typing_state === "composing";
    return { status: active ? "active" : "inactive", data: { active } };
  };

  const working = await syncWhatsAppTypingIndicators(env, {
    statusImpl: async () => ({ state: "working", working: true, typingActive: true }),
    callTool,
  });
  await appendThreadMessage("external-typing-thread", {
    role: "assistant",
    source: "codex-app-server",
    phase: "final_answer",
    state: "completed",
    text: "Done.",
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "external-typing@g.us",
  }, env);
  const completed = await syncWhatsAppTypingIndicators(env, {
    statusImpl: async () => ({ state: "ready", working: false, typingActive: false }),
    callTool,
  });

  assert.equal(working.active, 1);
  assert.equal(completed.active, 0);
  assert.deepEqual(calls, ["composing", "paused"]);
});

test("typing scan cannot hide a new SQLite-backed final from delivery", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-typing-final-cache-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_THREAD_STORE: "sqlite",
    WHATSAPP_BRIDGE_MODE: "external",
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1",
  };
  await createThread({ id: "typing-final-cache-thread", name: "Typing final cache" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.test",
    threadRoutes: { "typing-final-cache@g.us": "typing-final-cache-thread" },
  }, env);
  const routed = await routeWhatsAppInbound({
    eventId: "typing-final-cache-event",
    accountId: "sender",
    chatId: "typing-final-cache@g.us",
    text: "finish this",
  }, env);
  const final = await appendThreadMessage("typing-final-cache-thread", {
    role: "assistant",
    source: "codex-rollout",
    phase: "final_answer",
    state: "completed",
    text: "Final must be delivered immediately.",
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "typing-final-cache@g.us",
    accountId: "sender",
  }, env);

  await syncWhatsAppTypingIndicators(env, {
    statusImpl: async () => ({ state: "ready", working: false, typingActive: false }),
    syncImpl: async (targets) => ({ ok: true, active: targets.length, targets }),
  });

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options = {}) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ ok: true, ids: ["sent-final-after-typing"] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  assert.equal(delivery.delivered.length, 1);
  assert.equal(delivery.delivered[0].messageId, final.id);
  assert.equal(delivery.delivered[0].deliveryType, "final");
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.text, /Final must be delivered immediately\./);
});
