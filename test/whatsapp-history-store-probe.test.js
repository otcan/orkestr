import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  getLocalWhatsAppBridgeStatus,
  listLocalWhatsAppChatMessages,
  probeLocalWhatsAppStore,
  recoverLocalWhatsAppChatMessages,
  resetLocalWhatsAppBridgeForTest,
  setLocalWhatsAppRuntimeForTest,
} from "../packages/connectors/src/whatsapp-local-bridge.js";
import { loadEarlierLocalWhatsAppMessages, publicHistoryLoad } from "../packages/connectors/src/whatsapp-history-loader.js";
import { evaluateHistoryRead } from "../packages/connectors/src/whatsapp-history-health.js";
import { createOrkestrWaService } from "../scripts/orkestr-wa-service.mjs";

const CHAT_ID = "120000000000000001@g.us";
const SELF = "10000000000@c.us";
const OTHER = "20000000000@c.us";
const SECRET_BODY = "fixture-secret-body-text";
const SECRET_MEDIA_KEY = "fixture-secret-media-key";

function model(index, { fromMe = false, t = 1_780_000_000 + index } = {}) {
  const local = `FIXTUREMSG${String(index).padStart(4, "0")}`;
  return {
    id: {
      fromMe,
      remote: CHAT_ID,
      id: local,
      participant: fromMe ? undefined : OTHER,
      _serialized: `${fromMe}_${CHAT_ID}_${local}${fromMe ? "" : `_${OTHER}`}`,
    },
    t,
    body: `${SECRET_BODY}-${index}`,
    type: index % 5 === 0 ? "image" : "chat",
    mediaKey: index % 5 === 0 ? SECRET_MEDIA_KEY : undefined,
    from: fromMe ? SELF : CHAT_ID,
    author: fromMe ? undefined : OTHER,
    isNotification: false,
  };
}

// Minimal fake of the WhatsApp Web module system.
function fakeWhatsAppWeb({ older = 40, pageSize = 10, loaderMode = "object", reportStart = true, unreadCount = 0 } = {}) {
  const pool = Array.from({ length: older }, (_value, index) => model(index + 1));
  const own = model(older + 1, { fromMe: true });
  const chat = {
    unreadCount,
    t: own.t,
    msgs: {
      models: [own],
      getModelsArray() {
        return this.models;
      },
      msgLoadState: { noEarlierMsgs: false },
    },
  };
  const calls = { loader: 0 };
  const loadPage = () => {
    const page = pool.splice(Math.max(0, pool.length - pageSize), pageSize);
    chat.msgs.models = [...page, ...chat.msgs.models];
    if (!pool.length && reportStart) chat.msgs.msgLoadState.noEarlierMsgs = true;
    return page;
  };
  const loader = {
    loadEarlierMsgs(arg) {
      calls.loader += 1;
      if (loaderMode === "broken") throw new Error("r");
      if (loaderMode === "silent") return [];
      if (loaderMode === "infinite") {
        const extra = Array.from({ length: pageSize }, (_v, i) => model(10_000 + calls.loader * 100 + i));
        chat.msgs.models = [...extra, ...chat.msgs.models];
        return extra;
      }
      if (loaderMode === "positional" && arg !== chat) throw new Error("t");
      if (loaderMode === "object" && arg?.chat !== chat) throw new Error("t");
      return Promise.resolve(loadPage());
    },
  };
  const modules = {
    WAWebCollections: {
      Chat: { get: (wid) => ((wid?._serialized || wid) === CHAT_ID ? chat : undefined) },
      Msg: {
        get: (id) => chat.msgs.models.find((message) => message.id._serialized === id),
        getModelsArray: () => chat.msgs.models,
      },
    },
    WAWebWidFactory: { createWid: (id) => ({ _serialized: id }) },
    WAWebChatLoadMessages: loader,
    WAWebDownloadManager: { downloadManager: { downloadAndMaybeDecrypt(_a, _b) { return null; } } },
  };
  const window = {
    Debug: { VERSION: "2.3000.1012345678" },
    WWebJS: { getChat() {}, getMessageModel: (message) => ({ ...message }) },
    require(name) {
      if (!modules[name]) throw new Error("r");
      return modules[name];
    },
  };
  return { window, chat, calls, own };
}

async function withWindow(fake, fn) {
  const previous = globalThis.window;
  globalThis.window = fake.window;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
}

function fakeClient(fake, overrides = {}) {
  return {
    pupPage: { evaluate: async (fn, ...args) => fn(...args) },
    async getChatById() {
      return {
        id: { _serialized: CHAT_ID },
        unreadCount: fake.chat.unreadCount,
        async fetchMessages() {
          return [{ ...fake.own, id: fake.own.id, fromMe: true, timestamp: fake.own.t }];
        },
      };
    },
    async getMessageById() {
      return null;
    },
    ...overrides,
  };
}

async function setupEnv(prefix) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return { ORKESTR_HOME: home, ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender" };
}

test("history loader falls back to the positional signature and stays bounded", async () => {
  const fake = fakeWhatsAppWeb({ loaderMode: "positional", older: 100 });
  const client = fakeClient(fake);
  const result = await withWindow(fake, () => loadEarlierLocalWhatsAppMessages(client, CHAT_ID, { targetCount: 1000 }, {}));
  assert.equal(result.before, 1);
  assert.equal(result.pages, 3);
  assert.equal(result.after, 31);
  assert.equal(result.strategy, "chat_load_messages_positional");
  assert.equal(result.errors[0].message, "t");
  assert.equal(result.errors[0].strategy, "chat_load_messages_object");
  assert.ok(Array.isArray(result.errors[0].stackHead));
});

test("history loader stops after one page without progress instead of looping", async () => {
  const fake = fakeWhatsAppWeb({ loaderMode: "silent" });
  const result = await withWindow(fake, () => loadEarlierLocalWhatsAppMessages(fakeClient(fake), CHAT_ID, { targetCount: 15 }, {}));
  assert.equal(result.pages, 1);
  assert.equal(result.after, result.before);
  assert.equal(fake.calls.loader, 2);
  assert.equal(result.reachedStart, false);
});

test("history loader respects page and message caps with endless history", async () => {
  const fake = fakeWhatsAppWeb({ loaderMode: "infinite", pageSize: 50 });
  const capped = await withWindow(fake, () => loadEarlierLocalWhatsAppMessages(fakeClient(fake), CHAT_ID, { targetCount: 1000, maxMessages: 120 }, {}));
  assert.equal(capped.pages, 3);
  assert.equal(capped.after, 151);
  assert.equal(fake.calls.loader, 3);
});

test("store probe reports internals and counts without message content", async () => {
  const fake = fakeWhatsAppWeb({ loaderMode: "broken", unreadCount: 2 });
  const env = await setupEnv("orkestr-wa-store-probe-");
  try {
    setLocalWhatsAppRuntimeForTest("sender", { client: fakeClient(fake) }, { ready: true }, env);
    const result = await withWindow(fake, () => probeLocalWhatsAppStore({ accountId: "sender", chatId: CHAT_ID, env }));
    const text = JSON.stringify(result);
    assert.equal(result.ok, true);
    assert.equal(result.waWebVersion, "2.3000.1012345678");
    assert.match(result.wwebjsVersion, /^\d+\.\d+\.\d+/);
    assert.equal(result.internals.downloadManager.downloadAndMaybeDecrypt.type, "function");
    assert.equal(result.internals.downloadManager.downloadAndMaybeDecrypt.arity, 2);
    assert.equal(result.internals.chatLoadMessages.loadEarlierMsgs.type, "function");
    assert.equal(result.internals.windowStore.type, "undefined");
    assert.equal(result.chat.found, true);
    assert.equal(result.chat.inMemoryCount, 1);
    assert.equal(result.chat.unreadCount, 2);
    assert.equal(result.chat.msgLoadState.noEarlierMsgs, false);
    assert.equal(result.loadAttempt.before, 1);
    assert.equal(result.loadAttempt.after, 1);
    assert.equal(result.loadAttempt.errors[0].message, "r");
    for (const forbidden of [SECRET_BODY, SECRET_MEDIA_KEY, "FIXTUREMSG", "20000000000", "10000000000", CHAT_ID, "matchedId"]) {
      assert.equal(text.includes(forbidden), false, `probe leaked ${forbidden}`);
    }
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("chat history loads earlier messages when the read is short", async () => {
  const fake = fakeWhatsAppWeb({ loaderMode: "positional", older: 40 });
  const env = await setupEnv("orkestr-wa-history-fallback-");
  try {
    setLocalWhatsAppRuntimeForTest("sender", { client: fakeClient(fake) }, { ready: true }, env);
    const result = await withWindow(fake, () => listLocalWhatsAppChatMessages({ accountId: "sender", chatId: CHAT_ID, limit: 15, env }));
    assert.equal(result.fallback, "earlier_messages_loaded");
    assert.equal(result.messages.length, 15);
    assert.equal(result.messages.at(-1).fromMe, true);
    assert.equal(result.historyLoad.pages, 2);
    assert.ok(fake.calls.loader <= 4);
    const status = await getLocalWhatsAppBridgeStatus(env, { probeChatOps: false });
    assert.deepEqual(status.accounts[0].warnings, []);
    assert.equal(status.accounts[0].historyRead.state, "ok");
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("chat history keeps the existing path when enough messages are visible", async () => {
  const env = await setupEnv("orkestr-wa-history-enough-");
  let evaluated = 0;
  const client = {
    pupPage: { evaluate: async () => { evaluated += 1; return null; } },
    async getChatById() {
      return { async fetchMessages() { return [model(1), model(2), model(3, { fromMe: true })].map((m) => ({ ...m, fromMe: m.id.fromMe })); } };
    },
  };
  try {
    setLocalWhatsAppRuntimeForTest("sender", { client }, { ready: true }, env);
    const result = await listLocalWhatsAppChatMessages({ accountId: "sender", chatId: CHAT_ID, limit: 3, env });
    assert.equal(result.messages.length, 3);
    assert.equal(result.fallback, undefined);
    assert.equal(evaluated, 0);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("own-message-only history with a failing loader is flagged history_read_degraded as a warning", async () => {
  const fake = fakeWhatsAppWeb({ loaderMode: "broken" });
  const env = await setupEnv("orkestr-wa-history-degraded-");
  try {
    setLocalWhatsAppRuntimeForTest("sender", { client: fakeClient(fake) }, { ready: true }, env);
    const result = await withWindow(fake, () => listLocalWhatsAppChatMessages({ accountId: "sender", chatId: CHAT_ID, limit: 15, env }));
    assert.equal(result.messages.length, 1);
    assert.equal(result.historyLoad.errors.length > 0, true);
    const status = await getLocalWhatsAppBridgeStatus(env, { probeChatOps: false });
    const account = status.accounts[0];
    assert.deepEqual(account.warnings, ["history_read_degraded"]);
    assert.equal(account.historyRead.degradedChats, 1);
    assert.ok(account.historyRead.reasons.includes("earlier_load_failed"));
    assert.equal(account.capabilities.read, "available");
    assert.equal(status.state, "ready");
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("history health evaluation uses unread and last-activity metadata", () => {
  const own = [{ fromMe: true, timestamp: new Date(1_780_000_000_000).toISOString() }];
  assert.deepEqual(evaluateHistoryRead({ requested: 15, messages: own, load: { unreadCount: 3, before: 1, after: 1, errors: [] } }).reasons, ["unread_not_loaded"]);
  assert.ok(evaluateHistoryRead({ requested: 15, messages: own, load: { lastActivityTimestamp: 1_780_000_500, before: 1, after: 1, errors: [] } }).reasons.includes("last_activity_newer"));
  assert.equal(evaluateHistoryRead({ requested: 15, messages: own, load: { before: 1, after: 1, reachedStart: true, errors: [] } }).degraded, false);
  assert.equal(evaluateHistoryRead({ requested: 15, messages: [{ fromMe: false }], load: { unreadCount: 3 } }).degraded, false);
  assert.equal(evaluateHistoryRead({ requested: 1, messages: own, load: { unreadCount: 3 } }).degraded, false);
});

test("exact recover searches earlier pages by event id suffix before message_not_found", async () => {
  const fake = fakeWhatsAppWeb({ loaderMode: "object", older: 25 });
  // Make the target an own message so it is found but not routed.
  const pool = fake.chat;
  const env = await setupEnv("orkestr-wa-recover-search-");
  try {
    setLocalWhatsAppRuntimeForTest("sender", { client: fakeClient(fake) }, { ready: true }, env);
    const found = await withWindow(fake, () => recoverLocalWhatsAppChatMessages({ accountId: "sender", chatId: CHAT_ID, eventIds: ["FIXTUREMSG0008"], markSeen: false }, env));
    assert.equal(found.skipped.length, 1);
    assert.notEqual(found.skipped[0].reason, "message_not_found");
    assert.ok(pool.msgs.models.length > 1);

    const missing = await withWindow(fake, () => recoverLocalWhatsAppChatMessages({ accountId: "sender", chatId: CHAT_ID, eventIds: ["NOTPRESENT0001"], markSeen: false }, env));
    assert.equal(missing.skipped[0].reason, "message_not_found");
    const searched = missing.skipped[0].detail.searched;
    assert.equal(searched.matched, false);
    assert.ok(searched.after >= searched.before);
    assert.equal(searched.reachedStart, true);
    assert.ok(searched.oldestLoadedAt);
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("public history load summary drops the matched serialized id", () => {
  const summary = publicHistoryLoad({ matchedId: `false_${CHAT_ID}_X`, matched: true, before: 1, after: 2, errors: [] });
  assert.equal(JSON.stringify(summary).includes(CHAT_ID), false);
  assert.equal(summary.matched, true);
});

test("worker exposes the authenticated store probe route and history warnings", async () => {
  const calls = [];
  const bridge = {
    getLocalWhatsAppBridgeStatus: async () => ({
      ok: true,
      ready: true,
      state: "ready",
      accounts: [{ id: "responder", accountId: "responder", ready: true, state: "ready", warnings: ["history_read_degraded"], historyRead: { state: "history_read_degraded", degradedChats: 1, observedChats: 2, reasons: ["earlier_load_failed"], observedAt: null } }],
    }),
    probeLocalWhatsAppStore: async (payload) => {
      calls.push(payload);
      return { ok: true, accountId: payload.accountId, waWebVersion: "2.3000.1" };
    },
  };
  const server = createOrkestrWaService({ env: { ORKESTR_WA_SERVICE_TOKEN: "fixture-token" }, bridge });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { authorization: "Bearer fixture-token" };
  try {
    assert.equal((await fetch(`${base}/accounts/responder/diagnostics/store-probe?chatId=${encodeURIComponent(CHAT_ID)}`)).status, 401);
    assert.equal((await fetch(`${base}/accounts/responder/diagnostics/store-probe`, { headers: auth })).status, 400);
    const response = await fetch(`${base}/accounts/responder/diagnostics/store-probe?chatId=${encodeURIComponent(CHAT_ID)}&attemptLoad=0`, { headers: auth });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).waWebVersion, "2.3000.1");
    assert.equal(calls[0].chatId, CHAT_ID);
    assert.equal(calls[0].attemptLoad, false);
    const health = await (await fetch(`${base}/health`, { headers: auth })).json();
    assert.deepEqual(health.accounts[0].warnings, ["history_read_degraded"]);
    assert.equal(health.accounts[0].historyRead.degradedChats, 1);
    assert.equal(health.ok, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
