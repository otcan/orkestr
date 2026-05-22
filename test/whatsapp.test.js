import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { runNextAgentMessage, runNextThreadMessage } from "../packages/core/src/executors.js";
import { listAgentMessages } from "../packages/core/src/messages.js";
import { getSetupStatus } from "../packages/core/src/setup.js";
import { appendThreadMessage, createThread, enqueueThreadInput, listThreadMessages, updateThreadMessage } from "../packages/core/src/threads.js";
import { deliverWhatsAppReplies, formatWhatsAppOutboundText, getWhatsAppChatParticipants, getWhatsAppStatus, mapLocalWhatsAppStatusFromHealth, routeWhatsAppInbound } from "../packages/connectors/src/whatsapp.js";
import { listLocalWhatsAppChats, localWhatsAppAccountIdsForEnv, reduceLocalWhatsAppBridgeState, startLocalWhatsAppAccount } from "../packages/connectors/src/whatsapp-local-bridge.js";
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

test("whatsapp status defaults to the built-in local bridge", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-empty-"));
  const status = await getWhatsAppStatus({ ORKESTR_HOME: home });
  assert.equal(status.state, "unpaired");
  assert.equal(status.mode, "local");
  assert.equal(status.bridgeUrl, "/api/connectors/whatsapp/bridge");
  assert.equal(status.accounts.length, 2);
});

test("whatsapp status keeps the integrated local bridge as the default", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-local-first-"));
  const status = await getWhatsAppStatus(
    { ORKESTR_HOME: home, WHATSAPP_BRIDGE_URL: "http://wa.local" },
    async () => {
      throw new Error("external bridge should not be called in local mode");
    },
  );

  assert.equal(status.state, "unpaired");
  assert.equal(status.mode, "local");
  assert.equal(status.bridgeUrl, "/api/connectors/whatsapp/bridge");
  assert.equal(status.accounts.length, 2);
});

test("local whatsapp bridge supports configured account ids", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-configured-accounts-"));
  const env = { ORKESTR_HOME: home, ORKESTR_WHATSAPP_ACCOUNT_IDS: "main,openclaw" };

  assert.deepEqual(localWhatsAppAccountIdsForEnv(env), ["main", "openclaw"]);

  const status = await getWhatsAppStatus(env);

  assert.equal(status.state, "unpaired");
  assert.equal(status.mode, "local");
  assert.deepEqual(status.accounts.map((account) => account.accountId), ["main", "openclaw"]);
  assert.deepEqual(status.accounts.map((account) => account.label), ["main", "openclaw"]);
});

test("local whatsapp bridge maps public account ids to existing LocalAuth client ids", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-configured-client-ids-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "main,openclaw",
    ORKESTR_WHATSAPP_ACCOUNT_CLIENT_IDS: "main:codex-whatsapp,openclaw:codex-whatsapp-openclaw",
    ORKESTR_WHATSAPP_ACCOUNT_SESSION_ROOTS: "main:/state/main,openclaw:/state/openclaw",
  };

  const status = await getWhatsAppStatus(env);

  assert.deepEqual(status.accounts.map((account) => account.accountId), ["main", "openclaw"]);
  assert.deepEqual(status.accounts.map((account) => account.clientId), ["codex-whatsapp", "codex-whatsapp-openclaw"]);
  assert.deepEqual(status.accounts.map((account) => account.sessionRoot), ["/state/main", "/state/openclaw"]);
});

test("local whatsapp known chats include stored thread bindings while bridge is idle", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-known-chats-"));
  const env = { ORKESTR_HOME: home };
  await createThread({
    id: "known-wa-thread",
    name: "Known WA Thread",
    binding: {
      connector: "whatsapp",
      chatId: "120363000000000000@g.us",
      displayName: "Known Group",
      outboundAccountId: "account-1",
      updatedAt: "2026-05-18T03:00:00.000Z",
    },
  }, env);
  await createThread({
    id: "legacy-wa-thread",
    name: "Legacy WA Thread",
    binding: {
      connector: "whatsapp",
      chatId: "120363111111111111@g.us",
      displayName: "Legacy Group",
      outboundAccountId: "legacy-account",
    },
  }, env);

  const account1 = await listLocalWhatsAppChats("account-1", env);
  const account2 = await listLocalWhatsAppChats("account-2", env);

  assert.equal(account1.ready, false);
  assert.deepEqual(account1.chats.map((chat) => chat.name), ["Known Group", "Legacy Group"]);
  assert.deepEqual(account2.chats.map((chat) => chat.name), ["Legacy Group"]);
});

test("local whatsapp known chats honor configured responder account ids", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-known-configured-"));
  const env = { ORKESTR_HOME: home, ORKESTR_WHATSAPP_ACCOUNT_IDS: "main,openclaw" };
  await createThread({
    id: "known-openclaw-thread",
    name: "Known OpenClaw Thread",
    binding: {
      connector: "whatsapp",
      chatId: "120363222222222222@g.us",
      displayName: "OpenClaw Group",
      outboundAccountId: "openclaw",
    },
  }, env);

  const main = await listLocalWhatsAppChats("main", env);
  const openclaw = await listLocalWhatsAppChats("openclaw", env);

  assert.deepEqual(main.chats.map((chat) => chat.name), []);
  assert.deepEqual(openclaw.chats.map((chat) => chat.name), ["OpenClaw Group"]);
});

test("local whatsapp phone pairing validates phone numbers before browser launch", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-phone-invalid-"));
  await assert.rejects(
    startLocalWhatsAppAccount("account-1", { ORKESTR_HOME: home }, { phoneNumber: "+++" }),
    /whatsapp_pairing_phone_number_invalid/,
  );
});

test("local whatsapp phone pairing accepts configured account ids", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-phone-configured-invalid-"));
  await assert.rejects(
    startLocalWhatsAppAccount("openclaw", { ORKESTR_HOME: home, ORKESTR_WHATSAPP_ACCOUNT_IDS: "main,openclaw" }, { phoneNumber: "+++" }),
    /whatsapp_pairing_phone_number_invalid/,
  );
});

test("local whatsapp status keeps authenticated sessions in a partial setup state", async () => {
  const health = {
    ok: true,
    mode: "local",
    state: reduceLocalWhatsAppBridgeState([
      { accountId: "account-1", state: "authenticated", authenticated: true, ready: false },
      { accountId: "account-2", state: "idle", authenticated: false, ready: false },
    ]),
    ready: false,
    accounts: [
      { accountId: "account-1", state: "authenticated", authenticated: true, ready: false },
      { accountId: "account-2", state: "idle", authenticated: false, ready: false },
    ],
  };

  const status = mapLocalWhatsAppStatusFromHealth(health);

  assert.equal(health.state, "authenticated");
  assert.equal(status.state, "authenticating");
  assert.match(status.summary, /waiting for WhatsApp Web/i);
});

test("local whatsapp status reports auth-to-ready timeouts as failures", async () => {
  const error = "WhatsApp authenticated but did not become ready within 180s.";
  const health = {
    ok: true,
    mode: "local",
    state: reduceLocalWhatsAppBridgeState([
      { accountId: "account-1", state: "auth_ready_timeout", authenticated: true, ready: false, error },
      { accountId: "account-2", state: "idle", authenticated: false, ready: false },
    ]),
    ready: false,
    accounts: [
      { accountId: "account-1", state: "auth_ready_timeout", authenticated: true, ready: false, error },
      { accountId: "account-2", state: "idle", authenticated: false, ready: false },
    ],
  };

  const status = mapLocalWhatsAppStatusFromHealth(health);

  assert.equal(health.state, "failed");
  assert.equal(status.state, "unreachable");
  assert.equal(status.summary, error);
});

test("whatsapp status reports paired from health readiness", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-ready-"));
  const env = { ORKESTR_HOME: home };
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, env);

  const status = await getWhatsAppStatus(env, async (url) => {
    assert.equal(url.pathname, "/health");
    return response({ ok: true, ready: true });
  });

  assert.equal(status.state, "paired");
});

test("whatsapp status discovers external bridge accounts from dashboard", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-dashboard-"));
  const env = { ORKESTR_HOME: home };
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, env);

  const status = await getWhatsAppStatus(env, async (url) => {
    if (url.pathname === "/health") return response({ ok: true, ready: true });
    if (url.pathname === "/api/dashboard") {
      return response({
        ok: true,
        accounts: [
          { id: "main", label: "Main account", ready: true, state: "ready" },
          { id: "assistant", label: "Assistant account", ready: true, state: "ready" },
        ],
      });
    }
    throw new Error(`unexpected ${url.pathname}`);
  });

  assert.equal(status.state, "paired");
  assert.deepEqual(status.accounts.map((account) => account.id), ["main", "assistant"]);
});

test("whatsapp participants are discovered from external bridge chat metadata", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-participants-"));
  const env = { ORKESTR_HOME: home };
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, env);

  const result = await getWhatsAppChatParticipants({ accountId: "main", chatId: "chat-meta" }, env, async (url) => {
    assert.equal(url.pathname, "/api/chats/chat-meta/meta");
    return response({
      ok: true,
      chatId: "chat-meta",
      isGroup: true,
      groupMetadata: {
        participants: [
          { id: "491111111111@c.us", name: "Saved Main", isAdmin: true },
          { id: { _serialized: "492222222222@c.us" }, pushname: "Saved Other", isSuperAdmin: true },
        ],
      },
    });
  });

  assert.equal(result.ready, true);
  assert.deepEqual(result.participants.map((participant) => participant.id), ["491111111111@c.us", "492222222222@c.us"]);
  assert.deepEqual(result.participants.map((participant) => participant.name), ["Saved Main", "Saved Other"]);
});

test("whatsapp status reports qr needed when health is reachable and qr exists", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-qr-"));
  const env = { ORKESTR_HOME: home };
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local/" }, env);

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
  const env = { ORKESTR_HOME: home, WHATSAPP_BRIDGE_MODE: "external", WHATSAPP_BRIDGE_URL: "http://127.0.0.1:1" };
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
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local", apiToken: "secret-token" }, env);
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
    bridgeMode: "external",
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

test("whatsapp inbound suppresses duplicate active thread inputs by content", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-thread-active-duplicate-"));
  const env = { ORKESTR_HOME: home };
  await createThread({ id: "thread-wa-active-duplicate", name: "WA Active Duplicate Thread" }, env);
  await writeConnectorConfig("whatsapp", {
    threadRoutes: { "chat-active-duplicate": "thread-wa-active-duplicate" },
  }, env);

  const first = await routeWhatsAppInbound({ eventId: "wa-active-1", chatId: "chat-active-duplicate", from: "sender-1", text: "same queued work" }, env);
  const second = await routeWhatsAppInbound({ eventId: "wa-active-2", chatId: "chat-active-duplicate", from: "sender-1", text: "same queued work" }, env);
  const messages = await listThreadMessages("thread-wa-active-duplicate", env);

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.event.messageId, first.message.id);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].state, "queued");
});

test("whatsapp delivery translates markdown into chat-friendly formatting", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-markdown-reply-"));
  const env = { ORKESTR_HOME: home };
  await createThread({ id: "thread-wa-markdown", name: "WA Markdown Thread" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-markdown": "thread-wa-markdown" },
  }, env);

  const routed = await routeWhatsAppInbound({ eventId: "wa-markdown-1", chatId: "chat-markdown", text: "deploy?" }, env);
  const markdown = [
    "### Deploy target",
    "",
    "**Deploy latest into the orkestr-vps VM, by pulling/restarting the Docker container there.**",
    "",
    "[Demo URL](https://orkestr-demo.example.com)",
    "",
    "`**literal**` stays code.",
  ].join("\n");
  await appendThreadMessage("thread-wa-markdown", {
    role: "assistant",
    source: "codex-rollout",
    phase: "final_answer",
    state: "completed",
    text: markdown,
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-markdown",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-markdown"] });
  });
  const messages = await listThreadMessages("thread-wa-markdown", env);

  assert.equal(delivery.delivered.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.text, [
    "Deploy target",
    "",
    "*Deploy latest into the orkestr-vps VM, by pulling/restarting the Docker container there.*",
    "",
    "Demo URL: https://orkestr-demo.example.com",
    "",
    "`**literal**` stays code.",
  ].join("\n"));
  assert.equal(messages.at(-1).text, markdown);
});

test("whatsapp outbound formatting preserves fenced code blocks", () => {
  assert.equal(
    formatWhatsAppOutboundText("Before **bold**\n\n```\n**not bold**\n```\n\nAfter **bold**"),
    "Before *bold*\n\n```\n**not bold**\n```\n\nAfter *bold*",
  );
});

test("whatsapp outbound formatting strips proposed plan envelopes", () => {
  assert.equal(
    formatWhatsAppOutboundText("<proposed_plan>\n# Plan\n\n**Do it**\n</proposed_plan>"),
    "Plan\n\n*Do it*",
  );
  assert.equal(
    formatWhatsAppOutboundText("The literal `<proposed_plan>` tag should remain visible."),
    "The literal `<proposed_plan>` tag should remain visible.",
  );
});

test("whatsapp delivery does not mirror proposed plans as final answers", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-proposed-plan-"));
  const env = { ORKESTR_HOME: home };
  await createThread({ id: "thread-wa-proposed-plan", name: "WA Proposed Plan Thread" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-proposed-plan": "thread-wa-proposed-plan" },
  }, env);

  const routed = await routeWhatsAppInbound({ eventId: "wa-proposed-plan-1", chatId: "chat-proposed-plan", text: "plan it" }, env);
  await appendThreadMessage("thread-wa-proposed-plan", {
    role: "assistant",
    source: "codex-rollout",
    phase: "final_answer",
    state: "completed",
    text: "<proposed_plan>\n# Plan\n\nDo it\n</proposed_plan>",
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-proposed-plan",
  }, env);

  const delivery = await deliverWhatsAppReplies(env, async () => {
    throw new Error("should not mirror proposed plan");
  });

  assert.equal(delivery.delivered.length, 0);
  assert.equal(delivery.skipped.length, 0);
});

test("whatsapp delivery forwards failed WhatsApp-origin thread inputs once", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-failed-input-"));
  const env = { ORKESTR_HOME: home };
  await createThread({ id: "thread-wa-failed-input", name: "WA Failed Input Thread" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-failed-input": "thread-wa-failed-input" },
  }, env);

  const routed = await routeWhatsAppInbound({ eventId: "wa-failed-input-1", chatId: "chat-failed-input", text: "/now broken" }, env);
  await updateThreadMessage("thread-wa-failed-input", routed.message.id, {
    state: "failed",
    deliveryState: "failed",
    error: "Command failed: tmux send-keys -t %580 C-m can't find pane: %580",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-failed-input"] });
  });
  const duplicate = await deliverWhatsAppReplies(env, async () => {
    throw new Error("should not resend failed input notice");
  });

  assert.equal(delivery.delivered.length, 1);
  assert.equal(delivery.delivered[0].deliveryType, "delivery_error");
  assert.equal(duplicate.delivered.length, 0);
  assert.equal(calls[0].body.to, "chat-failed-input");
  assert.match(calls[0].body.text, /^Delivery failed\n\nYour message could not be delivered to Codex\./);
  assert.match(calls[0].body.text, /can't find pane: %580/);
});

test("whatsapp delivery reports queued mode switches without marking the input delivered", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-mode-queued-"));
  const env = { ORKESTR_HOME: home };
  await createThread({ id: "thread-wa-mode-queued", name: "WA Mode Queued Thread" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-mode-queued": "thread-wa-mode-queued" },
  }, env);
  const message = await appendThreadMessage("thread-wa-mode-queued", {
    role: "user",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-mode-queued",
    accountId: "account-1",
    text: "/code",
    state: "queued",
    deliveryState: "waiting_runtime_ready",
    observedVia: "orkestr_codex_mode_queued",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-mode-queued"] });
  });
  const messages = await listThreadMessages("thread-wa-mode-queued", env);

  assert.equal(delivery.delivered.length, 1);
  assert.equal(delivery.delivered[0].deliveryType, "mode_queued");
  assert.equal(delivery.delivered[0].sourceMessageId, message.id);
  assert.equal(calls[0].body.to, "chat-mode-queued");
  assert.match(calls[0].body.text, /switch to code when Codex is ready/);
  assert.equal(messages.find((entry) => entry.id === message.id).state, "queued");
});

test("whatsapp delivery forwards failed routed inputs using inbound event metadata", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-failed-input-event-"));
  const env = { ORKESTR_HOME: home };
  await createThread({ id: "thread-wa-failed-input-event", name: "WA Failed Input Event" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-failed-input-event": "thread-wa-failed-input-event" },
  }, env);

  const routed = await routeWhatsAppInbound({
    eventId: "wa-failed-input-event-1",
    chatId: "chat-failed-input-event",
    accountId: "main",
    text: "hi",
  }, env);
  await updateThreadMessage("thread-wa-failed-input-event", routed.message.id, {
    source: "",
    connector: "",
    chatId: "",
    accountId: "",
    state: "failed",
    deliveryState: "failed",
    error: "Message was pasted into Codex but was not accepted/submitted. Orkestr stopped retrying to avoid duplicate input.",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-failed-input-event"] });
  });

  assert.equal(delivery.delivered.length, 1);
  assert.equal(delivery.delivered[0].deliveryType, "delivery_error");
  assert.equal(calls[0].body.to, "chat-failed-input-event");
  assert.equal(calls[0].body.accountId, "main");
  assert.match(calls[0].body.text, /^Delivery failed\n\nYour message could not be delivered to Codex\./);
  assert.match(calls[0].body.text, /pasted into Codex but was not accepted/);
});

test("whatsapp passive mirror recovers a failed thread input instead of sending a failure notice", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-passive-failed-recover-"));
  const env = { ORKESTR_HOME: home };
  await createThread({ id: "thread-wa-passive-failed-recover", name: "WA Passive Failed Recover" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-passive-failed": "thread-wa-passive-failed-recover" },
  }, env);

  const routed = await routeWhatsAppInbound({ eventId: "wa-passive-failed-1", chatId: "chat-passive-failed", text: "status?" }, env);
  await updateThreadMessage("thread-wa-passive-failed-recover", routed.message.id, {
    state: "failed",
    deliveryState: "failed",
    error: "runtime_not_ready",
  }, env);
  const reply = await appendThreadMessage("thread-wa-passive-failed-recover", {
    role: "assistant",
    source: "codex-rollout",
    phase: "final_answer",
    state: "completed",
    text: "The status is clean.",
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-passive-failed",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-passive-failed"] });
  });
  const messages = await listThreadMessages("thread-wa-passive-failed-recover", env);
  const parent = messages.find((entry) => entry.id === routed.message.id);

  assert.equal(delivery.delivered.length, 1);
  assert.equal(delivery.delivered[0].messageId, reply.id);
  assert.equal(delivery.skipped.some((item) => item.reason === "assistant_reply_available"), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.text, "The status is clean.");
  assert.doesNotMatch(calls[0].body.text, /^Delivery failed/);
  assert.equal(parent.state, "completed");
  assert.equal(parent.deliveryState, "delivered");
  assert.equal(parent.observedVia, "whatsapp_passive_mirror_delivery");
  assert.equal(parent.passiveMirrorMessageId, reply.id);
  assert.equal(parent.error, null);
});

test("whatsapp passive mirror completes a running thread input when the reply is delivered", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-passive-running-complete-"));
  const env = { ORKESTR_HOME: home };
  await createThread({ id: "thread-wa-passive-running-complete", name: "WA Passive Running Complete" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-passive-running": "thread-wa-passive-running-complete" },
  }, env);

  const routed = await routeWhatsAppInbound({ eventId: "wa-passive-running-1", chatId: "chat-passive-running", text: "what changed?" }, env);
  await updateThreadMessage("thread-wa-passive-running-complete", routed.message.id, {
    state: "running",
    deliveryState: "awaiting_ack",
  }, env);
  const reply = await appendThreadMessage("thread-wa-passive-running-complete", {
    role: "assistant",
    source: "codex-rollout",
    phase: "final_answer",
    state: "completed",
    text: "It changed successfully.",
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-passive-running",
  }, env);

  const delivery = await deliverWhatsAppReplies(env, async () => response({ ok: true, ids: ["sent-passive-running"] }));
  const messages = await listThreadMessages("thread-wa-passive-running-complete", env);
  const parent = messages.find((entry) => entry.id === routed.message.id);

  assert.equal(delivery.delivered.length, 1);
  assert.equal(delivery.delivered[0].messageId, reply.id);
  assert.equal(parent.state, "completed");
  assert.equal(parent.deliveryState, "delivered");
  assert.equal(parent.passiveMirrorMessageId, reply.id);
});

test("whatsapp delivery mirrors pane interruption notices", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-interruption-notice-"));
  const env = { ORKESTR_HOME: home };
  await createThread({ id: "thread-wa-interruption-notice", name: "WA Interruption Notice" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-interruption": "thread-wa-interruption-notice" },
  }, env);
  const inbound = await appendThreadMessage("thread-wa-interruption-notice", {
    role: "user",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-interruption",
    accountId: "account-1",
    text: "run it",
    state: "completed",
  }, env);
  await appendThreadMessage("thread-wa-interruption-notice", {
    role: "assistant",
    source: "orkestr_runtime",
    phase: "runtime_interrupted",
    state: "completed",
    text: "Codex pane interrupted\n\nOrkestr could not confirm the previous input reached Codex.",
    parentMessageId: inbound.id,
    connector: "whatsapp",
    chatId: "chat-interruption",
    accountId: "account-1",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-interruption"] });
  });

  assert.equal(delivery.delivered.length, 1);
  assert.equal(calls[0].body.to, "chat-interruption");
  assert.match(calls[0].body.text, /^Codex pane interrupted/);
});

test("whatsapp delivery does not forward local failed inputs", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-local-failed-input-"));
  const env = { ORKESTR_HOME: home };
  await createThread({ id: "thread-local-failed-input", name: "Local Failed Input Thread" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
  }, env);
  await appendThreadMessage("thread-local-failed-input", {
    role: "user",
    source: "browser",
    state: "failed",
    deliveryState: "failed",
    text: "local failure",
    error: "local only",
  }, env);

  const delivery = await deliverWhatsAppReplies(env, async () => {
    throw new Error("should not send local failures to WhatsApp");
  });

  assert.equal(delivery.delivered.length, 0);
  assert.equal(delivery.failed.length, 0);
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

test("direct whatsapp thread inputs inherit binding delivery metadata", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-direct-binding-"));
  const env = { ORKESTR_HOME: home };
  await createThread({
    id: "direct-wa-thread",
    name: "Direct WA Thread",
    binding: {
      connector: "whatsapp",
      chatId: "chat-direct",
      displayName: "Direct Chat",
      enabled: true,
      responderAccountId: "openclaw",
      outboundAccountId: "openclaw",
    },
  }, env);

  const message = await enqueueThreadInput("direct-wa-thread", { source: "whatsapp", text: "legacy direct input" }, env);

  assert.equal(message.connector, "whatsapp");
  assert.equal(message.chatId, "chat-direct");
  assert.equal(message.accountId, "openclaw");
});

test("generated whatsapp bindings listen to the selected sender and answer as the responder", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-generated-binding-"));
  const env = { ORKESTR_HOME: home };
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, env);
  await createThread({
    id: "generated-thread",
    name: "Generated Thread",
    binding: {
      connector: "whatsapp",
      chatId: "chat-generated",
      displayName: "Generated Chat",
      enabled: true,
      allowOtherPeople: false,
      senderAccountId: "account-1",
      responderAccountId: "account-2",
      outboundAccountId: "account-2",
      senderContactId: "491111111111@c.us",
      responderContactId: "492222222222@c.us",
    },
  }, env);

  await assert.rejects(
    () => routeWhatsAppInbound({ eventId: "wa-generated-ignored", chatId: "chat-generated", accountId: "account-1", fromMe: false, text: "not selected" }, env),
    /whatsapp_target_required/,
  );

  const routedViaResponder = await routeWhatsAppInbound({
    eventId: "wa-generated-responder-sees-sender",
    chatId: "chat-generated",
    accountId: "account-2",
    from: "491111111111@c.us",
    fromMe: false,
    text: "selected sender via responder",
  }, env);
  const routed = await routeWhatsAppInbound({ eventId: "wa-generated-routed", chatId: "chat-generated", accountId: "account-1", fromMe: true, text: "selected sender" }, env);
  await appendThreadMessage("generated-thread", {
    role: "assistant",
    source: "codex-rollout",
    phase: "final_answer",
    state: "completed",
    text: "generated reply",
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-generated",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-generated"] });
  });

  assert.equal(routedViaResponder.threadId, "generated-thread");
  assert.equal(routed.threadId, "generated-thread");
  assert.equal(delivery.delivered.length, 1);
  assert.equal(calls[0].body.to, "chat-generated");
  assert.equal(calls[0].body.accountId, "account-2");
});

test("legacy allowOtherPeople does not enable additional participants without confirmation", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-additional-confirm-"));
  const env = { ORKESTR_HOME: home };
  await createThread({
    id: "legacy-additional-thread",
    name: "Legacy Additional Thread",
    binding: {
      connector: "whatsapp",
      chatId: "chat-additional",
      displayName: "Additional Chat",
      enabled: true,
      allowOtherPeople: true,
      senderAccountId: "account-1",
      responderAccountId: "account-2",
    },
  }, env);

  await assert.rejects(
    () => routeWhatsAppInbound({ eventId: "wa-additional-legacy", chatId: "chat-additional", accountId: "account-1", fromMe: false, text: "legacy allowed?" }, env),
    /whatsapp_target_required/,
  );
});

test("additional participants require an explicit selected participant", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-additional-selected-"));
  const env = { ORKESTR_HOME: home };
  await createThread({
    id: "selected-additional-thread",
    name: "Selected Additional Thread",
    binding: {
      connector: "whatsapp",
      chatId: "chat-selected",
      displayName: "Selected Chat",
      enabled: true,
      allowOtherPeople: true,
      additionalParticipantsEnabled: true,
      additionalParticipantIds: ["491111111111@c.us"],
      senderAccountId: "account-1",
      responderAccountId: "account-2",
      responderContactId: "492222222222@c.us",
    },
  }, env);

  await assert.rejects(
    () => routeWhatsAppInbound({ eventId: "wa-additional-rejected", chatId: "chat-selected", accountId: "account-1", from: "493333333333@c.us", fromMe: false, text: "not selected" }, env),
    /whatsapp_target_required/,
  );
  await assert.rejects(
    () => routeWhatsAppInbound({ eventId: "wa-additional-responder", chatId: "chat-selected", accountId: "account-1", from: "492222222222@c.us", fromMe: false, text: "responder" }, env),
    /whatsapp_target_required/,
  );

  const routed = await routeWhatsAppInbound({ eventId: "wa-additional-selected", chatId: "chat-selected", accountId: "account-1", from: "491111111111@c.us", fromMe: false, text: "selected allowed" }, env);

  assert.equal(routed.threadId, "selected-additional-thread");
});

test("whatsapp delivery respects thread binding mirroring toggle", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-mirror-toggle-"));
  const env = { ORKESTR_HOME: home };
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, env);
  await createThread({
    id: "mirror-off-thread",
    name: "Mirror Off Thread",
    executorId: "noop",
    binding: {
      connector: "whatsapp",
      chatId: "chat-mirror-off",
      displayName: "Mirror Off Chat",
      enabled: true,
      mirrorToWhatsApp: false,
    },
  }, env);

  const routed = await routeWhatsAppInbound({ eventId: "wa-mirror-off-1", chatId: "chat-mirror-off", text: "hello" }, env);
  await runNextThreadMessage("mirror-off-thread", {}, env);
  const delivery = await deliverWhatsAppReplies(env, async () => {
    throw new Error("should not send when mirroring is disabled");
  });

  assert.equal(routed.threadId, "mirror-off-thread");
  assert.equal(delivery.delivered.length, 0);
  assert.equal(delivery.failed.length, 0);
  assert.equal(delivery.skipped.some((item) => item.reason === "mirroring_disabled"), true);
});

test("whatsapp delivery skips duplicate live Codex answers for the same chat", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-duplicate-reply-"));
  const env = { ORKESTR_HOME: home };
  await createThread({ id: "thread-duplicate-wa", name: "Duplicate WA Thread" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
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
