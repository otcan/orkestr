import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { appendThreadMessage, createThread } from "../packages/core/src/threads.js";
import { routeWhatsAppInbound, syncWhatsAppTypingIndicators } from "../packages/connectors/src/whatsapp.js";
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
