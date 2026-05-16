import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { runNextAgentMessage, runNextThreadMessage } from "../packages/core/src/executors.js";
import { listAgentMessages } from "../packages/core/src/messages.js";
import { getSetupStatus } from "../packages/core/src/setup.js";
import { appendThreadMessage, createThread, listThreadMessages } from "../packages/core/src/threads.js";
import { deliverWhatsAppReplies, getWhatsAppStatus, routeWhatsAppInbound } from "../packages/connectors/src/whatsapp.js";
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

test("whatsapp status reports not configured without bridge URL", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-empty-"));
  const status = await getWhatsAppStatus({ ORKESTR_HOME: home });
  assert.equal(status.state, "not_configured");
});

test("whatsapp status reports paired from health readiness", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-ready-"));
  const env = { ORKESTR_HOME: home };
  await writeConnectorConfig("whatsapp", { bridgeUrl: "http://wa.local" }, env);

  const status = await getWhatsAppStatus(env, async (url) => {
    assert.equal(url.pathname, "/health");
    return response({ ok: true, ready: true });
  });

  assert.equal(status.state, "paired");
});

test("whatsapp status reports qr needed when health is reachable and qr exists", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-qr-"));
  const env = { ORKESTR_HOME: home };
  await writeConnectorConfig("whatsapp", { bridgeUrl: "http://wa.local/" }, env);

  const status = await getWhatsAppStatus(env, async (url) => {
    if (url.pathname === "/health") return response({ ok: true, ready: false });
    if (url.pathname === "/qr.svg") return response({}, true, 200);
    throw new Error(`unexpected ${url.pathname}`);
  });

  assert.equal(status.state, "qr_needed");
  assert.equal(status.qrUrl, "http://wa.local/qr.svg");
});

test("whatsapp setup status maps unreachable bridge to broken", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-broken-"));
  const env = { ORKESTR_HOME: home, WHATSAPP_BRIDGE_URL: "http://127.0.0.1:1" };
  const setup = await getSetupStatus({ env, home });
  const whatsapp = setup.connectors.find((connector) => connector.id === "whatsapp");

  assert.equal(whatsapp.state, "broken");
});

test("whatsapp inbound events route to configured agent and dedupe by event id", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-inbound-"));
  const env = { ORKESTR_HOME: home };
  await writeConnectorConfig("whatsapp", { routes: { "chat-1": "agent-1" } }, env);

  const first = await routeWhatsAppInbound(
    {
      eventId: "wa-evt-1",
      chatId: "chat-1",
      from: "sender-1",
      text: "Please check this",
      attachments: [{ kind: "image", path: "/tmp/image.png" }],
    },
    env,
  );
  const second = await routeWhatsAppInbound({ eventId: "wa-evt-1", chatId: "chat-1", text: "duplicate" }, env);
  const messages = await listAgentMessages("agent-1", env);

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.messageId, first.message.id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].source, "whatsapp_inbound");
  assert.equal(messages[0].externalId, "wa-evt-1");
  assert.equal(messages[0].chatId, "chat-1");
  assert.equal(messages[0].from, "sender-1");
  assert.equal(messages[0].attachments[0].kind, "image");
});

test("whatsapp inbound endpoint accepts direct agent target", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-api-"));
  const priorHome = process.env.ORKESTR_HOME;
  process.env.ORKESTR_HOME = home;
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/connectors/whatsapp/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventId: "wa-api-1", agentId: "agent-api", text: "hello from WhatsApp" }),
    });
    const payload = await response.json();
    const messages = await listAgentMessages("agent-api", { ORKESTR_HOME: home });

    assert.equal(response.status, 202);
    assert.equal(payload.duplicate, false);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].text, "hello from WhatsApp");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
  }
});

test("whatsapp delivery mirrors assistant replies once to the source chat", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-deliver-"));
  const env = { ORKESTR_HOME: home };
  await writeConnectorConfig("whatsapp", { bridgeUrl: "http://wa.local", apiToken: "secret-token" }, env);
  await routeWhatsAppInbound(
    { eventId: "wa-deliver-1", agentId: "agent-deliver", chatId: "chat-1", accountId: "main", text: "status?" },
    env,
  );
  await runNextAgentMessage("agent-deliver", { executorId: "noop" }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-1"] });
  });
  const duplicate = await deliverWhatsAppReplies(env, async () => {
    throw new Error("should not resend");
  });

  assert.equal(delivery.delivered.length, 1);
  assert.equal(delivery.failed.length, 0);
  assert.equal(duplicate.delivered.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/send-text");
  assert.equal(calls[0].options.headers.authorization, "Bearer secret-token");
  assert.equal(calls[0].body.to, "chat-1");
  assert.equal(calls[0].body.accountId, "main");
  assert.match(calls[0].body.text, /No-op executor received/);
});

test("whatsapp inbound can route directly to a thread and mirror its reply once", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-thread-"));
  const env = { ORKESTR_HOME: home };
  await createThread({ id: "thread-wa", name: "WA Thread", executorId: "noop" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-thread": "thread-wa" },
  }, env);

  const routed = await routeWhatsAppInbound({ eventId: "wa-thread-1", chatId: "chat-thread", text: "thread status?" }, env);
  await runNextThreadMessage("thread-wa", {}, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-thread"] });
  });
  const duplicate = await deliverWhatsAppReplies(env, async () => {
    throw new Error("should not resend");
  });
  const messages = await listThreadMessages("thread-wa", env);

  assert.equal(routed.threadId, "thread-wa");
  assert.equal(messages.length, 2);
  assert.equal(delivery.delivered.length, 1);
  assert.equal(duplicate.delivered.length, 0);
  assert.equal(calls[0].url.pathname, "/send-text");
  assert.equal(calls[0].body.to, "chat-thread");
});

test("whatsapp inbound routes through enabled thread bindings", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-binding-"));
  const env = { ORKESTR_HOME: home };
  await createThread({
    id: "bound-thread",
    name: "Bound Thread",
    binding: {
      connector: "whatsapp",
      chatId: "chat-bound",
      displayName: "Bound Chat",
      enabled: true,
      outboundAccountId: "bound-account",
    },
  }, env);

  const routed = await routeWhatsAppInbound({ eventId: "wa-bound-1", chatId: "chat-bound", text: "bound message" }, env);
  const messages = await listThreadMessages("bound-thread", env);

  assert.equal(routed.threadId, "bound-thread");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].connector, "whatsapp");
  assert.equal(messages[0].accountId, "bound-account");
});

test("whatsapp delivery skips duplicate live Codex answers for the same chat", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-duplicate-reply-"));
  const env = { ORKESTR_HOME: home };
  await createThread({ id: "thread-duplicate-wa", name: "Duplicate WA Thread" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-duplicate": "thread-duplicate-wa" },
  }, env);
  const routed = await routeWhatsAppInbound({ eventId: "wa-duplicate-1", chatId: "chat-duplicate", text: "question" }, env);
  for (let index = 0; index < 2; index += 1) {
    await appendThreadMessage("thread-duplicate-wa", {
      role: "assistant",
      source: "codex-rollout",
      phase: "final_answer",
      state: "completed",
      text: "same answer",
      parentMessageId: routed.message.id,
      connector: "whatsapp",
      chatId: "chat-duplicate",
    }, env);
  }

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-duplicate"] });
  });

  assert.equal(delivery.delivered.length, 1);
  assert.equal(delivery.skipped.some((item) => item.reason === "duplicate_text"), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.text, "same answer");
});
