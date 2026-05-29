import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { runNextAgentMessage, runNextThreadMessage } from "../packages/core/src/executors.js";
import { listAgentMessages } from "../packages/core/src/messages.js";
import { getSetupStatus } from "../packages/core/src/setup.js";
import { appendThreadMessage, createThread, enqueueThreadInput, getThread, listThreadMessages, listThreads, updateThreadMessage } from "../packages/core/src/threads.js";
import { deliverWhatsAppReplies, formatWhatsAppOutboundText, getWhatsAppChatParticipants, getWhatsAppStatus, initialQueueDeliveryState, mapLocalWhatsAppStatusFromHealth, routeWhatsAppInbound, syncWhatsAppTypingIndicators } from "../packages/connectors/src/whatsapp.js";
import { listLocalWhatsAppChats, localWhatsAppAccountIdsForEnv, localWhatsAppMessageRouteFields, localWhatsAppReadyFallbackEligible, localWhatsAppTypingClearRetryDelaysMs, localWhatsAppUnreadRecoveryBoundChats, localWhatsAppUnreadRecoveryIntervalMs, normalizeGroupParticipantIds, recoverUnreadLocalWhatsAppMessages, recoverableLocalWhatsAppAccountIds, reduceLocalWhatsAppBridgeState, sendWhatsAppTextWithConfirmation, startLocalWhatsAppAccount, webCacheRoot } from "../packages/connectors/src/whatsapp-local-bridge.js";
import { prepareWhatsAppTableAttachments } from "../packages/connectors/src/whatsapp-table-attachments.js";
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

function stripDebugFooter(text) {
  return String(text || "").replace(/\n\ndbg: .+$/s, "");
}

function assertDebugFooter(text, { mode = "", messageType = "final", model = "[^·\\n]+" } = {}) {
  const escapedModel = model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `\\n\\ndbg: m:${model === "[^·\\n]+" ? model : escapedModel}` +
      (mode ? ` · mode:${mode}` : "") +
      ` · msg:${messageType} · q:\\d+ · cpu:\\d+% · help:/help` +
      (mode === "plan" ? " · switch:/code" : "") +
      "$",
  );
  assert.match(text, pattern);
}

function externalBridgeEnv(home, extra = {}) {
  return {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1",
    ORKESTR_WHATSAPP_DEBUG_FOOTER: "1",
    ...extra,
  };
}

async function externalBridgeEnvWithAllowingSanitizer(home, extra = {}) {
  const script = path.join(home, "allow-sanitizer.mjs");
  await fs.writeFile(
    script,
    [
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  JSON.parse(input);",
      "  console.log(JSON.stringify({ allow: true, reason: 'test-allow', model: 'test-llm' }));",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  return externalBridgeEnv(home, {
    ORKESTR_LLM_SANITIZER_COMMAND_JSON: JSON.stringify([process.execPath, script]),
    ...extra,
  });
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

test("local whatsapp typing clear retries are conservative and configurable", () => {
  assert.deepEqual(localWhatsAppTypingClearRetryDelaysMs({}), [750, 2500, 8000]);
  assert.deepEqual(localWhatsAppTypingClearRetryDelaysMs({ ORKESTR_WHATSAPP_TYPING_CLEAR_RETRY_MS: "100 250,250 0" }), [100, 250, 0]);
  assert.deepEqual(localWhatsAppTypingClearRetryDelaysMs({ WA_TYPING_CLEAR_RETRY_MS: "off" }), []);
  assert.deepEqual(localWhatsAppTypingClearRetryDelaysMs({ WA_TYPING_CLEAR_RETRY_MS: "-1 nope 70000 300" }), [300]);
});

test("local whatsapp ready fallback accepts the WhatsApp 99 percent startup stall", () => {
  assert.equal(localWhatsAppReadyFallbackEligible({ authenticated: true, ready: false, loadingPercent: 99, loadingMessage: "WhatsApp" }), true);
  assert.equal(localWhatsAppReadyFallbackEligible({ authenticated: true, ready: false, loadingPercent: 100, loadingMessage: "WhatsApp" }), true);
  assert.equal(localWhatsAppReadyFallbackEligible({ authenticated: true, ready: false, loadingPercent: 98, loadingMessage: "WhatsApp" }), false);
  assert.equal(localWhatsAppReadyFallbackEligible({ authenticated: true, ready: true, loadingPercent: 99, loadingMessage: "WhatsApp" }), false);
  assert.equal(localWhatsAppReadyFallbackEligible({ authenticated: false, ready: false, loadingPercent: 99, loadingMessage: "WhatsApp" }), false);
  assert.equal(localWhatsAppReadyFallbackEligible({ authenticated: true, ready: false, loadingPercent: 99, loadingMessage: "Loading" }), false);
});

test("stored external whatsapp bridge config is ignored unless the host opts in", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-external-disabled-"));
  const env = { ORKESTR_HOME: home };
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, env);

  const status = await getWhatsAppStatus(env, async () => {
    throw new Error("external bridge should not be called without host opt-in");
  });

  assert.equal(status.state, "unpaired");
  assert.equal(status.mode, "local");
  assert.equal(status.bridgeUrl, "/api/connectors/whatsapp/bridge");
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

test("local whatsapp recovery notifies chat when tenant sanitizer blocks inbound", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-sanitizer-notice-"));
  const chatId = "120363423847331215@g.us";
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
  };
  await createThread({
    id: "otcantest",
    name: "otcantest",
    ownerUserId: "otcan",
    binding: {
      connector: "whatsapp",
      chatId,
      enabled: true,
      responderAccountId: "responder",
      outboundAccountId: "responder",
      allowOtherPeople: true,
    },
  }, env);

  const sent = [];
  let seen = 0;
  const inboundMessage = {
    id: { _serialized: `false_${chatId}_MSG_4917632400662@c.us` },
    from: chatId,
    author: "4917632400662@c.us",
    fromMe: false,
    body: "hi",
    timestamp: 1780070400,
  };
  const chat = {
    id: { _serialized: chatId },
    unreadCount: 1,
    async fetchMessages() {
      return [inboundMessage];
    },
    async sendSeen() {
      seen += 1;
    },
  };
  const client = {
    async getChats() {
      return [chat];
    },
    async sendMessage(to, text) {
      sent.push({ to, text });
      return { id: { _serialized: `true_${chatId}_NOTICE` }, body: text };
    },
  };

  const result = await recoverUnreadLocalWhatsAppMessages(env, {
    force: true,
    accountIds: ["responder"],
    accountStates: new Map([["responder", { ready: true, state: "ready" }]]),
    clients: new Map([["responder", client]]),
    chatsByAccount: new Map([["responder", [chat]]]),
  });
  const messages = await listThreadMessages("otcantest", env);

  assert.equal(result.routed, 0);
  assert.equal(result.recovered[0].skipped[0].reason, "llm_sanitizer_unconfigured");
  assert.equal(result.recovered[0].skipped[0].noticeSent, true);
  assert.equal(messages.length, 0);
  assert.equal(seen, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, chatId);
  assert.match(sent[0].text, /LLM sanitizer is not configured/);
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

test("local whatsapp web cache lives under orkestr home", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-web-cache-"));
  assert.equal(webCacheRoot({ ORKESTR_HOME: home }), path.join(home, "whatsapp-bridge", "web-cache"));
});

test("local whatsapp group participant ids are normalized for created test chats", () => {
  assert.deepEqual(
    normalizeGroupParticipantIds(["66378837028965@lid", " 66378837028965@lid ", "4917632400662@c.us"]),
    ["66378837028965@lid", "4917632400662@c.us"],
  );
  assert.deepEqual(
    normalizeGroupParticipantIds("66378837028965@lid, 4917632400662@c.us"),
    ["66378837028965@lid", "4917632400662@c.us"],
  );
});

test("local whatsapp send confirms transient text sends from recent own messages", async () => {
  const client = {
    async sendMessage() {
      throw new Error("Protocol error (Runtime.callFunctionOn): Promise was collected");
    },
    async getChatById(chatId) {
      assert.equal(chatId, "chat-confirmed");
      return {
        async fetchMessages() {
          return [
            { fromMe: false, body: "hello" },
            { fromMe: true, body: "hello", id: { _serialized: "sent-confirmed" } },
          ];
        },
      };
    },
  };

  const sent = await sendWhatsAppTextWithConfirmation({
    client,
    chatId: "chat-confirmed",
    text: "hello",
    retryDelayMs: 0,
  });

  assert.equal(sent.id._serialized, "sent-confirmed");
});

test("local whatsapp send retries transient text sends when not confirmed", async () => {
  let attempts = 0;
  const client = {
    async sendMessage() {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("Protocol error (Runtime.callFunctionOn): Promise was collected");
      }
      return { id: { _serialized: "sent-retry" } };
    },
    async getChatById() {
      return {
        async fetchMessages() {
          return [];
        },
      };
    },
  };

  const sent = await sendWhatsAppTextWithConfirmation({
    client,
    chatId: "chat-retry",
    text: "retry me",
    retryDelayMs: 0,
  });

  assert.equal(attempts, 2);
  assert.equal(sent.id._serialized, "sent-retry");
});

test("local whatsapp message route fields keep own group echoes on the group chat", () => {
  assert.deepEqual(
    localWhatsAppMessageRouteFields({
      fromMe: true,
      from: "51346837356638@lid",
      to: "120363424272031669@g.us",
      id: { remote: "120363424272031669@g.us" },
    }),
    {
      chatId: "120363424272031669@g.us",
      from: "51346837356638@lid",
      fromMe: true,
    },
  );
});

test("local whatsapp known chats include stored thread bindings while bridge is idle", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-known-chats-"));
  const env = externalBridgeEnv(home);
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

test("local whatsapp unread recovery only scans bound chats for the selected account", () => {
  const env = { ORKESTR_WHATSAPP_ACCOUNT_IDS: "main,openclaw" };
  const threads = [
    {
      id: "main-thread",
      binding: {
        connector: "whatsapp",
        chatId: "main-chat@g.us",
        responderAccountId: "main",
      },
    },
    {
      id: "openclaw-thread",
      binding: {
        connector: "whatsapp",
        chatId: "openclaw-chat@g.us",
        outboundAccountId: "openclaw",
      },
    },
    {
      id: "disabled-thread",
      binding: {
        connector: "whatsapp",
        chatId: "disabled-chat@g.us",
        responderAccountId: "main",
        enabled: false,
      },
    },
  ];

  assert.deepEqual(localWhatsAppUnreadRecoveryBoundChats(threads, "main", env), [
    { chatId: "main-chat@g.us", threadId: "main-thread", accountId: "main" },
  ]);
  assert.deepEqual(localWhatsAppUnreadRecoveryBoundChats(threads, "openclaw", env), [
    { chatId: "openclaw-chat@g.us", threadId: "openclaw-thread", accountId: "openclaw" },
  ]);
  assert.equal(localWhatsAppUnreadRecoveryIntervalMs({ ORKESTR_WHATSAPP_UNREAD_RECOVERY_MS: "5" }), 10000);
});

test("local whatsapp unread recovery routes missed unread messages", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-unread-recovery-"));
  const env = { ORKESTR_HOME: home, ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder" };
  const chatId = "120363000000000000@g.us";
  let sentSeen = false;
  let getChatByIdCalls = 0;
  const message = {
    id: { _serialized: "missed-message-1", remote: chatId },
    fromMe: false,
    from: chatId,
    author: "491111111111@c.us",
    body: "missed hello",
    timestamp: 1_780_000_000,
  };
  const chat = {
    id: { _serialized: chatId },
    unreadCount: 1,
    async fetchMessages() {
      return [message];
    },
    async sendSeen() {
      sentSeen = true;
    },
  };
  const client = {
    async getChats() {
      return [
        chat,
        { id: { _serialized: "unbound@g.us" }, unreadCount: 5 },
      ];
    },
    async getChatById() {
      getChatByIdCalls += 1;
      throw new Error("recover should reuse the chat object from getChats");
    },
  };
  const thread = await createThread({
    id: "fitness-thread",
    name: "Fitness",
    binding: {
      connector: "whatsapp",
      chatId,
      displayName: "Fitness",
      responderAccountId: "responder",
      outboundAccountId: "responder",
      enabled: true,
    },
  }, env);

  const result = await recoverUnreadLocalWhatsAppMessages(env, {
    force: true,
    accountIds: ["responder"],
    clients: new Map([["responder", client]]),
    accountStates: new Map([["responder", { state: "ready", ready: true }]]),
    threads: [thread],
    limit: 20,
  });
  const messages = await listThreadMessages("fitness-thread", env);

  assert.equal(result.routed, 1);
  assert.equal(result.recovered.length, 1);
  assert.equal(result.recovered[0].chatId, chatId);
  assert.equal(messages.at(-1).text, "missed hello");
  assert.equal(messages.at(-1).source, "whatsapp_inbound");
  assert.equal(sentSeen, true);
  assert.equal(getChatByIdCalls, 0);
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

test("local whatsapp recovery only targets autostarted stalled accounts", async () => {
  const accounts = [
    { accountId: "sender", state: "auth_ready_timeout", ready: false },
    { accountId: "responder", state: "auth_ready_timeout", ready: false },
    { accountId: "other", state: "disconnected", ready: false },
    { accountId: "target-closed", state: "failed", ready: false, error: "Protocol error (Runtime.addBinding): Target closed" },
    { accountId: "profile-locked", state: "failed", ready: false, error: "The browser is already running for /tmp/profile. Use a different `userDataDir`." },
    { accountId: "logged-out", state: "idle", ready: false },
    { accountId: "broken-auth", state: "auth_failure", ready: false },
    { accountId: "hard-failed", state: "failed", ready: false, error: "unexpected permanent connector error" },
    { accountId: "already-ready", state: "ready", ready: true },
  ];

  assert.deepEqual(recoverableLocalWhatsAppAccountIds(accounts, ["responder", "other", "target-closed", "profile-locked", "logged-out", "broken-auth", "hard-failed", "already-ready"]), [
    "responder",
    "other",
    "target-closed",
    "profile-locked",
  ]);
});

test("whatsapp status reports paired from health readiness", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-ready-"));
  const env = externalBridgeEnv(home);
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, env);

  const status = await getWhatsAppStatus(env, async (url) => {
    assert.equal(url.pathname, "/health");
    return response({ ok: true, ready: true });
  });

  assert.equal(status.state, "paired");
});

test("whatsapp status discovers external bridge accounts from dashboard", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-dashboard-"));
  const env = externalBridgeEnv(home);
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
  const env = externalBridgeEnv(home);
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
  const env = externalBridgeEnv(home);
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
  const env = externalBridgeEnv(home);
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
  const env = externalBridgeEnv(home);
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
  const env = externalBridgeEnv(home);
  await createThread({ id: "thread-wa", name: "WA Thread", executorId: "noop" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-thread": "thread-wa" },
  }, env);

  const routed = await routeWhatsAppInbound({
    eventId: "wa-thread-1",
    chatId: "chat-thread",
    text: "thread status?",
    attachments: [{ kind: "image", path: "/tmp/thread-image.jpg", filename: "thread-image.jpg", mimetype: "image/jpeg" }],
  }, env);
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
  assert.equal(messages[0].attachments[0].path, "/tmp/thread-image.jpg");
  assert.equal(messages[0].attachments[0].filename, "thread-image.jpg");
  assert.equal(delivery.delivered.length, 1);
  assert.equal(duplicate.delivered.length, 0);
  assert.equal(calls[0].url.pathname, "/send-text");
  assert.equal(calls[0].body.to, "chat-thread");
});

test("whatsapp inbound can auto-provision a scoped user thread", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-auto-user-thread-"));
  const env = await externalBridgeEnvWithAllowingSanitizer(home, {
    ORKESTR_WHATSAPP_AUTO_PROVISION_USERS: "1",
  });
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    autoProvisionUsers: true,
  }, env);

  const routed = await routeWhatsAppInbound({
    eventId: "wa-auto-user-1",
    chatId: "chat-auto-user",
    accountId: "main",
    from: "491234567890@c.us",
    chatName: "otcantest",
    senderName: "Otcan Test",
    text: "hello from the user",
  }, env);
  const thread = await getThread(routed.threadId, env);
  const messages = await listThreadMessages(routed.threadId, env);

  assert.equal(routed.autoProvisioned, true);
  assert.equal(routed.createdThread, true);
  assert.equal(thread.ownerUserId, routed.userId);
  assert.equal(thread.binding.chatId, "chat-auto-user");
  assert.equal(thread.binding.displayName, "otcantest");
  assert.equal(thread.binding.generated, true);
  assert.equal(thread.binding.senderContactId, "491234567890@c.us");
  assert.equal(thread.binding.outboundAccountId, "main");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].ownerUserId, thread.ownerUserId);
  assert.equal(messages[0].state, "queued");

  const routedAgain = await routeWhatsAppInbound({
    eventId: "wa-auto-user-2",
    chatId: "chat-auto-user",
    accountId: "main",
    from: "491234567890@c.us",
    text: "second message",
  }, env);
  const messagesAfter = await listThreadMessages(routed.threadId, env);
  const threads = await listThreads(env);

  assert.equal(routedAgain.threadId, routed.threadId);
  assert.equal(routedAgain.autoProvisioned, false);
  assert.equal(messagesAfter.length, 2);
  assert.deepEqual(threads.map((entry) => entry.id), [routed.threadId]);
});

test("whatsapp delivery mirrors bound thread replies that only carry the binding chat id", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-bound-orphan-"));
  const env = externalBridgeEnv(home);
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, env);
  await createThread({
    id: "thread-bound-orphan",
    name: "Bound Orphan Reply Thread",
    binding: {
      connector: "whatsapp",
      chatId: "chat-bound-orphan",
      responderAccountId: "account-bound",
      mirrorToWhatsApp: true,
    },
  }, env);
  await appendThreadMessage("thread-bound-orphan", {
    role: "assistant",
    source: "codex-app-server",
    phase: "final_answer",
    text: "This reply already has the bound chat id but no parent.",
    state: "completed",
    chatId: "chat-bound-orphan",
    accountId: "account-bound",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-bound-orphan"] });
  });

  assert.equal(delivery.delivered.length, 1);
  assert.equal(delivery.delivered[0].deliveryType, "final");
  assert.equal(calls[0].body.to, "chat-bound-orphan");
  assert.equal(calls[0].body.accountId, "account-bound");
  assert.match(calls[0].body.text, /bound chat id but no parent/);
});

test("whatsapp delivery mirrors throttled commentary progress before final replies", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-progress-"));
  const env = externalBridgeEnv(home, { ORKESTR_WHATSAPP_PROGRESS_MIN_INTERVAL_MS: "60000" });
  await createThread({ id: "thread-wa-progress", name: "WA Progress Thread" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-progress": "thread-wa-progress" },
  }, env);

  const routed = await routeWhatsAppInbound({ eventId: "wa-progress-1", chatId: "chat-progress", text: "do it" }, env);
  await appendThreadMessage("thread-wa-progress", {
    role: "assistant",
    source: "codex-rollout",
    phase: "commentary",
    state: "completed",
    text: "I’m checking the repo and running focused tests now.",
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-progress",
  }, env);

  const calls = [];
  const progress = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-progress"] });
  });

  await appendThreadMessage("thread-wa-progress", {
    role: "assistant",
    source: "codex-rollout",
    phase: "commentary",
    state: "completed",
    text: "Focused tests passed; I’m running the full suite.",
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-progress",
  }, env);
  const throttled = await deliverWhatsAppReplies(env, async () => {
    throw new Error("progress should be throttled");
  });

  await appendThreadMessage("thread-wa-progress", {
    role: "assistant",
    source: "codex-rollout",
    phase: "final_answer",
    state: "completed",
    text: "Done. Tests passed.",
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-progress",
  }, env);
  const final = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-final"] });
  });

  assert.equal(progress.delivered.length, 1);
  assert.equal(progress.delivered[0].deliveryType, "progress");
  assert.equal(throttled.delivered.length, 0);
  assert.equal(throttled.skipped.some((item) => item.reason === "progress_throttled"), true);
  assert.equal(final.delivered.length, 1);
  assert.equal(final.delivered[0].deliveryType, "final");
  assert.deepEqual(calls.map((call) => stripDebugFooter(call.body.text)), [
    "I’m checking the repo and running focused tests now.",
    "Done. Tests passed.",
  ]);
  assertDebugFooter(calls[0].body.text, { messageType: "update" });
  assertDebugFooter(calls[1].body.text, { messageType: "final" });
});

test("whatsapp typing indicators follow active routed thread runtime", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-typing-"));
  const env = externalBridgeEnv(home);
  await createThread({ id: "thread-wa-typing", name: "WA Typing Thread" }, env);
  await writeConnectorConfig("whatsapp", {
    threadRoutes: { "chat-typing": "thread-wa-typing" },
  }, env);

  const routed = await routeWhatsAppInbound({
    eventId: "wa-typing-1",
    chatId: "chat-typing",
    accountId: "orkestr",
    text: "work on this",
  }, env);
  const captures = [];
  const working = await syncWhatsAppTypingIndicators(env, {
    statusImpl: async () => ({ state: "working", working: true, typingActive: true }),
    syncImpl: async (targets) => {
      captures.push(targets);
      return { ok: true, active: targets.length };
    },
  });

  await appendThreadMessage("thread-wa-typing", {
    role: "assistant",
    source: "codex-rollout",
    phase: "final_answer",
    state: "completed",
    text: "Done.",
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-typing",
  }, env);
  const completed = await syncWhatsAppTypingIndicators(env, {
    statusImpl: async () => ({ state: "working", working: true, typingActive: true }),
    syncImpl: async (targets) => {
      captures.push(targets);
      return { ok: true, active: targets.length };
    },
  });

  assert.equal(working.active, 1);
  assert.deepEqual(captures[0], [{
    threadId: "thread-wa-typing",
    messageId: routed.message.id,
    chatId: "chat-typing",
    accountId: "orkestr",
  }]);
  assert.equal(completed.active, 0);
  assert.deepEqual(captures[1], []);
});

test("whatsapp typing indicators ignore background-only runtime work", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-typing-background-"));
  const env = externalBridgeEnv(home);
  await createThread({ id: "thread-wa-typing-background", name: "WA Typing Background Thread" }, env);
  await writeConnectorConfig("whatsapp", {
    threadRoutes: { "chat-typing-background": "thread-wa-typing-background" },
  }, env);

  await routeWhatsAppInbound({
    eventId: "wa-typing-background-1",
    chatId: "chat-typing-background",
    accountId: "orkestr",
    text: "work on this",
  }, env);
  const captures = [];
  const result = await syncWhatsAppTypingIndicators(env, {
    statusImpl: async () => ({
      state: "working",
      working: true,
      backgroundWork: true,
      foregroundWorking: false,
      typingActive: false,
      promptReady: true,
    }),
    syncImpl: async (targets) => {
      captures.push(targets);
      return { ok: true, active: targets.length };
    },
  });

  assert.equal(result.active, 0);
  assert.deepEqual(captures[0], []);
});

test("whatsapp typing indicators ignore stale working text after prompt returns", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-typing-stale-working-"));
  const env = externalBridgeEnv(home);
  await createThread({ id: "thread-wa-typing-stale-working", name: "WA Typing Stale Working Thread" }, env);
  await writeConnectorConfig("whatsapp", {
    threadRoutes: { "chat-typing-stale-working": "thread-wa-typing-stale-working" },
  }, env);

  await routeWhatsAppInbound({
    eventId: "wa-typing-stale-working-1",
    chatId: "chat-typing-stale-working",
    accountId: "orkestr",
    text: "work on this",
  }, env);
  const captures = [];
  const result = await syncWhatsAppTypingIndicators(env, {
    statusImpl: async () => ({
      state: "working",
      working: true,
      foregroundWorking: false,
      typingActive: false,
      promptReady: true,
      progress: { staleWorkingPrompt: true },
    }),
    syncImpl: async (targets) => {
      captures.push(targets);
      return { ok: true, active: targets.length };
    },
  });

  assert.equal(result.active, 0);
  assert.deepEqual(captures[0], []);
});

test("whatsapp typing indicators require an active app-server turn", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-typing-app-server-idle-"));
  const env = { ORKESTR_HOME: home };
  await createThread({
    id: "thread-wa-typing-app-server-idle",
    name: "WA Typing App Server Idle Thread",
    runtimeKind: "codex-app-server",
  }, env);
  await writeConnectorConfig("whatsapp", {
    threadRoutes: { "chat-typing-app-server-idle": "thread-wa-typing-app-server-idle" },
  }, env);

  const routed = await routeWhatsAppInbound({
    eventId: "wa-typing-app-server-idle-1",
    chatId: "chat-typing-app-server-idle",
    accountId: "responder",
    text: "work on this",
  }, env);
  const captures = [];
  const result = await syncWhatsAppTypingIndicators(env, {
    statusImpl: async () => ({
      state: "working",
      runtimeKind: "codex-app-server",
      activeTurnId: null,
      working: true,
      typingActive: true,
    }),
    syncImpl: async (targets) => {
      captures.push(targets);
      return { ok: true, active: targets.length, targets };
    },
  });

  assert.equal(result.active, 0);
  assert.equal(routed.message.connector, "whatsapp");
  assert.deepEqual(captures[0], []);
});

test("whatsapp typing indicators skip app-server messages queued behind active turns", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-typing-app-server-queued-"));
  const env = { ORKESTR_HOME: home };
  await createThread({
    id: "thread-wa-typing-app-server-queued",
    name: "WA Typing App Server Queued Thread",
    runtimeKind: "codex-app-server",
  }, env);
  await writeConnectorConfig("whatsapp", {
    threadRoutes: { "chat-typing-app-server-queued": "thread-wa-typing-app-server-queued" },
  }, env);

  const activeParent = await appendThreadMessage("thread-wa-typing-app-server-queued", {
    role: "user",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-typing-app-server-queued",
    accountId: "responder",
    state: "completed",
    text: "active turn message",
  }, env);
  await appendThreadMessage("thread-wa-typing-app-server-queued", {
    role: "user",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-typing-app-server-queued",
    accountId: "responder",
    state: "queued",
    deliveryState: "awaiting_active_turn",
    text: "queued next turn message",
  }, env);

  const result = await syncWhatsAppTypingIndicators(env, {
    statusImpl: async () => ({
      state: "working",
      runtimeKind: "codex-app-server",
      activeTurnId: "turn-1",
      working: true,
      typingActive: true,
    }),
    syncImpl: async (targets) => ({ ok: true, active: targets.length, targets }),
  });

  assert.equal(result.active, 1);
  assert.deepEqual(result.targets, [{
    threadId: "thread-wa-typing-app-server-queued",
    messageId: activeParent.id,
    chatId: "chat-typing-app-server-queued",
    accountId: "responder",
  }]);
});

test("whatsapp typing indicators stop after mirrored progress for the active message", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-typing-progress-delivered-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
  };
  await createThread({ id: "thread-wa-typing-progress-delivered", name: "WA Typing Progress Delivered" }, env);
  await writeConnectorConfig("whatsapp", {
    threadRoutes: { "chat-typing-progress-delivered": "thread-wa-typing-progress-delivered" },
  }, env);

  const routed = await routeWhatsAppInbound({
    eventId: "wa-typing-progress-delivered-1",
    chatId: "chat-typing-progress-delivered",
    accountId: "responder",
    text: "work on this",
  }, env);
  await fs.writeFile(path.join(home, "whatsapp.json"), JSON.stringify({
    outboundDeliveries: [{
      deliveryType: "progress",
      messageId: "progress-1",
      parentMessageId: routed.message.id,
      chatId: "chat-typing-progress-delivered",
      accountId: "responder",
      deliveredAt: new Date(Date.now() - 120_000).toISOString(),
    }],
  }, null, 2));

  const result = await syncWhatsAppTypingIndicators({ ...env, ORKESTR_WHATSAPP_TYPING_COOLDOWN_MS: "0" }, {
    statusImpl: async () => ({
      state: "working",
      runtimeKind: "codex-app-server",
      activeTurnId: "turn-1",
      working: true,
      foregroundWorking: true,
      typingActive: true,
    }),
    syncImpl: async (targets) => ({ ok: true, active: targets.length, targets }),
  });

  assert.equal(result.active, 0);
  assert.deepEqual(result.targets, []);
});

test("whatsapp typing sync tolerates stale inbound account ids", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-typing-stale-account-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender,responder",
  };
  await createThread({ id: "thread-wa-typing-stale-account", name: "WA Typing Stale Account" }, env);
  await writeConnectorConfig("whatsapp", {
    threadRoutes: { "chat-typing-stale-account": "thread-wa-typing-stale-account" },
  }, env);

  await routeWhatsAppInbound({
    eventId: "wa-typing-stale-account-1",
    chatId: "chat-typing-stale-account",
    accountId: "legacy-account",
    text: "work on this",
  }, env);
  const result = await syncWhatsAppTypingIndicators(env, {
    statusImpl: async () => ({ state: "working", working: true, typingActive: true }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.active, 0);
});

test("whatsapp typing sync stops when a newer same-chat final lacks a parent id", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-typing-unparented-final-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
  };
  await createThread({ id: "thread-wa-typing-unparented-final", name: "WA Typing Unparented Final" }, env);
  await writeConnectorConfig("whatsapp", {
    threadRoutes: { "chat-typing-unparented-final": "thread-wa-typing-unparented-final" },
  }, env);

  await routeWhatsAppInbound({
    eventId: "wa-typing-unparented-final-1",
    chatId: "chat-typing-unparented-final",
    accountId: "responder",
    text: "work on this",
  }, env);
  await appendThreadMessage("thread-wa-typing-unparented-final", {
    role: "assistant",
    source: "codex-rollout",
    phase: "final_answer",
    state: "completed",
    text: "Done.",
    connector: "whatsapp",
    chatId: "chat-typing-unparented-final",
  }, env);

  const captures = [];
  const result = await syncWhatsAppTypingIndicators(env, {
    statusImpl: async () => ({ state: "working", working: true, typingActive: true }),
    syncImpl: async (targets) => {
      captures.push(targets);
      return { ok: true, active: targets.length };
    },
  });

  assert.equal(result.active, 0);
  assert.deepEqual(captures[0], []);
});

test("whatsapp typing sync stops after outbound delivery for the active parent", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-typing-cooldown-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
    ORKESTR_WHATSAPP_TYPING_COOLDOWN_MS: "60000",
  };
  await createThread({ id: "thread-wa-typing-cooldown", name: "WA Typing Cooldown" }, env);
  await writeConnectorConfig("whatsapp", {
    threadRoutes: { "chat-typing-cooldown": "thread-wa-typing-cooldown" },
  }, env);

  const routed = await routeWhatsAppInbound({
    eventId: "wa-typing-cooldown-1",
    chatId: "chat-typing-cooldown",
    accountId: "responder",
    text: "work on this",
  }, env);
  await fs.writeFile(path.join(home, "whatsapp.json"), JSON.stringify({
    outboundDeliveries: [{
      deliveryType: "progress",
      messageId: "progress-1",
      parentMessageId: routed.message.id,
      chatId: "chat-typing-cooldown",
      accountId: "responder",
      deliveredAt: new Date().toISOString(),
    }],
  }, null, 2));

  const cooledDown = await syncWhatsAppTypingIndicators(env, {
    statusImpl: async () => ({ state: "working", working: true, typingActive: true }),
    syncImpl: async (targets) => ({ ok: true, active: targets.length, targets }),
  });
  const noCooldown = await syncWhatsAppTypingIndicators({ ...env, ORKESTR_WHATSAPP_TYPING_COOLDOWN_MS: "0" }, {
    statusImpl: async () => ({ state: "working", working: true, typingActive: true }),
    syncImpl: async (targets) => ({ ok: true, active: targets.length, targets }),
  });

  assert.equal(cooledDown.active, 0);
  assert.equal(noCooldown.active, 0);
  assert.deepEqual(noCooldown.targets, []);
});

test("whatsapp delivery does not backfill commentary progress after a final answer exists", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-progress-final-"));
  const env = externalBridgeEnv(home);
  await createThread({ id: "thread-wa-progress-final", name: "WA Progress Final Thread" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-progress-final": "thread-wa-progress-final" },
  }, env);

  const routed = await routeWhatsAppInbound({ eventId: "wa-progress-final-1", chatId: "chat-progress-final", text: "status?" }, env);
  await appendThreadMessage("thread-wa-progress-final", {
    role: "assistant",
    source: "codex-rollout",
    phase: "commentary",
    state: "completed",
    text: "Old progress that should not be backfilled.",
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-progress-final",
  }, env);
  await appendThreadMessage("thread-wa-progress-final", {
    role: "assistant",
    source: "codex-rollout",
    phase: "final_answer",
    state: "completed",
    text: "Final only.",
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-progress-final",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-final-only"] });
  });

  assert.equal(delivery.delivered.length, 1);
  assert.equal(delivery.skipped.some((item) => item.reason === "final_reply_available"), true);
  assert.deepEqual(calls.map((call) => stripDebugFooter(call.body.text)), ["Final only."]);
  assertDebugFooter(calls[0].body.text, { messageType: "final" });
});

test("whatsapp delivery mirrors newer progress after an older final was already delivered", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-progress-after-final-"));
  const env = externalBridgeEnv(home);
  await createThread({ id: "thread-wa-progress-after-final", name: "WA Progress After Final Thread" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-progress-after-final": "thread-wa-progress-after-final" },
  }, env);

  const routed = await routeWhatsAppInbound({ eventId: "wa-progress-after-final-1", chatId: "chat-progress-after-final", text: "status?" }, env);
  const finalAt = new Date(Date.now() - 60_000).toISOString();
  const progressAt = new Date().toISOString();
  const final = await appendThreadMessage("thread-wa-progress-after-final", {
    role: "assistant",
    source: "codex-rollout",
    phase: "final_answer",
    state: "completed",
    text: "Earlier final.",
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-progress-after-final",
    createdAt: finalAt,
    timestamp: finalAt,
  }, env);
  await fs.writeFile(path.join(home, "whatsapp.json"), JSON.stringify({
    outboundDeliveries: [{
      deliveryType: "final",
      messageId: final.id,
      parentMessageId: routed.message.id,
      chatId: "chat-progress-after-final",
      accountId: "account-1",
      deliveredAt: finalAt,
    }],
  }, null, 2));
  await appendThreadMessage("thread-wa-progress-after-final", {
    role: "assistant",
    source: "codex-rollout",
    phase: "commentary",
    state: "completed",
    text: "New progress from a later operator turn.",
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-progress-after-final",
    createdAt: progressAt,
    timestamp: progressAt,
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-new-progress"] });
  });

  assert.equal(delivery.delivered.length, 1);
  assert.equal(delivery.delivered[0].deliveryType, "progress");
  assert.deepEqual(calls.map((call) => stripDebugFooter(call.body.text)), ["New progress from a later operator turn."]);
  assertDebugFooter(calls[0].body.text, { messageType: "update" });
});

test("whatsapp delivery does not backfill stale progress after an older final", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-stale-progress-after-final-"));
  const env = externalBridgeEnv(home);
  await createThread({ id: "thread-wa-stale-progress-after-final", name: "WA Stale Progress After Final Thread" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-stale-progress-after-final": "thread-wa-stale-progress-after-final" },
  }, env);

  const routed = await routeWhatsAppInbound({ eventId: "wa-stale-progress-after-final-1", chatId: "chat-stale-progress-after-final", text: "status?" }, env);
  const finalAt = new Date(Date.now() - 20 * 60_000).toISOString();
  const progressAt = new Date(Date.now() - 10 * 60_000).toISOString();
  const final = await appendThreadMessage("thread-wa-stale-progress-after-final", {
    role: "assistant",
    source: "codex-rollout",
    phase: "final_answer",
    state: "completed",
    text: "Earlier final.",
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-stale-progress-after-final",
    createdAt: finalAt,
    timestamp: finalAt,
  }, env);
  const progress = await appendThreadMessage("thread-wa-stale-progress-after-final", {
    role: "assistant",
    source: "codex-rollout",
    phase: "commentary",
    state: "completed",
    text: "Old progress that should not be backfilled.",
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-stale-progress-after-final",
    createdAt: progressAt,
    timestamp: progressAt,
  }, env);
  await fs.writeFile(path.join(home, "whatsapp.json"), JSON.stringify({
    outboundDeliveries: [{
      deliveryType: "final",
      messageId: final.id,
      parentMessageId: routed.message.id,
      chatId: "chat-stale-progress-after-final",
      accountId: "account-1",
      deliveredAt: finalAt,
    }],
  }, null, 2));

  const delivery = await deliverWhatsAppReplies(env, async () => {
    throw new Error("stale progress should not be sent");
  });

  assert.equal(delivery.delivered.length, 0);
  assert.deepEqual(delivery.skipped.find((item) => item.messageId === progress.id)?.reason, "stale_untracked_reply");
});

test("whatsapp delivery appends compact debug footer for plan-mode Codex updates", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-debug-footer-"));
  const env = externalBridgeEnv(home);
  await createThread({
    id: "thread-wa-debug-footer",
    name: "WA Debug Footer Thread",
    codexMode: "code",
    runtime: { progress: { codexMode: "plan" } },
    codexModel: "gpt-5.5",
    codexReasoningEffort: "xhigh",
  }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-debug-footer": "thread-wa-debug-footer" },
  }, env);

  const routed = await routeWhatsAppInbound({ eventId: "wa-debug-footer-1", chatId: "chat-debug-footer", text: "/plan investigate" }, env);
  await appendThreadMessage("thread-wa-debug-footer", {
    role: "assistant",
    source: "codex-rollout",
    phase: "commentary",
    state: "completed",
    text: "I’ll inspect the current routing path.",
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-debug-footer",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-debug-footer"] });
  });

  assert.equal(delivery.delivered.length, 1);
  assert.equal(stripDebugFooter(calls[0].body.text), "I’ll inspect the current routing path.");
  assert.match(
    calls[0].body.text,
    /\n\ndbg: m:gpt-5\.5\/xh · mode:plan · msg:update · q:0 · cpu:\d+% · help:\/help · switch:\/code$/,
  );
});

test("whatsapp delivery appends debug footer for app-server final replies", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-debug-footer-app-server-"));
  const env = externalBridgeEnv(home);
  await createThread({
    id: "thread-wa-debug-footer-app-server",
    name: "WA Debug Footer App Server Thread",
    runtimeKind: "codex-app-server",
    codexModel: "gpt-5.5",
    codexReasoningEffort: "xhigh",
  }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-debug-footer-app-server": "thread-wa-debug-footer-app-server" },
  }, env);

  const routed = await routeWhatsAppInbound({ eventId: "wa-debug-footer-app-server-1", chatId: "chat-debug-footer-app-server", text: "status?" }, env);
  await appendThreadMessage("thread-wa-debug-footer-app-server", {
    role: "assistant",
    source: "codex-app-server",
    phase: "final_answer",
    state: "completed",
    text: "Final from app server.",
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-debug-footer-app-server",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-debug-footer-app-server"] });
  });

  assert.equal(delivery.delivered.length, 1);
  assert.equal(stripDebugFooter(calls[0].body.text), "Final from app server.");
  assertDebugFooter(calls[0].body.text, { messageType: "final", model: "gpt-5.5/xh" });
});

test("whatsapp debug footer can be disabled", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-debug-footer-off-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1",
    ORKESTR_WHATSAPP_DEBUG_FOOTER: "0",
  };
  await createThread({ id: "thread-wa-debug-footer-off", name: "WA Debug Footer Off Thread" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-debug-footer-off": "thread-wa-debug-footer-off" },
  }, env);

  const routed = await routeWhatsAppInbound({ eventId: "wa-debug-footer-off-1", chatId: "chat-debug-footer-off", text: "status?" }, env);
  await appendThreadMessage("thread-wa-debug-footer-off", {
    role: "assistant",
    source: "codex-rollout",
    phase: "commentary",
    state: "completed",
    text: "I’ll check it.",
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-debug-footer-off",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-debug-footer-off"] });
  });

  assert.equal(delivery.delivered.length, 1);
  assert.equal(calls[0].body.text, "I’ll check it.");
});

test("whatsapp debug footer ignores stale stored plan mode when live mode is code", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-debug-footer-stale-mode-"));
  const env = externalBridgeEnv(home);
  await createThread({
    id: "thread-wa-debug-footer-stale-mode",
    name: "WA Debug Footer Stale Mode Thread",
    codexMode: "plan",
    codexModeSource: "orkestr-command",
    runtime: { progress: { codexMode: "code" } },
    codexModel: "gpt-5.5",
    codexReasoningEffort: "xhigh",
  }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-debug-footer-stale-mode": "thread-wa-debug-footer-stale-mode" },
  }, env);

  const routed = await routeWhatsAppInbound({ eventId: "wa-debug-footer-stale-mode-1", chatId: "chat-debug-footer-stale-mode", text: "status?" }, env);
  await appendThreadMessage("thread-wa-debug-footer-stale-mode", {
    role: "assistant",
    source: "codex-rollout",
    phase: "commentary",
    state: "completed",
    text: "I’ll check it.",
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-debug-footer-stale-mode",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-debug-footer-stale-mode"] });
  });

  assert.equal(delivery.delivered.length, 1);
  assert.equal(stripDebugFooter(calls[0].body.text), "I’ll check it.");
  assertDebugFooter(calls[0].body.text, { messageType: "update", model: "gpt-5.5/xh" });
  assert.doesNotMatch(calls[0].body.text, /mode:plan/);
  assert.doesNotMatch(calls[0].body.text, /switch:\/code/);
});

test("whatsapp inbound suppresses duplicate active thread inputs by content", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-thread-active-duplicate-"));
  const env = externalBridgeEnv(home);
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
  const env = externalBridgeEnv(home);
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
    "**Deploy latest into the orkestr-vps VM, by pulling and restarting the host service there.**",
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
  assert.equal(stripDebugFooter(calls[0].body.text), [
    "Deploy target",
    "",
    "*Deploy latest into the orkestr-vps VM, by pulling and restarting the host service there.*",
    "",
    "Demo URL: https://orkestr-demo.example.com",
    "",
    "`**literal**` stays code.",
  ].join("\n"));
  assertDebugFooter(calls[0].body.text, { messageType: "final" });
  assert.equal(messages.at(-1).text, markdown);
});

test("whatsapp delivery does not backfill stale untracked final replies", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-stale-reply-"));
  const env = externalBridgeEnv(home, { ORKESTR_WHATSAPP_REPLY_BACKFILL_WINDOW_MS: "1000" });
  await createThread({ id: "thread-wa-stale", name: "WA Stale Thread" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-stale": "thread-wa-stale" },
  }, env);

  const parent = await appendThreadMessage("thread-wa-stale", {
    role: "user",
    source: "whatsapp_inbound",
    state: "completed",
    connector: "whatsapp",
    chatId: "chat-stale",
    text: "old request",
    createdAt: new Date(Date.now() - 5000).toISOString(),
  }, env);
  const reply = await appendThreadMessage("thread-wa-stale", {
    role: "assistant",
    source: "codex-rollout",
    phase: "final_answer",
    state: "completed",
    connector: "whatsapp",
    chatId: "chat-stale",
    parentMessageId: parent.id,
    text: "old answer",
    createdAt: new Date(Date.now() - 5000).toISOString(),
  }, env);

  const delivery = await deliverWhatsAppReplies(env, async () => {
    throw new Error("stale reply should not be sent");
  });

  assert.equal(delivery.delivered.length, 0);
  assert.deepEqual(delivery.skipped.find((item) => item.messageId === reply.id)?.reason, "stale_untracked_reply");
});

test("whatsapp delivery does not replay replies older than retained delivery ledger", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-retention-reply-"));
  const env = externalBridgeEnv(home, {
    ORKESTR_WHATSAPP_REPLY_BACKFILL_WINDOW_MS: String(7 * 24 * 60 * 60 * 1000),
    ORKESTR_WHATSAPP_OUTBOUND_DELIVERY_RETENTION: "2",
  });
  await createThread({ id: "thread-wa-retention", name: "WA Retention Thread" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-retention": "thread-wa-retention" },
  }, env);

  const oldReplyAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const oldestRetainedDeliveryAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const parent = await appendThreadMessage("thread-wa-retention", {
    role: "user",
    source: "whatsapp_inbound",
    state: "completed",
    connector: "whatsapp",
    chatId: "chat-retention",
    text: "retained request",
    createdAt: oldReplyAt,
  }, env);
  const reply = await appendThreadMessage("thread-wa-retention", {
    role: "assistant",
    source: "codex-rollout",
    phase: "final_answer",
    state: "completed",
    connector: "whatsapp",
    chatId: "chat-retention",
    parentMessageId: parent.id,
    text: "retained answer",
    createdAt: oldReplyAt,
  }, env);
  await fs.writeFile(path.join(home, "whatsapp.json"), JSON.stringify({
    inboundEvents: [],
    outboundDeliveries: [
      { messageId: "newer-1", chatId: "other-chat", deliveredAt: oldestRetainedDeliveryAt },
      { messageId: "newer-2", chatId: "other-chat", deliveredAt: new Date().toISOString() },
    ],
  }, null, 2));

  const delivery = await deliverWhatsAppReplies(env, async () => {
    throw new Error("reply older than retained ledger should not be sent");
  });

  assert.equal(delivery.delivered.length, 0);
  assert.deepEqual(delivery.skipped.find((item) => item.messageId === reply.id)?.reason, "stale_untracked_reply");
});

test("whatsapp delivery sends markdown tables as CSV attachments", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-table-reply-"));
  const env = externalBridgeEnv(home);
  await createThread({ id: "thread-wa-table", name: "WA Table Thread" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-table": "thread-wa-table" },
  }, env);

  const routed = await routeWhatsAppInbound({ eventId: "wa-table-1", chatId: "chat-table", text: "send table" }, env);
  await appendThreadMessage("thread-wa-table", {
    role: "assistant",
    source: "codex-rollout",
    phase: "final_answer",
    state: "completed",
    text: [
      "Here is the summary:",
      "",
      "| Name | Status | Notes |",
      "| --- | --- | --- |",
      "| Magie | Ready | **Daily** 09:00 |",
      "| KDP | Waiting | needs auth |",
      "",
      "Done.",
    ].join("\n"),
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-table",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-table-text", "sent-table-csv"] });
  });
  const duplicate = await deliverWhatsAppReplies(env, async () => {
    throw new Error("should not resend table attachment");
  });

  assert.equal(delivery.delivered.length, 1);
  assert.equal(duplicate.delivered.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/send-media");
  assert.equal(calls[0].body.to, "chat-table");
  assert.equal(calls[0].body.paths.length, 1);
  assert.match(stripDebugFooter(calls[0].body.text), /^Here is the summary:\n\nTable attached: orkestr-table-.+\.csv\n\nDone\.$/);
  const csv = await fs.readFile(calls[0].body.paths[0], "utf8");
  assert.equal(csv, [
    "Name,Status,Notes",
    "Magie,Ready,Daily 09:00",
    "KDP,Waiting,needs auth",
    "",
  ].join("\n"));
  assert.equal(delivery.delivered[0].attachments.length, 1);
  assert.equal(delivery.failed.length, 0);
});

test("whatsapp table attachment detection ignores fenced code blocks", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-table-code-"));
  const prepared = await prepareWhatsAppTableAttachments([
    "```",
    "| Name | Status |",
    "| --- | --- |",
    "| Magie | Ready |",
    "```",
  ].join("\n"), { env: { ORKESTR_HOME: home }, messageId: "code-table" });

  assert.equal(prepared.attachments.length, 0);
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
  const env = externalBridgeEnv(home);
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
  const env = externalBridgeEnv(home);
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
  const env = externalBridgeEnv(home);
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
  assertDebugFooter(calls[0].body.text, { messageType: "update" });
  assert.equal(messages.find((entry) => entry.id === message.id).state, "queued");
});

test("whatsapp delivery reports queued runtime inputs without marking the input delivered", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-queue-notice-"));
  const env = externalBridgeEnv(home);
  await createThread({
    id: "thread-wa-queue-notice",
    name: "WA Queue Notice Thread",
    codexModel: "gpt-5.5",
    codexReasoningEffort: "high",
  }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-queue-notice": "thread-wa-queue-notice" },
  }, env);
  const routed = await routeWhatsAppInbound({
    eventId: "wa-queue-notice-1",
    chatId: "chat-queue-notice",
    accountId: "account-1",
    text: "ship it",
  }, env);
  await updateThreadMessage("thread-wa-queue-notice", routed.message.id, {
    state: "queued",
    deliveryState: "waiting_runtime_ready",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-queue-notice"] });
  });
  const duplicate = await deliverWhatsAppReplies(env, async () => {
    throw new Error("should not resend queue notice");
  });
  const messages = await listThreadMessages("thread-wa-queue-notice", env);

  assert.equal(delivery.delivered.length, 1);
  assert.equal(delivery.delivered[0].deliveryType, "queue_notice");
  assert.equal(delivery.delivered[0].sourceMessageId, routed.message.id);
  assert.equal(duplicate.delivered.length, 0);
  assert.equal(calls[0].body.to, "chat-queue-notice");
  assert.match(stripDebugFooter(calls[0].body.text), /^Queued your message while Orkestr prepares this thread: "ship it"\./);
  assertDebugFooter(calls[0].body.text, { messageType: "update", model: "gpt-5.5/h" });
  assert.equal(messages.find((entry) => entry.id === routed.message.id).state, "queued");
});

test("whatsapp delivery reports frozen runtime blocks without marking the input delivered", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-frozen-notice-"));
  const env = externalBridgeEnv(home);
  await createThread({
    id: "thread-wa-frozen-notice",
    name: "WA Frozen Notice Thread",
    codexModel: "gpt-5.5",
    codexReasoningEffort: "xhigh",
  }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-frozen-notice": "thread-wa-frozen-notice" },
  }, env);
  const routed = await routeWhatsAppInbound({
    eventId: "wa-frozen-notice-1",
    chatId: "chat-frozen-notice",
    accountId: "account-1",
    text: "please continue",
  }, env);
  await updateThreadMessage("thread-wa-frozen-notice", routed.message.id, {
    state: "awaiting_ack",
    deliveryState: "blocked_frozen_runtime",
    observedVia: "runtime_frozen",
    error: "Runtime appears frozen; stale-ack recovery is paused until the pane changes or a manual recovery action is requested.",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-frozen-notice"] });
  });
  const duplicate = await deliverWhatsAppReplies(env, async () => {
    throw new Error("should not resend frozen runtime notice");
  });
  const messages = await listThreadMessages("thread-wa-frozen-notice", env);

  assert.equal(delivery.delivered.length, 1);
  assert.equal(delivery.delivered[0].deliveryType, "router_update");
  assert.equal(delivery.delivered[0].routerUpdateType, "blocked_frozen_runtime");
  assert.equal(delivery.delivered[0].sourceMessageId, routed.message.id);
  assert.equal(duplicate.delivered.length, 0);
  assert.equal(calls[0].body.to, "chat-frozen-notice");
  assert.match(stripDebugFooter(calls[0].body.text), /^Codex pane looks frozen\.\n\nOrkestr paused automatic recovery and did not restart or resend anything\./);
  assert.match(stripDebugFooter(calls[0].body.text), /Your message is blocked until the pane changes or you request a manual recovery: "please continue"\./);
  assertDebugFooter(calls[0].body.text, { messageType: "update", model: "gpt-5.5/xh" });
  assert.equal(messages.find((entry) => entry.id === routed.message.id).state, "awaiting_ack");
  assert.equal(messages.find((entry) => entry.id === routed.message.id).deliveryState, "blocked_frozen_runtime");
});

test("whatsapp delivery reports recovery action requests", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-recovery-action-"));
  const env = externalBridgeEnv(home);
  await createThread({ id: "thread-wa-recovery-action", name: "WA Recovery Action Thread" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-recovery-action": "thread-wa-recovery-action" },
  }, env);
  const restart = await appendThreadMessage("thread-wa-recovery-action", {
    role: "user",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-recovery-action",
    accountId: "account-1",
    text: "/restart",
    state: "completed",
    deliveryState: "delivered",
    observedVia: "orkestr_reset_command",
  }, env);
  const now = await appendThreadMessage("thread-wa-recovery-action", {
    role: "user",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-recovery-action",
    accountId: "account-1",
    text: "fix the pairing number",
    state: "queued",
    deliveryState: "interrupting",
    observedVia: "orkestr_interrupt_command",
    forceDeliveryAfterInterrupt: true,
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: [`sent-recovery-action-${calls.length}`] });
  });
  const duplicate = await deliverWhatsAppReplies(env, async () => {
    throw new Error("should not resend recovery action notices");
  });

  assert.equal(delivery.delivered.length, 2);
  assert.deepEqual(delivery.delivered.map((entry) => entry.deliveryType), ["router_update", "router_update"]);
  assert.deepEqual(delivery.delivered.map((entry) => entry.routerUpdateType), ["recovery_action_requested", "recovery_action_requested"]);
  assert.equal(delivery.delivered[0].sourceMessageId, restart.id);
  assert.equal(delivery.delivered[1].sourceMessageId, now.id);
  assert.equal(duplicate.delivered.length, 0);
  assert.equal(calls.every((call) => call.body.to === "chat-recovery-action"), true);
  assert.match(stripDebugFooter(calls[0].body.text), /^Restart requested\.\n\nOrkestr reset the current Codex runtime and resumed the thread\./);
  assert.match(stripDebugFooter(calls[1].body.text), /^Interrupt requested\.\n\nOrkestr interrupted the current Codex turn and queued your message for the next turn: "fix the pairing number"\./);
  assertDebugFooter(calls[0].body.text, { messageType: "update" });
  assertDebugFooter(calls[1].body.text, { messageType: "update" });
});

test("whatsapp delivery reports stale-ack recovery exhaustion as manual action", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-recovery-exhausted-"));
  const env = externalBridgeEnv(home);
  await createThread({ id: "thread-wa-recovery-exhausted", name: "WA Recovery Exhausted Thread" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-recovery-exhausted": "thread-wa-recovery-exhausted" },
  }, env);
  const routed = await routeWhatsAppInbound({
    eventId: "wa-recovery-exhausted-1",
    chatId: "chat-recovery-exhausted",
    accountId: "account-1",
    text: "hi",
  }, env);
  await updateThreadMessage("thread-wa-recovery-exhausted", routed.message.id, {
    state: "failed",
    deliveryState: "failed",
    observedVia: "stale_ack_recovery_exhausted",
    error: "Thread input was not observed after stale-ack recovery; failing it to unblock later input.",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-recovery-exhausted"] });
  });
  const duplicate = await deliverWhatsAppReplies(env, async () => {
    throw new Error("should not resend recovery exhausted notice");
  });

  assert.equal(delivery.delivered.length, 1);
  assert.equal(delivery.delivered[0].deliveryType, "router_update");
  assert.equal(delivery.delivered[0].routerUpdateType, "recovery_exhausted");
  assert.equal(delivery.delivered[0].sourceMessageId, routed.message.id);
  assert.equal(duplicate.delivered.length, 0);
  assert.equal(calls[0].body.to, "chat-recovery-exhausted");
  assert.match(stripDebugFooter(calls[0].body.text), /^Manual recovery needed\.\n\nOrkestr stopped retrying this message to avoid duplicate input\./);
  assert.match(stripDebugFooter(calls[0].body.text), /Open the thread or request \/restart, then resend if needed: "hi"\./);
  assertDebugFooter(calls[0].body.text, { messageType: "update" });
  assert.equal(delivery.delivered.some((entry) => entry.deliveryType === "delivery_error"), false);
});

test("whatsapp delivery reports mirror-disabled routed inputs once", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-mirror-disabled-notice-"));
  const env = externalBridgeEnv(home);
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, env);
  await createThread({
    id: "thread-wa-mirror-disabled-notice",
    name: "WA Mirror Disabled Notice Thread",
    binding: {
      connector: "whatsapp",
      chatId: "chat-mirror-disabled-notice",
      displayName: "Mirror Disabled Chat",
      enabled: true,
      mirrorToWhatsApp: false,
      outboundAccountId: "account-1",
    },
  }, env);
  const routed = await routeWhatsAppInbound({
    eventId: "wa-mirror-disabled-notice-1",
    chatId: "chat-mirror-disabled-notice",
    accountId: "account-1",
    text: "hello",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-mirror-disabled-notice"] });
  });
  const duplicate = await deliverWhatsAppReplies(env, async () => {
    throw new Error("should not resend mirror disabled notice");
  });

  assert.equal(routed.threadId, "thread-wa-mirror-disabled-notice");
  assert.equal(delivery.delivered.length, 1);
  assert.equal(delivery.delivered[0].deliveryType, "router_update");
  assert.equal(delivery.delivered[0].routerUpdateType, "mirror_disabled");
  assert.equal(delivery.delivered[0].sourceMessageId, routed.message.id);
  assert.equal(duplicate.delivered.length, 0);
  assert.equal(calls[0].body.to, "chat-mirror-disabled-notice");
  assert.equal(calls[0].body.accountId, "account-1");
  assert.match(stripDebugFooter(calls[0].body.text), /^Message routed to Orkestr\.\n\nWhatsApp mirroring is disabled for this thread/);
  assertDebugFooter(calls[0].body.text, { messageType: "update" });
});

test("whatsapp /now inputs report interrupting before normal queue notices", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-now-notice-"));
  const env = externalBridgeEnv(home);
  await createThread({ id: "thread-wa-now-notice", name: "WA Now Notice Thread" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-now-notice": "thread-wa-now-notice" },
  }, env);
  const routed = await routeWhatsAppInbound({
    eventId: "wa-now-notice-1",
    chatId: "chat-now-notice",
    accountId: "account-1",
    text: "/now fix the pairing number",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-now-notice"] });
  });

  assert.equal(routed.message.deliveryState, "interrupting");
  assert.equal(delivery.delivered.length, 1);
  assert.equal(delivery.delivered[0].deliveryType, "queue_notice");
  assert.match(stripDebugFooter(calls[0].body.text), /^Interrupting the current Codex turn and queued your message: "fix the pairing number"\./);
  assert.doesNotMatch(stripDebugFooter(calls[0].body.text), /\/now/);
  assertDebugFooter(calls[0].body.text, { messageType: "update" });
});

test("whatsapp delivery reports waking queue notices", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-queue-waking-"));
  const env = externalBridgeEnv(home);
  await createThread({ id: "thread-wa-queue-waking", name: "WA Queue Waking Thread" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-queue-waking": "thread-wa-queue-waking" },
  }, env);
  const routed = await routeWhatsAppInbound({ eventId: "wa-queue-waking-1", chatId: "chat-queue-waking", text: "wake test" }, env);
  assert.equal(routed.message.deliveryState, "waiting_runtime_start");

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-queue-waking"] });
  });

  assert.equal(delivery.delivered.length, 1);
  assert.equal(delivery.delivered[0].deliveryType, "queue_notice");
  assert.match(stripDebugFooter(calls[0].body.text), /^Waking this Orkestr thread and queued your message: "wake test"\./);
  assertDebugFooter(calls[0].body.text, { messageType: "update" });
});

test("whatsapp queue notices do not treat app-server threads as missing tmux sessions", () => {
  assert.equal(initialQueueDeliveryState({
    state: "ready",
    runtimeKind: "codex-app-server",
    sessionName: null,
    promptReady: true,
  }, { text: "send normally" }), "");
  assert.equal(initialQueueDeliveryState({
    state: "working",
    runtimeKind: "codex-app-server",
    activeTurnId: "turn-1",
  }, { text: "queue behind the turn" }), "awaiting_active_turn");
  assert.equal(initialQueueDeliveryState({
    state: "sleeping",
    runtimeKind: "codex-app-server",
  }, { text: "resume app server" }), "resuming_codex_thread");
  assert.equal(initialQueueDeliveryState({
    state: "ready",
    runtimeKind: "codex-tmux",
    sessionName: null,
    promptReady: true,
  }, { text: "wake tmux" }), "waiting_runtime_start");
});

test("whatsapp delivery forwards failed routed inputs using inbound event metadata", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-failed-input-event-"));
  const env = externalBridgeEnv(home);
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
  assertDebugFooter(calls[0].body.text, { messageType: "update" });
});

test("whatsapp passive mirror recovers a failed thread input instead of sending a failure notice", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-passive-failed-recover-"));
  const env = externalBridgeEnv(home);
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
  assert.equal(stripDebugFooter(calls[0].body.text), "The status is clean.");
  assertDebugFooter(calls[0].body.text, { messageType: "final" });
  assert.doesNotMatch(calls[0].body.text, /^Delivery failed/);
  assert.equal(parent.state, "completed");
  assert.equal(parent.deliveryState, "delivered");
  assert.equal(parent.observedVia, "whatsapp_passive_mirror_delivery");
  assert.equal(parent.passiveMirrorMessageId, reply.id);
  assert.equal(parent.error, null);
});

test("whatsapp passive mirror completes a running thread input when the reply is delivered", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-passive-running-complete-"));
  const env = externalBridgeEnv(home);
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
  const env = externalBridgeEnv(home);
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
  assertDebugFooter(calls[0].body.text, { messageType: "update" });
});

test("whatsapp delivery does not forward local failed inputs", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-local-failed-input-"));
  const env = externalBridgeEnv(home);
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
  const env = externalBridgeEnv(home);
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
  assert.equal(messages[0].originSurface, "whatsapp");
  assert.equal(messages[0].originTransport, "whatsapp-local-bridge");
});

test("direct whatsapp thread inputs inherit binding delivery metadata", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-direct-binding-"));
  const env = externalBridgeEnv(home);
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
  assert.equal(message.originSurface, "whatsapp");
  assert.equal(message.originTransport, "whatsapp-direct");
});

test("generated whatsapp bindings listen to the selected sender and answer as the responder", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-generated-binding-"));
  const env = externalBridgeEnv(home);
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
  assert.equal(delivery.delivered.length, 2);
  assert.equal(delivery.delivered.some((entry) => entry.deliveryType === "queue_notice"), true);
  assert.equal(calls.every((call) => call.body.to === "chat-generated"), true);
  assert.equal(calls.every((call) => call.body.accountId === "account-2"), true);
  assert.equal(calls.some((call) => stripDebugFooter(call.body.text) === "generated reply"), true);
});

test("whatsapp auto-provision does not bypass existing binding participant restrictions", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-auto-binding-boundary-"));
  const env = await externalBridgeEnvWithAllowingSanitizer(home, {
    ORKESTR_WHATSAPP_AUTO_PROVISION_USERS: "1",
  });
  await createThread({
    id: "restricted-generated-thread",
    name: "Restricted Generated Thread",
    binding: {
      connector: "whatsapp",
      chatId: "chat-auto-restricted",
      displayName: "Restricted Chat",
      enabled: true,
      generated: true,
      allowOtherPeople: false,
      senderAccountId: "account-1",
      responderAccountId: "account-1",
      outboundAccountId: "account-1",
      senderContactId: "491111111111@c.us",
    },
  }, env);

  await assert.rejects(
    () => routeWhatsAppInbound({
      eventId: "wa-auto-restricted-rejected",
      chatId: "chat-auto-restricted",
      accountId: "account-1",
      from: "493333333333@c.us",
      text: "should not create a separate user thread",
    }, env),
    /whatsapp_target_required/,
  );

  assert.deepEqual((await listThreads(env)).map((thread) => thread.id), ["restricted-generated-thread"]);
});

test("generated single-account whatsapp groups route lid senders through the group boundary", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-generated-lid-group-"));
  const env = externalBridgeEnv(home);
  await createThread({
    id: "generated-lid-thread",
    name: "Generated Lid Thread",
    binding: {
      connector: "whatsapp",
      chatId: "120363424272031669@g.us",
      displayName: "orkestr",
      enabled: true,
      generated: true,
      allowOtherPeople: false,
      senderAccountId: "responder",
      responderAccountId: "responder",
      outboundAccountId: "responder",
      senderContactId: "4917632400662@c.us",
      responderContactId: "905555154214@c.us",
    },
  }, env);

  await assert.rejects(
    () => routeWhatsAppInbound({
      eventId: "wa-generated-lid-responder",
      chatId: "120363424272031669@g.us",
      accountId: "responder",
      from: "905555154214@c.us",
      fromMe: false,
      text: "responder echo",
    }, env),
    /whatsapp_target_required/,
  );
  await assert.rejects(
    () => routeWhatsAppInbound({
      eventId: "wa-generated-lid-wrong-chat",
      chatId: "120363999999999999@g.us",
      accountId: "responder",
      from: "66378837028965@lid",
      fromMe: false,
      text: "wrong chat",
    }, env),
    /whatsapp_target_required/,
  );

  const routed = await routeWhatsAppInbound({
    eventId: "wa-generated-lid-sender",
    chatId: "120363424272031669@g.us",
    accountId: "responder",
    from: "66378837028965@lid",
    fromMe: false,
    text: "lid sender",
  }, env);
  const messages = await listThreadMessages("generated-lid-thread", env);

  assert.equal(routed.threadId, "generated-lid-thread");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, "lid sender");
  assert.equal(messages[0].from, "66378837028965@lid");
});

test("legacy allowOtherPeople does not enable additional participants without confirmation", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-additional-confirm-"));
  const env = externalBridgeEnv(home);
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
  const env = externalBridgeEnv(home);
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
  const env = externalBridgeEnv(home);
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
  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-mirror-off-router-notice"] });
  });

  assert.equal(routed.threadId, "mirror-off-thread");
  assert.equal(delivery.delivered.length, 1);
  assert.equal(delivery.delivered[0].deliveryType, "router_update");
  assert.equal(delivery.delivered[0].routerUpdateType, "mirror_disabled");
  assert.equal(delivery.failed.length, 0);
  assert.equal(delivery.skipped.some((item) => item.reason === "mirroring_disabled"), true);
  assert.equal(calls.length, 1);
  assert.match(stripDebugFooter(calls[0].body.text), /^Message routed to Orkestr\./);
});

test("whatsapp delivery skips duplicate live Codex answers for the same chat", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-duplicate-reply-"));
  const env = externalBridgeEnv(home);
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
  assert.equal(stripDebugFooter(calls[0].body.text), "same answer");
  assertDebugFooter(calls[0].body.text, { messageType: "final" });
});
