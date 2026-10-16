import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listEvents } from "../packages/storage/src/store.js";
import { getLocalWhatsAppBridgeStatus, localWhatsAppSelfChatId, resetLocalWhatsAppBridgeForTest, setLocalWhatsAppRuntimeForTest } from "../packages/connectors/src/whatsapp-local-bridge.js";

// Owner report (Docker on a Mac, many chats): getChats took longer than the
// probe timeout, so WhatsApp was marked broken and sends were refused.
test("a slow chat list falls back to the browser store instead of marking WhatsApp broken", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-slow-chats-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "account-1",
    ORKESTR_WHATSAPP_STATUS_CHAT_OPS_PROBE: "1",
    ORKESTR_WHATSAPP_CHAT_OPS_PROBE_INTERVAL_MS: "1000",
    ORKESTR_WHATSAPP_CHAT_OPS_PROBE_TIMEOUT_MS: "500",
  };
  const previousWindow = globalThis.window;
  const calls = [];
  const runtime = {
    client: {
      getChats() {
        calls.push("getChats");
        // Answers long after the 500 ms probe timeout.
        return new Promise((resolve) => setTimeout(() => resolve([]), 3000));
      },
      pupPage: {
        async evaluate(fn) {
          calls.push("browserStore");
          globalThis.window = {
            require(name) {
              if (name === "WAWebCollections") return { Chat: { getModelsArray: () => [{ id: { _serialized: "chat-one@g.us" } }] }, Msg: {} };
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
    setLocalWhatsAppRuntimeForTest("account-1", runtime, { lastChatOpsProbeAt: null }, env);
    const status = await getLocalWhatsAppBridgeStatus(env);
    const account = status.accounts.find((item) => item.accountId === "account-1");
    assert.deepEqual(calls, ["getChats", "browserStore"]);
    assert.equal(account.chatOpsReady, true);
    assert.equal(account.runtimeUsable, true);
    assert.equal(status.ready, true);
    assert.ok((await listEvents(env, 50)).find((event) => event.type === "whatsapp_local_chat_ops_probe_browser_store_ready"));
  } finally {
    globalThis.window = previousWindow;
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("Message yourself on a hidden @lid id is recognised without any lookup", async () => {
  const own = "15550000001@c.us";
  const client = { info: { wid: { _serialized: own } } }; // no getContactLidAndPhone: lookups unavailable
  assert.equal(await localWhatsAppSelfChatId(client, "51300000000009@lid", true, "51300000000009@lid"), own);
  assert.equal(await localWhatsAppSelfChatId(client, "51300000000008@lid", true, "51300000000008:12@lid"), own, "device suffix on the sender is ignored");
  assert.equal(await localWhatsAppSelfChatId(client, "51300000000007@lid", true, "51300000000099@lid"), "51300000000007@lid", "a chat with someone else keeps its id");
  assert.equal(await localWhatsAppSelfChatId(client, "51300000000006@lid", false, "51300000000006@lid"), "51300000000006@lid", "only the owner's own messages");
});
