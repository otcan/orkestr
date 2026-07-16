import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { promisify } from "node:util";
import { startServer } from "../apps/server/src/server.js";
import { stopCodexAppServerClients } from "../packages/core/src/codex-app-server-client.js";
import { runNextAgentMessage, runNextThreadMessage } from "../packages/core/src/executors.js";
import { listAgentMessages } from "../packages/core/src/messages.js";
import { deliverPendingThreadInputs, listRuntimeLeases } from "../packages/core/src/runtime-leases.js";
import { listRouterTraces } from "../packages/core/src/router-traces.js";
import { getSetupStatus } from "../packages/core/src/setup.js";
import { createDesktopShare, desktopShareStatus, openDesktopShare } from "../packages/core/src/desktop-shares.js";
import { createPairingChallenge, listPairingChallenges } from "../packages/core/src/security.js";
import { createTenantVm } from "../packages/core/src/tenant-vm-registry.js";
import { configureTenantWhatsAppRoute } from "../packages/core/src/tenant-whatsapp-routing.js";
import { appendThreadMessage, createThread, enqueueThreadInput, getThread, listThreadMessages, listThreads, updateThreadMessage } from "../packages/core/src/threads.js";
import { createUser, linkUserPrivateIdentity } from "../packages/core/src/users.js";
import { deliverWhatsAppReplies, formatWhatsAppOutboundText, getWhatsAppChatMessages, getWhatsAppChatParticipants, getWhatsAppStatus, initialQueueDeliveryState, mapLocalWhatsAppStatusFromHealth, routeWhatsAppInbound, sendWhatsAppText, syncWhatsAppTypingIndicators } from "../packages/connectors/src/whatsapp.js";
import { addLocalWhatsAppGroupParticipants, cleanupLocalWhatsAppChromeLocks, clearLocalWhatsAppChatTypingState, createLocalWhatsAppChat, demoteLocalWhatsAppGroupParticipants, forwardLocalWhatsAppInbound, getLocalWhatsAppBridgeStatus, handleInboundMessage, inboundRoutingFailureNoticeText, listLocalWhatsAppChats, listLocalWhatsAppChatParticipants, localWhatsAppAccountIdsForEnv, localWhatsAppConnectedPageReadyFallbackEligible, localWhatsAppInboundForwardTarget, localWhatsAppMessageRouteFields, localWhatsAppReadyFallbackEligible, localWhatsAppTypingClearRetryDelaysMs, localWhatsAppUnreadRecoveryBoundChats, localWhatsAppUnreadRecoveryIntervalMs, normalizeGroupParticipantIds, notifyLocalWhatsAppPairingRequired, promoteLocalWhatsAppGroupParticipants, recoverConfiguredLocalWhatsAppAccounts, recoverLocalWhatsAppChatMessages, recoverUnreadLocalWhatsAppMessages, recoverableLocalWhatsAppAccountIds, reduceLocalWhatsAppBridgeState, resetLocalWhatsAppBridgeForTest, restartRecoverableLocalWhatsAppAccount, sendLocalWhatsAppMessage, sendLocalWhatsAppRepairQrEmail, sendWhatsAppTextWithConfirmation, setLocalWhatsAppRuntimeForTest, setLocalWhatsAppRuntimeRecoveryHooksForTest, startLocalWhatsAppAccount, startLocalWhatsAppTyping, stopLocalWhatsAppTyping, syncLocalWhatsAppTypingTargets, webCacheRoot } from "../packages/connectors/src/whatsapp-local-bridge.js";
import { routedWhatsAppTypingTarget, runWithRoutedWhatsAppTyping } from "../packages/connectors/src/whatsapp-router-typing.js";
import { upsertWhatsAppBinding } from "../packages/connectors/src/whatsapp-account-bindings.js";
import { createAndBindWhatsAppThreadGroup } from "../packages/connectors/src/whatsapp-thread-groups.js";
import { prepareWhatsAppTableAttachments } from "../packages/connectors/src/whatsapp-table-attachments.js";
import { canRecoverLiveWhatsAppOutboundIntent, mergeWhatsAppOutboundIntents, mergeWhatsAppOutboundMirrorCursors } from "../packages/connectors/src/whatsapp-outbound-intents.js";
import { formatWhatsAppQueueNotice } from "../packages/connectors/src/whatsapp-outbound-mirror.js";
import { routerUpdateWhatsAppDeliveryTarget } from "../packages/connectors/src/whatsapp-router-updates.js";
import { upsertWhatsAppConnectorAccount } from "../packages/connectors/src/whatsapp-account-registry.js";
import { readConnectorOutbox, writeConnectorOutbox } from "../packages/connectors/src/connector-outbox.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";
import { dataPaths, userDataPaths } from "../packages/storage/src/paths.js";
import { listEvents } from "../packages/storage/src/store.js";

const execFileAsync = promisify(execFile);
const priorWhatsappAutostart = {
  ORKESTR_WHATSAPP_AUTOSTART: process.env.ORKESTR_WHATSAPP_AUTOSTART,
  WHATSAPP_LOCAL_AUTOSTART: process.env.WHATSAPP_LOCAL_AUTOSTART,
};

process.env.ORKESTR_WHATSAPP_AUTOSTART = "0";
process.env.WHATSAPP_LOCAL_AUTOSTART = "0";

afterEach(() => {
  stopCodexAppServerClients();
});

test.after(() => {
  for (const [key, value] of Object.entries(priorWhatsappAutostart)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("whatsapp outbound intent state merge is monotonic", () => {
  const cursors = mergeWhatsAppOutboundMirrorCursors(
    [{ messageSetKey: "thread||one", cursor: 42, updatedAt: "2026-06-02T12:00:00.000Z" }],
    [{ messageSetKey: "thread||one", cursor: 12, updatedAt: "2026-06-02T13:00:00.000Z" }],
  );
  const unchangedCursors = mergeWhatsAppOutboundMirrorCursors(
    [{ messageSetKey: "thread||one", cursor: 42, updatedAt: "2026-06-02T12:00:00.000Z" }],
    [{ messageSetKey: "thread||one", cursor: 42, updatedAt: "2026-06-02T13:00:00.000Z" }],
  );
  const intents = mergeWhatsAppOutboundIntents(
    [{
      intentId: "intent-1",
      status: "delivered",
      messageId: "message-1",
      updatedAt: "2026-06-02T12:00:00.000Z",
    }],
    [{
      intentId: "intent-1",
      status: "pending",
      messageId: "message-1",
      updatedAt: "2026-06-02T13:00:00.000Z",
    }],
  );
  const skippedIntents = mergeWhatsAppOutboundIntents(
    [{
      intentId: "intent-2",
      status: "pending",
      messageId: "message-2",
      updatedAt: "2026-06-02T12:00:00.000Z",
    }],
    [{
      intentId: "intent-2",
      status: "skipped",
      messageId: "message-2",
      updatedAt: "2026-06-02T13:00:00.000Z",
    }],
  );
  const replayedIntent = mergeWhatsAppOutboundIntents(
    [{
      intentId: "intent-3",
      status: "skipped",
      messageId: "message-3",
      replayRequestedAt: "2026-06-02T12:00:00.000Z",
      updatedAt: "2026-06-02T12:01:00.000Z",
    }],
    [{
      intentId: "intent-3",
      status: "pending",
      messageId: "message-3",
      replayRequestedAt: "2026-06-02T13:00:00.000Z",
      updatedAt: "2026-06-02T13:00:00.000Z",
    }],
  );
  const staleTerminalAfterReplay = mergeWhatsAppOutboundIntents(
    replayedIntent,
    [{
      intentId: "intent-3",
      status: "skipped",
      messageId: "message-3",
      replayRequestedAt: "2026-06-02T12:00:00.000Z",
      updatedAt: "2026-06-02T12:01:00.000Z",
    }],
  );
  const currentTerminalAfterReplay = mergeWhatsAppOutboundIntents(
    replayedIntent,
    [{
      intentId: "intent-3",
      status: "delivered",
      messageId: "message-3",
      replayRequestedAt: "2026-06-02T13:00:00.000Z",
      updatedAt: "2026-06-02T13:01:00.000Z",
    }],
  );

  assert.equal(cursors[0].cursor, 42);
  assert.equal(unchangedCursors[0].updatedAt, "2026-06-02T12:00:00.000Z");
  assert.equal(intents[0].status, "delivered");
  assert.equal(skippedIntents[0].status, "skipped");
  assert.equal(replayedIntent[0].status, "pending");
  assert.equal(staleTerminalAfterReplay[0].status, "pending");
  assert.equal(currentTerminalAfterReplay[0].status, "delivered");
});

test("whatsapp send failures preserve structured bridge error reasons", async () => {
  const runtimeEnv = externalBridgeEnv(await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-structured-error-")));
  await assert.rejects(
    () => sendWhatsAppText({
      chatId: "chat-structured-error",
      text: "hello",
      accountId: "account-1",
      config: { bridgeMode: "external", bridgeUrl: "http://wa.local" },
      env: runtimeEnv,
      fetchImpl: async () => response({
        ok: false,
        error: {
          code: "whatsapp_local_bridge_not_ready",
          message: "Local bridge is restarting",
        },
      }, false, 503),
    }),
    /whatsapp_local_bridge_not_ready: Local bridge is restarting/,
  );
});

test("whatsapp relay mode without bridge URL does not fall back to local bridge", async () => {
  const runtimeEnv = externalBridgeEnv(await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-relay-missing-url-")));
  let fetchCalls = 0;

  await assert.rejects(
    () => sendWhatsAppText({
      chatId: "chat-relay-missing-url",
      text: "hello",
      accountId: "sender",
      config: { bridgeMode: "relay" },
      env: runtimeEnv,
      fetchImpl: async () => {
        fetchCalls += 1;
        return response({ ok: true });
      },
    }),
    /whatsapp_bridge_not_configured/,
  );
  assert.equal(fetchCalls, 0);
});

function response(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() {
      return payload;
    },
  };
}

async function waitForWatcherAlerts(home, attempts = 25) {
  const file = dataPaths({ ORKESTR_HOME: home }).watcherAlerts;
  for (let index = 0; index < attempts; index += 1) {
    try {
      const payload = JSON.parse(await fs.readFile(file, "utf8"));
      if (Array.isArray(payload.alerts) && payload.alerts.length) return payload.alerts;
    } catch {
      // The watcher writes asynchronously after the response is returned.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return [];
}

async function waitForLocalWhatsAppAccount(env, accountId, predicate, attempts = 25) {
  let last = null;
  for (let index = 0; index < attempts; index += 1) {
    const status = await getLocalWhatsAppBridgeStatus(env);
    const account = status.accounts.find((item) => item.accountId === accountId) || null;
    last = { status, account };
    if (account && predicate(account, status)) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return last;
}

async function waitForTestCondition(predicate, attempts = 25) {
  for (let index = 0; index < attempts; index += 1) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

function binaryResponse(body, headers = {}, status = 200) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return normalizedHeaders[String(name || "").toLowerCase()] || "";
      },
    },
    async json() {
      return {};
    },
    async arrayBuffer() {
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },
  };
}

function stripDebugFooter(text) {
  return String(text || "").replace(/\n\ndbg: .+$/s, "");
}

function testNormalizedDeliveryText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function testDeliveryTextKey(chatId, text) {
  return crypto
    .createHash("sha256")
    .update(`${String(chatId || "").trim()}\n${testNormalizedDeliveryText(text)}`)
    .digest("hex");
}

function testFinalDeliveryTextKey(chatId, message, text) {
  const turnKey = String(message?.parentMessageId || message?.id || "").trim();
  return testDeliveryTextKey(chatId, `${turnKey}\n${text}`);
}

function testDeliveryClaimKey({ accountId = "", chatId = "", textKey = "" } = {}) {
  return crypto
    .createHash("sha256")
    .update(`${String(accountId || "").trim()}\n${String(chatId || "").trim()}\n${String(textKey || "").trim()}`)
    .digest("hex");
}

async function writeTestDeliveryClaim(home, { accountId, chatId, textKey, claimedAt, expiresAt } = {}) {
  const claimKey = testDeliveryClaimKey({ accountId, chatId, textKey });
  const dir = path.join(home, "whatsapp-delivery-claims");
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${claimKey}.json`);
  await fs.writeFile(
    filePath,
    JSON.stringify({
      claimKey,
      kind: "thread",
      deliveryType: "final",
      chatId,
      accountId,
      textKey,
      status: "claimed",
      claimedAt,
      updatedAt: claimedAt,
      expiresAt,
      pid: 12345,
    }, null, 2) + "\n",
    "utf8",
  );
  return { claimKey, filePath };
}

function assertDebugFooter(text, { mode = "", messageType = "final", model = "[^·\\n]+", queueReason = "", runtime = "", fiveHour = "", weekly = "" } = {}) {
  const escapedModel = model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const queuePart = queueReason
    ? ` · queue:\\d+ · reason:${queueReason}`
    : " · q:\\d+";
  const runtimeSwitch = runtime
    ? ` · rt-switch:${runtime === "api" ? "/switch-terminal" : "/switch-api"}`
    : "(?: · rt-switch:/switch-[a-z-]+)?";
  const pattern = new RegExp(
    `\\n\\ndbg: m:${model === "[^·\\n]+" ? model : escapedModel}` +
      (mode ? ` · mode:${mode}` : "") +
      (runtime ? ` · rt:${runtime}` : "(?: · rt:[a-z-]+)?") +
      ` · msg:${messageType}` +
      (fiveHour ? ` · 5h:${fiveHour}` : "(?: · 5h:\\d+%)?") +
      (weekly ? ` · wk:${weekly}` : "(?: · wk:\\d+%)?") +
      `${queuePart} · load:\\d+% · api:\\d+% · help:/help` +
      (mode === "plan" ? " · mode-switch:/code" : " · mode-switch:/plan") +
      runtimeSwitch +
      "$",
  );
  assert.match(text, pattern);
}

function externalBridgeEnv(home, extra = {}) {
  return {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1",
    ORKESTR_WHATSAPP_DEBUG_FOOTER: "1",
    ORKESTR_WHATSAPP_API_AGENT_AUTORUN: "0",
    ...extra,
  };
}

async function writeBrokerInstance(env, { instanceId, whatsappChatId }) {
  const registryPath = dataPaths(env).brokerInstances;
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  await fs.writeFile(
    registryPath,
    JSON.stringify({
      schemaVersion: 1,
      instances: [{
        instanceId,
        status: "registered",
        whatsappChatHash: crypto.createHash("sha256").update(whatsappChatId).digest("hex"),
        registeredAt: "2026-06-18T09:00:00.000Z",
      }],
    }, null, 2),
  );
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

test("local whatsapp typing clear uses chat api plus direct chatstate stop", async () => {
  const calls = [];
  const runtime = {
    client: {
      async getChatById(chatId) {
        calls.push(["getChatById", chatId]);
        return {
          async clearState() {
            calls.push(["clearState"]);
          },
        };
      },
      pupPage: {
        async evaluate(_fn, chatId, state) {
          calls.push(["directChatstate", chatId, state]);
          return true;
        },
      },
    },
  };

  const result = await clearLocalWhatsAppChatTypingState(runtime, "chat-typing-clear", {
    ORKESTR_WHATSAPP_TYPING_OPERATION_TIMEOUT_MS: "1000",
  });

  assert.deepEqual(result, { ok: true, chatApiOk: true, directOk: true });
  assert.deepEqual(calls, [
    ["getChatById", "chat-typing-clear"],
    ["clearState"],
    ["directChatstate", "chat-typing-clear", "stop"],
  ]);
});

test("local whatsapp typing clear falls back to direct chatstate stop", async () => {
  const calls = [];
  const runtime = {
    client: {
      async getChatById(chatId) {
        calls.push(["getChatById", chatId]);
        return {
          async clearState() {
            calls.push(["clearState"]);
            throw new Error("clear_state_noop");
          },
        };
      },
      pupPage: {
        async evaluate(_fn, chatId, state) {
          calls.push(["directChatstate", chatId, state]);
          return true;
        },
      },
    },
  };

  const result = await clearLocalWhatsAppChatTypingState(runtime, "chat-typing-clear", {
    ORKESTR_WHATSAPP_TYPING_OPERATION_TIMEOUT_MS: "1000",
  });

  assert.deepEqual(result, { ok: true, chatApiOk: false, directOk: true });
  assert.deepEqual(calls, [
    ["getChatById", "chat-typing-clear"],
    ["clearState"],
    ["directChatstate", "chat-typing-clear", "stop"],
  ]);
});

test("local whatsapp typing clear bypasses a broken chat lookup", async () => {
  const calls = [];
  const runtime = {
    client: {
      async getChatById(chatId) {
        calls.push(["getChatById", chatId]);
        throw new Error("r");
      },
      pupPage: {
        async evaluate(_fn, chatId, state) {
          calls.push(["directChatstate", chatId, state]);
          return true;
        },
      },
    },
  };

  const result = await clearLocalWhatsAppChatTypingState(runtime, "chat-typing-clear", {
    ORKESTR_WHATSAPP_TYPING_OPERATION_TIMEOUT_MS: "1000",
  });

  assert.deepEqual(result, { ok: true, chatApiOk: false, directOk: true });
  assert.deepEqual(calls, [
    ["getChatById", "chat-typing-clear"],
    ["directChatstate", "chat-typing-clear", "stop"],
  ]);
});

test("local whatsapp typing start bypasses a broken chat lookup", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-typing-chat-lookup-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
    ORKESTR_WHATSAPP_TYPING_REFRESH_MS: "60000",
    ORKESTR_WHATSAPP_TYPING_OPERATION_TIMEOUT_MS: "1000",
  };
  const calls = [];
  const runtime = {
    client: {
      async getChatById(chatId) {
        calls.push(["getChatById", chatId]);
        throw new Error("r");
      },
      pupPage: {
        async evaluate(_fn, chatId, state) {
          calls.push(["directChatstate", chatId, state]);
          return true;
        },
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("responder", runtime, { lastChatOpsProbeAt: null }, env);
    const result = await startLocalWhatsAppTyping({ accountId: "responder", chatId: "chat-typing-start", env });

    assert.equal(result.ok, true);
    assert.equal(result.active, true);
    assert.deepEqual(calls, [
      ["getChatById", "chat-typing-start"],
      ["directChatstate", "chat-typing-start", "typing"],
    ]);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp typing starts are single-flight per chat", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-typing-single-flight-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
    ORKESTR_WHATSAPP_TYPING_REFRESH_MS: "60000",
    ORKESTR_WHATSAPP_TYPING_OPERATION_TIMEOUT_MS: "1000",
  };
  let releaseStart;
  let holdStart = true;
  const startGate = new Promise((resolve) => {
    releaseStart = resolve;
  });
  const calls = [];
  const chat = {
    async sendStateTyping() {
      calls.push(["sendStateTyping"]);
    },
    async clearState() {
      calls.push(["clearState"]);
    },
  };
  const runtime = {
    client: {
      async getChatById(chatId) {
        calls.push(["getChatById", chatId]);
        if (holdStart) await startGate;
        return chat;
      },
      async sendPresenceAvailable() {
        calls.push(["sendPresenceAvailable"]);
      },
      pupPage: {
        async evaluate(_fn, chatId, state) {
          calls.push(["directChatstate", chatId, state]);
          return true;
        },
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("responder", runtime, { lastChatOpsProbeAt: null }, env);
    const first = startLocalWhatsAppTyping({ accountId: "responder", chatId: "chat-typing-race", env });
    const second = startLocalWhatsAppTyping({ accountId: "responder", chatId: "chat-typing-race", env });
    await Promise.resolve();

    assert.deepEqual(calls, [["getChatById", "chat-typing-race"]]);
    holdStart = false;
    releaseStart();
    const results = await Promise.all([first, second]);

    assert.equal(results[0].reused, false);
    assert.equal(results[1].reused, true);
    assert.equal(calls.filter((call) => call[0] === "getChatById").length, 1);
    assert.equal(calls.filter((call) => call[0] === "sendStateTyping").length, 1);
    assert.equal((await getLocalWhatsAppBridgeStatus(env)).activeTypingCount, 1);

    await stopLocalWhatsAppTyping({ accountId: "responder", chatId: "chat-typing-race", env });
    assert.equal((await getLocalWhatsAppBridgeStatus(env)).activeTypingCount, 0);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp typing sync keeps active sessions through transient empty targets", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-typing-grace-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
    ORKESTR_WHATSAPP_TYPING_REFRESH_MS: "60000",
    ORKESTR_WHATSAPP_TYPING_OPERATION_TIMEOUT_MS: "1000",
    ORKESTR_WHATSAPP_TYPING_STOP_GRACE_MS: "60000",
    ORKESTR_WHATSAPP_TYPING_CLEAR_RETRY_MS: "0",
  };
  const calls = [];
  const chat = {
    async sendStateTyping() {
      calls.push(["sendStateTyping"]);
    },
    async clearState() {
      calls.push(["clearState"]);
    },
  };
  const runtime = {
    client: {
      async getChatById(chatId) {
        calls.push(["getChatById", chatId]);
        return chat;
      },
      async sendPresenceAvailable() {
        calls.push(["sendPresenceAvailable"]);
      },
      pupPage: {
        async evaluate(_fn, chatId, state) {
          calls.push(["directChatstate", chatId, state]);
          return true;
        },
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("responder", runtime, { lastChatOpsProbeAt: null }, env);
    const started = await syncLocalWhatsAppTypingTargets([{ accountId: "responder", chatId: "chat-typing-grace" }], env);
    const kept = await syncLocalWhatsAppTypingTargets([], env);

    assert.equal(started.active, 1);
    assert.equal(kept.active, 1);
    assert.equal(kept.kept.length, 1);
    assert.equal((await getLocalWhatsAppBridgeStatus(env)).activeTypingCount, 1);
    assert.equal(calls.filter((call) => call[0] === "clearState").length, 0);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp typing sync can clear immediately when stop grace is disabled", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-typing-no-grace-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
    ORKESTR_WHATSAPP_TYPING_REFRESH_MS: "60000",
    ORKESTR_WHATSAPP_TYPING_OPERATION_TIMEOUT_MS: "1000",
    ORKESTR_WHATSAPP_TYPING_STOP_GRACE_MS: "0",
    ORKESTR_WHATSAPP_TYPING_CLEAR_RETRY_MS: "0",
  };
  const calls = [];
  const chat = {
    async sendStateTyping() {
      calls.push(["sendStateTyping"]);
    },
    async clearState() {
      calls.push(["clearState"]);
    },
  };
  const runtime = {
    client: {
      async getChatById(chatId) {
        calls.push(["getChatById", chatId]);
        return chat;
      },
      async sendPresenceAvailable() {
        calls.push(["sendPresenceAvailable"]);
      },
      pupPage: {
        async evaluate(_fn, chatId, state) {
          calls.push(["directChatstate", chatId, state]);
          return true;
        },
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("responder", runtime, { lastChatOpsProbeAt: null }, env);
    await syncLocalWhatsAppTypingTargets([{ accountId: "responder", chatId: "chat-typing-no-grace" }], env);
    const stopped = await syncLocalWhatsAppTypingTargets([], env);

    assert.equal(stopped.active, 0);
    assert.equal(stopped.stopped.length, 1);
    assert.equal((await getLocalWhatsAppBridgeStatus(env)).activeTypingCount, 0);
    assert.equal(calls.filter((call) => call[0] === "clearState").length, 1);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp typing expires when its desired-state lease is not renewed", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-typing-ttl-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
    ORKESTR_WHATSAPP_TYPING_REFRESH_MS: "60000",
    ORKESTR_WHATSAPP_TYPING_MAX_TTL_MS: "1000",
    ORKESTR_WHATSAPP_TYPING_OPERATION_TIMEOUT_MS: "500",
    ORKESTR_WHATSAPP_TYPING_CLEAR_RETRY_MS: "0",
  };
  const runtime = {
    client: {
      async getChatById() {
        return { async sendStateTyping() {}, async clearState() {} };
      },
      async sendPresenceAvailable() {},
      pupPage: { async evaluate() { return true; } },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("responder", runtime, {}, env);
    await startLocalWhatsAppTyping({ accountId: "responder", chatId: "chat-typing-ttl", env });
    assert.equal((await getLocalWhatsAppBridgeStatus(env)).activeTypingCount, 1);

    await new Promise((resolve) => setTimeout(resolve, 1200));

    assert.equal((await getLocalWhatsAppBridgeStatus(env)).activeTypingCount, 0);
    assert.ok((await listEvents(env)).some((event) => event.type === "whatsapp_local_typing_ttl_expired"));
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp typing refresh exhaustion stops stale sessions", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-typing-exhausted-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
    ORKESTR_WHATSAPP_TYPING_REFRESH_MS: "2000",
    ORKESTR_WHATSAPP_TYPING_OPERATION_TIMEOUT_MS: "500",
    ORKESTR_WHATSAPP_TYPING_REFRESH_FAILURE_LIMIT: "1",
    ORKESTR_WHATSAPP_TYPING_CLEAR_RETRY_MS: "0",
  };
  let failRefresh = false;
  const chat = {
    async sendStateTyping() {},
    async clearState() {},
  };
  const runtime = {
    client: {
      async getChatById() {
        if (failRefresh) throw new Error("typing_get_chat_timeout");
        return chat;
      },
      async sendPresenceAvailable() {},
      pupPage: {
        async evaluate() {
          if (failRefresh) throw new Error("typing_direct_timeout");
          return true;
        },
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("responder", runtime, {}, env);
    await startLocalWhatsAppTyping({ accountId: "responder", chatId: "chat-typing-stale", env });
    assert.equal((await getLocalWhatsAppBridgeStatus(env)).activeTypingCount, 1);

    failRefresh = true;
    await new Promise((resolve) => setTimeout(resolve, 2300));

    assert.equal((await getLocalWhatsAppBridgeStatus(env)).activeTypingCount, 0);
    const events = await listEvents(env);
    assert.ok(events.find((event) => event.type === "whatsapp_local_typing_refresh_exhausted"));
    assert.ok(events.find((event) => event.type === "whatsapp_local_typing_stopped"));
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp typing clear failure never restarts the inbound transport", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-typing-clear-r-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
    ORKESTR_WHATSAPP_TYPING_REFRESH_MS: "60000",
    ORKESTR_WHATSAPP_TYPING_OPERATION_TIMEOUT_MS: "500",
    ORKESTR_WHATSAPP_TYPING_STOP_GRACE_MS: "0",
    ORKESTR_WHATSAPP_TYPING_CLEAR_RETRY_MS: "5,10,15",
    ORKESTR_WHATSAPP_AUTO_RECOVER_MS: "5000",
  };
  const calls = [];
  let failClear = false;
  const chat = {
    async sendStateTyping() {
      calls.push(["sendStateTyping"]);
    },
    async clearState() {
      calls.push(["clearState"]);
      if (failClear) throw new Error("r");
    },
  };
  const runtime = {
    client: {
      async getChatById(chatId) {
        calls.push(["getChatById", chatId]);
        return chat;
      },
      async sendPresenceAvailable() {},
      pupPage: {
        async evaluate(_fn, chatId, state) {
          calls.push(["directChatstate", chatId, state]);
          if (failClear && state === "stop") throw new Error("r");
          return true;
        },
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("responder", runtime, { lastChatOpsProbeAt: null }, env);
    setLocalWhatsAppRuntimeRecoveryHooksForTest({
      async restartAccount(accountId, actualEnv, options) {
        calls.push(["restart", accountId, actualEnv === env, options.reason]);
      },
      async startAccount(accountId, actualEnv, options) {
        calls.push(["start", accountId, actualEnv === env, options.showNotification]);
        return { accountId, state: "starting", ready: false };
      },
    });
    await startLocalWhatsAppTyping({ accountId: "responder", chatId: "chat-typing-r@g.us", env });

    failClear = true;
    await stopLocalWhatsAppTyping({ accountId: "responder", chatId: "chat-typing-r@g.us", env });
    await new Promise((resolve) => setTimeout(resolve, 40));

    const status = await getLocalWhatsAppBridgeStatus(env);
    const account = status.accounts.find((item) => item.accountId === "responder");
    const events = await listEvents(env, 50);

    assert.equal(status.activeTypingCount, 0);
    assert.equal(account.ready, true);
    assert.equal(account.chatOpsReady, true);
    assert.equal(account.runtimeUsable, true);
    assert.equal(account.error, "");
    assert.deepEqual(calls.filter((call) => call[0] === "restart"), []);
    assert.deepEqual(calls.filter((call) => call[0] === "start"), []);
    assert.ok(events.find((event) => event.type === "whatsapp_local_typing_clear_failed" && event.error === "r"));
    assert.ok(events.find((event) => event.type === "whatsapp_local_typing_runtime_recovery_deferred" && event.source === "typing_clear"));
    assert.equal(events.some((event) => event.type === "whatsapp_local_runtime_degraded" && event.source === "typing_clear"), false);
    assert.equal(events.filter((event) => event.type === "whatsapp_local_typing_clear_retry_failed").length, 3);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp typing clear keeps runtime ready when browser store is connected", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-typing-clear-store-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
    ORKESTR_WHATSAPP_TYPING_REFRESH_MS: "60000",
    ORKESTR_WHATSAPP_TYPING_OPERATION_TIMEOUT_MS: "500",
    ORKESTR_WHATSAPP_TYPING_STOP_GRACE_MS: "0",
    ORKESTR_WHATSAPP_CHAT_OPS_PROBE_TIMEOUT_MS: "500",
  };
  const calls = [];
  let failClear = false;
  const chat = {
    async sendStateTyping() {
      calls.push(["sendStateTyping"]);
    },
    async clearState() {
      calls.push(["clearState"]);
      if (failClear) throw new Error("r");
    },
  };
  const runtime = {
    client: {
      async getChatById(chatId) {
        calls.push(["getChatById", chatId]);
        return chat;
      },
      async sendPresenceAvailable() {},
      pupPage: {
        async evaluate(_fn, chatId, state) {
          if (arguments.length >= 3) {
            calls.push(["directChatstate", chatId, state]);
            if (failClear && state === "stop") throw new Error("r");
            return true;
          }
          calls.push(["browserStore"]);
          return {
            ok: true,
            appState: "CONNECTED",
            chatCount: 3,
            hasChatStore: true,
            hasMsgStore: true,
          };
        },
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("responder", runtime, { lastChatOpsProbeAt: null }, env);
    setLocalWhatsAppRuntimeRecoveryHooksForTest({
      async restartAccount(accountId) {
        calls.push(["restart", accountId]);
      },
      async startAccount(accountId) {
        calls.push(["start", accountId]);
        return { accountId, state: "starting", ready: false };
      },
    });
    await startLocalWhatsAppTyping({ accountId: "responder", chatId: "chat-typing-store@g.us", env });

    failClear = true;
    await stopLocalWhatsAppTyping({ accountId: "responder", chatId: "chat-typing-store@g.us", env });

    const status = await getLocalWhatsAppBridgeStatus(env);
    const account = status.accounts.find((item) => item.accountId === "responder");
    const events = await listEvents(env, 50);

    assert.equal(status.activeTypingCount, 0);
    assert.equal(status.state, "ready");
    assert.equal(account.ready, true);
    assert.equal(account.chatOpsReady, true);
    assert.equal(account.runtimeUsable, true);
    assert.equal(account.lastRecoveryReason, "browser_store_typing_runtime_fallback");
    assert.equal(calls.some((call) => call[0] === "restart"), false);
    assert.equal(calls.some((call) => call[0] === "start"), false);
    assert.ok(events.find((event) => event.type === "whatsapp_local_typing_runtime_browser_store_ready" && event.accountId === "responder"));
    assert.equal(events.some((event) => event.type === "whatsapp_local_runtime_degraded" && event.source === "typing_clear"), false);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp passive status does not run chat ops probes that throw r", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-chatops-r-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
    ORKESTR_WHATSAPP_CHAT_OPS_PROBE_INTERVAL_MS: "1000",
    ORKESTR_WHATSAPP_CHAT_OPS_PROBE_TIMEOUT_MS: "500",
    ORKESTR_WHATSAPP_AUTO_RECOVER_MS: "5000",
  };
  const calls = [];
  const runtime = {
    client: {
      async getChats() {
        calls.push(["getChats"]);
        throw new Error("r");
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("responder", runtime, { lastChatOpsProbeAt: null }, env);
    setLocalWhatsAppRuntimeRecoveryHooksForTest({
      async restartAccount(accountId, actualEnv, options) {
        calls.push(["restart", accountId, actualEnv === env, options.reason]);
      },
      async startAccount(accountId, actualEnv, options) {
        calls.push(["start", accountId, actualEnv === env, options.showNotification]);
        return { accountId, state: "starting", ready: false };
      },
    });

    const status = await getLocalWhatsAppBridgeStatus(env);
    const account = status.accounts.find((item) => item.accountId === "responder");
    const events = await listEvents(env, 50);

    assert.equal(status.state, "ready");
    assert.equal(status.ready, true);
    assert.equal(status.chatOpsReady, true);
    assert.equal(account.state, "ready");
    assert.equal(account.ready, true);
    assert.equal(account.chatOpsReady, true);
    assert.equal(account.runtimeUsable, true);
    assert.equal(account.error, "");
    assert.deepEqual(calls, []);
    assert.equal(events.some((event) => event.type === "whatsapp_local_runtime_degraded" && event.source === "chat_ops_probe"), false);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp active status chat ops probe keeps send runtime ready when getChats throws r", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-chatops-active-r-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
    ORKESTR_WHATSAPP_STATUS_CHAT_OPS_PROBE: "1",
    ORKESTR_WHATSAPP_CHAT_OPS_PROBE_INTERVAL_MS: "1000",
    ORKESTR_WHATSAPP_CHAT_OPS_PROBE_TIMEOUT_MS: "500",
    ORKESTR_WHATSAPP_AUTO_RECOVER_MS: "5000",
  };
  const calls = [];
  const runtime = {
    client: {
      async getChats() {
        calls.push(["getChats"]);
        throw new Error("r");
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("responder", runtime, { lastChatOpsProbeAt: null }, env);
    setLocalWhatsAppRuntimeRecoveryHooksForTest({
      async restartAccount(accountId, actualEnv, options) {
        calls.push(["restart", accountId, actualEnv === env, options.reason]);
      },
      async startAccount(accountId, actualEnv, options) {
        calls.push(["start", accountId, actualEnv === env, options.showNotification]);
        return { accountId, state: "starting", ready: false };
      },
    });

    const status = await getLocalWhatsAppBridgeStatus(env);
    const account = status.accounts.find((item) => item.accountId === "responder");
    const events = await listEvents(env, 50);

    assert.equal(status.state, "failed");
    assert.equal(status.ready, false);
    assert.equal(status.chatOpsReady, false);
    assert.equal(account.state, "ready");
    assert.equal(account.ready, true);
    assert.equal(account.chatOpsReady, false);
    assert.equal(account.runtimeUsable, true);
    assert.equal(account.lastChatOpsError, "r");
    assert.ok(account.chatOpsUnavailableSince);
    assert.deepEqual(calls, [["getChats"]]);
    assert.equal(events.some((event) => event.type === "whatsapp_local_runtime_degraded" && event.source === "chat_ops_probe"), false);
    assert.ok(events.find((event) => event.type === "whatsapp_local_chat_ops_probe_unavailable" && event.accountId === "responder"));
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp active status accepts browser store when getChats throws r", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-chatops-store-fallback-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
    ORKESTR_WHATSAPP_STATUS_CHAT_OPS_PROBE: "1",
    ORKESTR_WHATSAPP_CHAT_OPS_PROBE_INTERVAL_MS: "1000",
    ORKESTR_WHATSAPP_CHAT_OPS_PROBE_TIMEOUT_MS: "500",
  };
  const calls = [];
  const previousWindow = globalThis.window;
  const runtime = {
    client: {
      async getChats() {
        calls.push(["getChats"]);
        throw new Error("r");
      },
      pupPage: {
        async evaluate(fn) {
          calls.push(["browserStore"]);
          globalThis.window = {
            require(name) {
              if (name === "WAWebCollections") {
                return {
                  Chat: {
                    getModelsArray() {
                      return [{ id: { _serialized: "chat-one@g.us" } }];
                    },
                  },
                  Msg: {},
                };
              }
              throw new Error(`unexpected require ${name}`);
            },
            AuthStore: { AppState: { state: "CONNECTED" } },
            WWebJS: {},
          };
          try {
            return await fn();
          } finally {
            globalThis.window = previousWindow;
          }
        },
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("responder", runtime, { lastChatOpsProbeAt: null }, env);

    const status = await getLocalWhatsAppBridgeStatus(env);
    const account = status.accounts.find((item) => item.accountId === "responder");
    const events = await listEvents(env, 50);

    assert.equal(status.state, "ready");
    assert.equal(status.ready, true);
    assert.equal(status.chatOpsReady, true);
    assert.equal(account.ready, true);
    assert.equal(account.chatOpsReady, true);
    assert.equal(account.runtimeUsable, true);
    assert.equal(account.lastChatOpsError, "");
    assert.equal(account.chatOpsUnavailableSince, null);
    assert.deepEqual(calls, [["getChats"], ["browserStore"]]);
    assert.ok(events.find((event) => event.type === "whatsapp_local_chat_ops_probe_browser_store_ready" && event.accountId === "responder"));
  } finally {
    globalThis.window = previousWindow;
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp chat list accepts browser store when getChats throws r", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-chat-list-store-fallback-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
    ORKESTR_WHATSAPP_CHAT_OPS_PROBE_TIMEOUT_MS: "500",
  };
  const calls = [];
  const previousWindow = globalThis.window;
  const runtime = {
    client: {
      async getChats() {
        calls.push(["getChats"]);
        throw new Error("r");
      },
      pupPage: {
        async evaluate(fn) {
          calls.push(["browserStore"]);
          globalThis.window = {
            require(name) {
              if (name === "WAWebCollections") {
                return {
                  Chat: {
                    getModelsArray() {
                      return [{ id: { _serialized: "chat-one@g.us" } }];
                    },
                  },
                  Msg: {},
                };
              }
              throw new Error(`unexpected require ${name}`);
            },
            AuthStore: { AppState: { state: "CONNECTED" } },
            WWebJS: {},
          };
          try {
            return await fn();
          } finally {
            globalThis.window = previousWindow;
          }
        },
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("responder", runtime, { lastChatOpsProbeAt: null }, env);

    const chats = await listLocalWhatsAppChats("responder", env);
    const status = await getLocalWhatsAppBridgeStatus(env);
    const account = status.accounts.find((item) => item.accountId === "responder");
    const events = await listEvents(env, 50);

    assert.equal(chats.ready, true);
    assert.equal(chats.state, "ready");
    assert.equal(chats.fallback, "browser_store");
    assert.equal(status.state, "ready");
    assert.equal(account.ready, true);
    assert.equal(account.runtimeUsable, true);
    assert.equal(account.lastChatOpsError, "");
    assert.deepEqual(calls, [["getChats"], ["browserStore"]]);
    assert.ok(events.find((event) => event.type === "whatsapp_local_chat_list_browser_store_ready" && event.accountId === "responder"));
    assert.equal(events.some((event) => event.type === "whatsapp_local_runtime_degraded" && event.source === "chat_list"), false);
  } finally {
    globalThis.window = previousWindow;
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp active status resets stale chat ops r degradation", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-chatops-stale-r-reset-"));
  const nowMs = Date.parse("2026-07-16T07:45:00.000Z");
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
    ORKESTR_WHATSAPP_STATUS_CHAT_OPS_PROBE: "1",
    ORKESTR_WHATSAPP_CHAT_OPS_PROBE_INTERVAL_MS: "1000",
    ORKESTR_WHATSAPP_CHAT_OPS_PROBE_TIMEOUT_MS: "500",
    ORKESTR_WHATSAPP_CHAT_OPS_RESET_AFTER_MS: "30000",
    ORKESTR_WHATSAPP_AUTO_RECOVER_MS: "5000",
  };
  const calls = [];
  const runtime = {
    client: {
      async getChats() {
        calls.push(["getChats"]);
        throw new Error("r");
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("responder", runtime, {
      lastChatOpsProbeAt: null,
      chatOpsReady: false,
      runtimeUsable: true,
      lastChatOpsError: "r",
      chatOpsUnavailableSince: new Date(nowMs - 31_000).toISOString(),
    }, env);
    setLocalWhatsAppRuntimeRecoveryHooksForTest({
      async restartAccount(accountId, actualEnv, options) {
        calls.push(["restart", accountId, actualEnv === env, options.reason]);
      },
      async startAccount(accountId, actualEnv, options) {
        calls.push(["start", accountId, actualEnv === env, options.showNotification]);
        return { accountId, state: "starting", ready: false };
      },
    });

    const status = await getLocalWhatsAppBridgeStatus(env, { nowMs });
    const account = status.accounts.find((item) => item.accountId === "responder");
    const events = await listEvents(env, 50);

    assert.equal(status.state, "failed");
    assert.equal(account.state, "degraded");
    assert.equal(account.ready, false);
    assert.equal(account.chatOpsReady, false);
    assert.equal(account.runtimeUsable, false);
    assert.deepEqual(calls, [
      ["getChats"],
      ["restart", "responder", true, "chat_ops_runtime_error"],
      ["start", "responder", true, false],
    ]);
    assert.ok(events.find((event) => event.type === "whatsapp_local_chat_ops_probe_recovery_due" && event.accountId === "responder"));
    assert.ok(events.find((event) => event.type === "whatsapp_local_runtime_degraded" && event.source === "chat_ops_probe"));
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp ready grace does not defer stale chat ops r outage", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-chatops-stale-grace-"));
  const nowMs = Date.parse("2026-07-16T08:32:00.000Z");
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
    ORKESTR_WHATSAPP_STATUS_CHAT_OPS_PROBE: "1",
    ORKESTR_WHATSAPP_CHAT_OPS_PROBE_INTERVAL_MS: "1000",
    ORKESTR_WHATSAPP_CHAT_OPS_PROBE_TIMEOUT_MS: "500",
    ORKESTR_WHATSAPP_CHAT_OPS_READY_GRACE_MS: "30000",
    ORKESTR_WHATSAPP_CHAT_OPS_RESET_AFTER_MS: "30000",
    ORKESTR_WHATSAPP_AUTO_RECOVER_MS: "5000",
  };
  const calls = [];
  const runtime = {
    client: {
      async getChats() {
        calls.push(["getChats"]);
        throw new Error("r");
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("responder", runtime, {
      readyAt: new Date(nowMs - 1000).toISOString(),
      lastChatOpsProbeAt: null,
      chatOpsReady: false,
      runtimeUsable: true,
      lastChatOpsError: "r",
      chatOpsUnavailableSince: new Date(nowMs - 31_000).toISOString(),
      lastRecoveryReason: "chat_ops_probe_ready_grace",
    }, env);
    setLocalWhatsAppRuntimeRecoveryHooksForTest({
      async restartAccount(accountId, actualEnv, options) {
        calls.push(["restart", accountId, actualEnv === env, options.reason]);
      },
      async startAccount(accountId, actualEnv, options) {
        calls.push(["start", accountId, actualEnv === env, options.showNotification]);
        return { accountId, state: "starting", ready: false };
      },
    });

    const status = await getLocalWhatsAppBridgeStatus(env, { nowMs });
    const account = status.accounts.find((item) => item.accountId === "responder");
    const events = await listEvents(env, 50);

    assert.equal(status.state, "failed");
    assert.equal(account.state, "degraded");
    assert.equal(account.ready, false);
    assert.equal(account.chatOpsReady, false);
    assert.equal(account.runtimeUsable, false);
    assert.equal(account.chatOpsUnavailableSince, new Date(nowMs - 31_000).toISOString());
    assert.deepEqual(calls, [
      ["getChats"],
      ["restart", "responder", true, "chat_ops_runtime_error"],
      ["start", "responder", true, false],
    ]);
    assert.ok(events.find((event) => event.type === "whatsapp_local_chat_ops_probe_recovery_due" && event.accountId === "responder"));
    assert.equal(events.some((event) => event.type === "whatsapp_local_chat_ops_probe_ready_grace" && event.accountId === "responder"), false);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp forced deep chat ops probe resets bare r after ready grace", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-chatops-forced-r-reset-"));
  const nowMs = Date.parse("2026-07-16T07:48:00.000Z");
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
    ORKESTR_WHATSAPP_CHAT_OPS_PROBE_INTERVAL_MS: "1000",
    ORKESTR_WHATSAPP_CHAT_OPS_PROBE_READ: "1",
    ORKESTR_WHATSAPP_CHAT_OPS_READY_GRACE_MS: "30000",
    ORKESTR_WHATSAPP_AUTO_RECOVER_MS: "5000",
  };
  const calls = [];
  const runtime = {
    client: {
      async getChats() {
        calls.push(["getChats"]);
        return [{ id: { _serialized: "unstable-sample@g.us" } }];
      },
      async getChatById(chatId) {
        calls.push(["getChatById", chatId]);
        throw new Error("r");
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("responder", runtime, {
      readyAt: new Date(nowMs - 60_000).toISOString(),
      lastChatOpsProbeAt: null,
    }, env);
    setLocalWhatsAppRuntimeRecoveryHooksForTest({
      async restartAccount(accountId, actualEnv, options) {
        calls.push(["restart", accountId, actualEnv === env, options.reason]);
      },
      async startAccount(accountId, actualEnv, options) {
        calls.push(["start", accountId, actualEnv === env, options.showNotification]);
        return { accountId, state: "starting", ready: false };
      },
    });

    const status = await getLocalWhatsAppBridgeStatus(env, {
      probeChatOps: true,
      read: true,
      force: true,
      nowMs,
    });
    const account = status.accounts.find((item) => item.accountId === "responder");

    assert.equal(status.state, "failed");
    assert.equal(account.state, "degraded");
    assert.equal(account.ready, false);
    assert.equal(account.chatOpsReady, false);
    assert.equal(account.runtimeUsable, false);
    assert.deepEqual(calls, [
      ["getChats"],
      ["getChatById", "unstable-sample@g.us"],
      ["restart", "responder", true, "chat_ops_runtime_error"],
      ["start", "responder", true, false],
    ]);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp status repairs stale chat ops r degradation as send-ready", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-chatops-stale-r-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
    ORKESTR_WHATSAPP_CHAT_OPS_PROBE_INTERVAL_MS: "1000",
  };
  const runtime = { client: {} };

  try {
    setLocalWhatsAppRuntimeForTest("responder", runtime, {
      state: "ready",
      ready: true,
      authenticated: true,
      started: true,
      chatOpsReady: false,
      runtimeUsable: false,
      lastChatOpsError: "r",
      error: "",
    }, env);

    const status = await getLocalWhatsAppBridgeStatus(env);
    const account = status.accounts.find((item) => item.accountId === "responder");

    assert.equal(status.state, "failed");
    assert.equal(status.ready, false);
    assert.equal(status.chatOpsReady, false);
    assert.equal(account.state, "ready");
    assert.equal(account.ready, true);
    assert.equal(account.chatOpsReady, false);
    assert.equal(account.runtimeUsable, true);
    assert.equal(account.error, "");
    assert.deepEqual(recoverableLocalWhatsAppAccountIds(status.accounts, ["responder"]), []);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp send continues when chat ops probe is unavailable", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-chatops-r-send-ready-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
    ORKESTR_WHATSAPP_STATUS_CHAT_OPS_PROBE: "1",
    ORKESTR_WHATSAPP_CHAT_OPS_PROBE_INTERVAL_MS: "1000",
    ORKESTR_WHATSAPP_SEND_CONFIRMATION_REQUIRED: "0",
  };
  const calls = [];
  const runtime = {
    client: {
      async getChats() {
        calls.push(["getChats"]);
        throw new Error("r");
      },
      async sendMessage(chatId, text) {
        calls.push(["send", chatId, text]);
        return { id: { _serialized: "sent-after-chatops-r" } };
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("responder", runtime, { lastChatOpsProbeAt: null }, env);

    const status = await getLocalWhatsAppBridgeStatus(env);
    const account = status.accounts.find((item) => item.accountId === "responder");
    assert.equal(account.ready, true);
    assert.equal(account.chatOpsReady, false);
    assert.equal(account.runtimeUsable, true);

    const sent = await sendLocalWhatsAppMessage({
      accountId: "responder",
      chatId: "chat-send-ready@g.us",
      text: "still send",
      env,
    });

    assert.equal(sent.ok, true);
    assert.equal(sent.id, "sent-after-chatops-r");
    assert.deepEqual(calls, [
      ["getChats"],
      ["send", "chat-send-ready@g.us", "still send"],
    ]);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp active status chat ops probe does not dereference arbitrary chats by default", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-chatops-list-only-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
    ORKESTR_WHATSAPP_STATUS_CHAT_OPS_PROBE: "1",
    ORKESTR_WHATSAPP_CHAT_OPS_PROBE_INTERVAL_MS: "1000",
  };
  const calls = [];
  const runtime = {
    client: {
      async getChats() {
        calls.push(["getChats"]);
        return [{ id: { _serialized: "unstable-sample@g.us" } }];
      },
      async getChatById(chatId) {
        calls.push(["getChatById", chatId]);
        throw new Error("r");
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("responder", runtime, { lastChatOpsProbeAt: null }, env);

    const status = await getLocalWhatsAppBridgeStatus(env);
    const account = status.accounts.find((item) => item.accountId === "responder");

    assert.equal(status.state, "ready");
    assert.equal(status.ready, true);
    assert.equal(status.chatOpsReady, true);
    assert.equal(account.ready, true);
    assert.equal(account.chatOpsReady, true);
    assert.equal(account.runtimeUsable, true);
    assert.deepEqual(calls, [["getChats"]]);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp deep chat ops probe marks chat ops unavailable when chat read throws r", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-chatops-deep-r-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
    ORKESTR_WHATSAPP_STATUS_CHAT_OPS_PROBE: "1",
    ORKESTR_WHATSAPP_CHAT_OPS_PROBE_INTERVAL_MS: "1000",
    ORKESTR_WHATSAPP_CHAT_OPS_PROBE_READ: "1",
    ORKESTR_WHATSAPP_AUTO_RECOVER_MS: "5000",
  };
  const calls = [];
  const runtime = {
    client: {
      async getChats() {
        calls.push(["getChats"]);
        return [{ id: { _serialized: "unstable-sample@g.us" } }];
      },
      async getChatById(chatId) {
        calls.push(["getChatById", chatId]);
        throw new Error("r");
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("responder", runtime, { lastChatOpsProbeAt: null }, env);
    setLocalWhatsAppRuntimeRecoveryHooksForTest({
      async restartAccount(accountId, actualEnv, options) {
        calls.push(["restart", accountId, actualEnv === env, options.reason]);
      },
      async startAccount(accountId, actualEnv, options) {
        calls.push(["start", accountId, actualEnv === env, options.showNotification]);
        return { accountId, state: "starting", ready: false };
      },
    });

    const status = await getLocalWhatsAppBridgeStatus(env);
    const account = status.accounts.find((item) => item.accountId === "responder");

    assert.equal(status.state, "failed");
    assert.equal(status.ready, false);
    assert.equal(status.chatOpsReady, false);
    assert.equal(account.state, "ready");
    assert.equal(account.ready, true);
    assert.equal(account.chatOpsReady, false);
    assert.equal(account.runtimeUsable, true);
    assert.equal(account.lastChatOpsError, "r");
    assert.deepEqual(calls, [
      ["getChats"],
      ["getChatById", "unstable-sample@g.us"],
    ]);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp deep chat ops probe keeps send runtime ready during ready warmup", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-chatops-ready-grace-r-"));
  const nowMs = Date.parse("2026-07-15T17:09:47.000Z");
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
    ORKESTR_WHATSAPP_CHAT_OPS_PROBE_INTERVAL_MS: "1000",
    ORKESTR_WHATSAPP_CHAT_OPS_PROBE_READ: "1",
    ORKESTR_WHATSAPP_CHAT_OPS_READY_GRACE_MS: "30000",
    ORKESTR_WHATSAPP_AUTO_RECOVER_MS: "5000",
  };
  const calls = [];
  const runtime = {
    client: {
      async getChats() {
        calls.push(["getChats"]);
        return [{ id: { _serialized: "warmup-sample@g.us" } }];
      },
      async getChatById(chatId) {
        calls.push(["getChatById", chatId]);
        throw new Error("r");
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("responder", runtime, {
      readyAt: new Date(nowMs - 1000).toISOString(),
      lastChatOpsProbeAt: null,
    }, env);
    setLocalWhatsAppRuntimeRecoveryHooksForTest({
      async restartAccount(accountId, actualEnv, options) {
        calls.push(["restart", accountId, actualEnv === env, options.reason]);
      },
      async startAccount(accountId, actualEnv, options) {
        calls.push(["start", accountId, actualEnv === env, options.showNotification]);
        return { accountId, state: "starting", ready: false };
      },
    });

    const status = await getLocalWhatsAppBridgeStatus(env, {
      probeChatOps: true,
      read: true,
      force: true,
      nowMs,
    });
    const account = status.accounts.find((item) => item.accountId === "responder");
    const events = await listEvents(env, 50);

    assert.equal(status.state, "failed");
    assert.equal(status.ready, false);
    assert.equal(status.chatOpsReady, false);
    assert.equal(account.state, "ready");
    assert.equal(account.ready, true);
    assert.equal(account.chatOpsReady, false);
    assert.equal(account.runtimeUsable, true);
    assert.equal(account.chatOpsUnavailableSince, new Date(nowMs).toISOString());
    assert.equal(account.error, "");
    assert.deepEqual(calls, [
      ["getChats"],
      ["getChatById", "warmup-sample@g.us"],
    ]);
    assert.deepEqual(recoverableLocalWhatsAppAccountIds(status.accounts, ["responder"]), []);
    assert.ok(events.find((event) => event.type === "whatsapp_local_chat_ops_probe_ready_grace" && event.accountId === "responder"));
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp ready grace r timestamp triggers reset after grace expires", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-chatops-ready-grace-reset-"));
  const firstProbeMs = Date.parse("2026-07-15T17:09:47.000Z");
  const secondProbeMs = firstProbeMs + 31_000;
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
    ORKESTR_WHATSAPP_CHAT_OPS_PROBE_INTERVAL_MS: "1000",
    ORKESTR_WHATSAPP_CHAT_OPS_PROBE_READ: "1",
    ORKESTR_WHATSAPP_CHAT_OPS_READY_GRACE_MS: "30000",
    ORKESTR_WHATSAPP_CHAT_OPS_RESET_AFTER_MS: "30000",
    ORKESTR_WHATSAPP_AUTO_RECOVER_MS: "5000",
  };
  const calls = [];
  const runtime = {
    client: {
      async getChats() {
        calls.push(["getChats"]);
        return [{ id: { _serialized: "warmup-sample@g.us" } }];
      },
      async getChatById(chatId) {
        calls.push(["getChatById", chatId]);
        throw new Error("r");
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("responder", runtime, {
      readyAt: new Date(firstProbeMs - 1000).toISOString(),
      lastChatOpsProbeAt: null,
    }, env);
    setLocalWhatsAppRuntimeRecoveryHooksForTest({
      async restartAccount(accountId, actualEnv, options) {
        calls.push(["restart", accountId, actualEnv === env, options.reason]);
      },
      async startAccount(accountId, actualEnv, options) {
        calls.push(["start", accountId, actualEnv === env, options.showNotification]);
        return { accountId, state: "starting", ready: false };
      },
    });

    const warmupStatus = await getLocalWhatsAppBridgeStatus(env, {
      probeChatOps: true,
      read: true,
      force: true,
      nowMs: firstProbeMs,
    });
    const warmupAccount = warmupStatus.accounts.find((item) => item.accountId === "responder");
    assert.equal(warmupAccount.chatOpsUnavailableSince, new Date(firstProbeMs).toISOString());

    const resetStatus = await getLocalWhatsAppBridgeStatus(env, {
      probeChatOps: true,
      read: true,
      force: true,
      nowMs: secondProbeMs,
    });
    const resetAccount = resetStatus.accounts.find((item) => item.accountId === "responder");
    const events = await listEvents(env, 50);

    assert.equal(resetStatus.state, "failed");
    assert.equal(resetAccount.state, "degraded");
    assert.equal(resetAccount.ready, false);
    assert.equal(resetAccount.chatOpsReady, false);
    assert.equal(resetAccount.runtimeUsable, false);
    assert.equal(resetAccount.chatOpsUnavailableSince, new Date(firstProbeMs).toISOString());
    assert.deepEqual(calls, [
      ["getChats"],
      ["getChatById", "warmup-sample@g.us"],
      ["getChats"],
      ["getChatById", "warmup-sample@g.us"],
      ["restart", "responder", true, "chat_ops_runtime_error"],
      ["start", "responder", true, false],
    ]);
    assert.ok(events.find((event) => event.type === "whatsapp_local_chat_ops_probe_recovery_due" && event.accountId === "responder"));
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp status resets stale cached chat ops r without a fresh probe", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-chatops-cached-r-reset-"));
  const unavailableSince = new Date(Date.now() - 31_000).toISOString();
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
    ORKESTR_WHATSAPP_CHAT_OPS_RESET_AFTER_MS: "30000",
    ORKESTR_WHATSAPP_AUTO_RECOVER_MS: "5000",
  };
  const calls = [];
  const runtime = {
    client: {
      async getChats() {
        calls.push(["getChats"]);
        return [];
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("responder", runtime, {
      state: "ready",
      ready: true,
      authenticated: true,
      started: true,
      chatOpsReady: false,
      runtimeUsable: true,
      lastChatOpsError: "r",
      chatOpsUnavailableSince: unavailableSince,
    }, env);
    setLocalWhatsAppRuntimeRecoveryHooksForTest({
      async restartAccount(accountId, actualEnv, options) {
        calls.push(["restart", accountId, actualEnv === env, options.reason]);
      },
      async startAccount(accountId, actualEnv, options) {
        calls.push(["start", accountId, actualEnv === env, options.showNotification]);
        return { accountId, state: "starting", ready: false };
      },
    });

    const status = await getLocalWhatsAppBridgeStatus(env);
    const account = status.accounts.find((item) => item.accountId === "responder");
    const events = await listEvents(env, 50);

    assert.equal(status.state, "failed");
    assert.equal(account.state, "degraded");
    assert.equal(account.ready, false);
    assert.equal(account.chatOpsReady, false);
    assert.equal(account.runtimeUsable, false);
    assert.equal(account.chatOpsUnavailableSince, unavailableSince);
    assert.deepEqual(calls, [
      ["restart", "responder", true, "chat_ops_runtime_error"],
      ["start", "responder", true, false],
    ]);
    assert.equal(calls.some((call) => call[0] === "getChats"), false);
    assert.ok(events.find((event) => event.type === "whatsapp_local_chat_ops_probe_recovery_due" && event.accountId === "responder"));
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp chat history recovers bare r runtime errors", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-chat-history-r-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
    ORKESTR_WHATSAPP_AUTO_RECOVER_MS: "5000",
  };
  const calls = [];
  const runtime = {
    client: {
      async getChatById(chatId) {
        calls.push(["getChatById", chatId]);
        return {
          async fetchMessages(options = {}) {
            calls.push(["fetchMessages", options.limit]);
            throw new Error("r");
          },
        };
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("responder", runtime, {}, env);
    setLocalWhatsAppRuntimeRecoveryHooksForTest({
      async restartAccount(accountId, actualEnv, options) {
        calls.push(["restart", accountId, actualEnv === env, options.reason]);
      },
      async startAccount(accountId, actualEnv, options) {
        calls.push(["start", accountId, actualEnv === env, options.showNotification]);
        return { accountId, state: "starting", ready: false };
      },
    });

    const result = await getWhatsAppChatMessages({ accountId: "responder", chatId: "history-r@g.us", limit: 5 }, env);
    const status = await getLocalWhatsAppBridgeStatus(env);
    const account = status.accounts.find((item) => item.accountId === "responder");
    const events = await listEvents(env, 50);

    assert.equal(result.ready, false);
    assert.equal(result.error, "r");
    assert.equal(account.state, "degraded");
    assert.equal(account.chatOpsReady, false);
    assert.equal(account.runtimeUsable, false);
    assert.deepEqual(calls, [
      ["getChatById", "history-r@g.us"],
      ["fetchMessages", 5],
      ["restart", "responder", true, "chat_read_runtime_error"],
      ["start", "responder", true, false],
    ]);
    assert.ok(events.find((event) => event.type === "whatsapp_local_runtime_degraded" && event.source === "chat_history"));
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp chat history uses browser store when getChatById throws bare r", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-chat-history-browser-store-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
  };
  const calls = [];
  const runtime = {
    client: {
      async getChatById(chatId) {
        calls.push(["getChatById", chatId]);
        throw new Error("r");
      },
      pupPage: {
        async evaluate(_callback, chatId, limit) {
          calls.push(["browserStore", chatId, limit]);
          return {
            found: true,
            unreadCount: 0,
            messages: [{
              id: { _serialized: "cached-history-message" },
              body: "visible through browser store",
              fromMe: true,
              timestamp: Math.floor(Date.now() / 1000),
            }],
          };
        },
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("responder", runtime, {}, env);
    const result = await getWhatsAppChatMessages({
      accountId: "responder",
      chatId: "history-browser-store@g.us",
      limit: 5,
    }, env);

    assert.equal(result.ready, true);
    assert.equal(result.fallback, "browser_store");
    assert.equal(result.messages[0].id, "cached-history-message");
    assert.equal(result.messages[0].body, "visible through browser store");
    assert.deepEqual(calls, [
      ["getChatById", "history-browser-store@g.us"],
      ["browserStore", "history-browser-store@g.us", 5],
    ]);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp unread recovery resets runtime when message fetch throws bare r", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-unread-recovery-r-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
    ORKESTR_WHATSAPP_AUTO_RECOVER_MS: "5000",
  };
  const calls = [];
  const runtime = {
    client: {
      async getChatById(chatId) {
        calls.push(["getChatById", chatId]);
        return {
          unreadCount: 1,
          async fetchMessages(options = {}) {
            calls.push(["fetchMessages", options.limit]);
            throw new Error("r");
          },
        };
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("responder", runtime, {}, env);
    setLocalWhatsAppRuntimeRecoveryHooksForTest({
      async restartAccount(accountId, actualEnv, options) {
        calls.push(["restart", accountId, actualEnv === env, options.reason]);
      },
      async startAccount(accountId, actualEnv, options) {
        calls.push(["start", accountId, actualEnv === env, options.showNotification]);
        return { accountId, state: "starting", ready: false };
      },
    });

    const result = await recoverLocalWhatsAppChatMessages({ accountId: "responder", chatId: "unread-r@g.us", limit: 7 }, env);
    const status = await getLocalWhatsAppBridgeStatus(env);
    const account = status.accounts.find((item) => item.accountId === "responder");
    const events = await listEvents(env, 50);

    assert.equal(result.ready, false);
    assert.equal(result.state, "degraded");
    assert.equal(result.error, "r");
    assert.equal(account.state, "degraded");
    assert.equal(account.chatOpsReady, false);
    assert.equal(account.runtimeUsable, false);
    assert.deepEqual(calls, [
      ["getChatById", "unread-r@g.us"],
      ["fetchMessages", 7],
      ["restart", "responder", true, "chat_read_runtime_error"],
      ["start", "responder", true, false],
    ]);
    assert.ok(events.find((event) => event.type === "whatsapp_local_runtime_degraded" && event.source === "chat_message_recovery"));
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp ready fallback accepts the WhatsApp 99 percent startup stall", () => {
  assert.equal(localWhatsAppReadyFallbackEligible({ authenticated: true, ready: false, loadingPercent: 99, loadingMessage: "WhatsApp" }), true);
  assert.equal(localWhatsAppReadyFallbackEligible({ authenticated: true, ready: false, loadingPercent: 100, loadingMessage: "WhatsApp" }), true);
  assert.equal(localWhatsAppReadyFallbackEligible({ authenticated: true, ready: false, loadingPercent: 98, loadingMessage: "WhatsApp" }), false);
  assert.equal(localWhatsAppReadyFallbackEligible({ authenticated: true, ready: true, loadingPercent: 99, loadingMessage: "WhatsApp" }), false);
  assert.equal(localWhatsAppReadyFallbackEligible({ authenticated: false, ready: false, loadingPercent: 99, loadingMessage: "WhatsApp" }), false);
  assert.equal(localWhatsAppReadyFallbackEligible({ authenticated: true, ready: false, loadingPercent: 99, loadingMessage: "Loading" }), false);
});

test("local whatsapp ready fallback accepts an already connected page after restart", () => {
  assert.equal(localWhatsAppConnectedPageReadyFallbackEligible({ ready: false, state: "starting" }, { hasSynced: "function", appState: "CONNECTED" }), true);
  assert.equal(localWhatsAppConnectedPageReadyFallbackEligible({ ready: false, state: "starting" }, { hasSynced: true, appState: "connected" }), true);
  assert.equal(localWhatsAppConnectedPageReadyFallbackEligible({ ready: true, state: "ready" }, { hasSynced: "function", appState: "CONNECTED" }), false);
  assert.equal(localWhatsAppConnectedPageReadyFallbackEligible({ ready: false, state: "starting" }, { hasSynced: "undefined", appState: "CONNECTED" }), false);
  assert.equal(localWhatsAppConnectedPageReadyFallbackEligible({ ready: false, state: "starting" }, { hasSynced: "function", appState: "OPENING" }), false);
});

test("local whatsapp status promotes an authenticated degraded account after chat ops recover", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-degraded-chatops-ready-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender",
  };
  const runtime = {
    client: {
      info: {
        wid: { _serialized: "491763240000@c.us", user: "491763240000", server: "c.us" },
        pushname: "Sender",
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("sender", runtime, {
      state: "degraded",
      ready: false,
      authenticated: true,
      started: true,
      error: "",
      chatOpsReady: true,
      runtimeUsable: true,
      lastRecoveryReason: "typing_clear_runtime_error",
      lastRecoveryAt: "2026-07-16T09:00:52.296Z",
    }, env);

    const status = await getLocalWhatsAppBridgeStatus(env);
    const account = status.accounts.find((item) => item.accountId === "sender");

    assert.equal(status.state, "ready");
    assert.equal(status.ready, true);
    assert.equal(account.state, "ready");
    assert.equal(account.ready, true);
    assert.equal(account.chatOpsReady, true);
    assert.equal(account.runtimeUsable, true);
    assert.equal(account.lastRecoveryReason, "typing_clear_runtime_error");
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp status promotes a connected browser store when ready event stalls", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-browser-store-ready-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender",
    ORKESTR_WHATSAPP_CHAT_OPS_PROBE_TIMEOUT_MS: "500",
  };
  const calls = [];
  const runtime = {
    client: {
      info: {
        wid: { _serialized: "491763240000@c.us", user: "491763240000", server: "c.us" },
        pushname: "Sender",
      },
      pupPage: {
        async evaluate() {
          calls.push("browser-store");
          return {
            ok: true,
            appState: "CONNECTED",
            chatCount: 7,
            hasChatStore: true,
            hasMsgStore: true,
          };
        },
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("sender", runtime, {
      state: "authenticated",
      ready: false,
      authenticated: true,
      started: true,
      error: "",
      chatOpsReady: null,
      runtimeUsable: null,
      lastChatOpsProbeAt: null,
    }, env);

    const status = await getLocalWhatsAppBridgeStatus(env, { probeChatOps: true, force: true });
    const account = status.accounts.find((item) => item.accountId === "sender");
    const events = await listEvents(env, 20);

    assert.deepEqual(calls, ["browser-store"]);
    assert.equal(status.state, "ready");
    assert.equal(status.ready, true);
    assert.equal(account.state, "ready");
    assert.equal(account.ready, true);
    assert.equal(account.chatOpsReady, true);
    assert.equal(account.runtimeUsable, true);
    assert.equal(account.lastRecoveryReason, "browser_store_ready_fallback");
    assert.ok(events.find((event) => event.type === "whatsapp_local_browser_store_ready_promoted" && event.accountId === "sender"));
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
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
  const env = { ORKESTR_HOME: home, ORKESTR_WHATSAPP_ACCOUNT_IDS: "main,secondary" };

  assert.deepEqual(localWhatsAppAccountIdsForEnv(env), ["main", "secondary"]);

  const status = await getWhatsAppStatus(env);

  assert.equal(status.state, "unpaired");
  assert.equal(status.mode, "local");
  assert.deepEqual(status.accounts.map((account) => account.accountId), ["main", "secondary"]);
  assert.deepEqual(status.accounts.map((account) => account.label), ["main", "secondary"]);
});

test("local whatsapp send resolves the legacy responder role to the default local account", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-responder-alias-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_SEND_CONFIRMATION_REQUIRED: "0",
  };
  const sent = [];
  const runtime = {
    client: {
      async sendMessage(chatId, text) {
        sent.push({ chatId, text });
        return { id: { _serialized: `true_${chatId}_alias` } };
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("account-1", runtime, {}, env);
    const result = await sendLocalWhatsAppMessage({
      accountId: "responder",
      chatId: "chat-responder-alias@g.us",
      text: "hello",
      env,
    });

    assert.equal(result.accountId, "account-1");
    assert.deepEqual(sent, [{ chatId: "chat-responder-alias@g.us", text: "hello" }]);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp send prefers configured default account over legacy responder id", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-responder-default-alias-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder,account-1",
    ORKESTR_WHATSAPP_DEFAULT_RESPONDER_ACCOUNT_ID: "account-1",
    ORKESTR_WHATSAPP_SEND_CONFIRMATION_REQUIRED: "0",
  };
  const sent = [];
  const runtime = {
    client: {
      async sendMessage(chatId, text) {
        sent.push({ chatId, text });
        return { id: { _serialized: `true_${chatId}_default_alias` } };
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("account-1", runtime, {}, env);
    const result = await sendLocalWhatsAppMessage({
      accountId: "responder",
      chatId: "chat-responder-default-alias@g.us",
      text: "hello",
      env,
    });

    assert.equal(result.accountId, "account-1");
    assert.deepEqual(sent, [{ chatId: "chat-responder-default-alias@g.us", text: "hello" }]);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp inbound forwarding posts mapped chats", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-forward-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_INBOUND_FORWARD_MAP_JSON: JSON.stringify({
      "chat-forward@g.us": "https://remote.example/api/connectors/whatsapp/inbound",
    }),
    ORKESTR_WHATSAPP_INBOUND_FORWARD_TOKEN: "forward-secret",
  };
  const calls = [];

  const forwarded = await forwardLocalWhatsAppInbound({
    eventId: "event-forward-1",
    chatId: "chat-forward@g.us",
    from: "wa-contact-one@c.us",
    accountId: "responder",
    text: "hello",
  }, env, async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return response({ ok: true, threadId: "thread-forward", messageId: "message-forward" }, true, 202);
  });
  const skipped = await forwardLocalWhatsAppInbound({ eventId: "event-skip", chatId: "other@g.us", text: "skip" }, env, async () => {
    throw new Error("unmapped chats should not be forwarded");
  });

  assert.equal(localWhatsAppInboundForwardTarget({ chatId: "chat-forward@g.us" }, env), "https://remote.example/api/connectors/whatsapp/inbound");
  assert.equal(forwarded.forwarded, true);
  assert.equal(forwarded.payload.threadId, "thread-forward");
  assert.equal(skipped, null);
  assert.equal(calls.length, 1);
  assert.equal(String(calls[0].url), "https://remote.example/api/connectors/whatsapp/inbound");
  assert.equal(calls[0].options.headers.authorization, "Bearer forward-secret");
  assert.equal(calls[0].body.chatId, "chat-forward@g.us");
});

test("local whatsapp forwarded security approval sends visible confirmation", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-forward-approval-notice-"));
  const chatId = "491700000000@c.us";
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender",
    ORKESTR_WHATSAPP_SEND_CONFIRMATION_REQUIRED: "0",
    ORKESTR_WHATSAPP_SECURITY_APPROVAL_FORWARD_URL: "http://127.0.0.1:19812/api/connectors/whatsapp/inbound",
    ORKESTR_WHATSAPP_INBOUND_TOKEN: "forward-secret",
  };
  const sent = [];
  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    fetchCalls.push({ url: String(url), body: JSON.parse(options.body) });
    return response({
      ok: true,
      approvedSecurityChallenge: true,
      challenge: { id: "challenge-one", status: "approved" },
    }, true, 202);
  };

  try {
    const result = await handleInboundMessage("sender", {
      id: { _serialized: `false_${chatId}_approval-one`, remote: chatId },
      fromMe: false,
      from: chatId,
      to: "491700000999@c.us",
      body: "orkestr connect approve ABC123",
      timestamp: 1_780_000_000,
    }, env, {
      client: {
        async sendMessage(to, body) {
          sent.push({ to, body });
          return { id: { _serialized: `true_${chatId}_approval-notice` } };
        },
      },
    });

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].body.text, "orkestr connect approve ABC123");
    assert.equal(result.forwarded, true);
    assert.equal(result.routed.approvedSecurityChallenge, true);
    assert.equal(result.approvalNotice.sent, true);
    assert.deepEqual(sent, [{
      to: chatId,
      body: "Orkestr access approved. Return to the Orkestr web UI to continue.",
    }]);
  } finally {
    globalThis.fetch = originalFetch;
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp forwarded security approval sends visible failure notice", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-forward-approval-failed-notice-"));
  const chatId = "491700000000@c.us";
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender",
    ORKESTR_WHATSAPP_SEND_CONFIRMATION_REQUIRED: "0",
    ORKESTR_WHATSAPP_SECURITY_APPROVAL_FORWARD_URL: "http://127.0.0.1:19812/api/connectors/whatsapp/inbound",
    ORKESTR_WHATSAPP_INBOUND_TOKEN: "forward-secret",
  };
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => response({
    duplicate: false,
    skipped: "security_approval_challenge_not_found",
    event: { ignoredReason: "security_approval_challenge_not_found" },
  }, true, 202);

  try {
    const result = await handleInboundMessage("sender", {
      id: { _serialized: `false_${chatId}_approval-failed`, remote: chatId },
      fromMe: false,
      from: chatId,
      to: "491700000999@c.us",
      body: "orkestr connect approve UNKNOWN1",
      timestamp: 1_780_000_000,
    }, env, {
      client: {
        async sendMessage(to, body) {
          sent.push({ to, body });
          return { id: { _serialized: `true_${chatId}_approval-failed-notice` } };
        },
      },
    });

    assert.equal(result.forwarded, true);
    assert.equal(result.approvalNotice.sent, true);
    assert.deepEqual(sent, [{
      to: chatId,
      body: "That Orkestr approval code is not pending here. Open a fresh Orkestr link and approve the new code.",
    }]);
  } finally {
    globalThis.fetch = originalFetch;
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp approval commands can forward to a security approval target without forwarding chat traffic", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-forward-approval-target-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_SECURITY_APPROVAL_FORWARD_URL: "http://127.0.0.1:19812/api/connectors/whatsapp/inbound",
    ORKESTR_WHATSAPP_SECURITY_APPROVAL_FORWARD_TOKEN_CHAT_ID: "491700000000@c.us",
    ORKESTR_WHATSAPP_INBOUND_FORWARD_TOKEN_MAP_JSON: JSON.stringify({
      "491700000000@c.us": "forward-secret",
    }),
  };
  const calls = [];

  const forwarded = await forwardLocalWhatsAppInbound({
    eventId: "event-approval-forward",
    chatId: "group-main@g.us",
    from: "491700000000@c.us",
    accountId: "sender",
    text: "orkestr connect approve ZFZBRW",
  }, env, async (url, options) => {
    calls.push({ url: String(url), options, body: JSON.parse(options.body) });
    return response({
      ok: true,
      approvedSecurityChallenge: true,
      challenge: { id: "challenge-public", status: "approved" },
    }, true, 202);
  });
  const skipped = await forwardLocalWhatsAppInbound({
    eventId: "event-normal-chat",
    chatId: "group-main@g.us",
    from: "491700000000@c.us",
    accountId: "sender",
    text: "hi",
  }, env, async () => {
    throw new Error("normal group chat should not use the security approval forward target");
  });

  assert.equal(forwarded.forwarded, true);
  assert.equal(forwarded.targetSource, "security_approval_forward");
  assert.equal(forwarded.routeMode, "security_approval");
  assert.equal(forwarded.payload.approvedSecurityChallenge, true);
  assert.equal(skipped, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:19812/api/connectors/whatsapp/inbound");
  assert.equal(calls[0].options.headers.authorization, "Bearer forward-secret");
  assert.equal(calls[0].body.chatId, "group-main@g.us");
  assert.equal(calls[0].body.text, "orkestr connect approve ZFZBRW");
});

test("local whatsapp security approval forward self-target follows active orkestr port", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-forward-approval-self-port-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_PORT: "18912",
    ORKESTR_HOST: "127.0.0.1",
    ORKESTR_WHATSAPP_INBOUND_TOKEN: "current-inbound-secret",
    ORKESTR_WHATSAPP_SECURITY_APPROVAL_FORWARD_URL: "http://127.0.0.1:19812/api/connectors/whatsapp/inbound",
    ORKESTR_WHATSAPP_SECURITY_APPROVAL_FORWARD_TOKEN_CHAT_ID: "491700000000@c.us",
    ORKESTR_WHATSAPP_INBOUND_FORWARD_TOKEN_MAP_JSON: JSON.stringify({
      "491700000000@c.us": "stale-forward-secret",
    }),
  };
  const calls = [];

  const forwarded = await forwardLocalWhatsAppInbound({
    eventId: "event-approval-forward-active-port",
    chatId: "group-main@g.us",
    from: "491700000000@c.us",
    accountId: "sender",
    text: "orkestr connect approve ZFZBRW",
  }, env, async (url, options) => {
    calls.push({ url: String(url), options, body: JSON.parse(options.body) });
    return response({
      ok: true,
      approvedSecurityChallenge: true,
      challenge: { id: "challenge-public", status: "approved" },
    }, true, 202);
  });

  assert.equal(forwarded.forwarded, true);
  assert.equal(forwarded.targetSource, "security_approval_forward");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:18912/api/connectors/whatsapp/inbound");
  assert.equal(calls[0].options.headers.authorization, "Bearer current-inbound-secret");
});

test("local whatsapp embedded approval examples do not use the security approval target", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-forward-approval-embedded-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_SECURITY_APPROVAL_FORWARD_URL: "http://127.0.0.1:19812/api/connectors/whatsapp/inbound",
    ORKESTR_WHATSAPP_SECURITY_APPROVAL_FORWARD_TOKEN_CHAT_ID: "491700000000@c.us",
    ORKESTR_WHATSAPP_INBOUND_FORWARD_TOKEN_MAP_JSON: JSON.stringify({
      "491700000000@c.us": "forward-secret",
    }),
  };
  const result = await forwardLocalWhatsAppInbound({
    eventId: "event-embedded-approval-example",
    chatId: "group-main@g.us",
    from: "491700000000@c.us",
    accountId: "sender",
    text: [
      "Example only:",
      "```",
      "orkestr connect approve ZFZBRW",
      "```",
    ].join("\n"),
  }, env, async () => {
    throw new Error("embedded approval examples should not use the security approval forward target");
  });

  assert.equal(result, null);
});

test("local whatsapp approval commands prefer parent security approval target over managed tenant route", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-forward-approval-managed-route-"));
  const chatId = "wa-group-managed-approval@g.us";
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_SECURITY_APPROVAL_FORWARD_URL: "http://127.0.0.1:19812/api/connectors/whatsapp/inbound",
    ORKESTR_WHATSAPP_SECURITY_APPROVAL_FORWARD_TOKEN_CHAT_ID: "491700000000@c.us",
    ORKESTR_WHATSAPP_INBOUND_FORWARD_TOKEN_MAP_JSON: JSON.stringify({
      "491700000000@c.us": "forward-secret",
    }),
  };
  await createTenantVm({
    id: "tenant-managed-approval-wa",
    ownerUserId: "firat",
    endpoint: { baseUrl: "https://tenant.example.test" },
    connectors: { whatsappChatName: "Firat Jobs", whatsappAccountId: "sender" },
  }, env);
  await configureTenantWhatsAppRoute("tenant-managed-approval-wa", {
    chatId,
    accountId: "sender",
    enabled: true,
  }, env);
  const calls = [];

  const forwarded = await forwardLocalWhatsAppInbound({
    eventId: "event-managed-approval-forward",
    chatId,
    from: "491700000000@c.us",
    accountId: "sender",
    text: "orkestr connect approve ZFZBRW",
  }, env, async (url, options = {}) => {
    if (String(url).includes("127.0.0.1:19812")) {
      calls.push({ url: String(url), options, body: JSON.parse(options.body) });
      return response({
        ok: true,
        approvedSecurityChallenge: true,
        challenge: { id: "challenge-public", status: "approved" },
      }, true, 202);
    }
    if (String(url).includes("/api/health")) {
      calls.push({ url: String(url), options, body: null });
      return response({ ok: true }, true, 200);
    }
    calls.push({ url: String(url), options, body: JSON.parse(options.body) });
    return response({ ok: true, threadId: "firat-jobs", messageId: "msg-approval" }, true, 202);
  });
  const normal = await forwardLocalWhatsAppInbound({
    eventId: "event-managed-normal-forward",
    chatId,
    from: "491700000000@c.us",
    accountId: "sender",
    text: "hi",
  }, env, async (url, options) => {
    if (String(url).includes("/api/health")) return response({ ok: true }, true, 200);
    calls.push({ url: String(url), options, body: JSON.parse(options.body) });
    return response({ ok: true, threadId: "firat-jobs", messageId: "msg-normal" }, true, 202);
  });

  assert.equal(forwarded.forwarded, true);
  assert.equal(forwarded.targetSource, "security_approval_forward");
  assert.equal(forwarded.routeMode, "security_approval");
  assert.equal(forwarded.payload.approvedSecurityChallenge, true);
  assert.equal(normal.forwarded, true);
  assert.equal(normal.targetSource, "endpoint");
  assert.equal(normal.routeMode, "direct");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "http://127.0.0.1:19812/api/connectors/whatsapp/inbound");
  assert.equal(calls[0].options.headers.authorization, "Bearer forward-secret");
  assert.equal(calls[0].body.text, "orkestr connect approve ZFZBRW");
  assert.equal(calls[1].url, "https://tenant.example.test/api/connectors/whatsapp/inbound");
  assert.notEqual(calls[1].options.headers.authorization, "Bearer forward-secret");
});

test("local whatsapp approval commands do not forward to tenant route when parent approval target is not configured", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-forward-approval-managed-no-parent-"));
  const chatId = "wa-group-managed-approval-no-parent@g.us";
  const env = { ORKESTR_HOME: home };
  await createTenantVm({
    id: "tenant-managed-approval-wa-no-parent",
    ownerUserId: "firat",
    endpoint: { baseUrl: "https://tenant.example.test" },
    connectors: { whatsappChatName: "Firat Jobs", whatsappAccountId: "sender" },
  }, env);
  await configureTenantWhatsAppRoute("tenant-managed-approval-wa-no-parent", {
    chatId,
    accountId: "sender",
    enabled: true,
  }, env);

  const approval = await forwardLocalWhatsAppInbound({
    eventId: "event-managed-approval-no-parent",
    chatId,
    from: "491700000000@c.us",
    accountId: "sender",
    text: "orkestr connect approve ZFZBRW",
  }, env, async () => {
    throw new Error("approval commands must not be forwarded to the tenant");
  });
  const normal = await forwardLocalWhatsAppInbound({
    eventId: "event-managed-normal-no-parent",
    chatId,
    from: "491700000000@c.us",
    accountId: "sender",
    text: "hi",
  }, env, async (url, options = {}) => {
    if (String(url).includes("/api/health")) return response({ ok: true }, true, 200);
    return response({ ok: true, threadId: "firat-jobs", messageId: "msg-normal" }, true, 202);
  });

  assert.equal(approval, null);
  assert.equal(normal.forwarded, true);
  assert.equal(normal.targetSource, "endpoint");
});

test("local whatsapp forwarded unconfigured codex target sends setup notice", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-forward-codex-notice-"));
  const chatId = "491700000001@c.us";
  const setupUrl = "https://orkestr.example.test/i/demo-instance/setup";
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender",
    ORKESTR_WHATSAPP_SEND_CONFIRMATION_REQUIRED: "0",
    ORKESTR_WHATSAPP_INBOUND_FORWARD_MAP_JSON: JSON.stringify({
      [chatId]: "http://127.0.0.1:19812/api/connectors/whatsapp/inbound",
    }),
    ORKESTR_WHATSAPP_INBOUND_FORWARD_SETUP_URL_MAP_JSON: JSON.stringify({
      [chatId]: setupUrl,
    }),
    ORKESTR_WHATSAPP_INBOUND_FORWARD_TOKEN: "forward-secret",
  };
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => response({
    ok: false,
    error: "whatsapp_target_required",
    routingFailure: {
      code: "whatsapp_target_required",
      capability: "whatsapp",
      userFacingCategory: "routing",
      safeMessage: "This WhatsApp chat is not connected to a thread.",
    },
  }, false, 400);

  try {
    const result = await handleInboundMessage("sender", {
      id: { _serialized: `false_${chatId}_codex-notice`, remote: chatId },
      fromMe: false,
      from: chatId,
      to: "491700000999@c.us",
      body: "hi",
      timestamp: 1_780_000_000,
    }, env, {
      client: {
        async sendMessage(to, body) {
          sent.push({ to, body });
          return { id: { _serialized: `true_${chatId}_codex-notice` } };
        },
      },
    });

    assert.equal(result.error, "target_codex_not_configured");
    assert.equal(result.routingFailure.code, "target_codex_not_configured");
    assert.equal(result.routingFailure.setupUrl, setupUrl);
    assert.equal(result.noticeSent, true);
    assert.deepEqual(sent, [{
      to: chatId,
      body: `This Orkestr VM is not ready for chat yet. Open ${setupUrl} and enable Codex in the web UI, then resend your message.`,
    }]);
  } finally {
    globalThis.fetch = originalFetch;
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp recovery notifies chat when tenant sanitizer blocks inbound", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-sanitizer-notice-"));
  const chatId = "wa-group-alpha@g.us";
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
    id: { _serialized: `false_${chatId}_MSG_wa-contact-primary@c.us` },
    from: chatId,
    author: "wa-contact-primary@c.us",
    fromMe: false,
    body: "hi",
    timestamp: 1780070400,
  };
  const chat = {
    id: { _serialized: chatId },
    unreadCount: 1,
    async fetchMessages() {
      return [
        inboundMessage,
        ...sent.map((message, index) => ({
          fromMe: true,
          body: message.text,
          id: { _serialized: `true_${chatId}_NOTICE_${index + 1}` },
          timestamp: Math.floor(Date.now() / 1000),
        })),
      ];
    },
    async sendSeen() {
      seen += 1;
    },
  };
  const client = {
    async getChats() {
      return [chat];
    },
    async getChatById(id) {
      assert.equal(id, chatId);
      return chat;
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

test("local whatsapp sanitizer outage notices avoid raw sanitizer reason codes", () => {
  assert.equal(
    inboundRoutingFailureNoticeText(new Error("llm_sanitizer_codex_timeout")),
    "Orkestr could not safely verify this message because the isolated-user safety service was temporarily unavailable. Please resend it in a moment.",
  );
  assert.equal(
    inboundRoutingFailureNoticeText(new Error("llm_sanitizer_policy_denied")),
    "Orkestr could not accept your message because the isolated-user safety policy blocked or could not verify it. Please retry with a simpler request, or ask the admin to check the chat setup.",
  );
});

test("local whatsapp bridge maps public account ids to existing LocalAuth client ids", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-configured-client-ids-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "main,secondary",
    ORKESTR_WHATSAPP_ACCOUNT_CLIENT_IDS: "main:codex-whatsapp,secondary:codex-whatsapp-secondary",
    ORKESTR_WHATSAPP_ACCOUNT_SESSION_ROOTS: "main:/state/main,secondary:/state/secondary",
  };

  const bridgeStatus = await getLocalWhatsAppBridgeStatus(env);
  const status = await getWhatsAppStatus(env);

  assert.deepEqual(bridgeStatus.accounts.map((account) => account.accountId), ["main", "secondary"]);
  assert.deepEqual(bridgeStatus.accounts.map((account) => account.clientId), ["codex-whatsapp", "codex-whatsapp-secondary"]);
  assert.deepEqual(bridgeStatus.accounts.map((account) => account.sessionRoot), ["/state/main", "/state/secondary"]);
  assert.deepEqual(bridgeStatus.accounts.map((account) => account.localAuthSessionDir), [
    "/state/main/session-codex-whatsapp",
    "/state/secondary/session-codex-whatsapp-secondary",
  ]);
  assert.deepEqual(bridgeStatus.accounts.map((account) => account.sessionRootAlreadyIncludesClient), [false, false]);
  assert.deepEqual(status.accounts.map((account) => account.accountId), ["main", "secondary"]);
  assert.deepEqual(status.accounts.map((account) => account.clientId), [undefined, undefined]);
  assert.deepEqual(status.accounts.map((account) => account.sessionRoot), [undefined, undefined]);
  assert.deepEqual(status.accounts.map((account) => account.localAuthSessionDir), [undefined, undefined]);
  assert.doesNotMatch(JSON.stringify(status.health.accounts), /clientId|sessionRoot|localAuthSessionDir/);
});

test("local whatsapp bridge flags session roots that already include LocalAuth client id", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-nested-session-root-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
    ORKESTR_WHATSAPP_ACCOUNT_CLIENT_IDS: "responder:codex-whatsapp-example",
    ORKESTR_WHATSAPP_ACCOUNT_SESSION_ROOTS: "responder:/state/session-codex-whatsapp-example",
  };

  const bridgeStatus = await getLocalWhatsAppBridgeStatus(env);
  const account = bridgeStatus.accounts[0];

  assert.equal(account.accountId, "responder");
  assert.equal(account.sessionRoot, "/state/session-codex-whatsapp-example");
  assert.equal(account.localAuthSessionDir, "/state/session-codex-whatsapp-example/session-codex-whatsapp-example");
  assert.equal(account.sessionRootAlreadyIncludesClient, true);
});

test("local whatsapp bridge accepts persisted connector accounts without exposing session paths in public status", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-user-owned-account-"));
  const env = { ORKESTR_HOME: home };
  await upsertWhatsAppConnectorAccount({
    accountId: "alice-wa",
    ownerUserId: "alice",
    displayName: "Alice WhatsApp",
  }, env);

  const status = await getWhatsAppStatus(env);
  const aliceAccount = status.accounts.find((account) => account.accountId === "alice-wa");

  assert.ok(aliceAccount, JSON.stringify(status.accounts));
  assert.deepEqual(status.accounts.map((account) => account.accountId), ["account-1", "account-2", "alice-wa"]);
  assert.equal(Object.hasOwn(aliceAccount, "sessionRoot"), false);
  assert.equal(Object.hasOwn(aliceAccount, "clientId"), false);
  assert.doesNotMatch(JSON.stringify(status.health.accounts), /sessionRoot|clientId/);
  await assert.rejects(
    () => startLocalWhatsAppAccount("alice-wa", env, { phoneNumber: "+++" }),
    /whatsapp_pairing_phone_number_invalid/,
  );
});

test("local whatsapp strict account ids ignore persisted legacy responder accounts", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-strict-accounts-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender",
    ORKESTR_WHATSAPP_STRICT_ACCOUNT_IDS: "1",
  };
  await upsertWhatsAppConnectorAccount({
    accountId: "responder",
    ownerUserId: "admin",
    displayName: "Legacy responder",
    autostart: true,
  }, env);

  const bridgeStatus = await getLocalWhatsAppBridgeStatus(env);
  const status = await getWhatsAppStatus(env);

  assert.deepEqual(bridgeStatus.accounts.map((account) => account.accountId), ["sender"]);
  assert.deepEqual(status.accounts.map((account) => account.accountId), ["sender"]);
});

test("local whatsapp bridge exposes public account identity without session internals", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-public-account-identity-"));
  const env = { ORKESTR_HOME: home, ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder" };
  try {
    setLocalWhatsAppRuntimeForTest("responder", {
      client: {
        info: {
          wid: { user: "155512345", server: "c.us", _serialized: "155512345@c.us" },
          pushname: "Responder Phone",
        },
      },
    }, {}, env);

    const bridgeStatus = await getLocalWhatsAppBridgeStatus(env);
    const status = await getWhatsAppStatus(env);
    const account = status.accounts.find((entry) => entry.accountId === "155512345");

    assert.equal(bridgeStatus.accounts[0].phoneNumber, "+155512345");
    assert.equal(bridgeStatus.accounts[0].contactId, "155512345@c.us");
    assert.equal(account.runtimeAccountId, "responder");
    assert.equal(account.phoneNumber, "+155512345");
    assert.equal(account.contactId, "155512345@c.us");
    assert.equal(account.pushName, "Responder Phone");
    assert.equal(Object.hasOwn(account, "sessionRoot"), false);
    assert.equal(Object.hasOwn(account, "clientId"), false);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp web cache lives under orkestr home", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-web-cache-"));
  assert.equal(webCacheRoot({ ORKESTR_HOME: home }), path.join(home, "whatsapp-bridge", "web-cache"));
});

test("local whatsapp group participant ids are normalized for created test chats", () => {
  const participantDigits = "15550100001";
  assert.deepEqual(
    normalizeGroupParticipantIds(["wa-lid-primary@lid", " wa-lid-primary@lid ", "wa-contact-primary@c.us"]),
    ["wa-lid-primary@lid", "wa-contact-primary@c.us"],
  );
  assert.deepEqual(
    normalizeGroupParticipantIds("wa-lid-primary@lid, wa-contact-primary@c.us"),
    ["wa-lid-primary@lid", "wa-contact-primary@c.us"],
  );
  assert.deepEqual(
    normalizeGroupParticipantIds([`+${participantDigits}`, participantDigits]),
    [`${participantDigits}@c.us`],
  );
});

test("local whatsapp group participant add validates participant input before browser work", async () => {
  await assert.rejects(
    () => addLocalWhatsAppGroupParticipants({ accountId: "responder", chatId: "fixture-group@g.us" }),
    /whatsapp_group_participants_required/,
  );
});

test("local whatsapp status downgrades stale ready state without a runtime client", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-stale-ready-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
  };

  try {
    setLocalWhatsAppRuntimeForTest("responder", {}, {}, env);
    const status = await getLocalWhatsAppBridgeStatus(env);

    assert.equal(status.ready, false);
    assert.equal(status.state, "failed");
    assert.equal(status.accounts[0].accountId, "responder");
    assert.equal(status.accounts[0].ready, false);
    assert.equal(status.accounts[0].state, "stale_runtime");
    assert.equal(status.accounts[0].error, "whatsapp_local_runtime_missing");
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp participant reads recover stale ready runtime", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-participant-read-recover-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
  };
  const calls = [];

  try {
    setLocalWhatsAppRuntimeForTest("responder", {}, {}, env);
    setLocalWhatsAppRuntimeRecoveryHooksForTest({
      async restartAccount(accountId, actualEnv, options) {
        calls.push(["restart", accountId, actualEnv === env, options.reason]);
      },
      async startAccount(accountId, actualEnv, options) {
        calls.push(["start", accountId, actualEnv === env, options.showNotification]);
        return { accountId, state: "starting", ready: false };
      },
    });

    await assert.rejects(
      () => listLocalWhatsAppChatParticipants({ accountId: "responder", chatId: "fixture-group@g.us", env }),
      (error) => {
        assert.equal(error.message, "whatsapp_local_bridge_not_ready_recovered_after_group_read_runtime_error");
        assert.equal(error.statusCode, 503);
        assert.equal(error.cause.message, "whatsapp_local_bridge_stale_runtime");
        return true;
      },
    );

    assert.deepEqual(calls, [
      ["restart", "responder", true, "group_read_runtime_error"],
      ["start", "responder", true, false],
    ]);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp group admin promotion recovers stale or broken runtime", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-admin-recover-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
  };
  const commsError = new Error("sendIq called before startComms");
  const calls = [];
  const runtime = {
    client: {
      async getChatById(chatId) {
        calls.push(["getChatById", chatId]);
        return {
          isGroup: true,
          async promoteParticipants(participants) {
            calls.push(["promoteParticipants", participants]);
            throw commsError;
          },
        };
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("responder", runtime, {}, env);
    setLocalWhatsAppRuntimeRecoveryHooksForTest({
      async restartAccount(accountId, actualEnv, options) {
        calls.push(["restart", accountId, actualEnv === env, options.reason]);
      },
      async startAccount(accountId, actualEnv, options) {
        calls.push(["start", accountId, actualEnv === env, options.showNotification]);
        return { accountId, state: "starting", ready: false };
      },
    });

    await assert.rejects(
      () => promoteLocalWhatsAppGroupParticipants({
        accountId: "responder",
        chatId: "fixture-group@g.us",
        participantIds: ["owner@c.us"],
        env,
      }),
      (error) => {
        assert.equal(error.message, "whatsapp_local_bridge_not_ready_recovered_after_group_admin_runtime_error");
        assert.equal(error.statusCode, 503);
        assert.equal(error.cause, commsError);
        return true;
      },
    );

    assert.deepEqual(calls, [
      ["getChatById", "fixture-group@g.us"],
      ["promoteParticipants", ["owner@c.us"]],
      ["restart", "responder", true, "group_admin_runtime_error"],
      ["start", "responder", true, false],
    ]);
    const events = await listEvents(env);
    assert.ok(events.find((event) => event.type === "whatsapp_local_group_admin_runtime_recovery_start"));
    assert.ok(events.find((event) => event.type === "whatsapp_local_group_admin_runtime_recovery_started"));
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp group admin demotion records durable event", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-admin-demote-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
  };
  const calls = [];
  const runtime = {
    client: {
      async getChatById(chatId) {
        calls.push(["getChatById", chatId]);
        return {
          isGroup: true,
          async demoteParticipants(participants) {
            calls.push(["demoteParticipants", participants]);
            return { status: 200 };
          },
        };
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("responder", runtime, {}, env);
    const result = await demoteLocalWhatsAppGroupParticipants({
      accountId: "responder",
      chatId: "fixture-group@g.us",
      participantIds: ["owner@c.us"],
      env,
    });

    assert.deepEqual(calls, [
      ["getChatById", "fixture-group@g.us"],
      ["demoteParticipants", ["owner@c.us"]],
    ]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.participantIds, ["owner@c.us"]);
    const events = await listEvents(env);
    const event = events.find((entry) => entry.type === "whatsapp_local_group_admins_demoted");
    assert.equal(event?.accountId, "responder");
    assert.equal(event?.chatId, "fixture-group@g.us");
    assert.deepEqual(event?.participantIds, ["owner@c.us"]);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("routed whatsapp typing wraps api-agent work for the bound chat", async () => {
  const calls = [];
  const thread = {
    id: "tenant-thread",
    binding: {
      chatId: "wa-group-four@g.us",
      responderAccountId: "account-2",
      outboundAccountId: "account-1",
    },
  };
  const target = routedWhatsAppTypingTarget({ thread, input: { chatId: "wa-group-four@g.us" } });
  const result = await runWithRoutedWhatsAppTyping({ thread, input: { chatId: "wa-group-four@g.us" } }, async () => {
    calls.push(["work"]);
    return { ok: true };
  }, {
    async startTyping(input) {
      calls.push(["start", input.accountId, input.chatId, input.threadId]);
      return { ok: true, active: true };
    },
    async stopTyping(input) {
      calls.push(["stop", input.accountId, input.chatId, input.threadId]);
      return { ok: true, active: false };
    },
  });

  assert.deepEqual(target, { accountId: "account-2", chatId: "wa-group-four@g.us", threadId: "tenant-thread" });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [
    ["start", "account-2", "wa-group-four@g.us", "tenant-thread"],
    ["work"],
    ["stop", "account-2", "wa-group-four@g.us", "tenant-thread"],
  ]);
});

test("whatsapp thread group creation binds an existing thread idempotently", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-thread-group-"));
  const env = { ORKESTR_HOME: home };
  const thread = await createThread({ id: "sample-linkedin", name: "Sample LinkedIn" }, env);
  const createCalls = [];

  const created = await createAndBindWhatsAppThreadGroup(thread, {
    name: "Sample-Linkedin",
    participantIds: ["wa-contact-primary@c.us"],
    responderAccountId: "account-1",
    mirrorToWhatsApp: true,
  }, env, {
    async createChat(options) {
      createCalls.push(options);
      return {
        ok: true,
        chat: { id: "wa-group-two@g.us", name: options.name, generated: true },
        senderAccountId: "account-1",
        responderAccountId: "account-1",
        senderContactId: "wa-contact-primary@c.us",
        responderContactId: "wa-contact-tenant@c.us",
      };
    },
  });
  const updated = await getThread("sample-linkedin", env);
  const reused = await createAndBindWhatsAppThreadGroup(updated, { name: "Sample-Linkedin" }, env, {
    async createChat() {
      throw new Error("existing binding should be reused");
    },
  });

  assert.equal(created.created, true);
  assert.equal(created.binding.chatId, "wa-group-two@g.us");
  assert.equal(updated.binding.displayName, "Sample-Linkedin");
  assert.equal(updated.binding.mirrorToWhatsApp, true);
  assert.equal(updated.binding.responderAccountId, "account-1");
  assert.deepEqual(createCalls.map((call) => call.participantIds), [["wa-contact-primary@c.us"]]);
  assert.equal(reused.reused, true);
  assert.equal(reused.binding.chatId, "wa-group-two@g.us");
});

test("whatsapp thread group creation can use an external bridge", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-thread-group-external-"));
  const env = externalBridgeEnv(home, { ORKESTR_WHATSAPP_BRIDGE_CLIENT_ID: "demo-instance-group" });
  await createThread({ id: "thread-external-group", name: "Crawlerai Linkedin", executorId: "noop" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://parent.local/bridge",
    apiToken: "secret-token",
  }, env);

  const calls = [];
  const result = await createAndBindWhatsAppThreadGroup(
    await getThread("thread-external-group", env),
    {
      name: "Sample-Linkedin",
      senderAccountId: "sender",
      responderAccountId: "responder",
      participantIds: ["wa-contact-one@c.us"],
      mirrorToWhatsApp: true,
    },
    env,
    {
      async fetchImpl(url, options) {
        calls.push({ url, options, body: JSON.parse(options.body) });
        return response({
          ok: true,
          chat: { id: "group-1@g.us", name: "Sample-Linkedin", isGroup: true, generated: true },
          senderAccountId: "sender",
          responderAccountId: "responder",
          senderContactId: "wa-contact-one@c.us",
          responderContactId: "wa-contact-two@c.us",
        });
      },
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/bridge/chats");
  assert.equal(calls[0].options.headers.authorization, "Bearer secret-token");
  assert.equal(calls[0].options.headers["x-orkestr-instance-id"], "demo-instance-group");
  assert.equal(calls[0].body.name, "Sample-Linkedin");
  assert.deepEqual(calls[0].body.participantIds, ["wa-contact-one@c.us"]);
  assert.equal(result.created, true);
  assert.equal(result.binding.chatId, "group-1@g.us");
  assert.equal(result.binding.responderAccountId, "responder");
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

test("local whatsapp send confirmation uses browser store when getChatById throws bare r", async () => {
  let attempts = 0;
  const client = {
    async sendMessage() {
      attempts += 1;
      return { id: { _serialized: "sent-browser-store" } };
    },
    async getChatById() {
      throw new Error("r");
    },
    pupPage: {
      async evaluate() {
        return {
          found: true,
          unreadCount: 0,
          messages: [{
            fromMe: true,
            body: "confirmed through browser store",
            id: { _serialized: "sent-browser-store" },
            timestamp: Math.floor(Date.now() / 1000),
          }],
        };
      },
    },
  };

  const sent = await sendWhatsAppTextWithConfirmation({
    client,
    chatId: "chat-browser-store",
    text: "confirmed through browser store",
    retryDelayMs: 0,
  });

  assert.equal(attempts, 1);
  assert.equal(sent.id._serialized, "sent-browser-store");
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
          return attempts >= 2
            ? [{ fromMe: true, body: "retry me", id: { _serialized: "sent-retry" }, timestamp: Math.floor(Date.now() / 1000) }]
            : [];
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

test("local whatsapp send rejects normal successes that are not visible in chat history", async () => {
  let attempts = 0;
  const client = {
    async sendMessage() {
      attempts += 1;
      return { id: { _serialized: "false-positive-send" } };
    },
    async getChatById() {
      return {
        async fetchMessages() {
          return [];
        },
      };
    },
  };

  await assert.rejects(
    () => sendWhatsAppTextWithConfirmation({
      client,
      chatId: "chat-false-positive",
      text: "not actually visible",
      maxAttempts: 1,
      retryDelayMs: 0,
      env: {
        ORKESTR_WHATSAPP_SEND_CONFIRMATION_ATTEMPTS: "1",
        ORKESTR_WHATSAPP_SEND_CONFIRMATION_DELAY_MS: "0",
      },
    }),
    /whatsapp_send_not_confirmed/,
  );
  assert.equal(attempts, 1);
});

test("local whatsapp send retries normal successes that are not confirmed", async () => {
  let attempts = 0;
  const client = {
    async sendMessage() {
      attempts += 1;
      return { id: { _serialized: `send-attempt-${attempts}` } };
    },
    async getChatById() {
      return {
        async fetchMessages() {
          return attempts >= 2
            ? [{ fromMe: true, body: "eventually visible", id: { _serialized: "confirmed-visible" }, timestamp: Math.floor(Date.now() / 1000) }]
            : [];
        },
      };
    },
  };

  const sent = await sendWhatsAppTextWithConfirmation({
    client,
    chatId: "chat-retry-unconfirmed",
    text: "eventually visible",
    retryDelayMs: 0,
    env: {
      ORKESTR_WHATSAPP_SEND_CONFIRMATION_ATTEMPTS: "1",
      ORKESTR_WHATSAPP_SEND_CONFIRMATION_DELAY_MS: "0",
    },
  });
  assert.equal(attempts, 2);
  assert.equal(sent.id._serialized, "confirmed-visible");
});

test("local whatsapp send times out hung browser sends without retrying", async () => {
  let attempts = 0;
  const client = {
    sendMessage() {
      attempts += 1;
      return new Promise(() => {});
    },
    async getChatById() {
      return {
        async fetchMessages() {
          return [];
        },
      };
    },
  };

  await assert.rejects(
    () => sendWhatsAppTextWithConfirmation({
      client,
      chatId: "chat-hung",
      text: "hung send",
      retryDelayMs: 0,
      operationTimeoutMs: 10,
    }),
    /whatsapp_send_message_timeout/,
  );
  assert.equal(attempts, 1);
});

test("local whatsapp inbound ignores recent outbound attachment echoes", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-attachment-echo-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
  };
  const chatId = "chat-attachment-echo@g.us";
  const filename = "orkestr-table-test.csv";
  const body = "a,b\n1,2\n";
  const attachmentPath = path.join(home, filename);
  await fs.writeFile(attachmentPath, body);
  const sent = [];
  const runtime = {
    MessageMedia: {
      fromFilePath(filePath) {
        return { filePath };
      },
    },
    client: {
      async sendMessage(to, media, options) {
        sent.push({ to, media, options });
        return { id: { _serialized: `true_${chatId}_sent-document` } };
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("responder", runtime, {}, env);
    await sendLocalWhatsAppMessage({
      accountId: "responder",
      chatId,
      attachments: [{ path: attachmentPath, filename, mimetype: "text/csv" }],
      env,
    });

    const result = await handleInboundMessage("responder", {
      id: { _serialized: `true_${chatId}_echo-document`, remote: chatId },
      from: "513468373@lid",
      to: chatId,
      fromMe: true,
      body: "",
      hasMedia: true,
      type: "document",
      timestamp: 1_780_000_000,
      _data: { filename },
      async downloadMedia() {
        return {
          data: Buffer.from(body).toString("base64"),
          filename,
          mimetype: "text/csv",
        };
      },
    }, env, { ownOnly: true });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, chatId);
    assert.equal(result.skipped, "outbound_echo_attachment");
    assert.equal(result.chatId, chatId);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp inbound ignores fromMe attachment echoes with rewritten filenames", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-attachment-size-echo-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
  };
  const chatId = "chat-attachment-size-echo@g.us";
  const filename = "Dockerfile";
  const body = "FROM node:22\nWORKDIR /app\n";
  const attachmentPath = path.join(home, filename);
  await fs.writeFile(attachmentPath, body);
  const sent = [];
  const runtime = {
    MessageMedia: {
      fromFilePath(filePath) {
        return { filePath };
      },
    },
    client: {
      async sendMessage(to, media, options) {
        sent.push({ to, media, options });
        return { id: { _serialized: `true_${chatId}_sent-rewritten-document` } };
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("responder", runtime, {}, env);
    await sendLocalWhatsAppMessage({
      accountId: "responder",
      chatId,
      attachments: [{ path: attachmentPath, filename, mimetype: "application/octet-stream" }],
      env,
    });

    const result = await handleInboundMessage("responder", {
      id: { _serialized: `true_${chatId}_echo-rewritten-document`, remote: chatId },
      from: "513468373@lid",
      to: chatId,
      fromMe: true,
      body: "",
      hasMedia: true,
      type: "document",
      timestamp: 1_780_000_000,
      _data: {},
      async downloadMedia() {
        return {
          data: Buffer.from(body).toString("base64"),
          mimetype: "application/octet-stream",
        };
      },
    }, env, { ownOnly: true });

    assert.equal(sent.length, 1);
    assert.equal(result.skipped, "outbound_echo_attachment");
    assert.equal(result.chatId, chatId);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp inbound ignores outbound text echoed through another local account", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-cross-account-echo-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender,responder",
    ORKESTR_WHATSAPP_SEND_CONFIRMATION_REQUIRED: "0",
  };
  const chatId = "chat-cross-account-echo@g.us";
  const text = "The push is done. I’ll check that the workspace is clean.\n\ndbg: m:gpt-5.5/xh";
  const sent = [];
  const responderRuntime = {
    client: {
      async sendMessage(to, body) {
        sent.push({ to, body });
        return { id: { _serialized: `true_${chatId}_responder-outbound` } };
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("responder", responderRuntime, {}, env);
    await sendLocalWhatsAppMessage({
      accountId: "responder",
      chatId,
      text,
      env,
    });

    const result = await handleInboundMessage("sender", {
      id: { _serialized: `false_${chatId}_sender-observed-responder`, remote: chatId },
      from: chatId,
      to: "sender@c.us",
      author: "responder@lid",
      fromMe: false,
      body: text,
      timestamp: 1_780_000_000,
    }, env);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, chatId);
    assert.equal(result.skipped, "outbound_echo_cross_account_text");
    assert.equal(result.chatId, chatId);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp inbound ignores outbound attachment echoed through another local account", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-cross-account-attachment-echo-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender,responder",
    ORKESTR_WHATSAPP_SEND_CONFIRMATION_REQUIRED: "0",
  };
  const chatId = "chat-cross-account-attachment-echo@g.us";
  const filename = "orkestr-table-cross-account.csv";
  const body = "name,value\nalpha,1\n";
  const attachmentPath = path.join(home, filename);
  await fs.writeFile(attachmentPath, body);
  const sent = [];
  const responderRuntime = {
    MessageMedia: {
      fromFilePath(filePath) {
        return { filePath };
      },
    },
    client: {
      async sendMessage(to, media, options) {
        sent.push({ to, media, options });
        return { id: { _serialized: `true_${chatId}_responder-attachment` } };
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("responder", responderRuntime, {}, env);
    await sendLocalWhatsAppMessage({
      accountId: "responder",
      chatId,
      attachments: [{ path: attachmentPath, filename, mimetype: "text/csv" }],
      env,
    });

    const result = await handleInboundMessage("sender", {
      id: { _serialized: `false_${chatId}_sender-observed-attachment`, remote: chatId },
      from: chatId,
      to: "sender@c.us",
      author: "responder@lid",
      fromMe: false,
      body: "",
      hasMedia: true,
      type: "document",
      timestamp: 1_780_000_000,
      _data: { filename },
      async downloadMedia() {
        throw new Error("cross-account attachment echo should be suppressed before download");
      },
    }, env);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, chatId);
    assert.equal(result.skipped, "outbound_echo_cross_account_attachment");
    assert.equal(result.chatId, chatId);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp inbound ignores filename-only outbound attachment echoes", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-cross-account-filename-echo-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender,responder",
    ORKESTR_WHATSAPP_SEND_CONFIRMATION_REQUIRED: "0",
  };
  const chatId = "chat-cross-account-filename-echo@g.us";
  const filename = "orkestr-table-filename-only.csv";
  const attachmentPath = path.join(home, filename);
  await fs.writeFile(attachmentPath, "a,b\n1,2\n");
  const responderRuntime = {
    MessageMedia: {
      fromFilePath(filePath) {
        return { filePath };
      },
    },
    client: {
      async sendMessage() {
        return { id: { _serialized: `true_${chatId}_responder-filename-attachment` } };
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("responder", responderRuntime, {}, env);
    await sendLocalWhatsAppMessage({
      accountId: "responder",
      chatId,
      attachments: [{ path: attachmentPath, filename, mimetype: "text/csv" }],
      env,
    });

    const result = await handleInboundMessage("sender", {
      id: { _serialized: `false_${chatId}_sender-observed-filename`, remote: chatId },
      from: chatId,
      to: "sender@c.us",
      author: "responder@lid",
      fromMe: false,
      body: filename,
      hasMedia: false,
      type: "document",
      timestamp: 1_780_000_001,
    }, env);

    assert.equal(result.skipped, "outbound_echo_cross_account_attachment");
    assert.equal(result.chatId, chatId);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp e2e sender sends can be visible to responder routing", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-cross-account-visible-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender,responder",
    ORKESTR_WHATSAPP_SEND_CONFIRMATION_REQUIRED: "0",
  };
  const chatId = "chat-cross-account-visible@g.us";
  const text = "Real transport e2e should be visible to the responder account.";
  const sent = [];
  const senderRuntime = {
    client: {
      async sendMessage(to, body) {
        sent.push({ to, body });
        return { id: { _serialized: `true_${chatId}_sender-outbound` } };
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("sender", senderRuntime, {}, env);
    await sendLocalWhatsAppMessage({
      accountId: "sender",
      chatId,
      text,
      env,
      crossAccountEchoSuppression: false,
    });

    const result = await handleInboundMessage("responder", {
      id: { _serialized: `false_${chatId}_responder-observed-sender`, remote: chatId },
      from: chatId,
      to: "responder@c.us",
      author: "sender@lid",
      fromMe: false,
      body: text,
      timestamp: 1_780_000_000,
    }, env);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, chatId);
    assert.equal(result.routed.ignoredNonSenderAccount, true);
    assert.equal(result.routed.skipped, "non_sender_account");
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp real sender sends can route their own sent message when requested", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-route-own-send-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender,responder",
    ORKESTR_WHATSAPP_SEND_CONFIRMATION_REQUIRED: "0",
    ORKESTR_WHATSAPP_API_AGENT_AUTORUN: "0",
  };
  const chatId = "chat-route-own-send@g.us";
  const text = "/connect google";
  const sent = [];
  const senderRuntime = {
    client: {
      async sendMessage(to, body) {
        sent.push({ to, body });
        return {
          id: { _serialized: `true_${chatId}_sender-routed` },
          to,
          fromMe: true,
          body,
          timestamp: 1_780_000_000,
        };
      },
    },
  };

  try {
    await createThread({
      id: "route-own-send-thread",
      name: "Route Own Send Thread",
      executorId: "api-agent",
      executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
      runtimeKind: "api-agent",
      binding: {
        connector: "whatsapp",
        chatId,
        enabled: true,
        senderAccountId: "sender",
        responderAccountId: "responder",
        outboundAccountId: "responder",
        senderContactId: "sender@lid",
      },
    }, env);
    setLocalWhatsAppRuntimeForTest("sender", senderRuntime, {}, env);
    const result = await sendLocalWhatsAppMessage({
      accountId: "sender",
      chatId,
      text,
      env,
      crossAccountEchoSuppression: false,
      routeSentMessage: true,
    });
    const messages = await listThreadMessages("route-own-send-thread", env);
    const userMessage = messages.find((message) => message.role === "user" && message.text === text);

    assert.ok(sent.some((entry) => entry.to === chatId && entry.body === text));
    assert.equal(result.routed[0].threadId, "route-own-send-thread");
    assert.ok(userMessage);
    assert.equal(userMessage.accountId, "sender");
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp e2e sender sends clear stale cross-account echo keys", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-cross-account-clear-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender,responder",
    ORKESTR_WHATSAPP_SEND_CONFIRMATION_REQUIRED: "0",
  };
  const chatId = "chat-cross-account-clear@g.us";
  const text = "/connect google";
  const sent = [];
  const senderRuntime = {
    client: {
      async sendMessage(to, body) {
        sent.push({ to, body });
        return { id: { _serialized: `true_${chatId}_sender-outbound-${sent.length}` } };
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("sender", senderRuntime, {}, env);
    await sendLocalWhatsAppMessage({ accountId: "sender", chatId, text, env });
    await sendLocalWhatsAppMessage({
      accountId: "sender",
      chatId,
      text,
      env,
      crossAccountEchoSuppression: false,
    });

    const result = await handleInboundMessage("responder", {
      id: { _serialized: `false_${chatId}_responder-observed-sender`, remote: chatId },
      from: chatId,
      to: "responder@c.us",
      author: "sender@lid",
      fromMe: false,
      body: text,
      timestamp: 1_780_000_000,
    }, env);

    assert.equal(sent.length, 2);
    assert.equal(result.routed.ignoredNonSenderAccount, true);
    assert.equal(result.routed.skipped, "non_sender_account");
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp message route fields keep own group echoes on the group chat", () => {
  assert.deepEqual(
    localWhatsAppMessageRouteFields({
      fromMe: true,
      from: "wa-lid-own@lid",
      to: "wa-group-beta@g.us",
      id: { remote: "wa-group-beta@g.us" },
    }),
    {
      chatId: "wa-group-beta@g.us",
      from: "wa-lid-own@lid",
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
      chatId: "wa-group-zero@g.us",
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
      chatId: "wa-group-route-one@g.us",
      displayName: "Legacy Group",
      outboundAccountId: "legacy-account",
    },
  }, env);

  const account1 = await listLocalWhatsAppChats("account-1", env);
  const account2 = await listLocalWhatsAppChats("account-2", env);

  assert.equal(account1.ready, false);
  assert.deepEqual(account1.chats.map((chat) => chat.name), ["Known Group"]);
  assert.deepEqual(account2.chats.map((chat) => chat.name), []);
});

test("local whatsapp known chats honor configured responder account ids", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-known-configured-"));
  const env = { ORKESTR_HOME: home, ORKESTR_WHATSAPP_ACCOUNT_IDS: "main,secondary" };
  await createThread({
    id: "known-secondary-thread",
    name: "Known Secondary Thread",
    binding: {
      connector: "whatsapp",
      chatId: "wa-group-route-two@g.us",
      displayName: "Secondary Group",
      outboundAccountId: "secondary",
    },
  }, env);

  const main = await listLocalWhatsAppChats("main", env);
  const secondary = await listLocalWhatsAppChats("secondary", env);

  assert.deepEqual(main.chats.map((chat) => chat.name), []);
  assert.deepEqual(secondary.chats.map((chat) => chat.name), ["Secondary Group"]);
});

test("local whatsapp unread recovery only scans bound chats for the selected account", () => {
  const env = { ORKESTR_WHATSAPP_ACCOUNT_IDS: "main,secondary" };
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
      id: "secondary-thread",
      binding: {
        connector: "whatsapp",
        chatId: "secondary-chat@g.us",
        outboundAccountId: "secondary",
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
  assert.deepEqual(localWhatsAppUnreadRecoveryBoundChats(threads, "secondary", env), [
    { chatId: "secondary-chat@g.us", threadId: "secondary-thread", accountId: "secondary" },
  ]);
  assert.equal(localWhatsAppUnreadRecoveryIntervalMs({ ORKESTR_WHATSAPP_UNREAD_RECOVERY_MS: "5" }), 10000);
});

test("local whatsapp unread recovery scans inbound forward-map chats", () => {
  const env = {
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "main,secondary",
    ORKESTR_WHATSAPP_INBOUND_FORWARD_MAP_JSON: JSON.stringify({
      "forward-chat@g.us": "https://remote.example/api/connectors/whatsapp/inbound",
      "empty-target@g.us": "",
    }),
  };

  assert.deepEqual(localWhatsAppUnreadRecoveryBoundChats([], "main", env), [
    { chatId: "forward-chat@g.us", threadId: "", accountId: "main", source: "inbound_forward_map" },
  ]);
});

test("local whatsapp unread recovery routes missed unread messages", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-unread-recovery-"));
  const env = { ORKESTR_HOME: home, ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder" };
  const chatId = "wa-group-zero@g.us";
  let sentSeen = false;
  let getChatByIdCalls = 0;
  const message = {
    id: { _serialized: "missed-message-1", remote: chatId },
    fromMe: false,
    from: chatId,
    author: "wa-contact-one@c.us",
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

test("local whatsapp unread recovery falls back to cached browser messages on r-state fetch", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-unread-cache-fallback-"));
  const env = { ORKESTR_HOME: home, ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder" };
  const chatId = "wa-group-cache-fallback@g.us";
  const messageModel = {
    id: {
      id: "cached-r-message-1",
      remote: { _serialized: chatId },
      fromMe: false,
      participant: { _serialized: "wa-contact-one@c.us" },
    },
    body: "cached hello after r",
    from: chatId,
    author: "wa-contact-one@c.us",
    type: "chat",
    t: 1_780_000_000,
  };
  const chat = {
    id: { _serialized: chatId },
    unreadCount: 1,
    async fetchMessages() {
      throw new Error("r");
    },
  };
  const previousWindow = globalThis.window;
  const client = {
    pupPage: {
      async evaluate(fn, targetChatId, targetLimit) {
        const cachedChat = {
          unreadCount: 1,
          msgs: {
            getModelsArray() {
              return [{
                id: messageModel.id,
                isNotification: false,
                serialize() {
                  return messageModel;
                },
              }];
            },
          },
        };
        globalThis.window = {
          require(name) {
            if (name === "WAWebCollections") {
              return {
                Chat: {
                  get(value) {
                    return String(value?._serialized || value || "") === targetChatId ? cachedChat : null;
                  },
                },
              };
            }
            if (name === "WAWebWidFactory") {
              return {
                createWid(value) {
                  return { _serialized: value };
                },
              };
            }
            throw new Error(`unexpected require ${name}`);
          },
          WWebJS: {
            getMessageModel(message) {
              return message.serialize();
            },
          },
        };
        try {
          return await fn(targetChatId, targetLimit);
        } finally {
          globalThis.window = previousWindow;
        }
      },
    },
    async getChats() {
      return [chat];
    },
  };
  const thread = await createThread({
    id: "cache-fallback-thread",
    name: "Cache Fallback",
    binding: {
      connector: "whatsapp",
      chatId,
      displayName: "Cache Fallback",
      responderAccountId: "responder",
      outboundAccountId: "responder",
      enabled: true,
    },
  }, env);

  try {
    const result = await recoverUnreadLocalWhatsAppMessages(env, {
      force: true,
      accountIds: ["responder"],
      clients: new Map([["responder", client]]),
      accountStates: new Map([["responder", { state: "ready", ready: true }]]),
      threads: [thread],
      limit: 20,
    });
    const messages = await listThreadMessages("cache-fallback-thread", env);

    assert.equal(result.routed, 1);
    assert.equal(result.recovered[0].ok, true);
    assert.equal(result.recovered[0].fetched, 1);
    assert.equal(messages.at(-1).text, "cached hello after r");
    assert.equal(messages.at(-1).source, "whatsapp_inbound");
    assert.equal(messages.at(-1).externalId, "cached-r-message-1");
  } finally {
    globalThis.window = previousWindow;
  }
});

test("local whatsapp recent recovery forwards missed messages for mapped external chats", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-forward-recovery-"));
  const chatId = "wa-forward-public@g.us";
  const nowSeconds = 1_780_000_000;
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
    ORKESTR_WHATSAPP_RECENT_RECOVERY_MAX_AGE_MS: "600000",
    ORKESTR_WHATSAPP_INBOUND_FORWARD_MAP_JSON: JSON.stringify({
      [chatId]: "https://public.example/api/connectors/whatsapp/inbound",
    }),
    ORKESTR_WHATSAPP_INBOUND_FORWARD_TOKEN: "forward-secret",
  };
  const message = {
    id: { _serialized: `false_${chatId}_missed-forward_wa-contact-one@c.us`, remote: chatId },
    fromMe: false,
    from: chatId,
    author: "wa-contact-one@c.us",
    body: "missed public hello",
    timestamp: nowSeconds,
  };
  const chat = {
    id: { _serialized: chatId },
    unreadCount: 0,
    async fetchMessages() {
      return [message];
    },
    async sendSeen() {
      throw new Error("recent recovery should not mark mapped seen messages");
    },
  };
  const client = {
    async getChats() {
      return [chat];
    },
  };
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options, body: JSON.parse(options.body) });
    return response({ ok: true, threadId: "public-thread", messageId: "public-message" }, true, 202);
  };

  try {
    const result = await recoverUnreadLocalWhatsAppMessages(env, {
      force: true,
      accountIds: ["responder"],
      clients: new Map([["responder", client]]),
      accountStates: new Map([["responder", { state: "ready", ready: true }]]),
      threads: [],
      limit: 20,
      nowMs: nowSeconds * 1000 + 60_000,
    });

    assert.equal(result.routed, 1);
    assert.equal(result.recovered.length, 1);
    assert.equal(result.recovered[0].chatId, chatId);
    assert.equal(result.recovered[0].recoveryMode, "recent");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://public.example/api/connectors/whatsapp/inbound");
    assert.equal(calls[0].options.headers.authorization, "Bearer forward-secret");
    assert.equal(calls[0].body.chatId, chatId);
    assert.equal(calls[0].body.text, "missed public hello");
    assert.equal(calls[0].body.eventId, `false_${chatId}_missed-forward_wa-contact-one@c.us`);
  } finally {
    globalThis.fetch = originalFetch;
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp recent recovery scans managed tenant route chats", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-tenant-forward-recovery-"));
  const chatId = "wa-tenant-forward@g.us";
  const nowSeconds = 1_780_000_000;
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender",
    ORKESTR_WHATSAPP_RECENT_RECOVERY_MAX_AGE_MS: "600000",
  };
  await createTenantVm({
    id: "tenant-recovery-wa",
    ownerUserId: "firat",
    endpoint: { baseUrl: "https://tenant-recovery.example.test" },
    connectors: { whatsappChatName: "Firat Jobs", whatsappAccountId: "sender" },
  }, env);
  await configureTenantWhatsAppRoute("tenant-recovery-wa", {
    chatId,
    accountId: "sender",
    enabled: true,
  }, env);
  const message = {
    id: { _serialized: `false_${chatId}_missed-tenant_wa-contact-one@c.us`, remote: chatId },
    fromMe: false,
    from: chatId,
    author: "wa-contact-one@c.us",
    body: "missed tenant hello",
    timestamp: nowSeconds,
  };
  const chat = {
    id: { _serialized: chatId },
    unreadCount: 0,
    async fetchMessages() {
      return [message];
    },
    async sendSeen() {
      throw new Error("recent recovery should not mark managed tenant seen messages");
    },
  };
  const client = {
    async getChats() {
      return [chat];
    },
  };
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("/api/health")) return response({ ok: true }, true, 200);
    calls.push({ url: String(url), options, body: JSON.parse(options.body) });
    return response({ ok: true, threadId: "firat-jobs", messageId: "tenant-message" }, true, 202);
  };

  try {
    const result = await recoverUnreadLocalWhatsAppMessages(env, {
      force: true,
      accountIds: ["sender"],
      clients: new Map([["sender", client]]),
      accountStates: new Map([["sender", { state: "ready", ready: true }]]),
      threads: [],
      limit: 20,
      nowMs: nowSeconds * 1000 + 60_000,
    });

    assert.equal(result.routed, 1);
    assert.equal(result.recovered.length, 1);
    assert.equal(result.recovered[0].chatId, chatId);
    assert.equal(result.recovered[0].recoveryMode, "recent");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://tenant-recovery.example.test/api/connectors/whatsapp/inbound");
    assert.equal(calls[0].body.chatId, chatId);
    assert.equal(calls[0].body.text, "missed tenant hello");
    assert.equal(calls[0].body.eventId, `false_${chatId}_missed-tenant_wa-contact-one@c.us`);
  } finally {
    globalThis.fetch = originalFetch;
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp recent recovery routes missed seen messages in bound chats", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-recent-recovery-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
    ORKESTR_WHATSAPP_RECENT_RECOVERY_MAX_AGE_MS: "600000",
  };
  const chatId = "wa-group-recent@g.us";
  const nowSeconds = 1_780_000_000;
  let sentSeen = false;
  let getChatByIdCalls = 0;
  const oldMessage = {
    id: { _serialized: "old-seen-message", remote: chatId },
    fromMe: false,
    from: chatId,
    author: "wa-contact-one@c.us",
    body: "old seen hello",
    timestamp: nowSeconds - 3600,
  };
  const recentMessage = {
    id: { _serialized: "recent-seen-message", remote: chatId },
    fromMe: false,
    from: chatId,
    author: "wa-contact-one@c.us",
    body: "recent seen hello",
    timestamp: nowSeconds,
  };
  const chat = {
    id: { _serialized: chatId },
    unreadCount: 0,
    async fetchMessages() {
      return [oldMessage, recentMessage];
    },
    async sendSeen() {
      sentSeen = true;
    },
  };
  const client = {
    async getChats() {
      return [chat];
    },
    async getChatById() {
      getChatByIdCalls += 1;
      throw new Error("recover should reuse the chat object from getChats");
    },
  };
  const thread = await createThread({
    id: "recent-thread",
    name: "Recent",
    binding: {
      connector: "whatsapp",
      chatId,
      displayName: "Recent",
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
    nowMs: nowSeconds * 1000 + 60_000,
  });
  const messages = await listThreadMessages("recent-thread", env);

  assert.equal(result.routed, 1);
  assert.equal(result.recovered.length, 1);
  assert.equal(result.recovered[0].chatId, chatId);
  assert.equal(result.recovered[0].recoveryMode, "recent");
  assert.equal(result.recovered[0].candidates, 1);
  assert.equal(messages.length, 1);
  assert.equal(messages.at(-1).text, "recent seen hello");
  assert.equal(messages.at(-1).source, "whatsapp_inbound");
  assert.equal(sentSeen, false);
  assert.equal(getChatByIdCalls, 0);
});

test("local whatsapp unread recovery defers bare r chat-list failures without restarting transport", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-unread-list-r-deferred-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
  };
  const chatId = "wa-group-list-r-state@g.us";
  const calls = [];
  const client = {
    async getChats() {
      calls.push(["getChats"]);
      throw new Error("r");
    },
  };
  const thread = await createThread({
    id: "list-r-state-thread",
    name: "List R State",
    binding: {
      connector: "whatsapp",
      chatId,
      responderAccountId: "responder",
      outboundAccountId: "responder",
      enabled: true,
    },
  }, env);

  try {
    setLocalWhatsAppRuntimeForTest("responder", { client }, {}, env);
    setLocalWhatsAppRuntimeRecoveryHooksForTest({
      async restartAccount() {
        calls.push(["restart"]);
      },
      async startAccount() {
        calls.push(["start"]);
      },
    });

    const result = await recoverUnreadLocalWhatsAppMessages(env, {
      force: true,
      accountIds: ["responder"],
      threads: [thread],
      nowMs: 1_780_000_000_000,
    });
    const status = await getLocalWhatsAppBridgeStatus(env);
    const account = status.accounts.find((item) => item.accountId === "responder");
    const events = await listEvents(env, 20);

    assert.deepEqual(calls, [["getChats"]]);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].reason, "list_chats_failed");
    assert.equal(account.state, "ready");
    assert.equal(account.ready, true);
    assert.equal(account.runtimeUsable, true);
    assert.equal(events.some((event) => event.type === "whatsapp_local_unread_runtime_recovery_deferred" && event.source === "unread_recovery"), true);
    assert.equal(events.some((event) => event.type === "whatsapp_local_runtime_degraded"), false);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp unread recovery defers bare r chat reads without restarting transport", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-unread-r-reset-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
    ORKESTR_WHATSAPP_AUTO_RECOVER_MS: "60000",
  };
  const chatId = "wa-group-r-state@g.us";
  const calls = [];
  const chat = {
    id: { _serialized: chatId },
    unreadCount: 1,
    async fetchMessages() {
      calls.push(["fetchMessages"]);
      throw new Error("r");
    },
  };
  const client = {
    async getChats() {
      calls.push(["getChats"]);
      return [chat];
    },
  };
  const thread = await createThread({
    id: "r-state-thread",
    name: "R State",
    binding: {
      connector: "whatsapp",
      chatId,
      responderAccountId: "responder",
      outboundAccountId: "responder",
      enabled: true,
    },
  }, env);

  try {
    setLocalWhatsAppRuntimeRecoveryHooksForTest({
      async restartAccount(accountId, actualEnv, options) {
        calls.push(["restart", accountId, actualEnv === env, options.reason]);
      },
      async startAccount(accountId, actualEnv, options) {
        calls.push(["start", accountId, actualEnv === env, options.showNotification]);
        return { accountId, state: "starting", ready: false };
      },
    });
    const options = {
      force: true,
      accountIds: ["responder"],
      clients: new Map([["responder", client]]),
      accountStates: new Map([["responder", { state: "ready", ready: true }]]),
      threads: [thread],
      limit: 20,
      nowMs: 1_780_000_000_000,
    };

    const first = await recoverUnreadLocalWhatsAppMessages(env, options);
    const second = await recoverUnreadLocalWhatsAppMessages(env, options);

    assert.equal(first.recovered[0].ok, false);
    assert.equal(second.recovered[0].ok, false);
    assert.equal(first.recovered[0].ready, true);
    assert.equal(second.recovered[0].ready, true);
    assert.equal(first.recovered[0].state, "ready");
    assert.equal(second.recovered[0].state, "ready");
    assert.equal(first.recovered[0].error, "r");
    assert.equal(second.recovered[0].error, "r");
    assert.deepEqual(calls.filter((call) => call[0] === "restart"), []);
    assert.deepEqual(calls.filter((call) => call[0] === "start"), []);
    const events = await listEvents(env, 20);
    assert.equal(events.filter((event) => event.type === "whatsapp_local_chat_read_failed").length, 0);
    assert.equal(events.filter((event) => event.type === "whatsapp_local_unread_runtime_recovery_deferred" && event.source === "unread_recovery").length, 2);
    assert.equal(events.filter((event) => event.type === "whatsapp_local_runtime_degraded").length, 0);
    assert.equal(events.filter((event) => event.type === "whatsapp_local_runtime_recovery_start").length, 0);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp pairing-required notification sends Gmail disconnect email once per cooldown", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-pairing-email-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
    ORKESTR_WHATSAPP_REPAIR_NOTIFY_EMAIL: "admin@example.test",
    ORKESTR_CONNECT_PUBLIC_SETUP_URL: "https://connect.example.test/setup",
  };
  const sent = [];

  try {
    const sendGmailMessage = async (args, actualEnv) => {
      sent.push({ args, sameEnv: actualEnv === env });
      return { ok: true, message: { id: "gmail-sent-1" } };
    };

    const first = await notifyLocalWhatsAppPairingRequired({
      accountId: "responder",
      reason: "qr_required",
    }, env, { nowMs: 1_780_000_000_000, sendGmailMessage });
    const second = await notifyLocalWhatsAppPairingRequired({
      accountId: "responder",
      reason: "qr_required",
    }, env, { nowMs: 1_780_000_001_000, sendGmailMessage });

    assert.equal(first.ok, true);
    assert.equal(first.configured, true);
    assert.equal(second.ok, true);
    assert.equal(second.skipped, true);
    assert.equal(second.skippedReason, "cooldown");
    assert.equal(sent.length, 1);
    assert.equal(sent[0].sameEnv, true);
    assert.equal(sent[0].args.to, "admin@example.test");
    assert.match(sent[0].args.subject, /WhatsApp disconnected/);
    assert.match(sent[0].args.body, /needs to be paired again/);
    assert.match(sent[0].args.body, /Reason: qr_required/);
    assert.match(sent[0].args.body, /https:\/\/connect\.example\.test\/api\/connectors\/whatsapp\/bridge\/repair\?accountId=responder/);
    const events = await listEvents(env, 20);
    assert.equal(events.some((event) => event.type === "whatsapp_local_pairing_required_email_sent"), true);
    assert.equal(events.some((event) => event.type === "whatsapp_local_pairing_required_email_skipped" && event.reason === "cooldown"), true);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp pairing-required notification falls back to connected Gmail account", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-pairing-email-gmail-account-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
  };
  const sent = [];

  try {
    const result = await notifyLocalWhatsAppPairingRequired({
      accountId: "responder",
      reason: "auth_failure",
    }, env, {
      nowMs: 1_780_000_000_000,
      readGmailToken: async () => ({ account: "owner@example.test" }),
      sendGmailMessage: async (args) => {
        sent.push(args);
        return { ok: true, message: { id: "gmail-sent-2" } };
      },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.recipients, ["owner@example.test"]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "owner@example.test");
    assert.match(sent[0].args?.body || sent[0].body, /Reason: auth_failure/);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp pairing-required notification resolves missing Gmail account metadata", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-pairing-email-gmail-resolved-account-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
  };
  const sent = [];

  try {
    const result = await notifyLocalWhatsAppPairingRequired({
      accountId: "responder",
      reason: "qr_required",
    }, env, {
      nowMs: 1_780_000_000_000,
      readGmailToken: async () => ({ refreshToken: "refresh-token-present" }),
      enrichGmailTokenAccount: async () => ({ account: "owner@example.test" }),
      sendGmailMessage: async (args) => {
        sent.push(args);
        return { ok: true, message: { id: "gmail-sent-3" } };
      },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.recipients, ["owner@example.test"]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "owner@example.test");
    assert.match(sent[0].args?.body || sent[0].body, /Reason: qr_required/);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp pairing-required notification uses user-scoped Gmail sender", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-pairing-email-user-scope-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
  };
  const sent = [];

  try {
    const result = await notifyLocalWhatsAppPairingRequired({
      accountId: "responder",
      reason: "qr_required",
    }, env, {
      nowMs: 1_780_000_000_000,
      listConnectorScopePaths: async () => [
        { userId: "" },
        { userId: "owner" },
      ],
      connectorAuthStatus: async (provider, actualEnv, options) => {
        assert.equal(provider, "gmail");
        assert.equal(actualEnv, env);
        if (options.userId !== "owner") return { connected: false };
        return {
          connected: true,
          account: "owner@example.test",
          capabilities: ["gmail_send", "gmail_read"],
        };
      },
      sendGmailMessage: async (args, actualEnv, fetchImpl, options) => {
        sent.push({ args, actualEnv, options });
        return { ok: true, message: { id: "gmail-sent-4" } };
      },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.recipients, ["owner@example.test"]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].actualEnv, env);
    assert.equal(sent[0].args.to, "owner@example.test");
    assert.equal(sent[0].options.userId, "owner");
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp pairing-required notification uses host-native Gmail fallback", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-pairing-email-host-native-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
  };
  const sent = [];

  try {
    const result = await notifyLocalWhatsAppPairingRequired({
      accountId: "responder",
      reason: "qr_required",
    }, env, {
      nowMs: 1_780_000_000_000,
      listConnectorScopePaths: async () => [{ userId: "" }],
      connectorAuthStatus: async () => ({ connected: false }),
      listHostNativeGmailAccounts: async () => [
        { account: "owner@example.test", primary: true, source: "overlay" },
      ],
      sendHostNativeGmailMessage: async (args, actualEnv, options) => {
        sent.push({ args, actualEnv, options });
        return { ok: true, provider: "gmail", transport: "host_native_gog", message: { id: "gog-sent-1" } };
      },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.recipients, ["owner@example.test"]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].actualEnv, env);
    assert.equal(sent[0].args.to, "owner@example.test");
    assert.equal(sent[0].args.account, "owner@example.test");
    assert.equal(sent[0].options.account, "owner@example.test");
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp repair QR email sends PNG attachment to configured mailbox", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-repair-qr-email-"));
  const qrPath = path.join(home, "sender-qr.png");
  await fs.writeFile(qrPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender",
  };
  const sent = [];

  try {
    const result = await sendLocalWhatsAppRepairQrEmail({
      accountId: "sender",
      reason: "manual_repair_page",
    }, env, {
      nowMs: 1_780_000_000_000,
      getLocalWhatsAppBridgeStatus: async () => ({
        accounts: [{ accountId: "sender", ready: false, state: "qr_required" }],
      }),
      getQrAttachmentPath: async () => qrPath,
      listConnectorScopePaths: async () => [{ userId: "" }],
      connectorAuthStatus: async () => ({ connected: false }),
      listHostNativeGmailAccounts: async () => [
        { account: "owner@example.test", primary: true, source: "test" },
      ],
      sendHostNativeGmailMessage: async (args, actualEnv, options) => {
        sent.push({ args, actualEnv, options });
        return { ok: true, provider: "gmail", transport: "host_native_gog", message: { id: "gog-qr-1" } };
      },
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.recipients, ["owner@example.test"]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].actualEnv, env);
    assert.equal(sent[0].args.to, "owner@example.test");
    assert.equal(sent[0].args.account, "owner@example.test");
    assert.equal(sent[0].args.attachments.length, 1);
    assert.equal(sent[0].args.attachments[0].path, qrPath);
    assert.equal(sent[0].args.attachments[0].filename, "sender-qr.png");
    assert.equal(sent[0].args.attachments[0].mimetype, "image/png");
    assert.match(sent[0].args.subject, /WhatsApp QR/);
    const events = await listEvents(env);
    assert.ok(events.find((event) => event.type === "whatsapp_local_repair_qr_email_sent" && event.reason === "manual_repair_page"));
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp recent recovery skips already forwarded broker messages", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-recent-recovery-forward-dedupe-"));
  const chatId = "wa-group-forward-dedupe@g.us";
  const nowSeconds = 1_780_000_000;
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
    ORKESTR_WHATSAPP_RECENT_RECOVERY_MAX_AGE_MS: "600000",
    ORKESTR_WHATSAPP_INBOUND_FORWARD_MAP_JSON: JSON.stringify({
      [chatId]: "https://public.example/api/connectors/whatsapp/inbound",
    }),
    ORKESTR_WHATSAPP_INBOUND_FORWARD_TOKEN: "forward-secret",
  };
  const message = {
    id: { _serialized: `false_${chatId}_forward-dedupe_wa-contact-one@c.us`, remote: chatId },
    fromMe: false,
    from: chatId,
    author: "wa-contact-one@c.us",
    body: "recover once",
    timestamp: nowSeconds,
  };
  const chat = {
    id: { _serialized: chatId },
    unreadCount: 0,
    async fetchMessages() {
      return [message];
    },
  };
  const client = {
    async getChats() {
      return [chat];
    },
  };
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return response({ ok: true, threadId: "public-thread", messageId: "public-message" }, true, 202);
  };

  try {
    const options = {
      force: true,
      accountIds: ["responder"],
      clients: new Map([["responder", client]]),
      accountStates: new Map([["responder", { state: "ready", ready: true }]]),
      threads: [],
      limit: 20,
      nowMs: nowSeconds * 1000 + 60_000,
    };
    const first = await recoverUnreadLocalWhatsAppMessages(env, options);
    const second = await recoverUnreadLocalWhatsAppMessages(env, options);

    assert.equal(first.routed, 1);
    assert.equal(second.routed, 0);
    assert.equal(second.recovered[0].skipped[0].reason, "duplicate");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.text, "recover once");
  } finally {
    globalThis.fetch = originalFetch;
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp managed tenant routes skip sender account own-message legacy fallback", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-managed-route-account-skip-"));
  const chatId = "wa-group-managed-route@g.us";
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_INBOUND_FORWARD_MAP_JSON: JSON.stringify({
      [chatId]: "https://legacy.example/api/connectors/whatsapp/inbound",
    }),
    ORKESTR_WHATSAPP_INBOUND_FORWARD_TOKEN: "legacy-secret",
  };
  await createTenantVm({
    id: "tenant-managed-wa",
    ownerUserId: "admin",
    endpoint: { baseUrl: "https://tenant.example.test" },
    connectors: { whatsappChatName: "Managed WA", whatsappAccountId: "responder" },
  }, env);
  await configureTenantWhatsAppRoute("tenant-managed-wa", {
    chatId,
    accountId: "responder",
  }, env);
  let fetchCalled = false;
  const result = await forwardLocalWhatsAppInbound({
    eventId: `true_${chatId}_source-one_sender@lid`,
    chatId,
    accountId: "sender",
    from: "sender@lid",
    fromMe: true,
    text: "sender own message",
  }, env, async () => {
    fetchCalled = true;
    return response({ ok: true }, true, 202);
  });

  assert.equal(result.skipped, "managed_route_account_mismatch");
  assert.equal(fetchCalled, false);
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
    startLocalWhatsAppAccount("secondary", { ORKESTR_HOME: home, ORKESTR_WHATSAPP_ACCOUNT_IDS: "main,secondary" }, { phoneNumber: "+++" }),
    /whatsapp_pairing_phone_number_invalid/,
  );
});

test("local whatsapp start serializes concurrent starts for the same account", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-start-serialize-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
  };
  const calls = [];
  let releaseDependencies;
  const dependenciesReady = new Promise((resolve) => {
    releaseDependencies = resolve;
  });

  class LocalAuth {}

  class Client {
    constructor() {
      calls.push("client");
    }

    on() {
      return this;
    }

    initialize() {
      calls.push("initialize");
      return Promise.resolve();
    }

    async destroy() {
      calls.push("destroy");
    }
  }

  const options = {
    listChromeProcesses: async () => [],
    loadBridgeDependencies: async () => {
      calls.push("load");
      await dependenciesReady;
      return {
        whatsapp: { Client, LocalAuth },
        qrcode: {},
      };
    },
  };

  try {
    const first = startLocalWhatsAppAccount("responder", env, options);
    const second = startLocalWhatsAppAccount("responder", env, options);
    await new Promise((resolve) => setImmediate(resolve));
    releaseDependencies();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    assert.equal(firstResult.state, "starting");
    assert.equal(secondResult.state, "starting");
    assert.equal(calls.filter((call) => call === "load").length, 1);
    assert.equal(calls.filter((call) => call === "client").length, 1);
    assert.equal(calls.filter((call) => call === "initialize").length, 1);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp phone pairing replaces an existing qr runtime", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-phone-replaces-qr-runtime-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender",
    WA_PUPPETEER_PROTOCOL_TIMEOUT_MS: "345000",
  };
  const calls = [];
  const existingRuntime = {
    clearAuthReadyTimer() {
      calls.push("clear-auth-timer");
    },
    clearPairingCodeUnhandledRejectionHandler() {
      calls.push("clear-pairing-handler");
    },
    client: {
      async destroy() {
        calls.push("destroy-existing");
      },
    },
  };

  class LocalAuth {
    constructor(options) {
      calls.push(["local-auth", options.clientId, options.dataPath]);
    }
  }

  class Client {
    constructor(options) {
      calls.push(["client", options.pairWithPhoneNumber?.phoneNumber, options.puppeteer?.protocolTimeout, options.userAgent]);
    }

    on(event) {
      calls.push(["on", event]);
      return this;
    }

    initialize() {
      calls.push("initialize");
      return Promise.resolve();
    }

    async destroy() {
      calls.push("destroy-new");
    }
  }

  try {
    setLocalWhatsAppRuntimeForTest("sender", existingRuntime, {
      state: "qr_needed",
      ready: false,
      authenticated: false,
      started: true,
      qrAvailable: true,
    }, env);
    const result = await startLocalWhatsAppAccount("sender", env, {
      phoneNumber: "+155512345",
      loadBridgeDependencies: async () => ({
        whatsapp: { Client, LocalAuth },
        qrcode: {},
      }),
    });

    assert.equal(calls.includes("destroy-existing"), true);
    const clientCall = calls.find((call) => Array.isArray(call) && call[0] === "client");
    assert.deepEqual(clientCall.slice(0, 3), ["client", "155512345", 345000]);
    assert.match(clientCall[3], /Chrome\/147\.0\.0\.0/);
    assert.equal(result.state, "starting");
    const events = await listEvents(env);
    assert.ok(events.find((event) => event.type === "whatsapp_local_pairing_runtime_replaced"));
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp reset start replaces an existing ready runtime without logging out", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-reset-start-runtime-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender",
  };
  const calls = [];
  const existingRuntime = {
    clearStartupTimer() {
      calls.push("clear-startup-timer");
    },
    clearAuthReadyTimer() {
      calls.push("clear-auth-timer");
    },
    clearPairingCodeUnhandledRejectionHandler() {
      calls.push("clear-pairing-handler");
    },
    clearRuntimeCloseUnhandledRejectionHandler() {
      calls.push("clear-runtime-close-handler");
    },
    client: {
      async destroy() {
        calls.push("destroy-existing");
      },
    },
  };

  class LocalAuth {
    constructor(options) {
      calls.push(["local-auth", options.clientId, options.dataPath]);
    }
  }

  class Client {
    constructor(options) {
      calls.push(["client", Boolean(options.pairWithPhoneNumber)]);
    }

    on(event) {
      calls.push(["on", event]);
      return this;
    }

    initialize() {
      calls.push("initialize");
      return Promise.resolve();
    }

    async destroy() {
      calls.push("destroy-new");
    }
  }

  try {
    setLocalWhatsAppRuntimeForTest("sender", existingRuntime, {
      state: "ready",
      ready: true,
      authenticated: true,
      started: true,
    }, env);
    const result = await startLocalWhatsAppAccount("sender", env, {
      resetRuntime: true,
      loadBridgeDependencies: async () => ({
        whatsapp: { Client, LocalAuth },
        qrcode: {},
      }),
    });

    assert.equal(calls.includes("destroy-existing"), true);
    assert.deepEqual(calls.find((call) => Array.isArray(call) && call[0] === "client"), ["client", false]);
    assert.equal(calls.includes("initialize"), true);
    assert.equal(result.state, "starting");
    const events = await listEvents(env);
    assert.ok(events.find((event) => event.type === "whatsapp_local_runtime_reset_requested" && event.previousState === "ready"));
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp reset start does not hang on wedged destroy", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-reset-destroy-timeout-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender",
    ORKESTR_WHATSAPP_RUNTIME_DESTROY_TIMEOUT_MS: "10",
  };
  const calls = [];
  const existingRuntime = {
    clearStartupTimer() {
      calls.push("clear-startup-timer");
    },
    clearAuthReadyTimer() {
      calls.push("clear-auth-timer");
    },
    clearPairingCodeUnhandledRejectionHandler() {
      calls.push("clear-pairing-handler");
    },
    clearRuntimeCloseUnhandledRejectionHandler() {
      calls.push("clear-runtime-close-handler");
    },
    client: {
      destroy() {
        calls.push("destroy-existing");
        return new Promise(() => {});
      },
    },
  };

  class LocalAuth {}

  class Client {
    constructor() {
      calls.push("client");
    }

    on() {
      return this;
    }

    initialize() {
      calls.push("initialize");
      return Promise.resolve();
    }

    async destroy() {
      calls.push("destroy-new");
    }
  }

  try {
    setLocalWhatsAppRuntimeForTest("sender", existingRuntime, {
      state: "ready",
      ready: true,
      authenticated: true,
      started: true,
      chatOpsReady: false,
      runtimeUsable: true,
      lastChatOpsError: "r",
      chatOpsUnavailableSince: new Date(Date.now() - 60_000).toISOString(),
    }, env);

    const result = await startLocalWhatsAppAccount("sender", env, {
      resetRuntime: true,
      listChromeProcesses: async () => [],
      loadBridgeDependencies: async () => ({
        whatsapp: { Client, LocalAuth },
        qrcode: {},
      }),
    });
    const status = await getLocalWhatsAppBridgeStatus(env);
    const account = status.accounts.find((item) => item.accountId === "sender");
    const events = await listEvents(env);

    assert.equal(result.state, "starting");
    assert.equal(account.state, "starting");
    assert.equal(account.chatOpsReady, null);
    assert.equal(account.chatOpsUnavailableSince, null);
    assert.equal(calls.includes("destroy-existing"), true);
    assert.equal(calls.includes("client"), true);
    assert.equal(calls.includes("initialize"), true);
    assert.ok(events.find((event) => event.type === "whatsapp_local_runtime_destroy_timeout" && event.accountId === "sender"));
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp startup timeout fails a pre-qr hang and makes it recoverable", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-startup-timeout-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
  };
  const calls = [];

  class LocalAuth {}

  class Client {
    on() {
      return this;
    }

    initialize() {
      calls.push("initialize");
      return new Promise(() => {});
    }

    async destroy() {
      calls.push("destroy");
    }
  }

  try {
    const result = await startLocalWhatsAppAccount("responder", env, {
      startupTimeoutMs: 100,
      loadBridgeDependencies: async () => ({
        whatsapp: { Client, LocalAuth },
        qrcode: {},
      }),
    });
    assert.equal(result.state, "starting");

    await new Promise((resolve) => setTimeout(resolve, 160));
    const status = await getLocalWhatsAppBridgeStatus(env);
    const account = status.accounts.find((item) => item.accountId === "responder");
    assert.equal(status.state, "failed");
    assert.equal(account.state, "startup_timeout");
    assert.equal(account.ready, false);
    assert.match(account.error, /did not emit QR, pairing, auth, or ready/i);
    assert.deepEqual(recoverableLocalWhatsAppAccountIds(status.accounts, ["responder"]), ["responder"]);
    assert.ok(calls.includes("destroy"));
    const events = await listEvents(env);
    assert.ok(events.find((event) => event.type === "whatsapp_local_startup_timeout"));
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp client target closure becomes recoverable disconnected", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-target-close-client-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
  };
  const calls = [];
  let clientInstance = null;

  class LocalAuth {}

  class Client extends EventEmitter {
    constructor() {
      super();
      clientInstance = this;
    }

    initialize() {
      calls.push("initialize");
      return Promise.resolve();
    }

    async destroy() {
      calls.push("destroy");
    }
  }

  try {
    const result = await startLocalWhatsAppAccount("responder", env, {
      loadBridgeDependencies: async () => ({
        whatsapp: { Client, LocalAuth },
        qrcode: {},
      }),
    });
    assert.equal(result.state, "starting");

    clientInstance.emit("error", new Error("Protocol error (Runtime.callFunctionOn): Target closed"));
    const { status, account } = await waitForLocalWhatsAppAccount(
      env,
      "responder",
      (item) => item.state === "disconnected",
    );

    assert.equal(status.state, "disconnected");
    assert.equal(account.ready, false);
    assert.match(account.error, /Target closed/);
    assert.deepEqual(recoverableLocalWhatsAppAccountIds(status.accounts, ["responder"]), ["responder"]);
    assert.equal(await waitForTestCondition(() => calls.includes("destroy")), true);
    const events = await listEvents(env);
    const event = events.find((entry) => entry.type === "whatsapp_local_client_runtime_closed");
    assert.equal(event?.source, "client_error");
    assert.equal(event?.recoverable, true);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp autostart account recovers after target closure", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-target-close-autorecover-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
    ORKESTR_WHATSAPP_AUTOSTART: "1",
    ORKESTR_WHATSAPP_AUTOSTART_ACCOUNT_IDS: "responder",
    ORKESTR_WHATSAPP_AUTO_RECOVER_DELAY_MS: "5",
    ORKESTR_WHATSAPP_AUTO_RECOVER_MS: "5000",
  };
  const calls = [];
  let clientInstance = null;

  class LocalAuth {}

  class Client extends EventEmitter {
    constructor() {
      super();
      clientInstance = this;
    }

    initialize() {
      calls.push(["initialize"]);
      return Promise.resolve();
    }

    async destroy() {
      calls.push(["destroy"]);
    }
  }

  try {
    setLocalWhatsAppRuntimeRecoveryHooksForTest({
      async restartAccount(accountId, actualEnv, options) {
        calls.push(["restart", accountId, actualEnv === env, options.reason]);
      },
      async startAccount(accountId, actualEnv, options) {
        calls.push(["start", accountId, actualEnv === env, options.showNotification]);
        return { accountId, state: "starting", ready: false };
      },
    });
    const result = await startLocalWhatsAppAccount("responder", env, {
      loadBridgeDependencies: async () => ({
        whatsapp: { Client, LocalAuth },
        qrcode: {},
      }),
    });
    assert.equal(result.state, "starting");

    clientInstance.emit("error", new Error("Protocol error (Runtime.callFunctionOn): Target closed"));
    assert.equal(await waitForTestCondition(() => calls.some((call) => call[0] === "start"), 50), true);

    assert.ok(calls.some((call) => call[0] === "destroy"));
    assert.deepEqual(calls.filter((call) => call[0] === "restart"), [["restart", "responder", true, "auto_recover"]]);
    assert.deepEqual(calls.filter((call) => call[0] === "start"), [["start", "responder", true, false]]);
    const events = await listEvents(env, 50);
    assert.ok(events.find((event) => event.type === "whatsapp_local_runtime_auto_recover_scheduled" && event.accountId === "responder"));
    assert.ok(events.find((event) => event.type === "whatsapp_local_runtime_auto_recover_run" && event.accountId === "responder"));
    assert.ok(events.find((event) => event.type === "whatsapp_local_auto_recover_started" && event.accountId === "responder"));
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp ready event clears previous chat ops outage timestamp", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-ready-clears-chatops-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
  };
  let clientInstance = null;

  class LocalAuth {}

  class Client extends EventEmitter {
    constructor() {
      super();
      clientInstance = this;
      this.info = { wid: { _serialized: "responder@c.us" }, pushname: "Responder" };
    }

    initialize() {
      return Promise.resolve();
    }

    async destroy() {}
  }

  try {
    const result = await startLocalWhatsAppAccount("responder", env, {
      loadBridgeDependencies: async () => ({
        whatsapp: { Client, LocalAuth },
        qrcode: {},
      }),
    });
    assert.equal(result.state, "starting");

    setLocalWhatsAppRuntimeForTest("responder", { client: clientInstance }, {
      state: "ready",
      ready: true,
      authenticated: true,
      started: true,
      chatOpsReady: false,
      runtimeUsable: true,
      lastChatOpsError: "r",
      chatOpsUnavailableSince: "2026-07-16T08:20:00.000Z",
    }, env);
    assert.equal(clientInstance.listenerCount("ready"), 1);
    assert.equal(clientInstance.emit("ready"), true);
    await new Promise((resolve) => setTimeout(resolve, 50));

    const { account } = await waitForLocalWhatsAppAccount(
      env,
      "responder",
      (item) => item.ready === true && item.chatOpsReady === true && item.chatOpsUnavailableSince === null,
    );
    assert.equal(account.lastChatOpsError, "");
    assert.equal(account.chatOpsUnavailableSince, null);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp disconnected event sends Gmail repair email", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-disconnected-email-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
  };
  const sent = [];
  let clientInstance = null;

  class LocalAuth {}

  class Client extends EventEmitter {
    constructor() {
      super();
      clientInstance = this;
    }

    initialize() {
      return Promise.resolve();
    }
  }

  try {
    await startLocalWhatsAppAccount("responder", env, {
      loadBridgeDependencies: async () => ({
        whatsapp: { Client, LocalAuth },
        qrcode: {},
      }),
      repairNotifyOptions: {
        listConnectorScopePaths: async () => [{ userId: "" }],
        connectorAuthStatus: async () => ({ connected: false }),
        listHostNativeGmailAccounts: async () => [
          { account: "owner@example.test", primary: true, source: "test" },
        ],
        sendHostNativeGmailMessage: async (args, actualEnv, options) => {
          sent.push({ args, actualEnv, options });
          return { ok: true, provider: "gmail", transport: "host_native_gog", message: { id: "gog-disconnected-1" } };
        },
      },
    });

    clientInstance.emit("disconnected", "LOGOUT");
    const { account } = await waitForLocalWhatsAppAccount(
      env,
      "responder",
      (item) => item.state === "disconnected",
    );

    assert.equal(account.ready, false);
    assert.equal(await waitForTestCondition(() => sent.length === 1), true);
    assert.equal(sent[0].actualEnv, env);
    assert.equal(sent[0].args.to, "owner@example.test");
    assert.match(sent[0].args.subject, /WhatsApp disconnected/);
    assert.match(sent[0].args.body, /Reason: disconnected:LOGOUT/);
    const events = await listEvents(env);
    assert.ok(events.find((event) => event.type === "whatsapp_local_disconnected" && event.reason === "LOGOUT"));
    assert.ok(events.find((event) => event.type === "whatsapp_local_pairing_required_email_sent" && event.reason === "disconnected:LOGOUT"));
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp initialize target closure becomes recoverable disconnected", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-target-close-start-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
  };
  const calls = [];
  const targetClosed = new Error("Protocol error (Runtime.addBinding): Target closed");

  class LocalAuth {}

  class Client extends EventEmitter {
    initialize() {
      calls.push("initialize");
      return Promise.reject(targetClosed);
    }

    async destroy() {
      calls.push("destroy");
    }
  }

  try {
    await startLocalWhatsAppAccount("responder", env, {
      loadBridgeDependencies: async () => ({
        whatsapp: { Client, LocalAuth },
        qrcode: {},
      }),
    });
    const { status, account } = await waitForLocalWhatsAppAccount(
      env,
      "responder",
      (item) => item.state === "disconnected",
    );

    assert.equal(status.state, "disconnected");
    assert.equal(account.ready, false);
    assert.match(account.error, /Target closed/);
    assert.deepEqual(recoverableLocalWhatsAppAccountIds(status.accounts, ["responder"]), ["responder"]);
    assert.equal(await waitForTestCondition(() => calls.includes("destroy")), true);
    assert.deepEqual(calls, ["initialize", "destroy"]);
    const events = await listEvents(env);
    const event = events.find((entry) => entry.type === "whatsapp_local_start_runtime_closed");
    assert.equal(event?.source, "initialize");
    assert.equal(event?.recoverable, true);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
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

test("local whatsapp status reports degraded chat ops as unreachable", async () => {
  const error = "whatsapp_local_runtime_missing";
  const health = {
    ok: true,
    mode: "local",
    state: reduceLocalWhatsAppBridgeState([
      { accountId: "account-1", state: "degraded", authenticated: true, ready: false, chatOpsReady: false, runtimeUsable: false, error },
      { accountId: "account-2", state: "idle", authenticated: false, ready: false },
    ]),
    ready: false,
    accounts: [
      { accountId: "account-1", state: "degraded", authenticated: true, ready: false, chatOpsReady: false, runtimeUsable: false, error },
      { accountId: "account-2", state: "idle", authenticated: false, ready: false },
    ],
  };

  const status = mapLocalWhatsAppStatusFromHealth(health);

  assert.equal(health.state, "failed");
  assert.equal(status.state, "unreachable");
  assert.equal(status.summary, error);
  assert.equal(status.accounts[0].ready, false);
  assert.equal(status.accounts[0].chatOpsReady, false);
  assert.equal(status.accounts[0].runtimeUsable, false);
});

test("local whatsapp status does not report paired when ready account chat ops are unavailable", () => {
  const health = {
    ok: true,
    mode: "local",
    state: "ready",
    ready: true,
    clientReady: true,
    chatOpsReady: false,
    runtimeUsable: true,
    accounts: [
      { accountId: "sender", state: "ready", ready: true, authenticated: true, chatOpsReady: false, runtimeUsable: true, lastChatOpsError: "r" },
    ],
  };

  const status = mapLocalWhatsAppStatusFromHealth(health);

  assert.equal(status.state, "unreachable");
  assert.equal(status.summary, "r");
  assert.equal(status.health.ready, false);
  assert.equal(status.health.chatOpsReady, false);
  assert.equal(status.accounts[0].ready, true);
  assert.equal(status.accounts[0].chatOpsReady, false);
});

test("local whatsapp recovery only targets autostarted stalled accounts", async () => {
  const accounts = [
    { accountId: "sender", state: "auth_ready_timeout", ready: false },
    { accountId: "responder", state: "auth_ready_timeout", ready: false },
    { accountId: "other", state: "disconnected", ready: false },
    { accountId: "target-closed", state: "failed", ready: false, error: "Protocol error (Runtime.addBinding): Target closed" },
    { accountId: "profile-locked", state: "failed", ready: false, error: "The browser is already running for /tmp/profile. Use a different `userDataDir`." },
    { accountId: "chatops-r", state: "degraded", ready: false, authenticated: true, chatOpsReady: false, runtimeUsable: false, error: "r" },
    { accountId: "runtime-missing", state: "failed", ready: false, authenticated: true, error: "whatsapp_local_runtime_missing" },
    { accountId: "logged-out", state: "idle", ready: false },
    { accountId: "broken-auth", state: "auth_failure", ready: false },
    { accountId: "hard-failed", state: "failed", ready: false, error: "unexpected permanent connector error" },
    { accountId: "already-ready", state: "ready", ready: true },
  ];

  assert.deepEqual(recoverableLocalWhatsAppAccountIds(accounts, ["responder", "other", "target-closed", "profile-locked", "chatops-r", "runtime-missing", "logged-out", "broken-auth", "hard-failed", "already-ready"]), [
    "responder",
    "other",
    "target-closed",
    "profile-locked",
    "chatops-r",
    "runtime-missing",
  ]);
});

test("local whatsapp recovery clears process handlers and startup timers before replacing a runtime", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-recover-listeners-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
  };
  const calls = [];
  const runtime = {
    client: {
      async destroy() {
        calls.push("destroy");
      },
    },
    clearStartupTimer() {
      calls.push("startup");
    },
    clearAuthReadyTimer() {
      calls.push("auth");
    },
    clearPairingCodeUnhandledRejectionHandler() {
      calls.push("pairing-handler");
    },
    clearRuntimeCloseUnhandledRejectionHandler() {
      calls.push("runtime-handlers");
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("responder", runtime, {}, env);
    const result = await restartRecoverableLocalWhatsAppAccount("responder", env, {
      reason: "test_recovery",
    });

    assert.equal(result.hadRuntime, true);
    assert.deepEqual(calls, ["startup", "auth", "pairing-handler", "runtime-handlers", "destroy"]);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp recovery resets recoverable accounts before restarting", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-recover-reset-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder,other",
    ORKESTR_WHATSAPP_AUTOSTART: "1",
    ORKESTR_WHATSAPP_AUTOSTART_ACCOUNT_IDS: "responder,other",
  };
  const calls = [];

  const result = await recoverConfiguredLocalWhatsAppAccounts(env, {
    nowMs: 1000,
    status: {
      accounts: [
        { accountId: "responder", state: "failed", ready: false, error: "The browser is already running for /tmp/profile. Use a different userDataDir." },
        { accountId: "other", state: "ready", ready: true },
      ],
    },
    async restartAccount(accountId) {
      calls.push(["restart", accountId]);
    },
    async startAccount(accountId) {
      calls.push(["start", accountId]);
      return { accountId, state: "starting", ready: false };
    },
  });

  assert.deepEqual(calls, [["restart", "responder"], ["start", "responder"]]);
  assert.deepEqual(result.recovered, [{ accountId: "responder", state: "starting", ready: false }]);
  assert.deepEqual(result.skipped, []);
});

test("local whatsapp recovery starts idle autostarted accounts without reset", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-recover-idle-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender-idle,responder-idle,manual-idle",
    ORKESTR_WHATSAPP_AUTOSTART: "1",
    ORKESTR_WHATSAPP_AUTOSTART_ACCOUNT_IDS: "sender-idle,responder-idle",
  };
  const calls = [];

  const result = await recoverConfiguredLocalWhatsAppAccounts(env, {
    nowMs: 10_000,
    status: {
      accounts: [
        { accountId: "sender-idle", state: "idle", ready: false },
        { accountId: "responder-idle", state: "ready", ready: true },
        { accountId: "manual-idle", state: "idle", ready: false },
      ],
    },
    async restartAccount(accountId) {
      calls.push(["restart", accountId]);
    },
    async startAccount(accountId) {
      calls.push(["start", accountId]);
      return { accountId, state: "starting", ready: false };
    },
  });

  assert.deepEqual(calls, [["start", "sender-idle"]]);
  assert.deepEqual(result.recovered, [{ accountId: "sender-idle", state: "starting", ready: false }]);
  assert.deepEqual(result.skipped, []);
});

test("local whatsapp send recovers unstarted Web comms before retrying later", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-send-comms-recover-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
  };
  const commsError = new Error("[comms] deprecatedSendStanzaAndReturnAck called before startComms");
  const calls = [];
  const runtime = {
    client: {
      async sendMessage(chatId, text) {
        calls.push(["send", chatId, text]);
        throw commsError;
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("responder", runtime, {}, env);
    setLocalWhatsAppRuntimeRecoveryHooksForTest({
      async restartAccount(accountId, actualEnv, options) {
        calls.push(["restart", accountId, actualEnv === env, options.reason]);
      },
      async startAccount(accountId, actualEnv, options) {
        calls.push(["start", accountId, actualEnv === env, options.showNotification]);
        return { accountId, state: "starting", ready: false };
      },
    });

    await assert.rejects(
      () => sendLocalWhatsAppMessage({ accountId: "responder", chatId: "chat-comms@g.us", text: "hello", env }),
      (error) => {
        assert.equal(error.message, "whatsapp_local_bridge_not_ready_recovered_after_send_runtime_error");
        assert.equal(error.statusCode, 503);
        assert.equal(error.cause, commsError);
        return true;
      },
    );

    assert.deepEqual(calls, [
      ["send", "chat-comms@g.us", "hello"],
      ["restart", "responder", true, "send_runtime_error"],
      ["start", "responder", true, false],
    ]);
    const events = await listEvents(env);
    assert.ok(events.find((event) => event.type === "whatsapp_local_send_runtime_recovery_start"));
    assert.ok(events.find((event) => event.type === "whatsapp_local_send_runtime_recovery_started"));
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp concurrent send failures share one runtime recovery", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-send-recovery-single-flight-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
  };
  const commsError = new Error("[comms] deprecatedSendStanzaAndReturnAck called before startComms");
  const calls = [];
  let releaseRestart;
  const restartGate = new Promise((resolve) => {
    releaseRestart = resolve;
  });
  const runtime = {
    client: {
      async sendMessage(chatId, text) {
        calls.push(["send", chatId, text]);
        throw commsError;
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("responder", runtime, {}, env);
    setLocalWhatsAppRuntimeRecoveryHooksForTest({
      async restartAccount(accountId) {
        calls.push(["restart", accountId]);
        await restartGate;
      },
      async startAccount(accountId) {
        calls.push(["start", accountId]);
        return { accountId, state: "starting", ready: false };
      },
    });

    const attempts = ["one", "two"].map((text) => sendLocalWhatsAppMessage({
      accountId: "responder",
      chatId: "chat-comms@g.us",
      text,
      env,
    }).then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    ));
    while (calls.filter(([operation]) => operation === "send").length < 2 ||
      calls.filter(([operation]) => operation === "restart").length < 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    releaseRestart();
    const results = await Promise.all(attempts);

    assert.equal(calls.filter(([operation]) => operation === "restart").length, 1);
    assert.equal(calls.filter(([operation]) => operation === "start").length, 1);
    assert.ok(results.every((result) => result.ok === false && result.error.message === "whatsapp_local_bridge_not_ready_recovered_after_send_runtime_error"));
    const events = await listEvents(env);
    assert.equal(events.filter((event) => event.type === "whatsapp_local_send_runtime_recovery_start").length, 1);
    assert.equal(events.filter((event) => event.type === "whatsapp_local_send_runtime_recovery_joined").length, 1);
  } finally {
    releaseRestart?.();
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp unconfirmed sends do not reset the runtime", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-send-unconfirmed-no-reset-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
    ORKESTR_WHATSAPP_SEND_CONFIRMATION_ATTEMPTS: "1",
    ORKESTR_WHATSAPP_SEND_CONFIRMATION_DELAY_MS: "0",
  };
  const calls = [];
  const runtime = {
    client: {
      async sendMessage(chatId, text) {
        calls.push(["send", chatId, text]);
        return { id: { _serialized: `unconfirmed-${calls.length}` } };
      },
      async getChatById(chatId) {
        calls.push(["getChatById", chatId]);
        return {
          async fetchMessages(options = {}) {
            calls.push(["fetchMessages", options.limit]);
            return [];
          },
        };
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("responder", runtime, {}, env);
    setLocalWhatsAppRuntimeRecoveryHooksForTest({
      async restartAccount(accountId, actualEnv, options) {
        calls.push(["restart", accountId, actualEnv === env, options.reason]);
      },
      async startAccount(accountId, actualEnv, options) {
        calls.push(["start", accountId, actualEnv === env, options.showNotification]);
        return { accountId, state: "starting", ready: false };
      },
    });

    await assert.rejects(
      () => sendLocalWhatsAppMessage({ accountId: "responder", chatId: "chat-unconfirmed@g.us", text: "not visible", env }),
      (error) => {
        assert.equal(error.message, "whatsapp_send_not_confirmed");
        return true;
      },
    );

    assert.equal(calls.filter((call) => call[0] === "restart").length, 0);
    assert.equal(calls.filter((call) => call[0] === "start").length, 0);
    const events = await listEvents(env);
    assert.equal(events.some((event) => event.type === "whatsapp_local_send_runtime_recovery_start"), false);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp send skips confirmation when chat ops are degraded", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-send-chatops-degraded-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
    ORKESTR_WHATSAPP_SEND_CONFIRMATION_ATTEMPTS: "1",
    ORKESTR_WHATSAPP_SEND_CONFIRMATION_DELAY_MS: "0",
  };
  const calls = [];
  const runtime = {
    client: {
      async sendMessage(chatId, text) {
        calls.push(["send", chatId, text]);
        return { id: { _serialized: "sent-with-chatops-degraded" } };
      },
      async getChatById(chatId) {
        calls.push(["getChatById", chatId]);
        return {
          async fetchMessages(options = {}) {
            calls.push(["fetchMessages", options.limit]);
            return [];
          },
        };
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("responder", runtime, {
      chatOpsReady: false,
      runtimeUsable: true,
      lastChatOpsError: "r",
    }, env);

    const sent = await sendLocalWhatsAppMessage({
      accountId: "responder",
      chatId: "chat-confirmation-degraded@g.us",
      text: "sent while chat ops degraded",
      env,
    });

    assert.equal(sent.ok, true);
    assert.equal(sent.id, "sent-with-chatops-degraded");
    assert.deepEqual(calls, [
      ["send", "chat-confirmation-degraded@g.us", "sent while chat ops degraded"],
      ["getChatById", "chat-confirmation-degraded@g.us"],
      ["fetchMessages", 20],
    ]);
    const events = await listEvents(env);
    assert.ok(events.find((event) =>
      event.type === "whatsapp_local_send_confirmation_skipped" &&
      event.reason === "chat_ops_degraded" &&
      event.messageId === "sent-with-chatops-degraded"
    ));
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp chat creation recovers unstarted Web comms before retrying later", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-chat-comms-recover-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
  };
  const commsError = new Error("sendIq called before startComms");
  const calls = [];
  const runtime = {
    client: {
      info: { wid: { _serialized: "responder@c.us" } },
      async createGroup(title, participants, options) {
        calls.push(["createGroup", title, participants, options]);
        throw commsError;
      },
    },
  };

  try {
    setLocalWhatsAppRuntimeForTest("responder", runtime, {}, env);
    setLocalWhatsAppRuntimeRecoveryHooksForTest({
      async restartAccount(accountId, actualEnv, options) {
        calls.push(["restart", accountId, actualEnv === env, options.reason]);
      },
      async startAccount(accountId, actualEnv, options) {
        calls.push(["start", accountId, actualEnv === env, options.showNotification]);
        return { accountId, state: "starting", ready: false };
      },
    });

    await assert.rejects(
      () => createLocalWhatsAppChat({
        name: "otcanClaw-watcher",
        responderAccountId: "responder",
        participantIds: ["owner@c.us"],
        env,
      }),
      (error) => {
        assert.equal(error.message, "whatsapp_local_bridge_not_ready_recovered_after_chat_create_runtime_error");
        assert.equal(error.statusCode, 503);
        assert.equal(error.cause, commsError);
        return true;
      },
    );

    assert.deepEqual(calls, [
      ["createGroup", "otcanClaw-watcher", ["owner@c.us"], { announce: false }],
      ["restart", "responder", true, "chat_create_runtime_error"],
      ["start", "responder", true, false],
    ]);
    const events = await listEvents(env);
    assert.ok(events.find((event) => event.type === "whatsapp_local_chat_create_runtime_recovery_start"));
    assert.ok(events.find((event) => event.type === "whatsapp_local_chat_create_runtime_recovery_started"));
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp start reaps only orphan Chrome using the account profile", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-orphan-chrome-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder,other",
    ORKESTR_WHATSAPP_ACCOUNT_CLIENT_IDS: "responder:codex-whatsapp-responder,other:codex-whatsapp-other",
  };
  const responderProfile = path.join(home, "whatsapp-bridge", "sessions", "session-codex-whatsapp-responder");
  const otherProfile = path.join(home, "whatsapp-bridge", "sessions", "session-codex-whatsapp-other");
  const calls = [];

  class LocalAuth {}

  class Client {
    on() {
      return this;
    }

    initialize() {
      calls.push("initialize");
      return Promise.resolve();
    }

    async destroy() {
      calls.push("destroy");
    }
  }

  try {
    const result = await startLocalWhatsAppAccount("responder", env, {
      listChromeProcesses: async () => [
        { pid: 43101, argv: ["/usr/bin/chromium", `--user-data-dir=${responderProfile}`] },
        { pid: 43102, argv: ["/usr/bin/chromium", `--user-data-dir=${otherProfile}`] },
        { pid: 43103, argv: [process.execPath, `--user-data-dir=${responderProfile}`] },
      ],
      killChromeProcess: async (pid, signal) => {
        calls.push(["kill", pid, signal]);
      },
      isChromeProcessAlive: () => false,
      loadBridgeDependencies: async () => {
        calls.push("load");
        return {
          whatsapp: { Client, LocalAuth },
          qrcode: {},
        };
      },
    });

    assert.deepEqual(calls.filter((call) => Array.isArray(call)), [["kill", 43101, "SIGTERM"]]);
    assert.equal(calls.indexOf("load") > calls.findIndex((call) => Array.isArray(call)), true);
    assert.equal(calls.includes("initialize"), true);
    assert.equal(result.recoveredChromeProcesses, 1);
    assert.equal(result.lastRecoveryReason, "orphan_chrome_recovered");
    const events = await listEvents(env);
    assert.ok(events.find((event) =>
      event.type === "whatsapp_local_orphan_chrome_cleanup" &&
      event.accountId === "responder" &&
      event.killed === 1
    ));
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("local whatsapp chrome lock cleanup moves only dead-pid singleton markers", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-lock-cleanup-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
    ORKESTR_WHATSAPP_ACCOUNT_CLIENT_IDS: "responder:codex-whatsapp-responder",
  };
  const sessionDir = path.join(home, "whatsapp-bridge", "sessions", "session-codex-whatsapp-responder");
  const activeSessionDir = path.join(home, "whatsapp-bridge", "sessions", "session-active");
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.mkdir(activeSessionDir, { recursive: true });
  await fs.writeFile(path.join(sessionDir, "SingletonLock"), "chrome-lock-99999999", "utf8");
  await fs.writeFile(path.join(sessionDir, "SingletonCookie"), "stale", "utf8");
  await fs.writeFile(path.join(sessionDir, "Local State"), "keep", "utf8");
  await fs.writeFile(path.join(activeSessionDir, "SingletonLock"), `chrome-lock-${process.pid}`, "utf8");
  await fs.writeFile(path.join(activeSessionDir, "SingletonCookie"), "keep-active", "utf8");

  const result = await cleanupLocalWhatsAppChromeLocks("responder", env);

  assert.equal(result.removed.length, 2);
  assert.equal(result.moved.length, 2);
  assert.deepEqual(result.stalePids, [99999999]);
  await assert.rejects(fs.access(path.join(sessionDir, "SingletonLock")));
  await assert.rejects(fs.access(path.join(sessionDir, "SingletonCookie")));
  assert.ok(result.moved.every((item) => item.to.includes(".orkestr-stale-")));
  assert.equal(await fs.readFile(path.join(sessionDir, "Local State"), "utf8"), "keep");
  assert.equal(await fs.readFile(path.join(activeSessionDir, "SingletonLock"), "utf8"), `chrome-lock-${process.pid}`);
  assert.equal(await fs.readFile(path.join(activeSessionDir, "SingletonCookie"), "utf8"), "keep-active");
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

test("whatsapp status bridge timeout is configurable", async () => {
  const timeoutHome = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-status-timeout-"));
  const timeoutEnv = externalBridgeEnv(timeoutHome, {
    ORKESTR_WHATSAPP_BRIDGE_STATUS_TIMEOUT_MS: "5",
  });
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, timeoutEnv);

  const timedOut = await getWhatsAppStatus(timeoutEnv, async (_url, options = {}) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener("abort", () => reject(options.signal.reason || new Error("aborted")), { once: true });
  }));

  assert.equal(timedOut.state, "unreachable");
  assert.match(timedOut.error, /timeout|aborted/i);

  const slowHome = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-status-slow-"));
  const slowEnv = externalBridgeEnv(slowHome, {
    ORKESTR_WHATSAPP_BRIDGE_STATUS_TIMEOUT_MS: "100",
  });
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, slowEnv);

  const slow = await getWhatsAppStatus(slowEnv, async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
    return response({ ok: true, ready: true });
  });

  assert.equal(slow.state, "paired");
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

test("whatsapp external bridge preserves path prefixes", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-path-"));
  const env = externalBridgeEnv(home, { ORKESTR_INSTANCE_ID: "demo-instance-001" });
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://parent.local/api/connectors/whatsapp/bridge",
    apiToken: "secret-token",
  }, env);

  const status = await getWhatsAppStatus(env, async (url, options) => {
    assert.equal(url.pathname, "/api/connectors/whatsapp/bridge/health");
    assert.equal(options.headers.authorization, "Bearer secret-token");
    assert.equal(options.headers["x-orkestr-instance-id"], "demo-instance-001");
    return response({
      ok: true,
      ready: true,
      accounts: [{ id: "responder", label: "Responder", ready: true, state: "ready" }],
    });
  });

  assert.equal(status.state, "paired");
  assert.equal(status.bridgeUrl, "http://parent.local/api/connectors/whatsapp/bridge");
  assert.deepEqual(status.accounts.map((account) => account.id), ["responder"]);
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
          { id: "wa-contact-one@c.us", name: "Saved Main", isAdmin: true },
          { id: { _serialized: "wa-contact-two@c.us" }, pushname: "Saved Other", isSuperAdmin: true },
        ],
      },
    });
  });

  assert.equal(result.ready, true);
  assert.deepEqual(result.participants.map((participant) => participant.id), ["wa-contact-one@c.us", "wa-contact-two@c.us"]);
  assert.deepEqual(result.participants.map((participant) => participant.name), ["Saved Main", "Saved Other"]);
});

test("whatsapp chat history is read from external bridge", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-history-"));
  const env = externalBridgeEnv(home);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    apiToken: "history-token",
  }, env);

  const calls = [];
  const result = await getWhatsAppChatMessages({ accountId: "responder", chatId: "chat-history@g.us", limit: 3 }, env, async (url, options) => {
    calls.push({ url, options });
    if (url.pathname === "/health") {
      return response({
        ok: true,
        ready: true,
        accounts: [{ id: "responder", ready: true, state: "ready" }],
      });
    }
    assert.equal(url.pathname, "/api/chats/chat-history%40g.us/history");
    assert.equal(url.searchParams.get("accountId"), "responder");
    assert.equal(url.searchParams.get("limit"), "3");
    assert.equal(options.headers.authorization, "Bearer history-token");
    return response({
      ok: true,
      messages: [
        { id: "m1", body: "/connect google", fromMe: false, from: "chat-history@g.us", author: "491763240@c.us", timestamp: 1780910000 },
      ],
    });
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.url.pathname), ["/health", "/api/chats/chat-history%40g.us/history"]);
  assert.equal(result.ready, true);
  assert.equal(result.runtimeAccountId, "responder");
  assert.deepEqual(result.messages.map((message) => ({
    id: message.id,
    body: message.body,
    fromMe: message.fromMe,
    author: message.author,
    timestamp: message.timestamp,
  })), [{
    id: "m1",
    body: "/connect google",
    fromMe: false,
    author: "491763240@c.us",
    timestamp: "2026-06-08T09:13:20.000Z",
  }]);
});

test("whatsapp chat history falls back to bridge-root external endpoint", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-history-prefix-"));
  const env = externalBridgeEnv(home);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://parent.local/api/connectors/whatsapp/bridge",
  }, env);

  const calls = [];
  const result = await getWhatsAppChatMessages({ accountId: "responder", chatId: "chat-history@g.us", limit: 2 }, env, async (url) => {
    calls.push(url.pathname);
    if (url.pathname === "/api/connectors/whatsapp/bridge/health") {
      return response({
        ok: true,
        ready: true,
        accounts: [{ id: "responder", ready: true, state: "ready" }],
      });
    }
    if (url.pathname === "/api/connectors/whatsapp/bridge/api/chats/chat-history%40g.us/history") {
      return response({ error: "not_found" }, false, 404);
    }
    assert.equal(url.pathname, "/api/connectors/whatsapp/bridge/accounts/responder/chats/chat-history%40g.us/history");
    return response({
      ok: true,
      messages: [
        { id: "m2", text: "hello", fromMe: true, timestamp: "2026-06-08T10:00:00.000Z" },
      ],
    });
  });

  assert.deepEqual(calls, [
    "/api/connectors/whatsapp/bridge/health",
    "/api/connectors/whatsapp/bridge/api/chats/chat-history%40g.us/history",
    "/api/connectors/whatsapp/bridge/accounts/responder/chats/chat-history%40g.us/history",
  ]);
  assert.equal(result.messages[0].body, "hello");
  assert.equal(result.messages[0].fromMe, true);
});

test("whatsapp chat history maps numeric public account ids to runtime external account ids", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-history-numeric-"));
  const env = externalBridgeEnv(home);
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, env);

  const calls = [];
  const result = await getWhatsAppChatMessages({ accountId: "491763240", chatId: "chat-history@g.us", limit: 1 }, env, async (url) => {
    calls.push(url.pathname);
    if (url.pathname === "/health") {
      return response({
        ok: true,
        ready: true,
        accounts: [
          { id: "sender", ready: true, state: "ready", phoneNumber: "+491763240", contactId: "491763240@c.us" },
        ],
      });
    }
    assert.equal(url.pathname, "/api/chats/chat-history%40g.us/history");
    assert.equal(url.searchParams.get("accountId"), "sender");
    return response({
      ok: true,
      messages: [{ id: "m-numeric", body: "/connect google", fromMe: true, timestamp: "2026-06-08T10:00:00.000Z" }],
    });
  });

  assert.deepEqual(calls, ["/health", "/api/chats/chat-history%40g.us/history"]);
  assert.equal(result.runtimeAccountId, "sender");
  assert.equal(result.messages[0].id, "m-numeric");
});

test("whatsapp external sends map numeric public account ids to runtime bridge account ids", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-send-numeric-"));
  const env = externalBridgeEnv(home, { ORKESTR_WA_SERVICE_CLIENT_ID: "demo-instance-send" });
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, env);

  const calls = [];
  const sent = await sendWhatsAppText({
    accountId: "491763240",
    chatId: "chat-send@g.us",
    text: "/connect google",
    crossAccountEchoSuppression: false,
    routeSentMessage: true,
    env,
    fetchImpl: async (url, options = {}) => {
      calls.push(url.pathname);
      if (url.pathname === "/health") {
        return response({
          ok: true,
          ready: true,
          accounts: [
            { id: "sender", ready: true, state: "ready", phoneNumber: "+491763240", contactId: "491763240@c.us" },
          ],
        });
      }
      assert.equal(url.pathname, "/send-text");
      const body = JSON.parse(options.body);
      assert.equal(body.accountId, "sender");
      assert.equal(body.to, "chat-send@g.us");
      assert.equal(body.text, "/connect google");
      assert.equal(body.crossAccountEchoSuppression, false);
      assert.equal(body.routeSentMessage, true);
      assert.equal(options.headers["x-orkestr-instance-id"], "demo-instance-send");
      return response({ ok: true, ids: ["sent-numeric"] });
    },
  });

  assert.deepEqual(calls, ["/health", "/send-text"]);
  assert.deepEqual(sent.ids, ["sent-numeric"]);
});

test("whatsapp external bridge delivery preserves path prefixes", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-path-deliver-"));
  const env = externalBridgeEnv(home);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://parent.local/api/connectors/whatsapp/bridge",
  }, env);
  await routeWhatsAppInbound(
    { eventId: "wa-path-deliver-1", agentId: "agent-path-deliver", chatId: "chat-1", accountId: "responder", text: "status?" },
    env,
  );
  await runNextAgentMessage("agent-path-deliver", { executorId: "noop" }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-path"] });
  });

  assert.equal(delivery.delivered.length, 1);
  assert.equal(calls[0].url.pathname, "/api/connectors/whatsapp/bridge/send-text");
  assert.equal(calls[0].body.accountId, "responder");
});

test("whatsapp bridge send uses external bridge config without local accounts", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-external-send-"));
  const env = externalBridgeEnv(home);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://parent.local/api/connectors/whatsapp/bridge",
    apiToken: "bridge-secret",
  }, env);

  const calls = [];
  const result = await sendWhatsAppText({
    chatId: "chat-release@g.us",
    text: "release notice",
    accountId: "responder",
    env,
    fetchImpl: async (url, options) => {
      calls.push({ url, options, body: JSON.parse(options.body) });
      return response({ ok: true, sent: [{ id: "sent-release" }] });
    },
  });

  assert.deepEqual(result, { ok: true, sent: [{ id: "sent-release" }] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.pathname, "/api/connectors/whatsapp/bridge/send-text");
  assert.equal(calls[0].options.headers.authorization, "Bearer bridge-secret");
  assert.equal(calls[0].body.to, "chat-release@g.us");
  assert.equal(calls[0].body.accountId, "responder");
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

test("whatsapp embedded approval examples route as normal chat", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-embedded-approve-"));
  const env = externalBridgeEnv(home);
  const instanceId = "instance-embedded-approve-1";
  const whatsappChatId = "491700000111@c.us";
  await writeBrokerInstance(env, { instanceId, whatsappChatId });
  await writeConnectorConfig("whatsapp", { routes: { [whatsappChatId]: "agent-embedded-approve" } }, env);
  const created = await createPairingChallenge({
    env,
    instanceId,
    request: { headers: { "user-agent": "node-test" }, socket: { remoteAddress: "127.0.0.1" } },
  });
  const text = [
    "Do you know this command structure?",
    "```",
    `orkestr connect approve ${created.challenge.approveCode}`,
    "```",
    "It should be forwarded as normal text.",
  ].join("\n");

  const routed = await routeWhatsAppInbound({
    eventId: "wa-embedded-approval-example-1",
    chatId: whatsappChatId,
    from: whatsappChatId,
    text,
  }, env);
  const messages = await listAgentMessages("agent-embedded-approve", env);
  const listed = await listPairingChallenges({ env, includeExpired: true });
  const challenge = listed.challenges.find((item) => item.id === created.challenge.id);

  assert.notEqual(routed.approvedSecurityChallenge, true);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, text);
  assert.equal(challenge.status, "pending");
});

test("whatsapp direct approval command approves matching instance pairing challenge", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-approve-"));
  const env = externalBridgeEnv(home);
  const instanceId = "instance-approve-1";
  const whatsappChatId = "491700000001@c.us";
  await writeBrokerInstance(env, { instanceId, whatsappChatId });
  const created = await createPairingChallenge({
    env,
    instanceId,
    request: { headers: { "user-agent": "node-test" }, socket: { remoteAddress: "127.0.0.1" } },
  });

  const routed = await routeWhatsAppInbound({
    eventId: "wa-approval-command-1",
    chatId: whatsappChatId,
    from: whatsappChatId,
    text: `orkestr connect approve ${created.challenge.approveCode}`,
  }, env);
  const duplicate = await routeWhatsAppInbound({
    eventId: "wa-approval-command-1",
    chatId: whatsappChatId,
    from: whatsappChatId,
    text: `orkestr connect approve ${created.challenge.approveCode}`,
  }, env);
  const replay = await routeWhatsAppInbound({
    eventId: "wa-approval-command-replay-1",
    chatId: whatsappChatId,
    from: whatsappChatId,
    text: `orkestr connect approve ${created.challenge.approveCode}`,
  }, env);
  const listed = await listPairingChallenges({ env, includeExpired: true });
  const challenge = listed.challenges.find((item) => item.id === created.challenge.id);

  assert.equal(routed.approvedSecurityChallenge, true);
  assert.equal(routed.threadId, null);
  assert.equal(duplicate.duplicate, true);
  assert.equal(replay.skipped, "security_approval_challenge_approved");
  assert.equal(challenge.status, "approved");
  assert.equal(challenge.approvedBy, "whatsapp");
});

test("whatsapp approval command accepts routed group binding for registered target challenge", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-approve-group-"));
  const env = externalBridgeEnv(home);
  const instanceId = "instance-approve-group-1";
  const whatsappChatId = "491700000001@c.us";
  const groupChatId = "120363400000000000@g.us";
  await writeBrokerInstance(env, { instanceId, whatsappChatId });
  await createThread({
    id: "wa-approval-group-thread",
    name: "WA Approval Group",
    binding: {
      connector: "whatsapp",
      chatId: groupChatId,
      enabled: true,
      routeEligible: true,
      allowOtherPeople: true,
      mirrorToWhatsApp: true,
      outboundAccountId: "sender",
    },
  }, env);
  const created = await createPairingChallenge({
    env,
    instanceId,
    request: { headers: { "user-agent": "node-test" }, socket: { remoteAddress: "127.0.0.1" } },
  });

  const routed = await routeWhatsAppInbound({
    eventId: "wa-approval-command-group-1",
    chatId: groupChatId,
    accountId: "sender",
    from: "11111111111111@lid",
    text: `orkestr connect approve ${created.challenge.approveCode}`,
  }, env);
  const listed = await listPairingChallenges({ env, includeExpired: true });
  const challenge = listed.challenges.find((item) => item.id === created.challenge.id);

  assert.equal(routed.approvedSecurityChallenge, true);
  assert.equal(routed.threadId, null);
  assert.equal(challenge.status, "approved");
  assert.equal(challenge.approvedBy, "whatsapp");
});

test("whatsapp approval command accepts parent auth intent chat for tenant connect challenge", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-approve-auth-intent-chat-"));
  const env = externalBridgeEnv(home);
  const instanceId = "82f83473-4fce-4c63-ae22-08d3cd0c148a";
  const chatId = "120363428493624197@g.us";
  const connectId = "connect-firat-google";
  const created = await createPairingChallenge({
    env,
    instanceId,
    userId: "firat",
    role: "user",
    requestedPath: `/connect/google?connect=${connectId}`,
    allowedActions: [`orkestr_auth.google.connect:${connectId}`],
    authIntent: {
      mcp: "tools/call",
      tool: "orkestr_auth",
      service: "gmail",
      provider: "google_workspace",
      action: "connect",
      connectId,
      instanceId,
      userId: "firat",
      threadId: "firat-jobs",
      chatId,
      accountId: "sender",
      source: "whatsapp",
    },
    request: { headers: { "user-agent": "node-test" }, socket: { remoteAddress: "127.0.0.1" } },
  });

  const routed = await routeWhatsAppInbound({
    eventId: "wa-approval-command-auth-intent-chat-1",
    chatId,
    accountId: "sender",
    from: "66378837028965@lid",
    text: `orkestr connect approve ${created.challenge.approveCode}`,
  }, env);
  const listed = await listPairingChallenges({ env, includeExpired: true });
  const challenge = listed.challenges.find((item) => item.id === created.challenge.id);

  assert.equal(routed.approvedSecurityChallenge, true);
  assert.equal(routed.threadId, null);
  assert.equal(challenge.status, "approved");
  assert.equal(challenge.approvedBy, "whatsapp");
});

test("whatsapp approval command rejects parent auth intent from wrong account", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-approve-auth-intent-wrong-account-"));
  const env = externalBridgeEnv(home);
  const instanceId = "82f83473-4fce-4c63-ae22-08d3cd0c148a";
  const chatId = "120363428493624197@g.us";
  const connectId = "connect-firat-google-wrong-account";
  const created = await createPairingChallenge({
    env,
    instanceId,
    userId: "firat",
    role: "user",
    requestedPath: `/connect/google?connect=${connectId}`,
    allowedActions: [`orkestr_auth.google.connect:${connectId}`],
    authIntent: {
      mcp: "tools/call",
      tool: "orkestr_auth",
      service: "gmail",
      provider: "google_workspace",
      action: "connect",
      connectId,
      instanceId,
      userId: "firat",
      threadId: "firat-jobs",
      chatId,
      accountId: "sender",
      source: "whatsapp",
    },
    request: { headers: { "user-agent": "node-test" }, socket: { remoteAddress: "127.0.0.1" } },
  });

  const routed = await routeWhatsAppInbound({
    eventId: "wa-approval-command-auth-intent-chat-wrong-account-1",
    chatId,
    accountId: "other-account",
    from: "66378837028965@lid",
    text: `orkestr connect approve ${created.challenge.approveCode}`,
  }, env);
  const listed = await listPairingChallenges({ env, includeExpired: true });
  const challenge = listed.challenges.find((item) => item.id === created.challenge.id);

  assert.equal(routed.skipped, "security_approval_sender_denied");
  assert.equal(routed.threadId, null);
  assert.equal(challenge.status, "pending");
});

test("whatsapp approval command accepts routed direct lid binding for unscoped challenge", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-approve-lid-"));
  const env = externalBridgeEnv(home);
  const chatId = "11111111111111@lid";
  await createThread({
    id: "wa-approval-lid-thread",
    name: "WA Approval LID",
    binding: {
      connector: "whatsapp",
      chatId,
      enabled: true,
      routeEligible: true,
      mirrorToWhatsApp: true,
      outboundAccountId: "sender",
    },
  }, env);
  const created = await createPairingChallenge({
    env,
    request: { headers: { "user-agent": "node-test" }, socket: { remoteAddress: "127.0.0.1" } },
  });

  const routed = await routeWhatsAppInbound({
    eventId: "wa-approval-command-lid-1",
    chatId,
    accountId: "sender",
    from: chatId,
    text: `orkestr connect approve ${created.challenge.approveCode}`,
  }, env);
  const listed = await listPairingChallenges({ env, includeExpired: true });
  const challenge = listed.challenges.find((item) => item.id === created.challenge.id);

  assert.equal(routed.approvedSecurityChallenge, true);
  assert.equal(routed.threadId, null);
  assert.equal(challenge.status, "approved");
  assert.equal(challenge.approvedBy, "whatsapp");
});

test("whatsapp approval command accepts brokered unscoped challenge when explicitly enabled", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-approve-brokered-unscoped-"));
  const env = externalBridgeEnv(home, {
    ORKESTR_WHATSAPP_SECURITY_APPROVAL_ALLOW_BROKERED_UNSCOPED: "1",
  });
  const created = await createPairingChallenge({
    env,
    request: { headers: { "user-agent": "node-test" }, socket: { remoteAddress: "127.0.0.1" } },
  });

  const deniedWithoutMachineAuth = await routeWhatsAppInbound({
    eventId: "wa-approval-command-brokered-unscoped-denied",
    chatId: "491700000001@c.us",
    from: "491700000001@c.us",
    text: `orkestr connect approve ${created.challenge.approveCode}`,
  }, env);
  const approvedWithMachineAuth = await routeWhatsAppInbound({
    eventId: "wa-approval-command-brokered-unscoped-approved",
    chatId: "491700000001@c.us",
    from: "491700000001@c.us",
    text: `orkestr connect approve ${created.challenge.approveCode}`,
    machineAuthContext: { subject: "parent-broker", scopes: ["whatsapp:inbound"] },
  }, env);
  const listed = await listPairingChallenges({ env, includeExpired: true });
  const challenge = listed.challenges.find((item) => item.id === created.challenge.id);

  assert.equal(deniedWithoutMachineAuth.skipped, "security_approval_sender_denied");
  assert.equal(approvedWithMachineAuth.approvedSecurityChallenge, true);
  assert.equal(approvedWithMachineAuth.threadId, null);
  assert.equal(challenge.status, "approved");
  assert.equal(challenge.approvedBy, "whatsapp");
});

test("whatsapp approval command accepts direct lid after prior routed group context", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-approve-prior-group-lid-"));
  const env = externalBridgeEnv(home);
  const groupChatId = "120363400000000000@g.us";
  const participantLid = "11111111111111@lid";
  await createThread({
    id: "wa-approval-prior-group-lid-thread",
    name: "WA Approval Prior Group LID",
    binding: {
      connector: "whatsapp",
      chatId: groupChatId,
      enabled: true,
      routeEligible: true,
      allowOtherPeople: true,
      mirrorToWhatsApp: true,
      outboundAccountId: "sender",
    },
  }, env);
  const prior = await routeWhatsAppInbound({
    eventId: "false_120363400000000000@g.us_prior_11111111111111@lid",
    chatId: groupChatId,
    accountId: "sender",
    from: participantLid,
    author: participantLid,
    fromMe: false,
    text: "prior routed message",
  }, env);
  const created = await createPairingChallenge({
    env,
    request: { headers: { "user-agent": "node-test" }, socket: { remoteAddress: "127.0.0.1" } },
  });

  const routed = await routeWhatsAppInbound({
    eventId: "wa-approval-command-direct-lid-after-group-1",
    chatId: participantLid,
    accountId: "sender",
    from: participantLid,
    author: participantLid,
    text: `orkestr connect approve ${created.challenge.approveCode}`,
  }, env);
  const listed = await listPairingChallenges({ env, includeExpired: true });
  const challenge = listed.challenges.find((item) => item.id === created.challenge.id);

  assert.equal(prior.threadId, "wa-approval-prior-group-lid-thread");
  assert.equal(routed.approvedSecurityChallenge, true);
  assert.equal(routed.threadId, null);
  assert.equal(challenge.status, "approved");
  assert.equal(challenge.approvedBy, "whatsapp");
});

test("whatsapp direct approval command rejects non-target sender", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-approve-denied-"));
  const env = externalBridgeEnv(home);
  const instanceId = "instance-approve-denied-1";
  await writeBrokerInstance(env, { instanceId, whatsappChatId: "491700000001@c.us" });
  const created = await createPairingChallenge({
    env,
    instanceId,
    request: { headers: { "user-agent": "node-test" }, socket: { remoteAddress: "127.0.0.1" } },
  });

  const routed = await routeWhatsAppInbound({
    eventId: "wa-approval-command-denied-1",
    chatId: "491700000002@c.us",
    from: "491700000002@c.us",
    text: `orkestr connect approve ${created.challenge.approveCode}`,
  }, env);
  const listed = await listPairingChallenges({ env, includeExpired: true });
  const challenge = listed.challenges.find((item) => item.id === created.challenge.id);

  assert.equal(routed.skipped, "security_approval_sender_denied");
  assert.equal(routed.threadId, null);
  assert.equal(challenge.status, "pending");
});

test("whatsapp inbound only queues sender account events", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-inbound-sender-only-"));
  const env = externalBridgeEnv(home, { ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender,responder" });
  await createThread({ id: "wa-inbound-sender-only-thread", name: "WA Inbound Sender Only" }, env);
  await writeConnectorConfig("whatsapp", {
    threadRoutes: { "chat-sender-only": "wa-inbound-sender-only-thread" },
  }, env);

  const responderFirst = await routeWhatsAppInbound({
    eventId: "false_chat-sender-only_msg-1_author",
    chatId: "chat-sender-only",
    accountId: "responder",
    from: "author",
    text: "How many tasks are open?",
  }, env);
  const senderSecond = await routeWhatsAppInbound({
    eventId: "true_chat-sender-only_msg-1_author",
    chatId: "chat-sender-only",
    accountId: "sender",
    from: "author",
    text: "How many tasks are open?",
  }, env);
  const messages = await listThreadMessages("wa-inbound-sender-only-thread", env);
  const events = await listEvents(env);

  assert.equal(responderFirst.ignoredNonSenderAccount, true);
  assert.equal(responderFirst.skipped, "non_sender_account");
  assert.equal(senderSecond.duplicate, false);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].accountId, "sender");
  assert.equal(messages[0].externalId, "chat-sender-only_msg-1_author");
  assert.equal(events.some((event) => event.type === "whatsapp_inbound_non_sender_ignored"), true);
});

test("whatsapp inbound strips pasted debug footers before storing messages", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-inbound-debug-footer-"));
  const env = externalBridgeEnv(home);
  await writeConnectorConfig("whatsapp", { routes: { "chat-debug-inbound": "agent-debug-inbound" } }, env);

  await routeWhatsAppInbound({
    eventId: "wa-debug-inbound-1",
    chatId: "chat-debug-inbound",
    from: "sender-1",
    text: "There are already unrelated local changes.\n\ndbg: m:gpt-5.5/xh · msg:update · q:4 · load:42% · api:95% · help:/help",
  }, env);
  const messages = await listAgentMessages("agent-debug-inbound", env);

  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, "There are already unrelated local changes.");
  assert.doesNotMatch(messages[0].text, /dbg:/);
});

test("whatsapp inbound ignores generated queue notices", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-inbound-generated-notice-"));
  const env = externalBridgeEnv(home);
  await writeConnectorConfig("whatsapp", { routes: { "chat-generated-notice": "agent-generated-notice" } }, env);

  const routed = await routeWhatsAppInbound({
    eventId: "wa-generated-notice-1",
    chatId: "chat-generated-notice",
    from: "sender-1",
    text: 'Queued your message while Orkestr prepares this thread: "Queued for the next Codex turn: "Focused tests passed. I’m restarting the active Orkestr UI service so the deployed `...".',
  }, env);
  const duplicate = await routeWhatsAppInbound({
    eventId: "wa-generated-notice-1",
    chatId: "chat-generated-notice",
    from: "sender-1",
    text: "retry should be deduped",
  }, env);
  const messages = await listAgentMessages("agent-generated-notice", env);
  const events = await listEvents(env);

  assert.equal(routed.skipped, true);
  assert.equal(routed.ignoredGeneratedQueueNotice, true);
  assert.equal(routed.event.ignoredReason, "generated_queue_notice");
  assert.equal(duplicate.duplicate, true);
  assert.equal(messages.length, 0);
  assert.equal(events.some((event) => event.type === "whatsapp_generated_queue_notice_ignored"), true);
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

test("whatsapp inbound endpoint accepts inbound token when browser pairing is required", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-token-api-"));
  const priorHome = process.env.ORKESTR_HOME;
  const priorAuth = process.env.ORKESTR_AUTH_REQUIRED;
  const priorInboundToken = process.env.ORKESTR_WHATSAPP_INBOUND_TOKEN;
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  process.env.ORKESTR_WHATSAPP_INBOUND_TOKEN = "bridge-inbound-secret";
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const blocked = await fetch(`${baseUrl}/api/connectors/whatsapp/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventId: "wa-token-blocked", agentId: "agent-token-api", text: "blocked" }),
    });
    const blockedPayload = await blocked.json();
    const accepted = await fetch(`${baseUrl}/api/connectors/whatsapp/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer bridge-inbound-secret" },
      body: JSON.stringify({
        eventId: "wa-token-accepted",
        agentId: "agent-token-api",
        chatId: "bridge-chat@g.us",
        from: "wa-contact-tenant@c.us",
        text: "token routed",
      }),
    });
    const payload = await accepted.json();
    const messages = await listAgentMessages("agent-token-api", { ORKESTR_HOME: home });

    assert.equal(blocked.status, 401);
    assert.equal(blockedPayload.error, "whatsapp_inbound_token_required");
    assert.equal(blockedPayload.routingFailure.code, "whatsapp_inbound_token_required");
    assert.equal(accepted.status, 202);
    assert.equal(payload.agentId, "agent-token-api");
    assert.equal(payload.duplicate, false);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].source, "whatsapp_inbound");
    assert.equal(messages[0].chatId, "bridge-chat@g.us");
    assert.equal(messages[0].text, "token routed");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
    if (priorAuth === undefined) delete process.env.ORKESTR_AUTH_REQUIRED;
    else process.env.ORKESTR_AUTH_REQUIRED = priorAuth;
    if (priorInboundToken === undefined) delete process.env.ORKESTR_WHATSAPP_INBOUND_TOKEN;
    else process.env.ORKESTR_WHATSAPP_INBOUND_TOKEN = priorInboundToken;
  }
});

test("whatsapp bridge scoped tokens cannot enumerate or control other account chats", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-bridge-scoped-account-"));
  const priorHome = process.env.ORKESTR_HOME;
  const priorAuth = process.env.ORKESTR_AUTH_REQUIRED;
  const priorScopedTokens = process.env.ORKESTR_WHATSAPP_SCOPED_TOKENS_JSON;
  const priorAccountIds = process.env.ORKESTR_WHATSAPP_ACCOUNT_IDS;
  const priorAutostart = process.env.ORKESTR_WHATSAPP_AUTOSTART;
  const priorLocalAutostart = process.env.WHATSAPP_LOCAL_AUTOSTART;
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  process.env.ORKESTR_WHATSAPP_ACCOUNT_IDS = "acct-a acct-b";
  process.env.ORKESTR_WHATSAPP_AUTOSTART = "0";
  process.env.WHATSAPP_LOCAL_AUTOSTART = "0";
  process.env.ORKESTR_WHATSAPP_SCOPED_TOKENS_JSON = JSON.stringify([
    {
      id: "acct-a-read",
      token: "acct-a-read-token",
      scopes: ["whatsapp:bridge:read"],
      accountId: "acct-a",
      principalKind: "external_instance",
      principalId: "remote-a",
    },
    {
      id: "chat-a-read",
      token: "chat-a-read-token",
      scopes: ["whatsapp:bridge:read"],
      accountId: "acct-a",
      chatId: "chat-a@g.us",
      principalKind: "external_instance",
      principalId: "remote-chat-a",
    },
  ]);
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const accountsResponse = await fetch(`${baseUrl}/api/connectors/whatsapp/bridge/accounts`, {
      headers: { authorization: "Bearer acct-a-read-token" },
    });
    const accounts = await accountsResponse.json();
    const allowedChatsResponse = await fetch(`${baseUrl}/api/connectors/whatsapp/bridge/accounts/acct-a/chats`, {
      headers: { authorization: "Bearer acct-a-read-token" },
    });
    const allowedChats = await allowedChatsResponse.json();
    const deniedOtherAccount = await fetch(`${baseUrl}/api/connectors/whatsapp/bridge/accounts/acct-b/chats`, {
      headers: { authorization: "Bearer acct-a-read-token" },
    });
    const deniedOtherPayload = await deniedOtherAccount.json();
    const deniedChatScopedList = await fetch(`${baseUrl}/api/connectors/whatsapp/bridge/accounts/acct-a/chats`, {
      headers: { authorization: "Bearer chat-a-read-token" },
    });
    const deniedChatPayload = await deniedChatScopedList.json();

    assert.equal(accountsResponse.status, 200);
    assert.deepEqual(accounts.accounts.map((account) => account.accountId), ["acct-a"]);
    assert.equal(allowedChatsResponse.status, 200);
    assert.equal(allowedChats.accountId, "acct-a");
    assert.equal(deniedOtherAccount.status, 403);
    assert.equal(deniedOtherPayload.error, "wa_acl_denied");
    assert.equal(deniedChatScopedList.status, 403);
    assert.equal(deniedChatPayload.error, "wa_acl_denied");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await resetLocalWhatsAppBridgeForTest(process.env);
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
    if (priorAuth === undefined) delete process.env.ORKESTR_AUTH_REQUIRED;
    else process.env.ORKESTR_AUTH_REQUIRED = priorAuth;
    if (priorScopedTokens === undefined) delete process.env.ORKESTR_WHATSAPP_SCOPED_TOKENS_JSON;
    else process.env.ORKESTR_WHATSAPP_SCOPED_TOKENS_JSON = priorScopedTokens;
    if (priorAccountIds === undefined) delete process.env.ORKESTR_WHATSAPP_ACCOUNT_IDS;
    else process.env.ORKESTR_WHATSAPP_ACCOUNT_IDS = priorAccountIds;
    if (priorAutostart === undefined) delete process.env.ORKESTR_WHATSAPP_AUTOSTART;
    else process.env.ORKESTR_WHATSAPP_AUTOSTART = priorAutostart;
    if (priorLocalAutostart === undefined) delete process.env.WHATSAPP_LOCAL_AUTOSTART;
    else process.env.WHATSAPP_LOCAL_AUTOSTART = priorLocalAutostart;
  }
});

test("whatsapp doctor skips optional idle accounts in global health", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-doctor-optional-account-"));
  const prior = Object.fromEntries([
    "ORKESTR_HOME",
    "ORKESTR_AUTH_REQUIRED",
    "ORKESTR_PUBLIC_HTTPS_URL",
    "ORKESTR_WHATSAPP_ACCOUNT_IDS",
    "WHATSAPP_LOCAL_ACCOUNT_IDS",
    "ORKESTR_WHATSAPP_STRICT_ACCOUNT_IDS",
    "WHATSAPP_LOCAL_STRICT_ACCOUNT_IDS",
    "ORKESTR_WHATSAPP_ACCOUNT_CLIENT_IDS",
    "WHATSAPP_LOCAL_ACCOUNT_CLIENT_IDS",
    "ORKESTR_WHATSAPP_ACCOUNT_SESSION_ROOTS",
    "WHATSAPP_LOCAL_ACCOUNT_SESSION_ROOTS",
    "ORKESTR_WHATSAPP_AUTOSTART",
    "WHATSAPP_LOCAL_AUTOSTART",
    "ORKESTR_WHATSAPP_AUTOSTART_ACCOUNT_IDS",
    "WHATSAPP_LOCAL_AUTOSTART_ACCOUNT_IDS",
    "ORKESTR_WHATSAPP_DEFAULT_RESPONDER_ACCOUNT_ID",
    "WHATSAPP_LOCAL_DEFAULT_RESPONDER_ACCOUNT_ID",
    "ORKESTR_CODEX_BIN",
    "ORKESTR_RECOVER_RUNNING_ON_START",
  ].map((key) => [key, process.env[key]]));
  process.env.ORKESTR_HOME = home;
  delete process.env.ORKESTR_AUTH_REQUIRED;
  delete process.env.ORKESTR_PUBLIC_HTTPS_URL;
  process.env.ORKESTR_WHATSAPP_ACCOUNT_IDS = "sender,responder";
  delete process.env.WHATSAPP_LOCAL_ACCOUNT_IDS;
  process.env.ORKESTR_WHATSAPP_STRICT_ACCOUNT_IDS = "1";
  delete process.env.WHATSAPP_LOCAL_STRICT_ACCOUNT_IDS;
  delete process.env.ORKESTR_WHATSAPP_ACCOUNT_CLIENT_IDS;
  delete process.env.WHATSAPP_LOCAL_ACCOUNT_CLIENT_IDS;
  delete process.env.ORKESTR_WHATSAPP_ACCOUNT_SESSION_ROOTS;
  delete process.env.WHATSAPP_LOCAL_ACCOUNT_SESSION_ROOTS;
  process.env.ORKESTR_WHATSAPP_AUTOSTART = "0";
  process.env.WHATSAPP_LOCAL_AUTOSTART = "0";
  process.env.ORKESTR_WHATSAPP_AUTOSTART_ACCOUNT_IDS = "responder";
  delete process.env.WHATSAPP_LOCAL_AUTOSTART_ACCOUNT_IDS;
  process.env.ORKESTR_WHATSAPP_DEFAULT_RESPONDER_ACCOUNT_ID = "responder";
  delete process.env.WHATSAPP_LOCAL_DEFAULT_RESPONDER_ACCOUNT_ID;
  process.env.ORKESTR_CODEX_BIN = "__orkestr_codex_disabled_for_test__";
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  const distBridge = await import("../dist/server/packages/connectors/src/whatsapp-local-bridge.js");
  await distBridge.resetLocalWhatsAppBridgeForTest(process.env);

  await createThread({
    id: "doctor-ready-thread",
    name: "Doctor Ready",
    binding: {
      connector: "whatsapp",
      chatId: "doctor-ready@g.us",
      senderAccountId: "sender",
      responderAccountId: "responder",
      outboundAccountId: "responder",
    },
  }, process.env);
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  distBridge.setLocalWhatsAppRuntimeForTest("responder", {
    client: {
      info: { wid: { _serialized: "responder@c.us" } },
    },
  }, { ready: true }, process.env);

  try {
    const globalResponse = await fetch(`${baseUrl}/api/connectors/whatsapp/doctor`);
    const globalPayload = await globalResponse.json();
    const senderResponse = await fetch(`${baseUrl}/api/connectors/whatsapp/doctor?account=sender`);
    const senderPayload = await senderResponse.json();

    assert.equal(globalResponse.status, 200);
    assert.equal(globalPayload.ok, true);
    assert.equal(globalPayload.status, "ok");
    assert.equal(globalPayload.checks.find((check) => check.type === "account" && check.id === "sender")?.skipped, true);
    assert.equal(globalPayload.checks.find((check) => check.type === "account" && check.id === "sender")?.reason, "account_not_required");
    assert.equal(senderResponse.status, 200);
    assert.equal(senderPayload.ok, false);
    assert.equal(senderPayload.checks.find((check) => check.type === "account" && check.id === "sender")?.reason, "account_not_ready");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await distBridge.resetLocalWhatsAppBridgeForTest(process.env);
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("whatsapp doctor fails selected QR-required accounts", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-doctor-selected-qr-"));
  const prior = Object.fromEntries([
    "ORKESTR_HOME",
    "ORKESTR_AUTH_REQUIRED",
    "ORKESTR_PUBLIC_HTTPS_URL",
    "ORKESTR_WHATSAPP_ACCOUNT_IDS",
    "ORKESTR_WHATSAPP_AUTOSTART",
    "WHATSAPP_LOCAL_AUTOSTART",
    "ORKESTR_WHATSAPP_AUTOSTART_ACCOUNT_IDS",
    "ORKESTR_CODEX_BIN",
    "ORKESTR_RECOVER_RUNNING_ON_START",
  ].map((key) => [key, process.env[key]]));
  process.env.ORKESTR_HOME = home;
  delete process.env.ORKESTR_AUTH_REQUIRED;
  delete process.env.ORKESTR_PUBLIC_HTTPS_URL;
  process.env.ORKESTR_WHATSAPP_ACCOUNT_IDS = "responder";
  process.env.ORKESTR_WHATSAPP_AUTOSTART = "0";
  process.env.WHATSAPP_LOCAL_AUTOSTART = "0";
  process.env.ORKESTR_WHATSAPP_AUTOSTART_ACCOUNT_IDS = "";
  process.env.ORKESTR_CODEX_BIN = "__orkestr_codex_disabled_for_test__";
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";

  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const distBridge = await import("../dist/server/packages/connectors/src/whatsapp-local-bridge.js");
  distBridge.setLocalWhatsAppRuntimeForTest("responder", {}, {
    ready: false,
    qrRequired: true,
    qrAvailable: true,
    state: "qr_required",
    nextAction: "pair_account",
  }, process.env);

  try {
    const response = await fetch(`${baseUrl}/api/connectors/whatsapp/doctor?account=responder`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.ok, false);
    assert.equal(payload.status, "broken");
    const check = payload.checks.find((item) => item.type === "account" && item.id === "responder");
    assert.equal(check?.ok, false);
    assert.equal(check?.reason, "account_pairing_required");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await distBridge.resetLocalWhatsAppBridgeForTest(process.env);
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("whatsapp bridge injection ignores cross-account outbound text echoes", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-bridge-inject-echo-"));
  const priorHome = process.env.ORKESTR_HOME;
  const priorAuth = process.env.ORKESTR_AUTH_REQUIRED;
  const priorBridgeToken = process.env.ORKESTR_WHATSAPP_BRIDGE_TOKEN;
  const priorAccountIds = process.env.ORKESTR_WHATSAPP_ACCOUNT_IDS;
  const priorConfirmation = process.env.ORKESTR_WHATSAPP_SEND_CONFIRMATION_REQUIRED;
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  process.env.ORKESTR_WHATSAPP_BRIDGE_TOKEN = "bridge-e2e-secret";
  process.env.ORKESTR_WHATSAPP_ACCOUNT_IDS = "sender,responder";
  process.env.ORKESTR_WHATSAPP_SEND_CONFIRMATION_REQUIRED = "0";
  const chatId = "chat-bridge-inject-echo@g.us";
  const text = "The push is done. I’ll check that the workspace is clean.\n\ndbg: m:gpt-5.5/xh";
  const sent = [];
  const runtime = {
    client: {
      async sendMessage(to, body) {
        sent.push({ to, body });
        return { id: { _serialized: `true_${chatId}_bridge-outbound` } };
      },
    },
  };
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const distBridge = await import("../dist/server/packages/connectors/src/whatsapp-local-bridge.js");
  distBridge.setLocalWhatsAppRuntimeForTest("responder", runtime, {}, process.env);
  try {
    const sentResponse = await fetch(`${baseUrl}/api/connectors/whatsapp/bridge/send-text`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer bridge-e2e-secret" },
      body: JSON.stringify({ accountId: "responder", chatId, text }),
    });
    const sentPayload = await sentResponse.json();
    const injected = await fetch(`${baseUrl}/api/connectors/whatsapp/bridge/inject-message`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer bridge-e2e-secret" },
      body: JSON.stringify({
        accountId: "responder",
        chatId,
        from: "sender@lid",
        eventId: `false_${chatId}_responder-observed-sender`,
        text,
      }),
    });
    const payload = await injected.json();

    assert.equal(sentResponse.status, 200, JSON.stringify(sentPayload));
    assert.equal(sentPayload.ok, true);
    assert.equal(sent.length, 1);
    assert.equal(injected.status, 202);
    assert.equal(payload.skipped, "outbound_echo_cross_account_text");
    assert.equal(payload.chatId, chatId);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await distBridge.resetLocalWhatsAppBridgeForTest(process.env);
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
    if (priorAuth === undefined) delete process.env.ORKESTR_AUTH_REQUIRED;
    else process.env.ORKESTR_AUTH_REQUIRED = priorAuth;
    if (priorBridgeToken === undefined) delete process.env.ORKESTR_WHATSAPP_BRIDGE_TOKEN;
    else process.env.ORKESTR_WHATSAPP_BRIDGE_TOKEN = priorBridgeToken;
    if (priorAccountIds === undefined) delete process.env.ORKESTR_WHATSAPP_ACCOUNT_IDS;
    else process.env.ORKESTR_WHATSAPP_ACCOUNT_IDS = priorAccountIds;
    if (priorConfirmation === undefined) delete process.env.ORKESTR_WHATSAPP_SEND_CONFIRMATION_REQUIRED;
    else process.env.ORKESTR_WHATSAPP_SEND_CONFIRMATION_REQUIRED = priorConfirmation;
  }
});

test("whatsapp bridge send-media accepts inline attachments and stages them locally", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-bridge-inline-media-"));
  const priorHome = process.env.ORKESTR_HOME;
  const priorAuth = process.env.ORKESTR_AUTH_REQUIRED;
  const priorBridgeToken = process.env.ORKESTR_WHATSAPP_BRIDGE_TOKEN;
  const priorAccountIds = process.env.ORKESTR_WHATSAPP_ACCOUNT_IDS;
  const priorConfirmation = process.env.ORKESTR_WHATSAPP_SEND_CONFIRMATION_REQUIRED;
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  process.env.ORKESTR_WHATSAPP_BRIDGE_TOKEN = "bridge-inline-secret";
  process.env.ORKESTR_WHATSAPP_ACCOUNT_IDS = "responder";
  process.env.ORKESTR_WHATSAPP_SEND_CONFIRMATION_REQUIRED = "0";
  const chatId = "chat-bridge-inline-media@g.us";
  const body = "inline report payload";
  const sent = [];
  const runtime = {
    MessageMedia: {
      fromFilePath(filePath) {
        return { filePath, mimetype: "text/markdown" };
      },
    },
    client: {
      async sendMessage(to, media, options) {
        sent.push({ to, media, options });
        return { id: { _serialized: `true_${chatId}_inline-media` } };
      },
    },
  };
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const distBridge = await import("../dist/server/packages/connectors/src/whatsapp-local-bridge.js");
  distBridge.setLocalWhatsAppRuntimeForTest("responder", runtime, {}, process.env);
  try {
    const response = await fetch(`${baseUrl}/api/connectors/whatsapp/bridge/send-media`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer bridge-inline-secret" },
      body: JSON.stringify({
        accountId: "responder",
        chatId,
        text: "Report attached.",
        attachments: [{
          filename: "report.md",
          mimetype: "text/markdown",
          size: Buffer.byteLength(body),
          sha256: crypto.createHash("sha256").update(body).digest("hex"),
          encoding: "base64",
          data: Buffer.from(body).toString("base64"),
        }],
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.ok, true);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].to, chatId);
    assert.equal(sent[0].media, "Report attached.");
    assert.equal(sent[1].to, chatId);
    assert.equal(sent[1].options.sendMediaAsDocument, true);
    assert.match(sent[1].media.filePath, /whatsapp-bridge\/outbound-media\/bridge-inline\/.+report\.md$/);
    assert.equal(await fs.readFile(sent[1].media.filePath, "utf8"), body);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await distBridge.resetLocalWhatsAppBridgeForTest(process.env);
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
    if (priorAuth === undefined) delete process.env.ORKESTR_AUTH_REQUIRED;
    else process.env.ORKESTR_AUTH_REQUIRED = priorAuth;
    if (priorBridgeToken === undefined) delete process.env.ORKESTR_WHATSAPP_BRIDGE_TOKEN;
    else process.env.ORKESTR_WHATSAPP_BRIDGE_TOKEN = priorBridgeToken;
    if (priorAccountIds === undefined) delete process.env.ORKESTR_WHATSAPP_ACCOUNT_IDS;
    else process.env.ORKESTR_WHATSAPP_ACCOUNT_IDS = priorAccountIds;
    if (priorConfirmation === undefined) delete process.env.ORKESTR_WHATSAPP_SEND_CONFIRMATION_REQUIRED;
    else process.env.ORKESTR_WHATSAPP_SEND_CONFIRMATION_REQUIRED = priorConfirmation;
  }
});

test("whatsapp bridge injection can enter through responder while routing as sender", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-bridge-inject-responder-route-sender-"));
  const priorHome = process.env.ORKESTR_HOME;
  const priorAuth = process.env.ORKESTR_AUTH_REQUIRED;
  const priorBridgeToken = process.env.ORKESTR_WHATSAPP_BRIDGE_TOKEN;
  const priorAccountIds = process.env.ORKESTR_WHATSAPP_ACCOUNT_IDS;
  const priorAutorun = process.env.ORKESTR_WHATSAPP_API_AGENT_AUTORUN;
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  process.env.ORKESTR_WHATSAPP_BRIDGE_TOKEN = "bridge-e2e-secret";
  process.env.ORKESTR_WHATSAPP_ACCOUNT_IDS = "sender,responder";
  process.env.ORKESTR_WHATSAPP_API_AGENT_AUTORUN = "0";
  const chatId = "chat-bridge-inject-route@g.us";
  await createThread({
    id: "bridge-inject-route-thread",
    name: "Bridge Inject Route Thread",
    executorId: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    runtimeKind: "api-agent",
    binding: {
      connector: "whatsapp",
      chatId,
      enabled: true,
      senderAccountId: "sender",
      responderAccountId: "responder",
      outboundAccountId: "responder",
      senderContactId: "sender@lid",
    },
  }, process.env);

  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const distBridge = await import("../dist/server/packages/connectors/src/whatsapp-local-bridge.js");
  distBridge.setLocalWhatsAppRuntimeForTest("responder", { client: {} }, {}, process.env);
  try {
    const injected = await fetch(`${baseUrl}/api/connectors/whatsapp/bridge/inject-message`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer bridge-e2e-secret" },
      body: JSON.stringify({
        accountId: "responder",
        routeAccountId: "sender",
        chatId,
        from: "sender@lid",
        eventId: `false_${chatId}_responder-tool-sender-route`,
        text: "route as sender",
      }),
    });
    const payload = await injected.json();
    const messages = await listThreadMessages("bridge-inject-route-thread", process.env);

    assert.equal(injected.status, 202, JSON.stringify(payload));
    assert.equal(payload.routed.threadId, "bridge-inject-route-thread");
    assert.equal(messages.length, 1);
    assert.equal(messages[0].accountId, "sender");
    assert.equal(messages[0].text, "route as sender");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await distBridge.resetLocalWhatsAppBridgeForTest(process.env);
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
    if (priorAuth === undefined) delete process.env.ORKESTR_AUTH_REQUIRED;
    else process.env.ORKESTR_AUTH_REQUIRED = priorAuth;
    if (priorBridgeToken === undefined) delete process.env.ORKESTR_WHATSAPP_BRIDGE_TOKEN;
    else process.env.ORKESTR_WHATSAPP_BRIDGE_TOKEN = priorBridgeToken;
    if (priorAccountIds === undefined) delete process.env.ORKESTR_WHATSAPP_ACCOUNT_IDS;
    else process.env.ORKESTR_WHATSAPP_ACCOUNT_IDS = priorAccountIds;
    if (priorAutorun === undefined) delete process.env.ORKESTR_WHATSAPP_API_AGENT_AUTORUN;
    else process.env.ORKESTR_WHATSAPP_API_AGENT_AUTORUN = priorAutorun;
  }
});

test("whatsapp inbound route failures record sanitized watcher alerts", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-inbound-watcher-"));
  const priorHome = process.env.ORKESTR_HOME;
  const priorAuth = process.env.ORKESTR_AUTH_REQUIRED;
  const priorWatcherThread = process.env.ORKESTR_WATCHER_THREAD_NAME;
  const priorWatcherDedupe = process.env.ORKESTR_WATCHER_DEDUPE_MS;
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "0";
  process.env.ORKESTR_WATCHER_THREAD_NAME = "test-inbound-watcher";
  process.env.ORKESTR_WATCHER_DEDUPE_MS = "0";
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const failed = await fetch(`${baseUrl}/api/connectors/whatsapp/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chatId: "watcher-chat@g.us",
        accountId: "responder",
        text: "body token=must-not-render",
      }),
    });
    const payload = await failed.json();
    const alerts = await waitForWatcherAlerts(home);
    const watcherThreads = await listThreads({ ORKESTR_HOME: home });
    const watcher = watcherThreads.find((thread) => thread.name === "test-inbound-watcher");
    const messages = watcher ? await listThreadMessages(watcher.id, { ORKESTR_HOME: home }) : [];

    assert.equal(failed.status, 400);
    assert.equal(payload.error, "whatsapp_event_id_required");
    assert.equal(payload.routingFailure.code, "whatsapp_event_id_required");
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0].source, "server.whatsappInbound");
    assert.equal(alerts[0].code, "whatsapp_event_id_required");
    assert.equal(alerts[0].details.connector, "whatsapp");
    assert.equal(alerts[0].details.chatIdPresent, "true");
    assert.equal(alerts[0].details.eventIdPresent, "false");
    assert.equal(alerts[0].details.accountId, "responder");
    assert.equal(messages.length, 1);
    assert.match(messages[0].text, /\[watcher:error\] server\.whatsappInbound/);
    assert.match(messages[0].text, /route: POST \/api\/connectors\/whatsapp\/inbound/);
    assert.doesNotMatch(JSON.stringify(alerts), /must-not-render/);
    assert.doesNotMatch(messages[0].text, /must-not-render/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
    if (priorAuth === undefined) delete process.env.ORKESTR_AUTH_REQUIRED;
    else process.env.ORKESTR_AUTH_REQUIRED = priorAuth;
    if (priorWatcherThread === undefined) delete process.env.ORKESTR_WATCHER_THREAD_NAME;
    else process.env.ORKESTR_WATCHER_THREAD_NAME = priorWatcherThread;
    if (priorWatcherDedupe === undefined) delete process.env.ORKESTR_WATCHER_DEDUPE_MS;
    else process.env.ORKESTR_WATCHER_DEDUPE_MS = priorWatcherDedupe;
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

test("whatsapp delivery suppresses NO_REPLY assistant turns", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-no-reply-"));
  const env = externalBridgeEnv(home);
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, env);
  await createThread({ id: "thread-wa-no-reply", name: "WA No Reply Thread" }, env);
  const parent = await appendThreadMessage("thread-wa-no-reply", {
    role: "user",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    state: "completed",
    deliveryState: "delivered",
    text: "quiet status?",
    chatId: "chat-no-reply",
  }, env);
  const silent = await appendThreadMessage("thread-wa-no-reply", {
    role: "assistant",
    source: "codex-app-server",
    phase: "final_answer",
    state: "completed",
    text: "NO_REPLY",
    parentMessageId: parent.id,
    connector: "whatsapp",
    chatId: "chat-no-reply",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-no-reply"] });
  });
  const messages = await listThreadMessages("thread-wa-no-reply", env);
  const stored = messages.find((message) => message.id === silent.id);

  assert.equal(stored.visibility, "silent");
  assert.equal(stored.silentReason, "no_reply");
  assert.equal(delivery.delivered.length, 0);
  assert.equal(delivery.failed.length, 0);
  assert.equal(calls.length, 0);
});

test("whatsapp remote runtime route forwards inbound input and mirrors queue notice from public router", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-remote-queue-"));
  const env = externalBridgeEnv(home, {
    ORKESTR_WHATSAPP_DEBUG_FOOTER: "0",
    ORKESTR_REMOTE_THREAD_BACKENDS_JSON: JSON.stringify({
      personal: { baseUrl: "http://parent.local", token: "parent-token" },
    }),
  });
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local", apiToken: "wa-token" }, env);
  await createThread({
    id: "public-remote-queue",
    name: "Public Remote Queue",
    binding: {
      connector: "whatsapp",
      chatId: "chat-remote-queue",
      responderAccountId: "responder",
      remoteBackend: "personal",
      remoteThreadId: "parent-thread",
    },
  }, env);
  const parentUser = {
    id: "parent-user-queue",
    role: "user",
    source: "whatsapp_inbound",
    state: "queued",
    deliveryState: "awaiting_active_turn",
    text: "status?",
    chatId: "chat-remote-queue",
    accountId: "responder",
    createdAt: new Date().toISOString(),
  };
  const sendCalls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.host === "parent.local" && parsed.pathname === "/threads/parent-thread/input") {
      assert.equal(options.headers.authorization, "Bearer parent-token");
      assert.equal(JSON.parse(options.body).parseCommands, true);
      return response({ ok: true, message: parentUser });
    }
    if (parsed.host === "parent.local" && parsed.pathname === "/threads/parent-thread/messages") {
      return response({ ok: true, messages: [parentUser] });
    }
    if (parsed.host === "wa.local" && parsed.pathname === "/send-text") {
      sendCalls.push(JSON.parse(options.body));
      return response({ ok: true, ids: ["queue-notice"] });
    }
    throw new Error(`unexpected fetch ${parsed.href}`);
  };

  const routed = await routeWhatsAppInbound({
    eventId: "remote-queue-1",
    chatId: "chat-remote-queue",
    accountId: "responder",
    text: "status?",
  }, env, fetchImpl);
  const delivery = await deliverWhatsAppReplies(env, fetchImpl);
  const messages = await listThreadMessages("public-remote-queue", env);

  assert.equal(routed.remoteRuntime, true);
  assert.equal(messages[0].remoteMessageId, "parent-user-queue");
  assert.equal(messages[0].deliveryState, "awaiting_active_turn");
  assert.equal(delivery.delivered.length, 1);
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].to, "chat-remote-queue");
  assert.match(sendCalls[0].text, /^Added after the current Codex turn/);
});

test("whatsapp remote runtime imports parent replies and mirrors them once through public bridge", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-remote-reply-"));
  const env = externalBridgeEnv(home, {
    ORKESTR_WHATSAPP_DEBUG_FOOTER: "0",
    ORKESTR_REMOTE_THREAD_BACKENDS_JSON: JSON.stringify({
      personal: { baseUrl: "http://parent.local", token: "parent-token" },
    }),
  });
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local", apiToken: "wa-token" }, env);
  await createThread({
    id: "public-remote-reply",
    name: "Public Remote Reply",
    binding: {
      connector: "whatsapp",
      chatId: "chat-remote-reply",
      responderAccountId: "responder",
      remoteBackend: "personal",
      remoteThreadId: "parent-thread",
    },
  }, env);
  const parentUser = {
    id: "parent-user-reply",
    role: "user",
    source: "whatsapp_inbound",
    state: "queued",
    deliveryState: "awaiting_active_turn",
    text: "status?",
    chatId: "chat-remote-reply",
    accountId: "responder",
    createdAt: new Date().toISOString(),
  };
  const parentUserDelivered = {
    ...parentUser,
    state: "completed",
    deliveryState: "delivered",
    deliveredAt: new Date().toISOString(),
  };
  const parentReply = {
    id: "parent-assistant-reply",
    role: "assistant",
    source: "codex-app-server",
    phase: "final_answer",
    state: "completed",
    parentMessageId: "parent-user-reply",
    text: "Parent runtime answer.",
    chatId: "chat-remote-reply",
    createdAt: new Date().toISOString(),
  };
  const sendCalls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.host === "parent.local" && parsed.pathname === "/threads/parent-thread/input") {
      return response({ ok: true, message: parentUser });
    }
    if (parsed.host === "parent.local" && parsed.pathname === "/threads/parent-thread/messages") {
      return response({ ok: true, messages: [parentUserDelivered, parentReply] });
    }
    if (parsed.host === "wa.local" && parsed.pathname === "/send-text") {
      sendCalls.push(JSON.parse(options.body));
      return response({ ok: true, ids: [`sent-${sendCalls.length}`] });
    }
    throw new Error(`unexpected fetch ${parsed.href}`);
  };

  await routeWhatsAppInbound({
    eventId: "remote-reply-1",
    chatId: "chat-remote-reply",
    accountId: "responder",
    text: "status?",
  }, env, fetchImpl);
  const delivery = await deliverWhatsAppReplies(env, fetchImpl);
  const duplicate = await deliverWhatsAppReplies(env, fetchImpl);
  const messages = await listThreadMessages("public-remote-reply", env);
  const imported = messages.find((message) => message.remoteMessageId === "parent-assistant-reply");

  assert.equal(delivery.delivered.length, 1);
  assert.equal(duplicate.delivered.length, 0);
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].to, "chat-remote-reply");
  assert.match(sendCalls[0].text, /Parent runtime answer/);
  assert.equal(imported.parentMessageId, messages[0].id);
});

test("whatsapp remote runtime stages parent attachments and sends them as media", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-remote-attachment-"));
  const env = externalBridgeEnv(home, {
    ORKESTR_WHATSAPP_DEBUG_FOOTER: "0",
    ORKESTR_REMOTE_THREAD_BACKENDS_JSON: JSON.stringify({
      personal: { baseUrl: "http://parent.local", token: "parent-token" },
    }),
  });
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local", apiToken: "wa-token" }, env);
  await createThread({
    id: "public-remote-attachment",
    name: "Public Remote Attachment",
    binding: {
      connector: "whatsapp",
      chatId: "chat-remote-attachment",
      responderAccountId: "responder",
      remoteBackend: "personal",
      remoteThreadId: "parent-thread",
    },
  }, env);
  const parentUser = {
    id: "parent-user-attachment",
    role: "user",
    source: "whatsapp_inbound",
    state: "completed",
    deliveryState: "delivered",
    text: "make a one-pager",
    chatId: "chat-remote-attachment",
    accountId: "responder",
    createdAt: new Date().toISOString(),
  };
  const parentReply = {
    id: "parent-assistant-attachment",
    role: "assistant",
    source: "codex-app-server",
    phase: "final_answer",
    state: "completed",
    parentMessageId: "parent-user-attachment",
    text: "Prepared it here: [PROJECT_ONE_PAGER.md](/workspace/thread/PROJECT_ONE_PAGER.md).",
    chatId: "chat-remote-attachment",
    createdAt: new Date().toISOString(),
    attachments: [{
      id: "remote-doc",
      filename: "PROJECT_ONE_PAGER.md",
      mimetype: "text/markdown",
      size: 22,
      downloadUrl: "/api/threads/parent-thread/attachments/remote-doc/download",
    }],
  };
  const sendCalls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.host === "parent.local" && parsed.pathname === "/threads/parent-thread/input") {
      return response({ ok: true, message: parentUser });
    }
    if (parsed.host === "parent.local" && parsed.pathname === "/threads/parent-thread/messages") {
      return response({ ok: true, messages: [parentUser, parentReply] });
    }
    if (parsed.host === "parent.local" && parsed.pathname === "/api/threads/parent-thread/attachments/remote-doc/download") {
      assert.equal(options.headers.authorization, "Bearer parent-token");
      return binaryResponse("# Project one-pager\n", { "content-type": "text/markdown" });
    }
    if (parsed.host === "wa.local" && parsed.pathname === "/send-media") {
      sendCalls.push(JSON.parse(options.body));
      return response({ ok: true, ids: ["sent-text", "sent-doc"] });
    }
    throw new Error(`unexpected fetch ${parsed.href}`);
  };

  await routeWhatsAppInbound({
    eventId: "remote-attachment-1",
    chatId: "chat-remote-attachment",
    accountId: "responder",
    text: "make a one-pager",
  }, env, fetchImpl);
  const delivery = await deliverWhatsAppReplies(env, fetchImpl);
  const duplicate = await deliverWhatsAppReplies(env, fetchImpl);
  const messages = await listThreadMessages("public-remote-attachment", env);
  const imported = messages.find((message) => message.remoteMessageId === "parent-assistant-attachment");

  assert.equal(delivery.delivered.length, 1);
  assert.equal(duplicate.delivered.length, 0);
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].to, "chat-remote-attachment");
  assert.equal(sendCalls[0].paths.length, 1);
  assert.match(sendCalls[0].paths[0], /whatsapp-bridge\/outbound-media\/remote-artifacts/);
  assert.equal(await fs.readFile(sendCalls[0].paths[0], "utf8"), "# Project one-pager\n");
  assert.equal(imported.attachments.length, 1);
  assert.equal(imported.attachments[0].remoteAttachmentId, "remote-doc");
  assert.equal(imported.attachments[0].filename, "PROJECT_ONE_PAGER.md");
  assert.equal(imported.attachments[0].path, sendCalls[0].paths[0]);
});

test("whatsapp remote runtime reports missing parent attachments instead of silently dropping them", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-remote-attachment-missing-"));
  const env = externalBridgeEnv(home, {
    ORKESTR_WHATSAPP_DEBUG_FOOTER: "0",
    ORKESTR_REMOTE_THREAD_BACKENDS_JSON: JSON.stringify({
      personal: { baseUrl: "http://parent.local", token: "parent-token" },
    }),
  });
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local", apiToken: "wa-token" }, env);
  await createThread({
    id: "public-remote-attachment-missing",
    name: "Public Remote Attachment Missing",
    binding: {
      connector: "whatsapp",
      chatId: "chat-remote-attachment-missing",
      responderAccountId: "responder",
      remoteBackend: "personal",
      remoteThreadId: "parent-thread",
    },
  }, env);
  const parentUser = {
    id: "parent-user-missing-attachment",
    role: "user",
    source: "whatsapp_inbound",
    state: "completed",
    deliveryState: "delivered",
    text: "make a one-pager",
    chatId: "chat-remote-attachment-missing",
    accountId: "responder",
    createdAt: new Date().toISOString(),
  };
  const parentReply = {
    id: "parent-assistant-missing-attachment",
    role: "assistant",
    source: "codex-app-server",
    phase: "final_answer",
    state: "completed",
    parentMessageId: "parent-user-missing-attachment",
    text: "Prepared the one-pager.",
    chatId: "chat-remote-attachment-missing",
    createdAt: new Date().toISOString(),
    attachments: [{
      id: "remote-missing",
      filename: "missing.md",
      mimetype: "text/markdown",
      size: 12,
      downloadUrl: "/api/threads/parent-thread/attachments/remote-missing/download",
    }],
  };
  const sendCalls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.host === "parent.local" && parsed.pathname === "/threads/parent-thread/input") {
      return response({ ok: true, message: parentUser });
    }
    if (parsed.host === "parent.local" && parsed.pathname === "/threads/parent-thread/messages") {
      return response({ ok: true, messages: [parentUser, parentReply] });
    }
    if (parsed.host === "parent.local" && parsed.pathname.includes("/attachments/remote-missing/download")) {
      return response({ ok: false, error: "missing" }, false, 404);
    }
    if (parsed.host === "wa.local" && parsed.pathname === "/send-text") {
      sendCalls.push(JSON.parse(options.body));
      return response({ ok: true, ids: ["sent-missing-note"] });
    }
    throw new Error(`unexpected fetch ${parsed.href}`);
  };

  await routeWhatsAppInbound({
    eventId: "remote-attachment-missing-1",
    chatId: "chat-remote-attachment-missing",
    accountId: "responder",
    text: "make a one-pager",
  }, env, fetchImpl);
  const delivery = await deliverWhatsAppReplies(env, fetchImpl);

  assert.equal(delivery.delivered.length, 1);
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].paths, undefined);
  assert.match(sendCalls[0].text, /Attachment not sent:/);
  assert.match(sendCalls[0].text, /missing\.md: missing/);
});

test("whatsapp delivery skips outbound replies while an active persisted claim exists", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-claim-active-"));
  const env = externalBridgeEnv(home, {
    ORKESTR_WHATSAPP_DEBUG_FOOTER: "0",
    ORKESTR_WHATSAPP_OUTBOUND_CLAIM_TTL_MS: "60000",
  });
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, env);
  await routeWhatsAppInbound(
    { eventId: "wa-claim-active-1", agentId: "agent-claim-active", chatId: "chat-claim-active", accountId: "main", text: "status?" },
    env,
  );
  await runNextAgentMessage("agent-claim-active", { executorId: "noop" }, env);

  const text = "No-op executor received 7 characters.";
  const reply = (await listAgentMessages("agent-claim-active", env)).find((message) => message.role === "assistant");
  const textKey = testFinalDeliveryTextKey("chat-claim-active", reply, text);
  const now = Date.now();
  await writeTestDeliveryClaim(home, {
    accountId: "main",
    chatId: "chat-claim-active",
    textKey,
    claimedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 60_000).toISOString(),
  });

  const delivery = await deliverWhatsAppReplies(env, async () => {
    throw new Error("active delivery claim should block duplicate send");
  });

  assert.equal(delivery.delivered.length, 0);
  assert.equal(delivery.failed.length, 0);
  assert.equal(delivery.skipped.some((item) => item.reason === "delivery_claim_active"), true);
});

test("whatsapp delivery expires stale outbound claims before sending", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-claim-stale-"));
  const env = externalBridgeEnv(home, {
    ORKESTR_WHATSAPP_DEBUG_FOOTER: "0",
    ORKESTR_WHATSAPP_OUTBOUND_CLAIM_TTL_MS: "5000",
  });
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, env);
  await routeWhatsAppInbound(
    { eventId: "wa-claim-stale-1", agentId: "agent-claim-stale", chatId: "chat-claim-stale", accountId: "main", text: "status?" },
    env,
  );
  await runNextAgentMessage("agent-claim-stale", { executorId: "noop" }, env);

  const text = "No-op executor received 7 characters.";
  const reply = (await listAgentMessages("agent-claim-stale", env)).find((message) => message.role === "assistant");
  const textKey = testFinalDeliveryTextKey("chat-claim-stale", reply, text);
  const old = Date.now() - 60_000;
  const { filePath } = await writeTestDeliveryClaim(home, {
    accountId: "main",
    chatId: "chat-claim-stale",
    textKey,
    claimedAt: new Date(old).toISOString(),
    expiresAt: new Date(old + 1_000).toISOString(),
  });

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-after-stale-claim"] });
  });
  const state = JSON.parse(await fs.readFile(path.join(home, "whatsapp.json"), "utf8"));

  assert.equal(delivery.delivered.length, 1);
  assert.equal(delivery.failed.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.to, "chat-claim-stale");
  assert.equal(calls[0].body.text, text);
  await assert.rejects(fs.stat(filePath), /ENOENT/);
  assert.equal(state.outboundDeliveries.some((item) => item.textKey === textKey), true);
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
  const inboundMediaDir = path.join(dataPaths(env).home, "whatsapp-bridge", "inbound-media", "test");
  await fs.mkdir(inboundMediaDir, { recursive: true });
  const inboundImagePath = path.join(inboundMediaDir, "thread-image.jpg");
  await fs.writeFile(inboundImagePath, "image", "utf8");

  const routed = await routeWhatsAppInbound({
    eventId: "wa-thread-1",
    chatId: "chat-thread",
    text: "thread status?",
    attachments: [{ kind: "image", path: inboundImagePath, filename: "thread-image.jpg", mimetype: "image/jpeg" }],
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
  assert.equal(messages[0].attachments[0].path, inboundImagePath);
  assert.equal(messages[0].attachments[0].filename, "thread-image.jpg");
  assert.equal(Boolean(messages[0].routerTraceId), true);
  assert.equal(messages[1].routerTraceId, messages[0].routerTraceId);
  assert.equal(delivery.delivered.length, 1);
  assert.equal(duplicate.delivered.length, 0);
  assert.equal(calls[0].url.pathname, "/send-text");
  assert.equal(calls[0].body.to, "chat-thread");
  const traces = await listRouterTraces({ threadId: "thread-wa" }, env);
  assert.equal(traces.length, 1);
  assert.equal(traces[0].routerTraceId, messages[0].routerTraceId);
  assert.equal(traces[0].currentPhase, "completed");
  assert.equal(traces[0].phases.some((phase) => phase.phase === "received"), true);
  assert.equal(traces[0].phases.some((phase) => phase.phase === "mirror_sent"), true);
});

test("whatsapp inbound ignores fromMe attachment echoes already sent by the responder", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-thread-attachment-echo-"));
  const env = externalBridgeEnv(home);
  const paths = dataPaths(env);
  const uploadDir = path.join(paths.home, "uploads", "thread-wa-echo");
  await fs.mkdir(uploadDir, { recursive: true });
  const reportPath = path.join(uploadDir, "report.csv");
  await fs.writeFile(reportPath, "report payload", "utf8");
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-thread-echo": "thread-wa-echo" },
  }, env);
  await createThread({
    id: "thread-wa-echo",
    name: "WA Echo Thread",
    binding: {
      connector: "whatsapp",
      chatId: "chat-thread-echo",
      responderAccountId: "responder",
      outboundAccountId: "responder",
      mirrorToWhatsApp: true,
    },
  }, env);
  const parent = await appendThreadMessage("thread-wa-echo", {
    role: "user",
    source: "whatsapp_inbound",
    state: "completed",
    connector: "whatsapp",
    chatId: "chat-thread-echo",
    accountId: "responder",
    text: "send the report",
  }, env);
  await appendThreadMessage("thread-wa-echo", {
    role: "assistant",
    source: "codex-app-server",
    phase: "final_answer",
    state: "completed",
    parentMessageId: parent.id,
    chatId: "chat-thread-echo",
    accountId: "responder",
    text: `Report attached: ${reportPath}`,
  }, env);

  const sentAttachmentId = "true_chat-thread-echo_sent-report";
  await deliverWhatsAppReplies(env, async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(new URL(url).pathname, "/send-media");
    assert.equal(body.to, "chat-thread-echo");
    return response({
      ok: true,
      ids: ["true_chat-thread-echo_sent-text", sentAttachmentId],
      sent: [
        { id: "true_chat-thread-echo_sent-text", kind: "text" },
        { id: sentAttachmentId, kind: "attachment", path: reportPath, filename: "report.csv" },
      ],
    });
  });

  const routed = await routeWhatsAppInbound({
    eventId: sentAttachmentId,
    chatId: "chat-thread-echo",
    accountId: "responder",
    from: "responder@lid",
    fromMe: true,
    text: "WhatsApp attachment received.",
    attachments: [{ path: reportPath, filename: "report.csv", mimetype: "text/csv" }],
  }, env);
  const messages = await listThreadMessages("thread-wa-echo", env);
  const traces = await listRouterTraces({ threadId: "thread-wa-echo" }, env);

  assert.equal(routed.skipped, "outbound_echo_delivery_ack");
  assert.equal(routed.threadId, "thread-wa-echo");
  assert.equal(messages.some((message) => message.externalId === sentAttachmentId), false);
  assert.equal(messages.filter((message) => message.role === "user").length, 1);
  assert.equal(traces.some((trace) =>
    trace.routerTraceId === routed.event.routerTraceId &&
    trace.phases.some((phase) => phase.reason === "outbound_echo_delivery_ack")
  ), true);
});

test("whatsapp inbound ignores fromMe text echoes with rewritten message ids", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-thread-text-echo-"));
  const env = externalBridgeEnv(home);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-thread-text-echo": "thread-wa-text-echo" },
  }, env);
  await createThread({
    id: "thread-wa-text-echo",
    name: "WA Text Echo Thread",
    binding: {
      connector: "whatsapp",
      chatId: "chat-thread-text-echo",
      responderAccountId: "responder",
      outboundAccountId: "responder",
      mirrorToWhatsApp: true,
    },
  }, env);
  const parent = await appendThreadMessage("thread-wa-text-echo", {
    role: "user",
    source: "whatsapp_inbound",
    state: "completed",
    connector: "whatsapp",
    chatId: "chat-thread-text-echo",
    accountId: "responder",
    text: "status please",
  }, env);
  await appendThreadMessage("thread-wa-text-echo", {
    role: "assistant",
    source: "codex-app-server",
    phase: "final_answer",
    state: "completed",
    parentMessageId: parent.id,
    chatId: "chat-thread-text-echo",
    accountId: "responder",
    text: "Done. I pushed the fix.",
  }, env);

  await deliverWhatsAppReplies(env, async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(new URL(url).pathname, "/send-text");
    assert.equal(body.to, "chat-thread-text-echo");
    assert.match(body.text, /^Done\. I pushed the fix\./);
    return response({ ok: true, ids: ["true_chat-thread-text-echo_sent-original"] });
  });

  const routed = await routeWhatsAppInbound({
    eventId: "true_chat-thread-text-echo_echo-rewritten",
    chatId: "chat-thread-text-echo",
    accountId: "responder",
    from: "responder@lid",
    fromMe: true,
    text: "Done. I pushed the fix.",
  }, env);
  const messages = await listThreadMessages("thread-wa-text-echo", env);
  const traces = await listRouterTraces({ threadId: "thread-wa-text-echo" }, env);

  assert.equal(routed.skipped, "outbound_echo_delivery_text");
  assert.equal(routed.threadId, "thread-wa-text-echo");
  assert.equal(routed.event.ignoredReason, "outbound_echo_delivery_text");
  assert.equal(messages.some((message) => message.externalId === "true_chat-thread-text-echo_echo-rewritten"), false);
  assert.equal(messages.filter((message) => message.role === "user").length, 1);
  assert.equal(traces.some((trace) =>
    trace.routerTraceId === routed.event.routerTraceId &&
    trace.phases.some((phase) => phase.reason === "outbound_echo_delivery_text")
  ), true);
});

test("whatsapp inbound ignores fromMe text echoes from delivered connector outbox jobs", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-thread-outbox-text-echo-"));
  const env = externalBridgeEnv(home);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-thread-outbox-text-echo": "thread-wa-outbox-text-echo" },
  }, env);
  await createThread({
    id: "thread-wa-outbox-text-echo",
    name: "WA Outbox Text Echo Thread",
    binding: {
      connector: "whatsapp",
      chatId: "chat-thread-outbox-text-echo",
      responderAccountId: "responder",
      outboundAccountId: "responder",
      mirrorToWhatsApp: true,
    },
  }, env);
  await writeConnectorOutbox({
    schemaVersion: 1,
    jobs: [{
      id: "co-wa-outbox-text-echo",
      connector: "whatsapp",
      state: "delivered",
      chatId: "chat-thread-outbox-text-echo",
      accountId: "responder",
      threadId: "thread-wa-outbox-text-echo",
      sourceMessageId: "assistant-outbox-text-echo",
      deliveryType: "final",
      payload: { text: "Delivered from the connector outbox." },
      deliveredAt: new Date().toISOString(),
      brokerAck: { ids: ["true_chat-thread-outbox-text-echo_sent-original"] },
    }],
  }, env);

  const routed = await routeWhatsAppInbound({
    eventId: "true_chat-thread-outbox-text-echo_echo-rewritten",
    chatId: "chat-thread-outbox-text-echo",
    accountId: "responder",
    from: "responder@lid",
    fromMe: true,
    text: "Delivered from the connector outbox.",
  }, env);
  const messages = await listThreadMessages("thread-wa-outbox-text-echo", env);
  const traces = await listRouterTraces({ threadId: "thread-wa-outbox-text-echo" }, env);

  assert.equal(routed.skipped, "outbound_echo_delivery_text");
  assert.equal(routed.threadId, "thread-wa-outbox-text-echo");
  assert.equal(routed.event.connectorOutboxJobId, "co-wa-outbox-text-echo");
  assert.equal(messages.length, 0);
  assert.equal(traces.some((trace) =>
    trace.routerTraceId === routed.event.routerTraceId &&
    trace.phases.some((phase) => phase.reason === "outbound_echo_delivery_text")
  ), true);
});

test("whatsapp router ignores cross-account outbound attachment delivery acks", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-router-cross-account-attachment-echo-"));
  const env = externalBridgeEnv(home);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-router-cross-account-echo": "thread-router-cross-account-echo" },
  }, env);
  await createThread({
    id: "thread-router-cross-account-echo",
    name: "WA Router Cross Account Echo Thread",
    binding: {
      connector: "whatsapp",
      chatId: "chat-router-cross-account-echo",
      senderAccountId: "sender",
      responderAccountId: "responder",
      outboundAccountId: "responder",
      mirrorToWhatsApp: true,
    },
  }, env);
  const paths = dataPaths(env);
  await fs.mkdir(paths.home, { recursive: true });
  await fs.writeFile(path.join(paths.home, "whatsapp.json"), JSON.stringify({
    inboundEvents: [],
    outboundDeliveries: [{
      kind: "thread",
      deliveryType: "final",
      threadId: "thread-router-cross-account-echo",
      messageId: "assistant-report",
      chatId: "chat-router-cross-account-echo",
      accountId: "responder",
      deliveredAt: "2026-06-11T12:00:00.000Z",
      bridgeResponse: {
        sent: [
          {
            id: "true_chat-router-cross-account-echo_sent-report",
            kind: "attachment",
            filename: "report.csv",
          },
        ],
      },
    }],
    outboundDeliveryClaims: [],
    outboundIntents: [],
  }, null, 2), "utf8");

  const routed = await routeWhatsAppInbound({
    eventId: "false_chat-router-cross-account-echo_sent-report",
    chatId: "chat-router-cross-account-echo",
    accountId: "sender",
    from: "responder@c.us",
    fromMe: false,
    text: "WhatsApp attachment received.",
    attachments: [{ filename: "report.csv", mimetype: "text/csv" }],
  }, env);
  const messages = await listThreadMessages("thread-router-cross-account-echo", env);
  const traces = await listRouterTraces({ threadId: "thread-router-cross-account-echo" }, env);

  assert.equal(routed.skipped, "outbound_echo_delivery_ack");
  assert.equal(routed.threadId, "thread-router-cross-account-echo");
  assert.equal(messages.length, 0);
  assert.equal(traces.some((trace) =>
    trace.routerTraceId === routed.event.routerTraceId &&
    trace.phases.some((phase) => phase.reason === "outbound_echo_delivery_ack")
  ), true);
});

test("whatsapp explicit approve command is local when no Codex approval is pending", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-approval-no-pending-"));
  const env = externalBridgeEnv(home);
  await createThread({
    id: "thread-wa-approval-no-pending",
    name: "WA Approval No Pending",
    executorId: "codex",
    runtimeKind: "codex-app-server",
    codexThreadId: "codex-wa-approval-no-pending",
    executor: {
      type: "codex",
      transport: "app-server",
      codexThreadId: "codex-wa-approval-no-pending",
    },
    runtime: {
      runtimeKind: "codex-app-server",
      state: "ready",
      codexStatus: { type: "idle" },
    },
  }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-approval-no-pending": "thread-wa-approval-no-pending" },
  }, env);

  const routed = await routeWhatsAppInbound({
    eventId: "wa-approval-no-pending-1",
    chatId: "chat-approval-no-pending",
    accountId: "responder",
    text: "/approve",
  }, env);
  const messages = await listThreadMessages("thread-wa-approval-no-pending", env);
  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, body: JSON.parse(options.body) });
  });

  assert.equal(routed.reason, "no_pending_request");
  assert.equal(routed.message.state, "completed");
  assert.equal(routed.message.deliveryState, "ignored");
  assert.equal(messages.filter((message) => message.role === "user" && message.state === "queued").length, 0);
  assert.equal(messages[0].observedVia, "whatsapp_codex_app_server_approval_not_pending");
  assert.match(messages[1].text, /No Codex approval request is pending/);
  assert.equal(delivery.delivered.length, 1);
  assert.match(calls[0].body.text, /No Codex approval request is pending/);
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
    from: "wa-contact-sample@c.us",
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
  assert.equal(thread.binding.senderContactId, "wa-contact-sample@c.us");
  assert.equal(thread.binding.outboundAccountId, "main");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].ownerUserId, thread.ownerUserId);
  assert.equal(messages[0].state, "queued");

  const routedAgain = await routeWhatsAppInbound({
    eventId: "wa-auto-user-2",
    chatId: "chat-auto-user",
    accountId: "main",
    from: "wa-contact-sample@c.us",
    text: "second message",
  }, env);
  const messagesAfter = await listThreadMessages(routed.threadId, env);
  const threads = await listThreads(env);

  assert.equal(routedAgain.threadId, routed.threadId);
  assert.equal(routedAgain.autoProvisioned, false);
  assert.equal(messagesAfter.length, 2);
  assert.deepEqual(threads.map((entry) => entry.id), [routed.threadId]);
});

test("local whatsapp bridge runs api-agent tenant chats without waking legacy runtime", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-api-agent-local-"));
  const chatId = "wa-group-alpha@g.us";
  const env = await externalBridgeEnvWithAllowingSanitizer(home, {
    OPENAI_API_KEY: "sk-test",
    ORKESTR_WHATSAPP_API_AGENT_AUTORUN: "1",
    ORKESTR_WHATSAPP_DEBUG_FOOTER: "0",
  });
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, env);
  await createThread({
    id: "otcantest",
    name: "otcantest",
    ownerUserId: "otcan",
    runtimeKind: "api-agent",
    executorId: "api-agent",
    executor: {
      id: "api-agent",
      type: "api-agent",
      transport: "api-agent",
      metadata: { runtimeKind: "api-agent", transport: "api-agent" },
    },
    binding: {
      connector: "whatsapp",
      chatId,
      displayName: "otcantest",
      enabled: true,
      generated: true,
      allowOtherPeople: false,
      mirrorToWhatsApp: true,
      senderAccountId: "responder",
      responderAccountId: "responder",
      outboundAccountId: "responder",
      senderContactId: "wa-lid-primary@lid",
      responderContactId: "wa-contact-tenant@c.us",
    },
  }, env);

  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const entry = {
      url: String(url),
      body: options.body ? JSON.parse(String(options.body)) : null,
    };
    calls.push(entry);
    if (entry.url.endsWith("/responses")) {
      return response({
        id: "resp_local_bridge_api_agent",
        model: "gpt-5-mini",
        output_text: "Hi! How can I help you today?",
        output: [],
        usage: { input_tokens: 120, output_tokens: 8 },
      });
    }
    if (entry.url.endsWith("/send-text")) {
      return response({ ok: true, ids: ["sent-local-api-agent"] });
    }
    throw new Error(`unexpected fetch ${entry.url}`);
  };

  let routed;
  try {
    routed = await handleInboundMessage("responder", {
      id: { _serialized: `false_${chatId}_3AB09B996787296175FB_wa-lid-primary@lid`, remote: chatId },
      from: chatId,
      author: "wa-lid-primary@lid",
      fromMe: false,
      body: "Hi",
      timestamp: 1_780_000_000,
    }, env);
  } finally {
    globalThis.fetch = originalFetch;
  }
  await new Promise((resolve) => setTimeout(resolve, 20));

  const messages = await listThreadMessages("otcantest", env);
  const events = await listEvents(env, 50);
  const user = messages.find((message) => message.role === "user");
  const assistant = messages.find((message) => message.role === "assistant");

  assert.equal(routed.routed.runtimeKind, "api-agent");
  assert.equal(messages.length, 2);
  assert.equal(user.text, "Hi");
  assert.equal(user.state, "completed");
  assert.equal(user.deliveryState, "delivered");
  assert.equal(user.observedVia, "api_agent_response");
  assert.equal(assistant.source, "api-agent");
  assert.equal(assistant.text, "Hi! How can I help you today?");
  assert.deepEqual((await listRuntimeLeases(env)).map((lease) => lease.threadId), []);
  assert.equal(events.some((event) => event.type === "runtime_woken" && event.threadId === "otcantest"), false);
  assert.equal(events.some((event) => event.type === "thread_input_delivery_deferred" && event.threadId === "otcantest"), false);
  assert.equal(events.some((event) => event.type === "thread_input_delivery_skipped" && event.threadId === "otcantest"), false);
  assert.equal(calls.some((call) => call.url.endsWith("/responses")), true);
  const sendCalls = calls.filter((call) => call.url.endsWith("/send-text") && call.body?.to === chatId);
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].body.text, "Hi! How can I help you today?");
});

test("local whatsapp inbound failures explain missing user capabilities", () => {
  const gmail = inboundRoutingFailureNoticeText(new Error("gmail capability missing"));
  const desktop = inboundRoutingFailureNoticeText(new Error("desktop capability false"));
  const timer = inboundRoutingFailureNoticeText(Object.assign(new Error("timer capability false"), {
    routingFailure: { code: "timer_capability_unavailable", capability: "timers", userFacingCategory: "timer" },
  }));
  const unhealthy = inboundRoutingFailureNoticeText(Object.assign(new Error("target_instance_unhealthy"), {
    routingFailure: { code: "target_instance_unhealthy", userFacingCategory: "instance_health", retryable: true },
  }));
  const routeWriteDenied = inboundRoutingFailureNoticeText(Object.assign(new Error("whatsapp_inbound_route_failed"), {
    routingFailure: {
      code: "whatsapp_inbound_route_failed",
      reason: "EACCES: permission denied, open '[redacted-path]'",
      userFacingCategory: "connector",
      safeMessage: "Target instance could not accept the brokered WhatsApp message.",
    },
  }));
  const token = inboundRoutingFailureNoticeText(Object.assign(new Error("whatsapp_inbound_token_invalid"), {
    routingFailure: {
      code: "whatsapp_inbound_token_invalid",
      userFacingCategory: "connector",
      safeMessage: "Target instance rejected the broker WhatsApp inbound token.",
    },
  }));
  const senderDenied = inboundRoutingFailureNoticeText(Object.assign(new Error("whatsapp_inbound_sender_denied"), {
    routingFailure: {
      code: "whatsapp_inbound_sender_denied",
      reason: "unknown_sender",
      userFacingCategory: "connector",
      safeMessage: "This WhatsApp sender is not allowed to control this Orkestr chat.",
    },
  }));
  const target = inboundRoutingFailureNoticeText(new Error("whatsapp_target_required"));
  const pairing = inboundRoutingFailureNoticeText(new Error("browser_pairing_required"), {
    env: { ORKESTR_PUBLIC_SITE_URL: "https://orkestr.example.test/" },
  });
  const tenantCodex = inboundRoutingFailureNoticeText(Object.assign(new Error("target_codex_not_configured"), {
    routingFailure: {
      code: "target_codex_not_configured",
      userFacingCategory: "codex",
      appUrl: "https://connect.example.test/i/firat-jobs-vm/app",
      setupUrl: "https://connect.example.test/i/firat-jobs-vm/setup",
    },
  }));
  const tenantPairing = inboundRoutingFailureNoticeText(new Error("browser_pairing_required"), {
    env: {
      ORKESTR_TENANT_VM_ID: "firat-jobs-vm",
      ORKESTR_CONNECT_PUBLIC_URL: "https://connect.example.test",
      ORKESTR_PUBLIC_SITE_URL: "http://0.0.0.0:21050",
    },
  });

  assert.match(gmail, /Gmail is not connected or enabled for this chat yet/i);
  assert.doesNotMatch(gmail, /safely handle|private connector|account identity/i);
  assert.match(desktop, /managed desktop is not connected or enabled/i);
  assert.doesNotMatch(desktop, /safely handle|private connector|account identity/i);
  assert.match(timer, /Timers are not available/i);
  assert.doesNotMatch(timer, /safely handle|private connector|account identity|admin/i);
  assert.match(unhealthy, /temporarily unavailable/i);
  assert.doesNotMatch(unhealthy, /safely handle|private connector|account identity|admin/i);
  assert.match(routeWriteDenied, /could not write its local chat state/i);
  assert.doesNotMatch(routeWriteDenied, /missing a required Orkestr capability|connector setup/i);
  assert.match(token, /target Orkestr instance rejected or is missing the broker WhatsApp token/i);
  assert.equal(senderDenied, "This WhatsApp sender is not allowed to control this Orkestr chat.");
  assert.doesNotMatch(senderDenied, /missing a required Orkestr capability|connector setup/i);
  assert.match(target, /not connected to a thread/i);
  assert.doesNotMatch(target, /safely handle|private connector|account identity/i);
  assert.match(pairing, /needs browser pairing approval/i);
  assert.doesNotMatch(pairing, /browser_pairing_required/);
  assert.match(pairing, /https:\/\/orkestr\.example\.test\//);
  assert.match(tenantCodex, /https:\/\/connect\.example\.test\/i\/firat-jobs-vm\/app/);
  assert.doesNotMatch(tenantCodex, /\/setup/);
  assert.doesNotMatch(tenantCodex, /0\.0\.0\.0|127\.0\.0\.1|localhost|10\./);
  assert.match(tenantPairing, /https:\/\/connect\.example\.test\/i\/firat-jobs-vm\/app/);
  assert.doesNotMatch(tenantPairing, /0\.0\.0\.0|127\.0\.0\.1|localhost|10\./);
});

test("local whatsapp inbound stays silent for unbound chats", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-unbound-silent-"));
  const env = externalBridgeEnv(home);
  const sent = [];
  const client = {
    async sendMessage(chatId, text) {
      sent.push({ chatId, text });
      return { id: { _serialized: "sent-unbound-notice" }, body: text };
    },
  };

  const result = await handleInboundMessage("responder", {
    id: { _serialized: "false_unknown-chat@g.us_3AB0UNBOUND_semra@c.us", remote: "unknown-chat@g.us" },
    from: "unknown-chat@g.us",
    author: "semra@c.us",
    fromMe: false,
    body: "hello?",
    timestamp: 1_780_000_000,
  }, env, { client });
  const events = await listEvents(env, 20);
  const failed = events.find((event) => event.type === "whatsapp_local_inbound_failed");

  assert.equal(result.error, "whatsapp_target_required");
  assert.equal(result.routingFailure.code, "whatsapp_target_required");
  assert.equal(result.noticeSent, false);
  assert.equal(result.noticeReason, "routing_failure_not_user_notifiable");
  assert.deepEqual(sent, []);
  assert.equal(failed?.noticeSent, false);
  assert.equal(failed?.noticeReason, "routing_failure_not_user_notifiable");
});

test("local whatsapp inbound warns source chat when binding is disabled", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-disabled-binding-notice-"));
  const env = externalBridgeEnv(home, {
    ORKESTR_WHATSAPP_SEND_CONFIRMATION_REQUIRED: "0",
  });
  const sent = [];
  const client = {
    async sendMessage(chatId, text) {
      sent.push({ chatId, text });
      return { id: { _serialized: "sent-disabled-binding-notice" }, body: text };
    },
  };
  await createThread({
    id: "disabled-notice-thread",
    name: "Disabled Notice Thread",
    binding: {
      connector: "whatsapp",
      chatId: "disabled-notice-chat@g.us",
      displayName: "Disabled Notice Chat",
      enabled: false,
      routeEligible: true,
      responderAccountId: "responder",
      outboundAccountId: "responder",
    },
  }, env);

  const result = await handleInboundMessage("responder", {
    id: { _serialized: "false_disabled-notice-chat@g.us_3AB0DISABLED_semra@c.us", remote: "disabled-notice-chat@g.us" },
    from: "disabled-notice-chat@g.us",
    author: "semra@c.us",
    fromMe: false,
    body: "hello disabled binding",
    timestamp: 1_780_000_001,
  }, env, { client });
  const messages = await listThreadMessages("disabled-notice-thread", env);

  assert.equal(result.routed.ignoredDisabledBinding, true);
  assert.equal(result.noticeSent, true);
  assert.equal(result.routingFailure.code, "whatsapp_binding_disabled");
  assert.equal(messages.length, 0);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chatId, "disabled-notice-chat@g.us");
  assert.match(sent[0].text, /inbound messages are currently disabled/i);
  assert.match(sent[0].text, /enable the WhatsApp binding/i);
});

test("api-agent thread pending delivery skips legacy runtime wakeups", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-api-agent-delivery-skip-"));
  const env = { ORKESTR_HOME: home };
  await createThread({
    id: "api-agent-skip",
    name: "API Agent Skip",
    ownerUserId: "otcan",
    runtimeKind: "api-agent",
    executorId: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: { connector: "whatsapp", chatId: "chat-api-agent-skip" },
  }, env);
  await enqueueThreadInput("api-agent-skip", { source: "whatsapp_inbound", text: "hi" }, env);

  const delivered = await deliverPendingThreadInputs("api-agent-skip", env);
  const messages = await listThreadMessages("api-agent-skip", env);
  const events = await listEvents(env, 20);

  assert.deepEqual(delivered, []);
  assert.equal(messages[0].state, "queued");
  assert.deepEqual((await listRuntimeLeases(env)).map((lease) => lease.threadId), []);
  assert.equal(events.some((event) => event.type === "thread_input_delivery_skipped" && event.reason === "api_agent_thread"), true);
});

test("whatsapp inbound uses manually linked user identities before provisioning", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-manual-user-thread-"));
  const env = await externalBridgeEnvWithAllowingSanitizer(home, {
    ORKESTR_WHATSAPP_AUTO_PROVISION_USERS: "1",
  });
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    autoProvisionUsers: true,
  }, env);
  const user = await createUser({ id: "alice", role: "user", displayName: "Alice" }, env);
  await linkUserPrivateIdentity(user.id, {
    provider: "whatsapp",
    accountId: "main",
    externalId: "wa-contact-one@c.us",
    chatId: "manual-alice-chat@g.us",
    displayName: "Alice WA",
    source: "manual",
  }, { env, actorUserId: "admin" });

  const routed = await routeWhatsAppInbound({
    eventId: "wa-manual-user-1",
    chatId: "manual-alice-chat@g.us",
    accountId: "main",
    from: "wa-contact-one@c.us",
    chatName: "Alice Chat",
    text: "hello from manually linked whatsapp",
  }, env);
  const thread = await getThread(routed.threadId, env);
  const messages = await listThreadMessages(routed.threadId, env);
  const users = await listThreads(env);

  assert.equal(routed.autoProvisioned, true);
  assert.equal(routed.userId, "alice");
  assert.equal(thread.ownerUserId, "alice");
  assert.equal(thread.binding.chatId, "manual-alice-chat@g.us");
  assert.equal(messages[0].ownerUserId, "alice");
  assert.deepEqual(users.map((entry) => entry.ownerUserId), ["alice"]);
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

test("whatsapp delivery mirrors imported app-server updates and final replies through the bound thread chat", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-import-bound-"));
  const env = externalBridgeEnv(home);
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, env);
  await createThread({
    id: "thread-import-bound",
    name: "Imported Bound Reply Thread",
    binding: {
      connector: "whatsapp",
      chatId: "chat-import-bound",
      responderAccountId: "account-import-bound",
      mirrorToWhatsApp: true,
    },
  }, env);
  await appendThreadMessage("thread-import-bound", {
    role: "assistant",
    source: "codex-app-server-import",
    phase: "commentary",
    text: "Imported progress should be mirrored.",
    state: "completed",
  }, env);
  await appendThreadMessage("thread-import-bound", {
    role: "assistant",
    source: "codex-app-server-import",
    phase: "final_answer",
    text: "Imported final should be mirrored.",
    state: "completed",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: [`sent-import-${calls.length}`] });
  });

  assert.equal(delivery.delivered.length, 2);
  assert.deepEqual(delivery.delivered.map((item) => item.deliveryType), ["progress", "final"]);
  assert.deepEqual(calls.map((call) => call.body.to), ["chat-import-bound", "chat-import-bound"]);
  assert.deepEqual(calls.map((call) => call.body.accountId), ["account-import-bound", "account-import-bound"]);
  assert.deepEqual(calls.map((call) => stripDebugFooter(call.body.text)), [
    "Imported progress should be mirrored.",
    "Imported final should be mirrored.",
  ]);
});

test("whatsapp delivery mirrors Codex updates and final messages by default", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-final-only-"));
  const env = externalBridgeEnv(home);
  await createThread({ id: "thread-wa-final-only", name: "WA Final Only Thread" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-final-only": "thread-wa-final-only" },
  }, env);

  const routed = await routeWhatsAppInbound({ eventId: "wa-final-only-1", chatId: "chat-final-only", text: "help me" }, env);
  await appendThreadMessage("thread-wa-final-only", {
    role: "assistant",
    source: "codex-rollout",
    phase: "commentary",
    state: "completed",
    text: "I am checking the repo now.",
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-final-only",
  }, env);
  await appendThreadMessage("thread-wa-final-only", {
    role: "assistant",
    source: "codex-rollout",
    phase: "context_compaction",
    state: "completed",
    text: "Codex compacted the conversation context.",
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-final-only",
  }, env);
  const finalText = [
    "Here is the answer.",
    "",
    "Steps:",
    "- Open the receipt.",
    "- Cancel only if the merchant exposes a subscription.",
  ].join("\n");
  await appendThreadMessage("thread-wa-final-only", {
    role: "assistant",
    source: "codex-rollout",
    phase: "final_answer",
    state: "completed",
    text: finalText,
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-final-only",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-final-only"] });
  });

  assert.equal(delivery.delivered.length, 2);
  assert.deepEqual(delivery.delivered.map((item) => item.deliveryType), ["progress", "final"]);
  assert.equal(calls.length, 2);
  assert.equal(stripDebugFooter(calls[0].body.text), "I am checking the repo now.");
  assert.equal(stripDebugFooter(calls[1].body.text), finalText);
});

test("whatsapp delivery mirrors every commentary update before final replies by default", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-progress-"));
  const env = externalBridgeEnv(home);
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
  const firstProgress = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-progress-1"] });
  });

  await appendThreadMessage("thread-wa-progress", {
    role: "assistant",
    source: "codex-rollout",
    phase: "commentary",
    state: "completed",
    text: "Milestone: focused tests are running.",
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-progress",
  }, env);

  const secondProgress = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-progress-2"] });
  });

  await appendThreadMessage("thread-wa-progress", {
    role: "assistant",
    source: "codex-rollout",
    phase: "commentary",
    state: "completed",
    text: "Milestone: focused tests passed; full suite is running.",
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-progress",
  }, env);
  const thirdProgress = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-progress-3"] });
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

  assert.equal(firstProgress.delivered.length, 1);
  assert.equal(firstProgress.delivered[0].deliveryType, "progress");
  assert.equal(secondProgress.delivered.length, 1);
  assert.equal(secondProgress.delivered[0].deliveryType, "progress");
  assert.equal(thirdProgress.delivered.length, 1);
  assert.equal(thirdProgress.delivered[0].deliveryType, "progress");
  assert.equal(final.delivered.length, 1);
  assert.equal(final.delivered[0].deliveryType, "final");
  assert.deepEqual(calls.map((call) => stripDebugFooter(call.body.text)), [
    "I’m checking the repo and running focused tests now.",
    "Milestone: focused tests are running.",
    "Milestone: focused tests passed; full suite is running.",
    "Done. Tests passed.",
  ]);
  assertDebugFooter(calls[0].body.text, { messageType: "update" });
  assertDebugFooter(calls[1].body.text, { messageType: "update" });
  assertDebugFooter(calls[2].body.text, { messageType: "update" });
  assertDebugFooter(calls[3].body.text, { messageType: "final" });
});

test("whatsapp thread binding suppresses updates and debug footer for one chat only", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-thread-update-suppression-"));
  const env = externalBridgeEnv(home);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
  }, env);
  await createThread({
    id: "thread-wa-updates-suppressed",
    name: "WA Updates Suppressed Thread",
    binding: {
      connector: "whatsapp",
      chatId: "chat-updates-suppressed",
      mirrorToWhatsApp: true,
      suppressWhatsAppUpdates: true,
      suppressWhatsAppDebugFooter: true,
    },
  }, env);
  await createThread({
    id: "thread-wa-updates-normal",
    name: "WA Updates Normal Thread",
    binding: {
      connector: "whatsapp",
      chatId: "chat-updates-normal",
      mirrorToWhatsApp: true,
    },
  }, env);

  const suppressedParent = await appendThreadMessage("thread-wa-updates-suppressed", {
    role: "user",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-updates-suppressed",
    text: "suppressed task",
  }, env);
  const normalParent = await appendThreadMessage("thread-wa-updates-normal", {
    role: "user",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-updates-normal",
    text: "normal task",
  }, env);
  const suppressedProgress = await appendThreadMessage("thread-wa-updates-suppressed", {
    role: "assistant",
    source: "codex-rollout",
    phase: "commentary",
    state: "completed",
    text: "Suppressed progress.",
    parentMessageId: suppressedParent.id,
    connector: "whatsapp",
    chatId: "chat-updates-suppressed",
  }, env);
  await appendThreadMessage("thread-wa-updates-suppressed", {
    role: "assistant",
    source: "codex-rollout",
    phase: "final_answer",
    state: "completed",
    text: "Suppressed final.",
    parentMessageId: suppressedParent.id,
    connector: "whatsapp",
    chatId: "chat-updates-suppressed",
  }, env);
  await appendThreadMessage("thread-wa-updates-normal", {
    role: "assistant",
    source: "codex-rollout",
    phase: "commentary",
    state: "completed",
    text: "Normal progress.",
    parentMessageId: normalParent.id,
    connector: "whatsapp",
    chatId: "chat-updates-normal",
  }, env);
  await appendThreadMessage("thread-wa-updates-normal", {
    role: "assistant",
    source: "codex-rollout",
    phase: "final_answer",
    state: "completed",
    text: "Normal final.",
    parentMessageId: normalParent.id,
    connector: "whatsapp",
    chatId: "chat-updates-normal",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: [`sent-${calls.length}`] });
  });

  const deliveredTexts = calls.map((call) => stripDebugFooter(call.body.text));
  assert.equal(delivery.delivered.length, 3);
  assert.equal(delivery.skipped.find((item) => item.messageId === suppressedProgress.id)?.reason, "updates_suppressed");
  assert.deepEqual(new Set(deliveredTexts), new Set([
    "Suppressed final.",
    "Normal progress.",
    "Normal final.",
  ]));
  assert.ok(!deliveredTexts.includes("Suppressed progress."));
  assert.equal(calls.find((call) => stripDebugFooter(call.body.text) === "Suppressed final.")?.body.text, "Suppressed final.");
  assertDebugFooter(calls.find((call) => stripDebugFooter(call.body.text) === "Normal progress.")?.body.text, { messageType: "update" });
  assertDebugFooter(calls.find((call) => stripDebugFooter(call.body.text) === "Normal final.")?.body.text, { messageType: "final" });
});

test("whatsapp delivery mirrors Codex approval prompts as updates", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-approval-update-"));
  const env = externalBridgeEnv(home);
  await createThread({ id: "thread-wa-approval-update", name: "WA Approval Update Thread" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-approval-update": "thread-wa-approval-update" },
  }, env);

  const routed = await routeWhatsAppInbound({ eventId: "wa-approval-update-1", chatId: "chat-approval-update", text: "clean it" }, env);
  await appendThreadMessage("thread-wa-approval-update", {
    role: "assistant",
    source: "codex-app-server",
    phase: "awaiting_approval",
    state: "completed",
    text: "Codex is requesting command approval.\nCommand: rm -f tmp.pyc\nApprove or deny in Orkestr.",
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-approval-update",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-approval-update"] });
  });

  assert.equal(delivery.delivered.length, 1);
  assert.equal(delivery.delivered[0].deliveryType, "progress");
  assert.match(stripDebugFooter(calls[0].body.text), /Codex is requesting command approval/);
  assertDebugFooter(calls[0].body.text, { messageType: "update" });
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

test("whatsapp typing indicators follow explicit turn lifecycle over raw runtime booleans", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-typing-lifecycle-"));
  const env = { ORKESTR_HOME: home };
  await createThread({
    id: "thread-wa-typing-lifecycle",
    name: "WA Typing Lifecycle Thread",
    runtimeKind: "codex-app-server",
  }, env);
  await writeConnectorConfig("whatsapp", {
    threadRoutes: { "chat-typing-lifecycle": "thread-wa-typing-lifecycle" },
  }, env);
  await routeWhatsAppInbound({
    eventId: "wa-typing-lifecycle-1",
    chatId: "chat-typing-lifecycle",
    accountId: "responder",
    text: "work on this",
  }, env);

  const result = await syncWhatsAppTypingIndicators(env, {
    statusImpl: async () => ({
      state: "working",
      runtimeKind: "codex-app-server",
      activeTurnId: "turn-queued",
      working: true,
      typingActive: true,
      turnLifecycle: {
        state: "queued",
        queued: true,
        running: false,
        awaitingApproval: false,
        typingActive: false,
      },
    }),
    syncImpl: async (targets) => ({ ok: true, active: targets.length, targets }),
  });

  assert.equal(result.active, 0);
  assert.deepEqual(result.targets, []);
});

test("whatsapp typing indicators suppress approval turns from lifecycle", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-typing-lifecycle-approval-"));
  const env = { ORKESTR_HOME: home };
  await createThread({
    id: "thread-wa-typing-lifecycle-approval",
    name: "WA Typing Lifecycle Approval Thread",
    runtimeKind: "codex-app-server",
  }, env);
  await writeConnectorConfig("whatsapp", {
    threadRoutes: { "chat-typing-lifecycle-approval": "thread-wa-typing-lifecycle-approval" },
  }, env);
  await routeWhatsAppInbound({
    eventId: "wa-typing-lifecycle-approval-1",
    chatId: "chat-typing-lifecycle-approval",
    accountId: "responder",
    text: "work on this",
  }, env);

  const result = await syncWhatsAppTypingIndicators(env, {
    statusImpl: async () => ({
      state: "awaiting_approval",
      runtimeKind: "codex-app-server",
      activeTurnId: "turn-approval",
      working: true,
      typingActive: true,
      turnLifecycle: {
        state: "awaiting_approval",
        queued: false,
        running: false,
        awaitingApproval: true,
        typingActive: false,
      },
    }),
    syncImpl: async (targets) => ({ ok: true, active: targets.length, targets }),
  });

  assert.equal(result.active, 0);
  assert.deepEqual(result.targets, []);
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

test("whatsapp typing indicators resume after mirrored progress cooldown", async () => {
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

  assert.equal(result.active, 1);
  assert.deepEqual(result.targets, [{
    threadId: "thread-wa-typing-progress-delivered",
    messageId: routed.message.id,
    chatId: "chat-typing-progress-delivered",
    accountId: "responder",
  }]);
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

test("whatsapp typing sync pauses briefly after outbound progress for the active parent", async () => {
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
  assert.equal(noCooldown.active, 1);
  assert.deepEqual(noCooldown.targets, [{
    threadId: "thread-wa-typing-cooldown",
    messageId: routed.message.id,
    chatId: "chat-typing-cooldown",
    accountId: "responder",
  }]);
});

test("whatsapp typing sync stops after outbound final delivery for the active parent", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-typing-final-delivered-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder",
    ORKESTR_WHATSAPP_TYPING_COOLDOWN_MS: "0",
  };
  await createThread({ id: "thread-wa-typing-final-delivered", name: "WA Typing Final Delivered" }, env);
  await writeConnectorConfig("whatsapp", {
    threadRoutes: { "chat-typing-final-delivered": "thread-wa-typing-final-delivered" },
  }, env);

  const routed = await routeWhatsAppInbound({
    eventId: "wa-typing-final-delivered-1",
    chatId: "chat-typing-final-delivered",
    accountId: "responder",
    text: "work on this",
  }, env);
  await fs.writeFile(path.join(home, "whatsapp.json"), JSON.stringify({
    outboundDeliveries: [{
      deliveryType: "final",
      messageId: "final-1",
      parentMessageId: routed.message.id,
      chatId: "chat-typing-final-delivered",
      accountId: "responder",
      deliveredAt: new Date().toISOString(),
    }],
  }, null, 2));

  const result = await syncWhatsAppTypingIndicators(env, {
    statusImpl: async () => ({ state: "working", working: true, typingActive: true }),
    syncImpl: async (targets) => ({ ok: true, active: targets.length, targets }),
  });

  assert.equal(result.active, 0);
  assert.deepEqual(result.targets, []);
});

test("whatsapp delivery mirrors fresh commentary even when a final answer already exists", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-progress-final-"));
  const env = externalBridgeEnv(home, { ORKESTR_WHATSAPP_MIRROR_PROGRESS_UPDATES: "1" });
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
    text: "Milestone: fresh progress should still be mirrored.",
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
    return response({ ok: true, ids: ["sent-progress-or-final"] });
  });

  assert.equal(delivery.delivered.length, 2);
  assert.deepEqual(delivery.delivered.map((item) => item.deliveryType), ["progress", "final"]);
  assert.deepEqual(calls.map((call) => stripDebugFooter(call.body.text)), [
    "Milestone: fresh progress should still be mirrored.",
    "Final only.",
  ]);
  assertDebugFooter(calls[0].body.text, { messageType: "update" });
  assertDebugFooter(calls[1].body.text, { messageType: "final" });
});

test("whatsapp delivery skips delayed progress overtaken by a final answer", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-overtaken-progress-"));
  const env = externalBridgeEnv(home, { ORKESTR_WHATSAPP_MIRROR_PROGRESS_UPDATES: "1" });
  await createThread({ id: "thread-wa-overtaken-progress", name: "WA Overtaken Progress Thread" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-overtaken-progress": "thread-wa-overtaken-progress" },
  }, env);

  const routed = await routeWhatsAppInbound({ eventId: "wa-overtaken-progress-1", chatId: "chat-overtaken-progress", text: "status?" }, env);
  const progressAt = new Date(Date.now() - 45_000).toISOString();
  const finalAt = new Date(Date.now() - 5_000).toISOString();
  const progress = await appendThreadMessage("thread-wa-overtaken-progress", {
    role: "assistant",
    source: "codex-rollout",
    phase: "commentary",
    state: "completed",
    text: "Milestone: delayed progress should not be backfilled.",
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-overtaken-progress",
    createdAt: progressAt,
    timestamp: progressAt,
  }, env);
  await appendThreadMessage("thread-wa-overtaken-progress", {
    role: "assistant",
    source: "codex-rollout",
    phase: "final_answer",
    state: "completed",
    text: "Final only after delayed progress.",
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-overtaken-progress",
    createdAt: finalAt,
    timestamp: finalAt,
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-overtaken-final"] });
  });

  assert.equal(delivery.delivered.length, 1);
  assert.equal(delivery.delivered[0].deliveryType, "final");
  assert.deepEqual(calls.map((call) => stripDebugFooter(call.body.text)), ["Final only after delayed progress."]);
  assert.deepEqual(delivery.skipped.find((item) => item.messageId === progress.id)?.reason, "overtaken_by_final");
});

test("whatsapp delivery can suppress repeated final body when configured", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-repeated-final-body-"));
  const env = externalBridgeEnv(home, {
    ORKESTR_WHATSAPP_RECENT_BODY_DUPLICATE_TTL_MS: "600000",
    ORKESTR_WHATSAPP_RECENT_BODY_DUPLICATE_FINALS: "1",
  });
  await createThread({ id: "thread-wa-repeated-final-body", name: "WA Repeated Final Body Thread" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-repeated-final-body": "thread-wa-repeated-final-body" },
  }, env);

  const routed = await routeWhatsAppInbound({ eventId: "wa-repeated-final-body-1", chatId: "chat-repeated-final-body", text: "status?" }, env);
  const first = await appendThreadMessage("thread-wa-repeated-final-body", {
    role: "assistant",
    source: "codex-rollout",
    phase: "final_answer",
    state: "completed",
    text: "The current status is unchanged.",
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-repeated-final-body",
  }, env);

  const firstCalls = [];
  const firstDelivery = await deliverWhatsAppReplies(env, async (url, options) => {
    firstCalls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-repeated-final-body-1"] });
  });

  assert.equal(firstDelivery.delivered.length, 1);
  assert.equal(firstDelivery.delivered[0].messageId, first.id);
  assert.deepEqual(firstCalls.map((call) => stripDebugFooter(call.body.text)), ["The current status is unchanged."]);

  const secondRouted = await routeWhatsAppInbound({ eventId: "wa-repeated-final-body-2", chatId: "chat-repeated-final-body", text: "status again?" }, env);
  const second = await appendThreadMessage("thread-wa-repeated-final-body", {
    role: "assistant",
    source: "codex-rollout",
    phase: "final_answer",
    state: "completed",
    text: "The current status is unchanged.",
    parentMessageId: secondRouted.message.id,
    connector: "whatsapp",
    chatId: "chat-repeated-final-body",
  }, env);

  const secondCalls = [];
  const secondDelivery = await deliverWhatsAppReplies(env, async (url, options) => {
    secondCalls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-repeated-final-body-2"] });
  });
  const outbox = await readConnectorOutbox(env);

  assert.equal(secondDelivery.delivered.length, 0);
  assert.equal(secondCalls.length, 0);
  assert.equal(secondDelivery.skipped.find((item) => item.messageId === second.id)?.reason, "duplicate_recent_body");
  assert.equal(outbox.jobs.some((job) => job.sourceMessageId === second.id), false);
});

test("whatsapp delivery suppresses repeated progress body across new assistant messages", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-repeated-progress-body-"));
  const env = externalBridgeEnv(home, {
    ORKESTR_WHATSAPP_MIRROR_PROGRESS_UPDATES: "1",
    ORKESTR_WHATSAPP_RECENT_BODY_DUPLICATE_TTL_MS: "600000",
  });
  await createThread({ id: "thread-wa-repeated-progress-body", name: "WA Repeated Progress Body Thread" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-repeated-progress-body": "thread-wa-repeated-progress-body" },
  }, env);

  const routed = await routeWhatsAppInbound({ eventId: "wa-repeated-progress-body-1", chatId: "chat-repeated-progress-body", text: "status?" }, env);
  const first = await appendThreadMessage("thread-wa-repeated-progress-body", {
    role: "assistant",
    source: "codex-rollout",
    phase: "commentary",
    state: "completed",
    text: "I am still checking the WA runtime.",
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-repeated-progress-body",
  }, env);

  const firstCalls = [];
  const firstDelivery = await deliverWhatsAppReplies(env, async (url, options) => {
    firstCalls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-repeated-progress-body-1"] });
  });

  assert.equal(firstDelivery.delivered.length, 1);
  assert.equal(firstDelivery.delivered[0].messageId, first.id);
  assert.deepEqual(firstCalls.map((call) => stripDebugFooter(call.body.text)), ["I am still checking the WA runtime."]);

  const second = await appendThreadMessage("thread-wa-repeated-progress-body", {
    role: "assistant",
    source: "codex-rollout",
    phase: "commentary",
    state: "completed",
    text: "I am still checking the WA runtime.",
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-repeated-progress-body",
  }, env);

  const secondCalls = [];
  const secondDelivery = await deliverWhatsAppReplies(env, async (url, options) => {
    secondCalls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-repeated-progress-body-2"] });
  });
  const outbox = await readConnectorOutbox(env);

  assert.equal(secondDelivery.delivered.length, 0);
  assert.equal(secondCalls.length, 0);
  assert.equal(secondDelivery.skipped.find((item) => item.messageId === second.id)?.reason, "duplicate_recent_body");
  assert.equal(outbox.jobs.some((job) => job.sourceMessageId === second.id), false);
});

test("whatsapp delivery suppresses retryable progress once final answer is delivered", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-retry-progress-after-final-"));
  const env = externalBridgeEnv(home, {
    ORKESTR_WHATSAPP_MIRROR_PROGRESS_UPDATES: "1",
    ORKESTR_CONNECTOR_OUTBOX_STORE: "json",
  });
  await createThread({ id: "thread-wa-retry-progress-after-final", name: "WA Retry Progress After Final Thread" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-retry-progress-after-final": "thread-wa-retry-progress-after-final" },
  }, env);

  const routed = await routeWhatsAppInbound({ eventId: "wa-retry-progress-after-final-1", chatId: "chat-retry-progress-after-final", text: "status?" }, env);
  const progressAt = new Date(Date.now() - 5_000).toISOString();
  const finalAt = new Date().toISOString();
  const progress = await appendThreadMessage("thread-wa-retry-progress-after-final", {
    role: "assistant",
    source: "codex-rollout",
    phase: "commentary",
    state: "completed",
    text: "Milestone: retryable progress should be suppressed after final.",
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-retry-progress-after-final",
    createdAt: progressAt,
    timestamp: progressAt,
  }, env);
  const final = await appendThreadMessage("thread-wa-retry-progress-after-final", {
    role: "assistant",
    source: "codex-rollout",
    phase: "final_answer",
    state: "completed",
    text: "Final answer wins.",
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-retry-progress-after-final",
    createdAt: finalAt,
    timestamp: finalAt,
  }, env);

  const calls = [];
  const first = await deliverWhatsAppReplies(env, async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body.text);
    if (/retryable progress/.test(body.text)) throw new Error("bridge temporarily unavailable");
    return response({ ok: true, ids: ["sent-final-after-progress-failure"] });
  });
  const outboxAfterFinal = await readConnectorOutbox(env);
  const progressJob = outboxAfterFinal.jobs.find((job) => job.sourceMessageId === progress.id);
  const finalJob = outboxAfterFinal.jobs.find((job) => job.sourceMessageId === final.id);

  assert.equal(first.failed.length, 1);
  assert.equal(first.delivered.length, 1);
  assert.equal(first.delivered[0].deliveryType, "final");
  assert.deepEqual(calls.map(stripDebugFooter), [
    "Milestone: retryable progress should be suppressed after final.",
    "Final answer wins.",
  ]);
  assert.equal(progressJob?.state, "skipped");
  assert.equal(progressJob?.error, "overtaken_by_final");
  assert.equal(finalJob?.state, "delivered");

  const retry = await deliverWhatsAppReplies(env, async () => {
    throw new Error("suppressed progress should not retry");
  });
  assert.equal(retry.delivered.length, 0);
  assert.equal(retry.failed.length, 0);
});

test("whatsapp delivery mirrors newer progress after an older final was already delivered", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-progress-after-final-"));
  const env = externalBridgeEnv(home, { ORKESTR_WHATSAPP_MIRROR_PROGRESS_UPDATES: "1" });
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
    text: "Milestone: new progress from a later operator turn.",
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
  assert.deepEqual(calls.map((call) => stripDebugFooter(call.body.text)), ["Milestone: new progress from a later operator turn."]);
  assertDebugFooter(calls[0].body.text, { messageType: "update" });
});

test("whatsapp delivery does not backfill stale progress after an older final", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-stale-progress-after-final-"));
  const env = externalBridgeEnv(home, { ORKESTR_WHATSAPP_MIRROR_PROGRESS_UPDATES: "1" });
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
    text: "Milestone: old progress that should not be backfilled.",
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
  const env = externalBridgeEnv(home, { ORKESTR_WHATSAPP_MIRROR_PROGRESS_UPDATES: "1" });
  await createThread({
    id: "thread-wa-debug-footer",
    name: "WA Debug Footer Thread",
    codexMode: "code",
    runtime: { progress: { codexMode: "plan" } },
    codexModel: "gpt-5.5",
    codexReasoningEffort: "xhigh",
    codexRateLimits: {
      primary: { used_percent: 12, window_minutes: 300 },
      secondary: { used_percent: 34, window_minutes: 10080 },
    },
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
    text: "Milestone: routing check started.",
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
  assert.equal(stripDebugFooter(calls[0].body.text), "Milestone: routing check started.");
  assert.match(
    calls[0].body.text,
    /\n\ndbg: m:gpt-5\.5\/xh · mode:plan · msg:update · 5h:88% · wk:66% · q:0 · load:\d+% · api:\d+% · help:\/help · mode-switch:\/code$/,
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
    executor: {
      metadata: {
        codexRateLimits: {
          primary: { used_percent: 25, window_minutes: 300 },
          secondary: { used_percent: 60, window_minutes: 10080 },
        },
      },
    },
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
  assertDebugFooter(calls[0].body.text, { messageType: "final", model: "gpt-5.5/xh", runtime: "api", fiveHour: "75%", weekly: "40%" });
});

test("whatsapp debug footer classifies a single weekly Codex limit by window", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-debug-footer-weekly-primary-"));
  const env = externalBridgeEnv(home);
  await createThread({
    id: "thread-wa-debug-footer-weekly-primary",
    name: "WA Debug Footer Weekly Primary Thread",
    codexModel: "gpt-5.5",
    codexReasoningEffort: "xhigh",
    codexRateLimits: {
      primary: { used_percent: 4, window_minutes: 10080 },
      secondary: null,
    },
  }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-debug-footer-weekly-primary": "thread-wa-debug-footer-weekly-primary" },
  }, env);

  const routed = await routeWhatsAppInbound({ eventId: "wa-debug-footer-weekly-primary-1", chatId: "chat-debug-footer-weekly-primary", text: "status?" }, env);
  await appendThreadMessage("thread-wa-debug-footer-weekly-primary", {
    role: "assistant",
    source: "codex-rollout",
    phase: "final_answer",
    state: "completed",
    text: "Final with weekly-only rate metadata.",
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-debug-footer-weekly-primary",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-debug-footer-weekly-primary"] });
  });

  assert.equal(delivery.delivered.length, 1);
  assert.match(calls[0].body.text, / · wk:96% · /);
  assert.doesNotMatch(calls[0].body.text, / · 5h:\d+%/);
});

test("whatsapp debug footer reads live Codex rate limits when thread metadata is stale", async (t) => {
  try {
    await execFileAsync("sqlite3", ["--version"]);
  } catch {
    t.skip("sqlite3 unavailable");
    return;
  }

  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-debug-footer-live-limits-"));
  const codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-codex-home-"));
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-codex-workspace-"));
  const codexThreadId = "22222222-2222-4222-8222-222222222222";
  const rolloutPath = path.join(codexHome, "sessions", "rollout-live-limits.jsonl");
  await fs.mkdir(path.dirname(rolloutPath), { recursive: true });
  await fs.writeFile(rolloutPath, `${JSON.stringify({
    timestamp: "2026-06-24T10:00:00.000Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
        last_token_usage: { input_tokens: 80, output_tokens: 10, total_tokens: 90 },
        model_context_window: 258400,
      },
      rate_limits: {
        primary: { used_percent: 9, window_minutes: 300 },
        secondary: { used_percent: 83, window_minutes: 10080 },
        plan_type: "pro",
      },
    },
  })}\n`, "utf8");
  await execFileAsync("sqlite3", [path.join(codexHome, "state_5.sqlite"), [
    "create table threads (id text primary key, rollout_path text, model text, reasoning_effort text, model_provider text, tokens_used integer, archived integer, cwd text, created_at integer, updated_at integer, created_at_ms integer, updated_at_ms integer);",
    `insert into threads (id, rollout_path, model, reasoning_effort, model_provider, tokens_used, archived, cwd, created_at, updated_at, created_at_ms, updated_at_ms) values ('${codexThreadId}', '${rolloutPath.replaceAll("'", "''")}', 'gpt-5.5', 'high', 'openai', 90, 0, '${workspace.replaceAll("'", "''")}', 1, 1, 1, 1);`,
  ].join("\n")]);

  const env = externalBridgeEnv(home, { CODEX_HOME: codexHome });
  await createThread({
    id: "thread-wa-debug-footer-live-limits",
    name: "WA Debug Footer Live Limits Thread",
    cwd: workspace,
    codexThreadId,
    runtimeKind: "codex-app-server",
    codexModel: "gpt-5.5",
    codexReasoningEffort: "high",
  }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-debug-footer-live-limits": "thread-wa-debug-footer-live-limits" },
  }, env);

  const routed = await routeWhatsAppInbound({ eventId: "wa-debug-footer-live-limits-1", chatId: "chat-debug-footer-live-limits", text: "status?" }, env);
  await appendThreadMessage("thread-wa-debug-footer-live-limits", {
    role: "assistant",
    source: "codex-app-server",
    phase: "final_answer",
    state: "completed",
    text: "Final with live limits.",
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-debug-footer-live-limits",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-debug-footer-live-limits"] });
  });

  assert.equal(delivery.delivered.length, 1);
  assert.equal(stripDebugFooter(calls[0].body.text), "Final with live limits.");
  assertDebugFooter(calls[0].body.text, { messageType: "final", model: "gpt-5.5/h", runtime: "api", fiveHour: "91%", weekly: "17%" });
});

test("whatsapp debug footer can be disabled", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-debug-footer-off-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1",
    ORKESTR_WHATSAPP_DEBUG_FOOTER: "0",
    ORKESTR_WHATSAPP_MIRROR_PROGRESS_UPDATES: "1",
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
    text: "Milestone: checking it.",
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
  assert.equal(calls[0].body.text, "Milestone: checking it.");
});

test("whatsapp delivery suppresses debug footer for contained user threads", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-debug-footer-contained-"));
  const env = await externalBridgeEnvWithAllowingSanitizer(home, { ORKESTR_WHATSAPP_MIRROR_PROGRESS_UPDATES: "1" });
  await createThread({
    id: "thread-wa-debug-footer-contained",
    name: "WA Debug Footer Contained Thread",
    ownerUserId: "otcan",
    securityProfile: "private-user",
    runtimeKind: "codex-app-server",
    codexModel: "gpt-5.5",
    codexReasoningEffort: "xhigh",
  }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-debug-footer-contained": "thread-wa-debug-footer-contained" },
  }, env);

  const routed = await routeWhatsAppInbound({ eventId: "wa-debug-footer-contained-1", chatId: "chat-debug-footer-contained", text: "status?" }, env);
  await appendThreadMessage("thread-wa-debug-footer-contained", {
    role: "assistant",
    source: "codex-app-server",
    phase: "commentary",
    state: "completed",
    text: "Milestone: contained progress update.",
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-debug-footer-contained",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-debug-footer-contained"] });
  });

  assert.equal(delivery.delivered.length, 1);
  assert.equal(calls[0].body.text, "Milestone: contained progress update.");
  assert.doesNotMatch(calls[0].body.text, /dbg:/);
});

test("whatsapp debug footer ignores stale stored plan mode when live mode is code", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-debug-footer-stale-mode-"));
  const env = externalBridgeEnv(home, { ORKESTR_WHATSAPP_MIRROR_PROGRESS_UPDATES: "1" });
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
    text: "Milestone: checking it.",
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
  assert.equal(stripDebugFooter(calls[0].body.text), "Milestone: checking it.");
  assertDebugFooter(calls[0].body.text, { messageType: "update", model: "gpt-5.5/xh" });
  assert.doesNotMatch(calls[0].body.text, /mode:plan/);
  assert.doesNotMatch(calls[0].body.text, /mode-switch:\/code/);
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

test("whatsapp inbound suppresses source timestamp replays after first input completes", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-thread-source-replay-"));
  const env = externalBridgeEnv(home);
  await createThread({ id: "thread-wa-source-replay", name: "WA Source Replay Thread" }, env);
  await writeConnectorConfig("whatsapp", {
    threadRoutes: { "chat-source-replay": "thread-wa-source-replay" },
  }, env);

  const timestamp = "2026-06-14T18:00:00.000Z";
  const first = await routeWhatsAppInbound({
    eventId: "true_chat-source-replay_AAAAA_sender@lid",
    chatId: "chat-source-replay",
    from: "sender@lid",
    text: "same physical message",
    timestamp,
  }, env);
  await updateThreadMessage("thread-wa-source-replay", first.message.id, {
    state: "completed",
    deliveryState: "delivered",
  }, env);
  const second = await routeWhatsAppInbound({
    eventId: "false_chat-source-replay_BBBBB_sender@lid",
    chatId: "chat-source-replay",
    from: "sender@lid",
    text: "same physical message",
    timestamp,
  }, env);
  const messages = await listThreadMessages("thread-wa-source-replay", env);

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.messageId, first.message.id);
  assert.equal(second.event.messageId, first.message.id);
  assert.equal(messages.filter((message) => message.role === "user").length, 1);
});

test("whatsapp inbound ignores responder copy of a group message after sender queues it", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-cross-account-source-duplicate-"));
  const env = externalBridgeEnv(home, { ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender,responder" });
  await createThread({ id: "thread-wa-cross-account-source-duplicate", name: "WA Cross Account Source Duplicate" }, env);
  await writeConnectorConfig("whatsapp", {
    threadRoutes: { "chat-cross-account-source-duplicate": "thread-wa-cross-account-source-duplicate" },
  }, env);

  const first = await routeWhatsAppInbound({
    eventId: "true_chat-cross-account-source-duplicate_msg-123_sender@lid",
    chatId: "chat-cross-account-source-duplicate",
    accountId: "sender",
    from: "sender@lid",
    fromMe: true,
    text: "same physical group message",
  }, env);
  await updateThreadMessage("thread-wa-cross-account-source-duplicate", first.message.id, {
    state: "completed",
    deliveryState: "delivered",
  }, env);
  const second = await routeWhatsAppInbound({
    eventId: "false_chat-cross-account-source-duplicate_msg-123_sender@lid",
    chatId: "chat-cross-account-source-duplicate",
    accountId: "responder",
    from: "sender@lid",
    fromMe: false,
    text: "same physical group message",
  }, env);
  const messages = await listThreadMessages("thread-wa-cross-account-source-duplicate", env);

  assert.equal(first.duplicate, false);
  assert.equal(second.ignoredNonSenderAccount, true);
  assert.equal(second.skipped, "non_sender_account");
  assert.equal(messages.filter((message) => message.role === "user").length, 1);
});

test("whatsapp desktop approve command approves a pending desktop share challenge", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-desktop-share-approve-"));
  const env = externalBridgeEnv(home, { ORKESTR_PUBLIC_HTTPS_URL: "https://app.example.test" });
  await createThread({ id: "thread-wa-desktop-share-approve", name: "WA Desktop Share Approve" }, env);
  await writeConnectorConfig("whatsapp", {
    threadRoutes: { "chat-desktop-share-approve": "thread-wa-desktop-share-approve" },
  }, env);
  const created = await createDesktopShare({ desktopSlug: "linkedin", env });
  const parsed = new URL(created.url);
  const parts = parsed.pathname.split("/").filter(Boolean);
  const shareId = parts.at(-1);
  const key = parsed.searchParams.get("key");
  const opened = await openDesktopShare({ shareId, key, subdomain: created.subdomain, env });

  const routed = await routeWhatsAppInbound({
    eventId: "wa-desktop-share-approve-1",
    chatId: "chat-desktop-share-approve",
    accountId: "responder",
    text: `orkestr desktop approve ${opened.attempt.challenge}`,
  }, env);
  const ready = await desktopShareStatus({
    shareId,
    key,
    subdomain: created.subdomain,
    browserToken: opened.cookie.value.split(":")[1],
    env,
  });
  const messages = await listThreadMessages("thread-wa-desktop-share-approve", env);
  const assistant = messages.find((message) => message.parentMessageId === routed.message.id);

  assert.equal(routed.handledCommand, "desktop_share_approve");
  assert.equal(routed.desktopShareApproved, true);
  assert.equal(ready.approved, true);
  assert.match(assistant.text, /Desktop access approved for linkedin/);
});

test("whatsapp pasted desktop challenge id approves a pending desktop share challenge", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-desktop-share-bare-approve-"));
  const env = externalBridgeEnv(home, { ORKESTR_PUBLIC_HTTPS_URL: "https://app.example.test" });
  await createThread({ id: "thread-wa-desktop-share-bare-approve", name: "WA Desktop Share Bare Approve" }, env);
  await writeConnectorConfig("whatsapp", {
    threadRoutes: { "chat-desktop-share-bare-approve": "thread-wa-desktop-share-bare-approve" },
  }, env);
  const created = await createDesktopShare({ desktopSlug: "linkedin", env });
  const parsed = new URL(created.url);
  const parts = parsed.pathname.split("/").filter(Boolean);
  const shareId = parts.at(-1);
  const key = parsed.searchParams.get("key");
  const opened = await openDesktopShare({ shareId, key, subdomain: created.subdomain, env });

  const routed = await routeWhatsAppInbound({
    eventId: "wa-desktop-share-bare-approve-1",
    chatId: "chat-desktop-share-bare-approve",
    accountId: "responder",
    text: opened.attempt.challenge,
  }, env);
  const ready = await desktopShareStatus({
    shareId,
    key,
    subdomain: created.subdomain,
    browserToken: opened.cookie.value.split(":")[1],
    env,
  });
  const messages = await listThreadMessages("thread-wa-desktop-share-bare-approve", env);
  const assistant = messages.find((message) => message.parentMessageId === routed.message.id);

  assert.equal(routed.handledCommand, "desktop_share_approve");
  assert.equal(routed.desktopShareApproved, true);
  assert.equal(ready.approved, true);
  assert.match(assistant.text, /Desktop access approved for linkedin/);
});

test("whatsapp duplicate active tenant input is suppressed before sanitizer reruns", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-tenant-duplicate-before-sanitizer-"));
  const countFile = path.join(home, "sanitizer-count.txt");
  const script = path.join(home, "single-sanitizer.mjs");
  await fs.writeFile(
    script,
    [
      "import fs from 'node:fs';",
      `const countFile = ${JSON.stringify(countFile)};`,
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  JSON.parse(input);",
      "  const current = Number(fs.existsSync(countFile) ? fs.readFileSync(countFile, 'utf8') : '0');",
      "  fs.writeFileSync(countFile, String(current + 1));",
      "  console.log(JSON.stringify({ allow: current === 0, reason: current === 0 ? 'first-input-ok' : 'sanitizer-ran-for-duplicate', model: 'test-llm' }));",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  const env = externalBridgeEnv(home, {
    ORKESTR_LLM_SANITIZER_COMMAND_JSON: JSON.stringify([process.execPath, script]),
  });
  await createThread({
    id: "thread-wa-tenant-active-duplicate",
    name: "Tenant WA Active Duplicate Thread",
    ownerUserId: "otcan",
    binding: { connector: "whatsapp", chatId: "chat-tenant-active-duplicate" },
  }, env);
  await writeConnectorConfig("whatsapp", {
    threadRoutes: { "chat-tenant-active-duplicate": "thread-wa-tenant-active-duplicate" },
  }, env);

  const first = await routeWhatsAppInbound({ eventId: "wa-tenant-active-1", chatId: "chat-tenant-active-duplicate", from: "sender-1", text: "same queued tenant work" }, env);
  const second = await routeWhatsAppInbound({ eventId: "wa-tenant-active-2", chatId: "chat-tenant-active-duplicate", from: "sender-1", text: "same queued tenant work" }, env);
  const messages = await listThreadMessages("thread-wa-tenant-active-duplicate", env);
  const sanitizerRuns = Number(await fs.readFile(countFile, "utf8"));

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.event.messageId, first.message.id);
  assert.equal(messages.length, 1);
  assert.equal(sanitizerRuns, 1);
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

test("whatsapp delivery does not send day-old final replies by default", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-day-old-final-"));
  const env = externalBridgeEnv(home);
  await createThread({ id: "thread-wa-day-old-final", name: "WA Day Old Final Thread" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-day-old-final": "thread-wa-day-old-final" },
  }, env);

  const oldFinalAt = new Date(Date.now() - 19 * 60 * 60 * 1000).toISOString();
  const parent = await appendThreadMessage("thread-wa-day-old-final", {
    role: "user",
    source: "whatsapp_inbound",
    state: "completed",
    connector: "whatsapp",
    chatId: "chat-day-old-final",
    text: "300 ml kefir add",
    createdAt: oldFinalAt,
  }, env);
  const reply = await appendThreadMessage("thread-wa-day-old-final", {
    role: "assistant",
    source: "codex-app-server",
    phase: "final_answer",
    state: "completed",
    connector: "whatsapp",
    chatId: "chat-day-old-final",
    parentMessageId: parent.id,
    text: "Added 300 ml kefir.",
    createdAt: oldFinalAt,
  }, env);

  const delivery = await deliverWhatsAppReplies(env, async () => {
    throw new Error("day-old final reply should not be sent");
  });

  assert.equal(delivery.delivered.length, 0);
  assert.deepEqual(delivery.skipped.find((item) => item.messageId === reply.id)?.reason, "stale_untracked_reply");
});

test("whatsapp delivery records an outbound intent for current WA replies", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-intent-current-"));
  const env = externalBridgeEnv(home);
  await createThread({ id: "thread-wa-intent-current", name: "WA Intent Current Thread" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-intent-current": "thread-wa-intent-current" },
  }, env);

  const routed = await routeWhatsAppInbound({ eventId: "wa-intent-current-1", chatId: "chat-intent-current", text: "current request" }, env);
  const reply = await appendThreadMessage("thread-wa-intent-current", {
    role: "assistant",
    source: "codex-rollout",
    phase: "final_answer",
    state: "completed",
    connector: "whatsapp",
    chatId: "chat-intent-current",
    parentMessageId: routed.message.id,
    text: "current answer",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-intent-current"] });
  });
  const duplicate = await deliverWhatsAppReplies(env, async () => {
    throw new Error("current intent should not resend after delivery");
  });
  const state = JSON.parse(await fs.readFile(path.join(home, "whatsapp.json"), "utf8"));
  const intent = state.outboundIntents.find((item) => item.messageId === reply.id);

  assert.equal(delivery.delivered.length, 1);
  assert.equal(duplicate.delivered.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(stripDebugFooter(calls[0].body.text), "current answer");
  assert.equal(intent.status, "delivered");
  assert.equal(intent.deliveryType, "final");
  assert.equal(state.outboundMirrorCursors.some((cursor) => cursor.threadId === "thread-wa-intent-current"), true);
});

test("whatsapp live output recovery keeps recent cursor-passed app-server finals eligible", () => {
  const parent = {
    id: "wa-parent-live-recovery",
    role: "user",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-live-recovery",
    createdAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
  };
  const message = {
    id: "wa-final-live-recovery",
    role: "assistant",
    source: "codex-app-server",
    state: "completed",
    connector: "whatsapp",
    chatId: "chat-live-recovery",
    parentMessageId: parent.id,
    createdAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    cursor: 42,
  };
  const thread = {
    id: "thread-wa-live-recovery",
    binding: {
      connector: "whatsapp",
      enabled: true,
      routeEligible: true,
      mirrorToWhatsApp: true,
      chatId: "chat-live-recovery",
    },
  };
  const state = {
    inboundEvents: [{ messageId: parent.id, chatId: "chat-live-recovery" }],
    outboundMirrorCursors: [{
      messageSetKey: "thread||thread-wa-live-recovery",
      kind: "thread",
      threadId: "thread-wa-live-recovery",
      cursor: 42,
    }],
  };

  assert.equal(canRecoverLiveWhatsAppOutboundIntent({
    state,
    messageSetKey: "thread||thread-wa-live-recovery",
    messageCursor: 42,
    message,
    parent,
    thread,
    kind: "thread",
  }), true);
});

test("whatsapp delivery re-reads pending outbound intents after delivery claim clears", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-pending-intent-cache-"));
  const env = externalBridgeEnv(home);
  await createThread({ id: "thread-wa-pending-intent-cache", name: "WA Pending Intent Cache Thread" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-pending-intent-cache": "thread-wa-pending-intent-cache" },
  }, env);

  const routed = await routeWhatsAppInbound({ eventId: "wa-pending-intent-cache-1", chatId: "chat-pending-intent-cache", text: "current request" }, env);
  const reply = await appendThreadMessage("thread-wa-pending-intent-cache", {
    role: "assistant",
    source: "codex-rollout",
    phase: "final_answer",
    state: "completed",
    connector: "whatsapp",
    chatId: "chat-pending-intent-cache",
    parentMessageId: routed.message.id,
    text: "claim answer",
  }, env);

  const first = await deliverWhatsAppReplies(env, async () => {
    throw new Error("bridge temporarily unavailable");
  });
  assert.equal(first.failed.length, 1);

  const state = JSON.parse(await fs.readFile(path.join(home, "whatsapp.json"), "utf8"));
  const intent = state.outboundIntents.find((item) => item.messageId === reply.id);
  assert.equal(intent.status, "pending");
  const outbox = await readConnectorOutbox(env);
  const retryExpiredAt = new Date(Date.now() - 1000).toISOString();
  outbox.jobs = outbox.jobs.map((job) => job.sourceMessageId === reply.id ? {
    ...job,
    claimExpiresAt: retryExpiredAt,
    claimedBy: "",
    metadata: {
      ...(job.metadata || {}),
      retryAfterAt: retryExpiredAt,
    },
  } : job);
  await writeConnectorOutbox(outbox, env);

  const claimedAt = new Date().toISOString();
  const claim = await writeTestDeliveryClaim(home, {
    accountId: intent.accountId,
    chatId: intent.chatId,
    textKey: intent.textKey,
    claimedAt,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  const blocked = await deliverWhatsAppReplies(env, async () => {
    throw new Error("active delivery claim should prevent bridge send");
  });
  assert.equal(blocked.delivered.length, 0);
  assert.equal(blocked.failed.length, 0);
  assert.deepEqual(blocked.skipped.find((item) => item.messageId === reply.id)?.reason, "delivery_claim_active");

  await fs.unlink(claim.filePath);

  const calls = [];
  const second = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-after-claim"] });
  });

  assert.equal(second.delivered.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(stripDebugFooter(calls[0].body.text), "claim answer");
});

test("whatsapp delivery closes outbound intents when connector outbox is terminal skipped", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-terminal-outbox-intent-"));
  const env = externalBridgeEnv(home, { ORKESTR_WHATSAPP_DEBUG_FOOTER: "0", ORKESTR_CONNECTOR_OUTBOX_STORE: "json" });
  await createThread({ id: "thread-wa-terminal-outbox-intent", name: "WA Terminal Outbox Intent Thread" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-terminal-outbox-intent": "thread-wa-terminal-outbox-intent" },
  }, env);

  const routed = await routeWhatsAppInbound({ eventId: "wa-terminal-outbox-intent-1", chatId: "chat-terminal-outbox-intent", text: "current request" }, env);
  const reply = await appendThreadMessage("thread-wa-terminal-outbox-intent", {
    role: "assistant",
    source: "codex-rollout",
    phase: "final_answer",
    state: "completed",
    connector: "whatsapp",
    chatId: "chat-terminal-outbox-intent",
    parentMessageId: routed.message.id,
    text: "terminal answer",
  }, env);

  const first = await deliverWhatsAppReplies(env, async () => {
    throw new Error("bridge temporarily unavailable");
  });
  assert.equal(first.failed.length, 1);

  const outboxPath = dataPaths(env).connectorOutbox;
  const outboxStore = JSON.parse(await fs.readFile(outboxPath, "utf8"));
  const outboxJob = outboxStore.jobs.find((item) => item.sourceMessageId === reply.id);
  assert.equal(outboxJob.state, "failed_retryable");
  const skippedAt = new Date().toISOString();
  outboxJob.state = "skipped";
  outboxJob.skippedAt = skippedAt;
  outboxJob.terminalAt = skippedAt;
  outboxJob.error = "quarantined_stale_recovery_loop";
  outboxJob.claimedBy = "";
  outboxJob.claimedAt = "";
  outboxJob.claimExpiresAt = "";
  await fs.writeFile(outboxPath, JSON.stringify(outboxStore, null, 2) + "\n");

  const second = await deliverWhatsAppReplies(env, async () => {
    throw new Error("terminal connector outbox should prevent bridge send");
  });
  const state = JSON.parse(await fs.readFile(path.join(home, "whatsapp.json"), "utf8"));
  const intent = state.outboundIntents.find((item) => item.messageId === reply.id);

  assert.equal(second.delivered.length, 0);
  assert.equal(second.failed.length, 0);
  assert.deepEqual(second.skipped.find((item) => item.messageId === reply.id)?.reason, "connector_outbox_skipped");
  assert.equal(intent.status, "skipped");
  assert.equal(intent.error, "quarantined_stale_recovery_loop");
});

test("whatsapp delivery treats skipped outbound intents as terminal", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-intent-skipped-"));
  const env = externalBridgeEnv(home);
  await createThread({ id: "thread-wa-intent-skipped", name: "WA Skipped Intent Thread" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-intent-skipped": "thread-wa-intent-skipped" },
  }, env);

  const routed = await routeWhatsAppInbound({ eventId: "wa-intent-skipped-1", chatId: "chat-intent-skipped", text: "current request" }, env);
  const reply = await appendThreadMessage("thread-wa-intent-skipped", {
    role: "assistant",
    source: "codex-rollout",
    phase: "final_answer",
    state: "completed",
    connector: "whatsapp",
    chatId: "chat-intent-skipped",
    parentMessageId: routed.message.id,
    text: "current answer",
  }, env);

  await deliverWhatsAppReplies(env, async () => {
    throw new Error("bridge temporarily unavailable");
  });
  const state = JSON.parse(await fs.readFile(path.join(home, "whatsapp.json"), "utf8"));
  const intent = state.outboundIntents.find((item) => item.messageId === reply.id);
  intent.status = "skipped";
  intent.error = "superseded_runtime_interruption";
  await fs.writeFile(path.join(home, "whatsapp.json"), JSON.stringify(state, null, 2));

  const second = await deliverWhatsAppReplies(env, async () => {
    throw new Error("skipped outbound intent should not be retried");
  });

  assert.equal(second.delivered.length, 0);
  assert.deepEqual(second.skipped.find((item) => item.messageId === reply.id)?.reason, "superseded_runtime_interruption");
});

test("whatsapp delivery skips runtime interruption notices superseded by newer WA input", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-superseded-runtime-notice-"));
  const env = externalBridgeEnv(home);
  await createThread({
    id: "thread-wa-superseded-runtime-notice",
    name: "WA Superseded Runtime Notice Thread",
    binding: {
      connector: "whatsapp",
      chatId: "chat-superseded-runtime-notice",
      responderAccountId: "account-1",
      outboundAccountId: "account-1",
      mirrorToWhatsApp: true,
    },
  }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
  }, env);
  const baseMs = Date.now() - 60_000;
  await appendThreadMessage("thread-wa-superseded-runtime-notice", {
    role: "user",
    source: "whatsapp_inbound",
    state: "completed",
    deliveryState: "delivered",
    connector: "whatsapp",
    chatId: "chat-superseded-runtime-notice",
    accountId: "account-1",
    text: "Status?",
    createdAt: new Date(baseMs).toISOString(),
  }, env);
  const notice = await appendThreadMessage("thread-wa-superseded-runtime-notice", {
    role: "assistant",
    source: "orkestr_runtime",
    phase: "runtime_interrupted",
    state: "completed",
    text: "Codex response missing\n\nOrkestr found a delivered message with no assistant response.",
    createdAt: new Date(baseMs + 1000).toISOString(),
  }, env);
  await appendThreadMessage("thread-wa-superseded-runtime-notice", {
    role: "user",
    source: "whatsapp_inbound",
    state: "completed",
    deliveryState: "delivered",
    connector: "whatsapp",
    chatId: "chat-superseded-runtime-notice",
    accountId: "account-1",
    text: "Still broken! Please check if messages are delivered!!!!",
    createdAt: new Date(baseMs + 2000).toISOString(),
  }, env);

  const delivery = await deliverWhatsAppReplies(env, async () => {
    throw new Error("superseded runtime notice should not be sent");
  });

  assert.equal(delivery.delivered.length, 0);
  assert.deepEqual(delivery.skipped.find((item) => item.messageId === notice.id)?.reason, "superseded_runtime_interruption");
});

test("whatsapp delivery skips runtime interruption notices superseded by same-turn final answers", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-superseded-runtime-final-"));
  const env = externalBridgeEnv(home);
  await createThread({
    id: "thread-wa-superseded-runtime-final",
    name: "WA Superseded Runtime Final Thread",
    binding: {
      connector: "whatsapp",
      chatId: "chat-superseded-runtime-final",
      responderAccountId: "account-1",
      outboundAccountId: "account-1",
      mirrorToWhatsApp: true,
    },
  }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
  }, env);
  const baseMs = Date.now() - 60_000;
  const inbound = await appendThreadMessage("thread-wa-superseded-runtime-final", {
    role: "user",
    source: "whatsapp_inbound",
    state: "completed",
    deliveryState: "delivered",
    connector: "whatsapp",
    chatId: "chat-superseded-runtime-final",
    accountId: "account-1",
    text: "Status?",
    createdAt: new Date(baseMs).toISOString(),
  }, env);
  const final = await appendThreadMessage("thread-wa-superseded-runtime-final", {
    role: "assistant",
    source: "codex-app-server",
    phase: "final_answer",
    state: "completed",
    text: "Actual final answer.",
    parentMessageId: inbound.id,
    connector: "whatsapp",
    chatId: "chat-superseded-runtime-final",
    accountId: "account-1",
    createdAt: new Date(baseMs + 1000).toISOString(),
  }, env);
  const notice = await appendThreadMessage("thread-wa-superseded-runtime-final", {
    role: "assistant",
    source: "orkestr_runtime",
    phase: "runtime_interrupted",
    state: "completed",
    text: "Codex stopped before final answer\n\nOrkestr found a delivered message with no assistant response.",
    parentMessageId: inbound.id,
    connector: "whatsapp",
    chatId: "chat-superseded-runtime-final",
    accountId: "account-1",
    createdAt: new Date(baseMs + 2000).toISOString(),
  }, env);
  await fs.writeFile(path.join(home, "whatsapp.json"), JSON.stringify({
    outboundDeliveries: [{
      deliveryType: "final",
      messageId: final.id,
      parentMessageId: inbound.id,
      chatId: "chat-superseded-runtime-final",
      accountId: "account-1",
      deliveredAt: new Date(baseMs + 1500).toISOString(),
    }],
  }, null, 2));

  const delivery = await deliverWhatsAppReplies(env, async () => {
    throw new Error("superseded runtime notice should not be sent");
  });

  assert.equal(delivery.delivered.length, 0);
  assert.deepEqual(delivery.skipped.find((item) => item.messageId === notice.id)?.reason, "superseded_runtime_interruption");
});

test("whatsapp delivery does not backfill historical replies without outbound intents", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-no-historical-intent-"));
  const env = externalBridgeEnv(home, {
    ORKESTR_WHATSAPP_REPLY_BACKFILL_WINDOW_MS: String(24 * 60 * 60 * 1000),
  });
  await createThread({ id: "thread-wa-no-historical-intent", name: "WA No Historical Intent Thread" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-no-historical-intent": "thread-wa-no-historical-intent" },
  }, env);

  const oldAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const parent = await appendThreadMessage("thread-wa-no-historical-intent", {
    role: "user",
    source: "whatsapp_inbound",
    state: "completed",
    connector: "whatsapp",
    chatId: "chat-no-historical-intent",
    text: "old request inside old backfill window",
    createdAt: oldAt,
  }, env);
  const reply = await appendThreadMessage("thread-wa-no-historical-intent", {
    role: "assistant",
    source: "codex-rollout",
    phase: "final_answer",
    state: "completed",
    connector: "whatsapp",
    chatId: "chat-no-historical-intent",
    parentMessageId: parent.id,
    text: "old answer that should not be recovered by scan",
    createdAt: oldAt,
  }, env);

  const delivery = await deliverWhatsAppReplies(env, async () => {
    throw new Error("historical reply without an outbound intent should not be sent");
  });
  const state = JSON.parse(await fs.readFile(path.join(home, "whatsapp.json"), "utf8"));
  const second = await deliverWhatsAppReplies(env, async () => {
    throw new Error("historical reply should stay inert after cursor advances");
  });

  assert.equal(delivery.delivered.length, 0);
  assert.deepEqual(delivery.skipped.find((item) => item.messageId === reply.id)?.reason, "missing_outbound_intent");
  assert.equal((state.outboundIntents || []).some((item) => item.messageId === reply.id), false);
  assert.equal(state.outboundMirrorCursors.some((cursor) => cursor.threadId === "thread-wa-no-historical-intent"), true);
  assert.equal(second.delivered.length, 0);
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

test("whatsapp delivery sends allowed local paths as media attachments and does not replay them", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-path-attachment-"));
  const env = externalBridgeEnv(home);
  const paths = dataPaths(env);
  const uploadDir = path.join(paths.home, "uploads", "thread-wa-path-attachment");
  await fs.mkdir(uploadDir, { recursive: true });
  const reportPath = path.join(uploadDir, "report.txt");
  await fs.writeFile(reportPath, "report payload", "utf8");
  await createThread({ id: "thread-wa-path-attachment", name: "WA Path Attachment" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-path-attachment": "thread-wa-path-attachment" },
  }, env);

  const routed = await routeWhatsAppInbound({ eventId: "wa-path-attachment-1", chatId: "chat-path-attachment", text: "send report" }, env);
  const reply = await appendThreadMessage("thread-wa-path-attachment", {
    role: "assistant",
    source: "codex-rollout",
    phase: "final_answer",
    state: "completed",
    text: `Generated report: ${reportPath}`,
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-path-attachment",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-report"] });
  });
  const duplicate = await deliverWhatsAppReplies(env, async () => {
    throw new Error("should not resend path attachment");
  });
  const storedReply = (await listThreadMessages("thread-wa-path-attachment", env)).find((message) => message.id === reply.id);

  assert.equal(delivery.delivered.length, 1);
  assert.equal(duplicate.delivered.length, 0);
  assert.equal(calls[0].url.pathname, "/send-media");
  assert.deepEqual(calls[0].body.paths, [reportPath]);
  assert.match(stripDebugFooter(calls[0].body.text), new RegExp(reportPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(storedReply.attachments.length, 1);
  assert.match(storedReply.attachments[0].id, /^att_[a-f0-9]{32}$/);
  assert.equal(storedReply.attachments[0].filename, "report.txt");
});

test("whatsapp tenant relay sends local report links as inline bridge media instead of parent bridge paths", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-tenant-relay-attachment-"));
  const env = await externalBridgeEnvWithAllowingSanitizer(home, {
    WHATSAPP_BRIDGE_MODE: "relay",
    WHATSAPP_BRIDGE_URL: "http://wa.local",
    ORKESTR_TENANT_VM_ID: "firat-jobs-vm",
  });
  const workspace = path.join(home, "workspace", "firat-jobs");
  await fs.mkdir(workspace, { recursive: true });
  const reportPath = path.join(workspace, "job-search-report.md");
  await fs.writeFile(reportPath, "report payload", "utf8");
  await createThread({
    id: "thread-wa-tenant-relay-attachment",
    ownerUserId: "firat",
    name: "Firat Jobs",
    cwd: workspace,
    workspace,
  }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "relay",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-tenant-relay-attachment": "thread-wa-tenant-relay-attachment" },
  }, env);

  const routed = await routeWhatsAppInbound({ eventId: "wa-tenant-relay-attachment-1", chatId: "chat-tenant-relay-attachment", text: "send report" }, env);
  await appendThreadMessage("thread-wa-tenant-relay-attachment", {
    role: "assistant",
    source: "codex-rollout",
    phase: "final_answer",
    state: "completed",
    text: `Generated report: [job-search-report.md](${reportPath})`,
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-tenant-relay-attachment",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-report-link"] });
  });

  assert.equal(delivery.delivered.length, 1);
  assert.equal(delivery.failed.length, 0);
  assert.equal(calls[0].url.pathname, "/send-media");
  assert.equal(calls[0].body.paths, undefined);
  assert.equal(calls[0].body.attachments.length, 1);
  assert.equal(calls[0].body.attachments[0].filename, "job-search-report.md");
  assert.equal(calls[0].body.attachments[0].mimetype, "text/markdown");
  assert.equal(calls[0].body.attachments[0].size, "report payload".length);
  assert.equal(calls[0].body.attachments[0].sha256, crypto.createHash("sha256").update("report payload").digest("hex"));
  assert.equal(Buffer.from(calls[0].body.attachments[0].data, "base64").toString("utf8"), "report payload");
  assert.match(stripDebugFooter(calls[0].body.text), /job-search-report\.md/);
});

test("whatsapp delivery sends admin temp screenshots as media attachments", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-tmp-screenshot-"));
  const env = externalBridgeEnv(home, { ORKESTR_ADMIN_USER_ID: "admin" });
  const screenshotDir = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-screenshot-"));
  const screenshotPath = path.join(screenshotDir, "portal-mobile.png");
  await fs.writeFile(screenshotPath, "png payload", "utf8");
  await createThread({ id: "thread-wa-tmp-screenshot", ownerUserId: "admin", name: "WA Temp Screenshot" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-tmp-screenshot": "thread-wa-tmp-screenshot" },
  }, env);

  const routed = await routeWhatsAppInbound({ eventId: "wa-tmp-screenshot-1", chatId: "chat-tmp-screenshot", text: "send screenshot" }, env);
  const reply = await appendThreadMessage("thread-wa-tmp-screenshot", {
    role: "assistant",
    source: "codex-rollout",
    phase: "final_answer",
    state: "completed",
    text: `Screenshot: [mobile](${screenshotPath})`,
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-tmp-screenshot",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-screenshot"] });
  });
  const storedReply = (await listThreadMessages("thread-wa-tmp-screenshot", env)).find((message) => message.id === reply.id);

  assert.equal(delivery.delivered.length, 1);
  assert.equal(calls[0].url.pathname, "/send-media");
  assert.deepEqual(calls[0].body.paths, [screenshotPath]);
  assert.equal(delivery.delivered[0].attachments[0].filename, "portal-mobile.png");
  assert.equal(storedReply.attachments[0].mimetype, "image/png");
});

test("whatsapp delivery reports skipped local attachments in the outgoing text", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-skipped-attachment-"));
  const env = externalBridgeEnv(home);
  await createThread({ id: "thread-wa-skipped-attachment", name: "WA Skipped Attachment" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-skipped-attachment": "thread-wa-skipped-attachment" },
  }, env);

  const routed = await routeWhatsAppInbound({ eventId: "wa-skipped-attachment-1", chatId: "chat-skipped-attachment", text: "send report" }, env);
  await appendThreadMessage("thread-wa-skipped-attachment", {
    role: "assistant",
    source: "codex-rollout",
    phase: "final_answer",
    state: "completed",
    text: "Generated report: /etc/passwd",
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-skipped-attachment",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-skipped-note"] });
  });

  assert.equal(delivery.delivered.length, 1);
  assert.equal(calls[0].url.pathname, "/send-text");
  assert.match(stripDebugFooter(calls[0].body.text), /Attachment not sent:\n- \/etc\/passwd: attachment path not allowed/);
});

test("whatsapp delivery does not report code links, routes, or directories as skipped attachments", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-reference-paths-"));
  const env = externalBridgeEnv(home);
  const workspace = path.join(home, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  const filePath = path.join(workspace, "index.html");
  await fs.writeFile(filePath, "<main></main>", "utf8");
  await createThread({
    id: "thread-wa-reference-paths",
    name: "WA Reference Paths",
    cwd: workspace,
    workspace,
  }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-reference-paths": "thread-wa-reference-paths" },
  }, env);

  const routed = await routeWhatsAppInbound({ eventId: "wa-reference-paths-1", chatId: "chat-reference-paths", text: "what changed?" }, env);
  await appendThreadMessage("thread-wa-reference-paths", {
    role: "assistant",
    source: "codex-rollout",
    phase: "final_answer",
    state: "completed",
    text: [
      `Updated [index.html](${filePath}:120).`,
      `Workspace: ${workspace}`,
      "Routes: /api/leads and /api/events",
    ].join("\n"),
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-reference-paths",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-reference-paths"] });
  });
  const visibleText = stripDebugFooter(calls[0].body.text);

  assert.equal(delivery.delivered.length, 1);
  assert.equal(calls[0].url.pathname, "/send-text");
  assert.equal(calls[0].body.paths, undefined);
  assert.match(visibleText, /\/api\/leads/);
  assert.doesNotMatch(visibleText, /Attachment not sent:/);
});

test("whatsapp delivery exposes allowed local paths for user-owned chats while sending media", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-user-path-redaction-"));
  const env = await externalBridgeEnvWithAllowingSanitizer(home, { ORKESTR_ADMIN_USER_ID: "admin" });
  const paths = dataPaths(env);
  const uploadDir = path.join(paths.home, "uploads", "thread-wa-user-path-redaction");
  await fs.mkdir(uploadDir, { recursive: true });
  const reportPath = path.join(uploadDir, "report.txt");
  await fs.writeFile(reportPath, "report payload", "utf8");
  await createThread({ id: "thread-wa-user-path-redaction", ownerUserId: "alice", name: "WA User Path Redaction" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-user-path-redaction": "thread-wa-user-path-redaction" },
  }, env);

  const routed = await routeWhatsAppInbound({ eventId: "wa-user-path-redaction-1", chatId: "chat-user-path-redaction", text: "send report" }, env);
  const reply = await appendThreadMessage("thread-wa-user-path-redaction", {
    role: "assistant",
    source: "codex-rollout",
    phase: "final_answer",
    state: "completed",
    text: `Generated report: ${reportPath}`,
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-user-path-redaction",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-user-report"] });
  });
  const storedReply = (await listThreadMessages("thread-wa-user-path-redaction", env)).find((message) => message.id === reply.id);
  const visibleText = stripDebugFooter(calls[0].body.text);

  assert.equal(delivery.delivered.length, 1);
  assert.equal(calls[0].url.pathname, "/send-media");
  assert.deepEqual(calls[0].body.paths, [reportPath]);
  assert.match(visibleText, new RegExp(reportPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(visibleText, /\[local file path omitted]/);
  assert.equal(storedReply.attachments.length, 1);
  assert.equal(storedReply.attachments[0].filename, "report.txt");
});

test("whatsapp delivery exposes allowed local paths for admin-role thread owners", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-admin-role-path-"));
  const env = await externalBridgeEnvWithAllowingSanitizer(home, { ORKESTR_ADMIN_USER_ID: "root-admin" });
  const paths = dataPaths(env);
  const uploadDir = path.join(paths.home, "uploads", "thread-wa-admin-role-path");
  await fs.mkdir(uploadDir, { recursive: true });
  const reportPath = path.join(uploadDir, "report.txt");
  await fs.writeFile(reportPath, "report payload", "utf8");
  await createUser({ id: "otcan", role: "admin", displayName: "Otcan Admin" }, env);
  await createThread({ id: "thread-wa-admin-role-path", ownerUserId: "otcan", name: "WA Admin Role Path" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-admin-role-path": "thread-wa-admin-role-path" },
  }, env);

  const routed = await routeWhatsAppInbound({ eventId: "wa-admin-role-path-1", chatId: "chat-admin-role-path", text: "send report" }, env);
  const reply = await appendThreadMessage("thread-wa-admin-role-path", {
    role: "assistant",
    source: "codex-rollout",
    phase: "final_answer",
    state: "completed",
    text: `Generated report: ${reportPath}`,
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-admin-role-path",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-admin-role-report"] });
  });
  const storedReply = (await listThreadMessages("thread-wa-admin-role-path", env)).find((message) => message.id === reply.id);
  const visibleText = stripDebugFooter(calls[0].body.text);

  assert.equal(delivery.delivered.length, 1);
  assert.equal(calls[0].url.pathname, "/send-media");
  assert.deepEqual(calls[0].body.paths, [reportPath]);
  assert.match(visibleText, new RegExp(reportPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(visibleText, /\[local file path omitted]/);
  assert.equal(storedReply.attachments.length, 1);
  assert.equal(storedReply.attachments[0].filename, "report.txt");
});

test("whatsapp delivery skips forbidden local paths without omitting them from outbound text", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-forbidden-path-"));
  const env = externalBridgeEnv(home);
  const paths = dataPaths(env);
  await fs.mkdir(paths.secrets, { recursive: true });
  const secretPath = path.join(paths.secrets, "token.txt");
  await fs.writeFile(secretPath, "secret", "utf8");
  await createThread({ id: "thread-wa-forbidden-path", name: "WA Forbidden Path" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-forbidden-path": "thread-wa-forbidden-path" },
  }, env);

  const routed = await routeWhatsAppInbound({ eventId: "wa-forbidden-path-1", chatId: "chat-forbidden-path", text: "send report" }, env);
  await appendThreadMessage("thread-wa-forbidden-path", {
    role: "assistant",
    source: "codex-rollout",
    phase: "final_answer",
    state: "completed",
    text: `Secret path: ${secretPath}`,
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-forbidden-path",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-redacted"] });
  });

  assert.equal(delivery.delivered.length, 1);
  assert.equal(calls[0].url.pathname, "/send-text");
  assert.equal(calls[0].body.paths, undefined);
  assert.match(calls[0].body.text, new RegExp(secretPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(calls[0].body.text, /\[local file path omitted]/);
});

test("whatsapp delivery preserves recovery slash commands in outbound text", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-recovery-slash-command-"));
  const env = await externalBridgeEnvWithAllowingSanitizer(home, { ORKESTR_ADMIN_USER_ID: "admin" });
  await createThread({ id: "thread-wa-recovery-slash-command", ownerUserId: "alice", name: "WA Recovery Slash Command" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-recovery-slash-command": "thread-wa-recovery-slash-command" },
  }, env);

  const routed = await routeWhatsAppInbound({ eventId: "wa-recovery-slash-command-1", chatId: "chat-recovery-slash-command", text: "status?" }, env);
  await appendThreadMessage("thread-wa-recovery-slash-command", {
    role: "assistant",
    source: "codex-app-server-recovery",
    phase: "final_answer",
    state: "completed",
    text: "If this repeats, reply /safe-reset to save recent Orkestr context and start a fresh Codex session. You can also use /now, /implement, /codex, /connect google, or /help.",
    parentMessageId: routed.message.id,
    connector: "whatsapp",
    chatId: "chat-recovery-slash-command",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-recovery-command"] });
  });
  const visibleText = stripDebugFooter(calls[0].body.text);

  assert.equal(delivery.delivered.length, 1);
  assert.equal(calls[0].url.pathname, "/send-text");
  assert.match(visibleText, /reply \/safe-reset/);
  assert.match(visibleText, /\/now, \/implement, \/codex, \/connect google, or \/help/);
  assert.doesNotMatch(visibleText, /\[local file path omitted]/);
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

test("whatsapp delivery mirrors proposed plans with WhatsApp-safe formatting", async () => {
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

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-proposed-plan"] });
  });

  assert.equal(delivery.delivered.length, 1);
  assert.equal(delivery.delivered[0].deliveryType, "final");
  assert.equal(stripDebugFooter(calls[0].body.text), "Plan\n\nDo it");
  assertDebugFooter(calls[0].body.text, { messageType: "final" });
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
  assert.match(calls[0].body.text, new RegExp(`Trace: ${routed.message.routerTraceId}`));
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
  assert.match(stripDebugFooter(calls[0].body.text), /^Runtime handoff is taking longer than expected: "ship it"\./);
  assert.match(stripDebugFooter(calls[0].body.text), new RegExp(`Trace: ${routed.message.routerTraceId}`));
  assertDebugFooter(calls[0].body.text, { messageType: "update", model: "gpt-5.5/h", queueReason: "handoff-delayed" });
  assert.doesNotMatch(calls[0].body.text, /q:0/);
  assert.equal(messages.find((entry) => entry.id === routed.message.id).state, "queued");
});

test("whatsapp delivery does not report ready app-server handoff as a queue notice", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-ready-app-server-no-notice-"));
  const env = externalBridgeEnv(home);
  await createThread({
    id: "thread-wa-ready-app-server-no-notice",
    name: "WA Ready App Server No Notice Thread",
    runtimeKind: "codex-app-server",
  }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-ready-app-server-no-notice": "thread-wa-ready-app-server-no-notice" },
  }, env);
  const routed = await routeWhatsAppInbound({
    eventId: "wa-ready-app-server-no-notice-1",
    chatId: "chat-ready-app-server-no-notice",
    accountId: "account-1",
    text: "send normally",
  }, env);
  await updateThreadMessage("thread-wa-ready-app-server-no-notice", routed.message.id, {
    state: "queued",
    deliveryState: "",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["unexpected-ready-queue-notice"] });
  });

  assert.equal(delivery.delivered.length, 0);
  assert.equal(delivery.failed.length, 0);
  assert.equal(calls.length, 0);
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
  const safeReset = await appendThreadMessage("thread-wa-recovery-action", {
    role: "user",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "chat-recovery-action",
    accountId: "account-1",
    text: "/safe-reset",
    state: "completed",
    deliveryState: "delivered",
    observedVia: "orkestr_safe_reset_command",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: [`sent-recovery-action-${calls.length}`] });
  });
  const duplicate = await deliverWhatsAppReplies(env, async () => {
    throw new Error("should not resend recovery action notices");
  });

  assert.equal(delivery.delivered.length, 3);
  assert.deepEqual(delivery.delivered.map((entry) => entry.deliveryType), ["router_update", "queue_notice", "router_update"]);
  assert.deepEqual(delivery.delivered.map((entry) => entry.routerUpdateType || ""), ["recovery_action_requested", "", "recovery_action_requested"]);
  assert.equal(delivery.delivered[0].sourceMessageId, restart.id);
  assert.equal(delivery.delivered[1].sourceMessageId, now.id);
  assert.equal(delivery.delivered[2].sourceMessageId, safeReset.id);
  assert.equal(duplicate.delivered.length, 0);
  assert.equal(calls.every((call) => call.body.to === "chat-recovery-action"), true);
  assert.match(stripDebugFooter(calls[0].body.text), /^Restart requested\.\n\nOrkestr reset the current Codex runtime and resumed the thread\./);
  assert.match(stripDebugFooter(calls[1].body.text), /^Interrupting the current Codex turn and queued your message: "fix the pairing number"\./);
  assert.match(stripDebugFooter(calls[2].body.text), /^Safe reset requested\.\n\nOrkestr saved recent Orkestr context and started a fresh Codex session for this thread\./);
  assertDebugFooter(calls[0].body.text, { messageType: "update" });
  assertDebugFooter(calls[1].body.text, { messageType: "update", queueReason: "interrupting" });
  assertDebugFooter(calls[2].body.text, { messageType: "update" });
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

test("whatsapp router update notices strip pasted debug footers from previews", () => {
  const target = routerUpdateWhatsAppDeliveryTarget({
    message: {
      id: "wa-router-update-footer",
      role: "user",
      source: "whatsapp_inbound",
      connector: "whatsapp",
      chatId: "chat-router-update-footer",
      text: "please continue\n\ndbg: m:gpt-5.5/xh · msg:update · q:0 · load:25% · api:122% · help:/help",
      state: "awaiting_ack",
      deliveryState: "blocked_frozen_runtime",
    },
    thread: {},
    state: {},
    kind: "thread",
  });

  assert.equal(target.routerUpdateType, "blocked_frozen_runtime");
  assert.match(target.text, /Your message is blocked until the pane changes or you request a manual recovery: "please continue"\./);
  assert.doesNotMatch(target.text, /dbg:/);
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

test("whatsapp /status replies from the router without queuing runtime work", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-status-command-"));
  const env = externalBridgeEnv(home);
  await createThread({
    id: "thread-wa-status-command",
    name: "WA Status Command Thread",
    runtimeKind: "codex-app-server",
    binding: {
      connector: "whatsapp",
      chatId: "chat-status-command",
      enabled: true,
    },
  }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
  }, env);

  const routed = await routeWhatsAppInbound({
    eventId: "wa-status-command-1",
    chatId: "chat-status-command",
    accountId: "account-1",
    text: "/status",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-status-command"] });
  });
  const messages = await listThreadMessages("thread-wa-status-command", env);
  const userMessage = messages.find((message) => message.id === routed.message.id);
  const reply = messages.find((message) => message.parentMessageId === routed.message.id && message.source === "whatsapp_router");

  assert.equal(routed.handledCommand, "status");
  assert.equal(userMessage.state, "completed");
  assert.equal(userMessage.observedVia, "whatsapp_router_status_command");
  assert.ok(reply);
  assert.match(reply.text, /^Thread: WA Status Command Thread\nStatus: /);
  assert.match(reply.text, /\nRuntime: Codex API\n/);
  assert.equal(messages.some((message) => message.role === "user" && message.state === "queued"), false);
  assert.equal(delivery.delivered.length, 1);
  assert.equal(calls[0].body.to, "chat-status-command");
  assert.match(stripDebugFooter(calls[0].body.text), /^Thread: WA Status Command Thread\nStatus: /);
});

test("whatsapp /status reuses the first router reply when inbound state misses a duplicate", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-status-command-duplicate-"));
  const env = externalBridgeEnv(home);
  await createThread({
    id: "thread-wa-status-command-duplicate",
    name: "WA Status Command Duplicate Thread",
    runtimeKind: "codex-app-server",
    binding: {
      connector: "whatsapp",
      chatId: "chat-status-command-duplicate",
      enabled: true,
    },
  }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
  }, env);
  const inbound = {
    eventId: "false_chat-status-command-duplicate_msg-1_sender",
    chatId: "chat-status-command-duplicate",
    from: "sender",
    accountId: "account-1",
    text: "/status",
  };

  const first = await routeWhatsAppInbound(inbound, env);
  await fs.writeFile(dataPaths(env).whatsapp, JSON.stringify({ inboundEvents: [] }, null, 2));
  const second = await routeWhatsAppInbound(inbound, env);
  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-status-command-duplicate"] });
  });
  const duplicateDelivery = await deliverWhatsAppReplies(env, async () => {
    throw new Error("should not resend duplicate status command reply");
  });
  const messages = await listThreadMessages("thread-wa-status-command-duplicate", env);
  const replies = messages.filter((message) =>
    message.role === "assistant" &&
    message.source === "whatsapp_router" &&
    message.parentMessageId === first.message.id
  );

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.message.id, first.message.id);
  assert.equal(second.assistantMessage.id, first.assistantMessage.id);
  assert.equal(messages.filter((message) => message.role === "user" && message.observedVia === "whatsapp_router_status_command").length, 1);
  assert.equal(replies.length, 1);
  assert.equal(delivery.delivered.length, 1);
  assert.equal(duplicateDelivery.delivered.length, 0);
  assert.equal(calls.length, 1);
  assert.match(stripDebugFooter(calls[0].body.text), /^Thread: WA Status Command Duplicate Thread\nStatus: /);
});

test("whatsapp /now inputs default to steer without interrupt queue notices", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-now-notice-"));
  const env = externalBridgeEnv(home);
  await createThread({
    id: "thread-wa-now-notice",
    name: "WA Now Notice Thread",
    runtimeKind: "codex-app-server",
    executor: { transport: "app-server", metadata: { runtimeKind: "codex-app-server" } },
  }, env);
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

  assert.equal(routed.message.codexDeliveryMode, "instant_steer");
  assert.equal(routed.message.steerActiveTurn, true);
  assert.notEqual(routed.message.deliveryState, "interrupting");
  assert.equal(delivery.delivered.length, 0);
  assert.equal(calls.length, 0);
});

test("whatsapp inbound marks Codex API threads for default active-turn steer", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-instant-steer-"));
  const env = externalBridgeEnv(home);
  await createThread({
    id: "thread-wa-instant-steer",
    name: "WA Instant Steer Thread",
    runtimeKind: "codex-app-server",
    binding: {
      connector: "whatsapp",
      chatId: "chat-instant-steer",
      enabled: true,
    },
  }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
  }, env);

  const routed = await routeWhatsAppInbound({
    eventId: "wa-instant-steer-1",
    chatId: "chat-instant-steer",
    accountId: "account-1",
    text: "this should steer the active turn",
  }, env);

  assert.equal(routed.threadId, "thread-wa-instant-steer");
  assert.equal(routed.message.codexDeliveryMode, "instant_steer");
  assert.equal(routed.message.steerActiveTurn, true);
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
  assert.match(stripDebugFooter(calls[0].body.text), /^Waking this thread\. Your message will run after startup: "wake test"\./);
  assertDebugFooter(calls[0].body.text, { messageType: "update", queueReason: "waking" });
});

test("whatsapp queue notices use app-server runtime states", () => {
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
    state: "working",
    runtimeKind: "codex-app-server",
    activeTurnId: "turn-1",
  }, { text: "steer into the turn", codexDeliveryMode: "instant_steer", steerActiveTurn: true }), "");
  assert.equal(initialQueueDeliveryState({
    state: "sleeping",
    runtimeKind: "codex-app-server",
  }, { text: "resume app server" }), "waking");
  assert.equal(initialQueueDeliveryState({
    state: "ready",
    runtimeKind: "codex-tmux",
    sessionName: null,
    promptReady: true,
  }, { text: "wake tmux" }), "waiting_runtime_start");
});

test("whatsapp queue notices strip pasted debug footers from previews", () => {
  const notice = formatWhatsAppQueueNotice({
    text: "Codex compacted the conversation context.\n\ndbg: m:gpt-5.5/xh · msg:update · q:0 · load:25% · api:122% · help:/help",
  }, "awaiting_active_turn");

  assert.equal(notice, 'Added after the current Codex turn: "Codex compacted the conversation context.". Use /now to steer into the active turn.');
  assert.doesNotMatch(notice, /dbg:/);
});

test("whatsapp queue notices include an opaque trace reference when available", () => {
  const notice = formatWhatsAppQueueNotice({
    text: "ship it",
    routerTraceId: "rt_trace_123",
  }, "waiting_runtime_ready");

  assert.equal(notice, 'Runtime handoff is taking longer than expected: "ship it".\nTrace: rt_trace_123');
});

test("whatsapp queue notices unwrap nested queue notice previews", () => {
  const notice = formatWhatsAppQueueNotice({
    text: 'Queued for the next Codex turn: "Queued for the next Codex turn: "Queued your message while Orkestr prepares this thread: "I’m treating this as a release hygiene issue: WA mi...".".".',
  }, "awaiting_active_turn");

  assert.equal(notice, 'Added after the current Codex turn: "I’m treating this as a release hygiene issue: WA mi...". Use /now to steer into the active turn.');
});

test("whatsapp queue notices unwrap malformed nested queue notice previews", () => {
  const notice = formatWhatsAppQueueNotice({
    text: 'Queued your message while Orkestr prepares this thread: "Queued for the next Codex turn: "Queued for the next Codex turn: "Codex compacted the conversation context.".',
  }, "awaiting_active_turn");

  assert.equal(notice, 'Added after the current Codex turn: "Codex compacted the conversation context.". Use /now to steer into the active turn.');
});

test("whatsapp queue notices suppress generated truncated queue previews", () => {
  const notice = formatWhatsAppQueueNotice({
    text: 'Queued your message while Orkestr prepares this thread: "Queued for the next Codex turn: "Queued for the next Codex turn: "Queued for the next Codex turn: "Queued for the nex...".',
  }, "awaiting_active_turn");

  assert.equal(notice, "Added after the current Codex turn. Use /now to steer into the active turn.");
});

test("whatsapp delivery reports app-server active-turn queue notices", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-app-server-active-queue-notice-"));
  const env = externalBridgeEnv(home);
  await createThread({
    id: "thread-wa-app-server-active-queue-notice",
    name: "WA App Server Active Queue Notice Thread",
    runtimeKind: "codex-app-server",
  }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-app-server-active-queue-notice": "thread-wa-app-server-active-queue-notice" },
  }, env);
  const routed = await routeWhatsAppInbound({
    eventId: "wa-app-server-active-queue-notice-1",
    chatId: "chat-app-server-active-queue-notice",
    text: "queue behind app server turn",
  }, env);
  await updateThreadMessage("thread-wa-app-server-active-queue-notice", routed.message.id, {
    state: "queued",
    deliveryState: "awaiting_active_turn",
  }, env);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-app-server-queue-notice"] });
  });
  const duplicate = await deliverWhatsAppReplies(env, async () => {
    throw new Error("should not resend app-server active-turn queue notice");
  });
  const messages = await listThreadMessages("thread-wa-app-server-active-queue-notice", env);

  assert.equal(delivery.delivered.length, 1);
  assert.equal(delivery.delivered[0].deliveryType, "queue_notice");
  assert.equal(delivery.delivered[0].sourceMessageId, routed.message.id);
  assert.equal(duplicate.delivered.length, 0);
  assert.equal(calls[0].body.to, "chat-app-server-active-queue-notice");
  assert.match(stripDebugFooter(calls[0].body.text), /^Added after the current Codex turn: "queue behind app server turn"\. Use \/now to steer into the active turn\./);
  assertDebugFooter(calls[0].body.text, { messageType: "update", queueReason: "active-turn" });
  assert.equal(messages.find((entry) => entry.id === routed.message.id).state, "queued");
});

test("whatsapp inbound ignores generated queue notices with trace and debug footer", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-ignore-generated-queue-notice-"));
  const env = externalBridgeEnv(home);
  await createThread({
    id: "thread-wa-ignore-generated-queue-notice",
    name: "WA Ignore Generated Queue Notice Thread",
    runtimeKind: "codex-app-server",
  }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-ignore-generated-queue-notice": "thread-wa-ignore-generated-queue-notice" },
  }, env);

  const notices = [
    `Added after the current Codex turn: "queue behind app server turn". Use /now to steer into the active turn.
Trace: rt_trace_123

dbg: m:unknown · rt:api · msg:update · queue:20 · reason:active-turn`,
    `Runtime handoff is taking longer than expected: "start the agent".
Trace: rt_trace_456

dbg: m:unknown · rt:api · msg:update · q:0`,
  ];
  for (const [index, text] of notices.entries()) {
    const routed = await routeWhatsAppInbound({
      eventId: `wa-ignore-generated-queue-notice-${index + 1}`,
      chatId: "chat-ignore-generated-queue-notice",
      accountId: "account-1",
      fromMe: false,
      text,
    }, env);
    assert.equal(routed.skipped, true);
    assert.equal(routed.ignoredGeneratedQueueNotice, true);
  }

  const messages = await listThreadMessages("thread-wa-ignore-generated-queue-notice", env);
  assert.equal(messages.length, 0);
});

test("whatsapp delivery suppresses premature api-agent runtime-ready queue notices", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-api-agent-handoff-notice-"));
  const env = externalBridgeEnv(home);
  await createThread({
    id: "thread-wa-api-agent-handoff-notice",
    name: "WA API Agent Handoff Notice Thread",
    runtimeKind: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
  }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-api-agent-handoff-notice": "thread-wa-api-agent-handoff-notice" },
  }, env);
  const routed = await routeWhatsAppInbound({
    eventId: "wa-api-agent-handoff-notice-1",
    chatId: "chat-api-agent-handoff-notice",
    text: "Do I have a virtual desk?",
  }, env);
  await updateThreadMessage("thread-wa-api-agent-handoff-notice", routed.message.id, {
    state: "queued",
    deliveryState: "waiting_runtime_ready",
  }, env);

  const delivery = await deliverWhatsAppReplies(env, async () => {
    throw new Error("api-agent handoff notice should not be mirrored");
  });

  assert.equal(delivery.delivered.length, 0);
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

test("whatsapp passive mirror does not complete a newer input with an older reparented runtime notice", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-passive-stale-notice-"));
  const env = externalBridgeEnv(home);
  await createThread({ id: "thread-wa-passive-stale-notice", name: "WA Passive Stale Notice" }, env);
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    threadRoutes: { "chat-passive-stale-notice": "thread-wa-passive-stale-notice" },
  }, env);

  const first = await routeWhatsAppInbound({ eventId: "wa-passive-stale-1", chatId: "chat-passive-stale-notice", text: "status?" }, env);
  const notice = await appendThreadMessage("thread-wa-passive-stale-notice", {
    role: "assistant",
    source: "orkestr_runtime",
    phase: "runtime_interrupted",
    state: "completed",
    text: "Codex conversation interrupted\n\nCodex reported that the active turn was interrupted.",
    parentMessageId: first.message.id,
    connector: "whatsapp",
    chatId: "chat-passive-stale-notice",
    accountId: "account-1",
  }, env);
  await deliverWhatsAppReplies(env, async () => response({ ok: true, ids: ["sent-stale-notice-original"] }));

  const second = await routeWhatsAppInbound({ eventId: "wa-passive-stale-2", chatId: "chat-passive-stale-notice", text: "continue working" }, env);
  await updateThreadMessage("thread-wa-passive-stale-notice", notice.id, {
    parentMessageId: second.message.id,
    revision: 2,
  }, env);

  const delivery = await deliverWhatsAppReplies(env, async () => response({ ok: true, ids: ["sent-stale-queue-notice"] }));
  const messages = await listThreadMessages("thread-wa-passive-stale-notice", env);
  const parent = messages.find((entry) => entry.id === second.message.id);

  assert.equal(delivery.skipped.some((item) => item.messageId === second.message.id && item.reason === "assistant_reply_available"), false);
  assert.equal(parent.state, "queued");
  assert.notEqual(parent.observedVia, "whatsapp_passive_mirror_delivery");
  assert.notEqual(parent.passiveMirrorMessageId, notice.id);
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

test("whatsapp inbound honors selected registry binding over disabled legacy thread binding", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-registry-over-legacy-binding-"));
  const env = externalBridgeEnv(home, { ORKESTR_WHATSAPP_ACCOUNT_IDS: "registry-responder" });
  setLocalWhatsAppRuntimeForTest("registry-responder", {
    client: { info: { wid: { _serialized: "registry-responder@c.us" } } },
  }, { ready: true }, env);
  try {
    await createThread({
      id: "registry-bound-thread",
      name: "Registry Bound Thread",
      binding: {
        connector: "whatsapp",
        chatId: "chat-registry-bound",
        displayName: "Stale Disabled Chat",
        enabled: false,
        routeEligible: true,
        outboundAccountId: "old-responder",
      },
    }, env);
    await upsertWhatsAppBinding({
      level: "chat",
      threadId: "registry-bound-thread",
      chatId: "chat-registry-bound",
      displayName: "Selected Registry Chat",
      accountId: "registry-responder",
      enabled: true,
      routeEligible: true,
    }, env);

    const routed = await routeWhatsAppInbound({
      eventId: "wa-registry-over-legacy-1",
      chatId: "chat-registry-bound",
      accountId: "registry-responder",
      text: "registry-selected message",
    }, env);
    const messages = await listThreadMessages("registry-bound-thread", env);

    assert.equal(routed.threadId, "registry-bound-thread");
    assert.equal(routed.ignoredDisabledBinding, undefined);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].accountId, "registry-responder");
    assert.equal(messages[0].text, "registry-selected message");
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("whatsapp direct bindings can receive responder-observed inbound", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-direct-responder-observed-"));
  const env = externalBridgeEnv(home, { ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender,responder" });
  await createThread({
    id: "direct-responder-observed-thread",
    name: "Direct Responder Observed",
    binding: {
      connector: "whatsapp",
      chatId: "sender-lid@lid",
      displayName: "Direct Chat",
      enabled: true,
      responderAccountId: "responder",
      outboundAccountId: "responder",
    },
  }, env);

  const routed = await routeWhatsAppInbound({
    eventId: "false_sender-lid@lid_direct-message",
    chatId: "sender-lid@lid",
    accountId: "responder",
    from: "sender-lid@lid",
    fromMe: false,
    text: "/connect google",
  }, env);
  const messages = await listThreadMessages("direct-responder-observed-thread", env);
  const userMessages = messages.filter((message) => message.role === "user");

  assert.equal(routed.threadId, "direct-responder-observed-thread");
  assert.equal(routed.ignoredNonSenderAccount, undefined);
  assert.equal(userMessages.length, 1);
  assert.equal(userMessages[0].text, "/connect google");
  assert.equal(userMessages[0].accountId, "responder");
  assert.equal(userMessages[0].from, "sender-lid@lid");
});

test("whatsapp inbound fails closed for ambiguous thread bindings", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-binding-ambiguous-route-"));
  const env = externalBridgeEnv(home);
  await createThread({
    id: "bound-thread-a",
    name: "Bound Thread A",
    binding: {
      connector: "whatsapp",
      chatId: "chat-ambiguous",
      displayName: "Ambiguous Chat A",
      enabled: true,
      routeEligible: true,
      outboundAccountId: "bound-account-a",
    },
  }, env);
  await createThread({
    id: "bound-thread-b",
    name: "Bound Thread B",
    binding: {
      connector: "whatsapp",
      chatId: "chat-ambiguous",
      displayName: "Ambiguous Chat B",
      enabled: true,
      routeEligible: true,
      outboundAccountId: "bound-account-b",
    },
  }, env);

  await assert.rejects(
    () => routeWhatsAppInbound({ eventId: "wa-ambiguous-1", chatId: "chat-ambiguous", text: "do not guess" }, env),
    (error) => {
      assert.equal(error.message, "wa_binding_ambiguous");
      assert.equal(error.statusCode, 409);
      assert.equal(error.routingFailure.code, "wa_binding_ambiguous");
      assert.equal(error.routingFailure.chatId, "chat-ambiguous");
      assert.match(error.routingFailure.bindingId, /bound-thread-a/);
      assert.match(error.routingFailure.bindingId, /bound-thread-b/);
      return true;
    },
  );
  assert.deepEqual(await listThreadMessages("bound-thread-a", env), []);
  assert.deepEqual(await listThreadMessages("bound-thread-b", env), []);
});

test("whatsapp inbound skips explicit disabled thread bindings", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-disabled-binding-"));
  const env = externalBridgeEnv(home);
  await createThread({
    id: "disabled-bound-thread",
    name: "Disabled Bound Thread",
    binding: {
      connector: "whatsapp",
      chatId: "chat-disabled-bound",
      displayName: "Disabled Bound Chat",
      enabled: false,
      routeEligible: true,
      outboundAccountId: "bound-account",
    },
  }, env);

  const routed = await routeWhatsAppInbound({
    eventId: "wa-disabled-bound-1",
    threadId: "disabled-bound-thread",
    chatId: "chat-disabled-bound",
    accountId: "bound-account",
    text: "stale recovered echo",
  }, env);
  const messages = await listThreadMessages("disabled-bound-thread", env);

  assert.equal(routed.skipped, true);
  assert.equal(routed.ignoredDisabledBinding, true);
  assert.equal(messages.length, 0);
});

test("whatsapp inbound receive ACL denies scoped tokens outside binding grant", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-binding-receive-acl-"));
  const env = externalBridgeEnv(home);
  await createThread({
    id: "receive-acl-thread",
    name: "Receive ACL Thread",
    binding: {
      connector: "whatsapp",
      chatId: "chat-receive-acl",
      displayName: "Receive ACL Chat",
      enabled: true,
      outboundAccountId: "bound-account",
      acl: {
        receive: { mode: "users", users: ["remote-inbound"] },
      },
    },
  }, env);

  await assert.rejects(
    () => routeWhatsAppInbound({
      eventId: "wa-receive-acl-denied",
      chatId: "chat-receive-acl",
      accountId: "bound-account",
      text: "blocked",
      machineAuthContext: { principalId: "other-remote", chatId: "chat-receive-acl", accountId: "bound-account" },
    }, env),
    /wa_acl_denied/,
  );
  const routed = await routeWhatsAppInbound({
    eventId: "wa-receive-acl-allowed",
    chatId: "chat-receive-acl",
    accountId: "bound-account",
    text: "allowed",
    machineAuthContext: { principalId: "remote-inbound", chatId: "chat-receive-acl", accountId: "bound-account" },
  }, env);
  const messages = await listThreadMessages("receive-acl-thread", env);

  assert.equal(routed.threadId, "receive-acl-thread");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, "allowed");
});

test("whatsapp /connect google creates a user-scoped workspace oauth link", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-google-connect-"));
  const env = externalBridgeEnv(home, {
    ORKESTR_CONNECT_PUBLIC_URL: "https://connect.example.test",
  });
  await createUser({
    id: "alice",
    displayName: "Alice",
    email: "alice-profile@example.com",
    phoneNumber: "+15550100",
  }, env);
  await linkUserPrivateIdentity("alice", {
    provider: "gmail",
    accountId: "alice-gmail@example.com",
    externalId: "alice-gmail@example.com",
  }, { env });
  await createThread({
    id: "google-connect-thread",
    name: "Google Connect Thread",
    ownerUserId: "alice",
    runtimeKind: "api-agent",
    executorId: "api-agent",
    executor: { type: "api-agent", metadata: { runtimeKind: "api-agent" } },
    binding: {
      connector: "whatsapp",
      chatId: "chat-google-connect",
      displayName: "Google Connect Chat",
      enabled: true,
      outboundAccountId: "bound-account",
    },
  }, env);

  const routed = await routeWhatsAppInbound({
    eventId: "wa-google-connect-1",
    chatId: "chat-google-connect",
    text: "/connect google",
  }, env);
  const messages = await listThreadMessages("google-connect-thread", env);
  const ledger = JSON.parse(await fs.readFile(path.join(userDataPaths("alice", env).oauth, "google-workspace-connect.json"), "utf8"));

  assert.equal(routed.threadId, "google-connect-thread");
  assert.equal(routed.googleWorkspaceConnect, true);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].observedVia, "google_workspace_connect_command");
  assert.equal(messages[0].state, "completed");
  assert.equal(messages[0].deliveryState, "delivered");
  assert.equal(messages[1].role, "assistant");
  assert.match(messages[1].text, /Google Workspace is optional/);
  assert.match(messages[1].text, /send this exact command: \/connect google/);
  assert.match(messages[1].text, /https:\/\/connect\.example\.test\/connect\/google\?connect=/);
  assert.match(messages[1].text, /Requested provider: google_workspace\. Requested service: gmail\./);
  assert.equal(ledger.requests[0].connectId, routed.connectId);
  assert.equal(ledger.requests[0].userId, "alice");
  assert.equal(ledger.requests[0].threadId, "google-connect-thread");
  assert.equal(ledger.requests[0].account, "");
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
      responderAccountId: "secondary",
      outboundAccountId: "secondary",
    },
  }, env);

  const message = await enqueueThreadInput("direct-wa-thread", { source: "whatsapp", text: "legacy direct input" }, env);

  assert.equal(message.connector, "whatsapp");
  assert.equal(message.chatId, "chat-direct");
  assert.equal(message.accountId, "secondary");
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
      senderContactId: "wa-contact-one@c.us",
      responderContactId: "wa-contact-two@c.us",
    },
  }, env);

  await assert.rejects(
    () => routeWhatsAppInbound({ eventId: "wa-generated-ignored", chatId: "chat-generated", accountId: "account-1", fromMe: false, text: "not selected" }, env),
    /whatsapp_inbound_sender_denied/,
  );

  const routedViaResponder = await routeWhatsAppInbound({
    eventId: "wa-generated-responder-sees-sender",
    chatId: "chat-generated",
    accountId: "account-2",
    from: "wa-contact-one@c.us",
    fromMe: false,
    text: "selected sender via responder",
  }, env);
  const routed = await routeWhatsAppInbound({ eventId: "wa-generated-routed", chatId: "chat-generated", accountId: "account-1", fromMe: true, text: "selected sender" }, env);
  const userMessages = (await listThreadMessages("generated-thread", env)).filter((message) => message.role === "user");
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

  assert.equal(routedViaResponder.ignoredNonSenderAccount, true);
  assert.equal(routedViaResponder.skipped, "non_sender_account");
  assert.equal(routed.threadId, "generated-thread");
  assert.equal(userMessages.length, 1);
  assert.equal(userMessages[0].accountId, "account-1");
  assert.equal(delivery.delivered.length, 1);
  assert.equal(delivery.delivered.some((entry) => entry.deliveryType === "queue_notice"), false);
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
      senderContactId: "wa-contact-one@c.us",
    },
  }, env);

  await assert.rejects(
    () => routeWhatsAppInbound({
      eventId: "wa-auto-restricted-rejected",
      chatId: "chat-auto-restricted",
      accountId: "account-1",
      from: "wa-contact-three@c.us",
      text: "should not create a separate user thread",
    }, env),
    /whatsapp_inbound_sender_denied/,
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
      chatId: "wa-group-beta@g.us",
      displayName: "orkestr",
      enabled: true,
      generated: true,
      allowOtherPeople: false,
      senderAccountId: "responder",
      responderAccountId: "responder",
      outboundAccountId: "responder",
      senderContactId: "wa-contact-primary@c.us",
      responderContactId: "wa-contact-responder@c.us",
    },
  }, env);

  await assert.rejects(
    () => routeWhatsAppInbound({
      eventId: "wa-generated-lid-responder",
      chatId: "wa-group-beta@g.us",
      accountId: "responder",
      from: "wa-contact-responder@c.us",
      fromMe: false,
      text: "responder echo",
    }, env),
    /whatsapp_inbound_sender_denied/,
  );
  await assert.rejects(
    () => routeWhatsAppInbound({
      eventId: "wa-generated-lid-wrong-chat",
      chatId: "wa-group-other@g.us",
      accountId: "responder",
      from: "wa-lid-primary@lid",
      fromMe: false,
      text: "wrong chat",
    }, env),
    /whatsapp_target_required/,
  );

  const routed = await routeWhatsAppInbound({
    eventId: "wa-generated-lid-sender",
    chatId: "wa-group-beta@g.us",
    accountId: "responder",
    from: "wa-lid-primary@lid",
    fromMe: false,
    text: "lid sender",
  }, env);
  const messages = await listThreadMessages("generated-lid-thread", env);

  assert.equal(routed.threadId, "generated-lid-thread");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, "lid sender");
  assert.equal(messages[0].from, "wa-lid-primary@lid");
});

test("whatsapp inbound coalesces short text and attachment bursts into one thread input", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-inbound-coalesce-"));
  const env = externalBridgeEnv(home, {
    ORKESTR_WHATSAPP_INBOUND_COALESCE_MS: "5000",
  });
  await createThread({
    id: "coalesce-thread",
    name: "Coalesce Thread",
    binding: {
      connector: "whatsapp",
      chatId: "coalesce-chat@g.us",
      enabled: true,
      allowOtherPeople: true,
      responderAccountId: "sender",
      outboundAccountId: "sender",
      mirrorToWhatsApp: true,
    },
  }, env);
  const first = await routeWhatsAppInbound({
    eventId: "false_coalesce-chat@g.us_MSG1_user@lid",
    chatId: "coalesce-chat@g.us",
    accountId: "sender",
    from: "user@lid",
    text: "prepare the mail body",
    timestamp: "2026-06-15T09:46:26.000Z",
  }, env);
  const second = await routeWhatsAppInbound({
    eventId: "false_coalesce-chat@g.us_MSG2_user@lid",
    chatId: "coalesce-chat@g.us",
    accountId: "sender",
    from: "user@lid",
    text: "Rechnung_1775.pdf",
    attachments: [{
      remote: true,
      remoteThreadId: "remote-thread-1",
      remoteAttachmentId: "remote-pdf-1",
      filename: "Rechnung_1775.pdf",
      mimetype: "application/pdf",
    }],
    timestamp: "2026-06-15T09:46:28.000Z",
  }, env);
  const messages = await listThreadMessages("coalesce-thread", env);

  assert.equal(first.message.id, second.message.id);
  assert.equal(second.coalesced, true);
  assert.equal(messages.filter((message) => message.role === "user").length, 1);
  assert.match(messages[0].text, /prepare the mail body/);
  assert.match(messages[0].text, /Rechnung_1775\.pdf/);
  assert.equal(messages[0].attachments.length, 1);
  assert.deepEqual(messages[0].coalescedEventIds, [
    "false_coalesce-chat@g.us_MSG1_user@lid",
    "false_coalesce-chat@g.us_MSG2_user@lid",
  ]);
});

test("generated single-account whatsapp groups tolerate missing responder identity for lid senders", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-generated-lid-no-responder-"));
  const env = externalBridgeEnv(home);
  await createThread({
    id: "generated-lid-no-responder-thread",
    name: "Generated Lid No Responder Thread",
    binding: {
      connector: "whatsapp",
      chatId: "wa-group-beta@g.us",
      displayName: "orkestr",
      enabled: true,
      generated: true,
      allowOtherPeople: false,
      senderAccountId: "responder",
      responderAccountId: "responder",
      outboundAccountId: "responder",
      senderContactId: "wa-contact-primary@c.us",
    },
  }, env);

  const routed = await routeWhatsAppInbound({
    eventId: "wa-generated-lid-no-responder",
    chatId: "wa-group-beta@g.us",
    accountId: "responder",
    from: "wa-lid-primary@lid",
    fromMe: false,
    text: "lid sender",
  }, env);
  const messages = await listThreadMessages("generated-lid-no-responder-thread", env);

  assert.equal(routed.threadId, "generated-lid-no-responder-thread");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, "lid sender");
  assert.equal(messages[0].from, "wa-lid-primary@lid");
});

test("whatsapp inbound matches saved phone sender against WhatsApp contact ids", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-phone-sender-match-"));
  const env = externalBridgeEnv(home);
  const senderDigits = "15550100001";
  const senderContactId = `${senderDigits}@c.us`;
  await createThread({
    id: "phone-sender-thread",
    name: "Phone Sender Thread",
    binding: {
      connector: "whatsapp",
      chatId: "wa-group-acceptance@g.us",
      displayName: "orkestr.example.test",
      enabled: true,
      senderAccountId: "sender",
      responderAccountId: "responder",
      outboundAccountId: "responder",
      senderContactId: `+${senderDigits}`,
    },
  }, env);

  const routed = await routeWhatsAppInbound({
    eventId: "wa-phone-sender-match",
    chatId: "wa-group-acceptance@g.us",
    accountId: "sender",
    from: senderContactId,
    fromMe: false,
    text: "route check",
  }, env);
  const messages = await listThreadMessages("phone-sender-thread", env);

  assert.equal(routed.threadId, "phone-sender-thread");
  assert.equal(messages.length, 1);
  assert.equal(messages[0].text, "route check");
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
    /whatsapp_inbound_sender_denied/,
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
      additionalParticipantIds: ["wa-contact-one@c.us"],
      senderAccountId: "account-1",
      responderAccountId: "account-2",
      responderContactId: "wa-contact-two@c.us",
    },
  }, env);

  await assert.rejects(
    () => routeWhatsAppInbound({ eventId: "wa-additional-rejected", chatId: "chat-selected", accountId: "account-1", from: "wa-contact-three@c.us", fromMe: false, text: "not selected" }, env),
    /whatsapp_inbound_sender_denied/,
  );
  await assert.rejects(
    () => routeWhatsAppInbound({ eventId: "wa-additional-responder", chatId: "chat-selected", accountId: "account-1", from: "wa-contact-two@c.us", fromMe: false, text: "responder" }, env),
    /whatsapp_inbound_sender_denied/,
  );

  const routed = await routeWhatsAppInbound({ eventId: "wa-additional-selected", chatId: "chat-selected", accountId: "account-1", from: "wa-contact-one@c.us", fromMe: false, text: "selected allowed" }, env);

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
  assert.equal(delivery.skipped.some((item) => item.reason === "mirroring_disabled"), false);
  assert.equal(delivery.skipped.some((item) => item.reason === "mirroring_disabled_terminal"), true);
  assert.equal(calls.length, 1);
  assert.match(stripDebugFooter(calls[0].body.text), /^Message routed to Orkestr\./);

  const duplicate = await deliverWhatsAppReplies(env, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return response({ ok: true, ids: ["sent-mirror-off-duplicate"] });
  });
  assert.equal(duplicate.delivered.length, 0);
  assert.equal(duplicate.failed.length, 0);
  assert.equal(duplicate.skipped.length, 0);
  assert.equal(calls.length, 1);
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
