import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { routeWhatsAppInbound } from "../packages/connectors/src/whatsapp.js";
import {
  createLocalWhatsAppChat,
  localWhatsAppUnreadRecoveryBoundChats,
  resetLocalWhatsAppBridgeForTest,
  setLocalWhatsAppRuntimeForTest,
} from "../packages/connectors/src/whatsapp-local-bridge.js";
import {
  whatsappBindingIsRouteEligible,
  whatsappInboundThreadMatchesBinding,
} from "../packages/connectors/src/whatsapp-inbound-routing.js";
import { createThread, listThreads } from "../packages/core/src/threads.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";

afterEach(() => {
  resetLocalWhatsAppBridgeForTest();
});

function externalBridgeEnv(home, extra = {}) {
  return {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1",
    ORKESTR_WHATSAPP_API_AGENT_AUTORUN: "0",
    ...extra,
  };
}

test("retired WhatsApp bindings do not route or recover unread work", () => {
  const binding = {
    connector: "whatsapp",
    chatId: "retired-chat@g.us",
    responderAccountId: "main",
    enabled: true,
    deprecated: true,
  };
  const thread = { id: "retired-thread", binding };

  assert.equal(whatsappBindingIsRouteEligible(binding), false);
  assert.equal(whatsappInboundThreadMatchesBinding({
    thread,
    chatId: "retired-chat@g.us",
    accountId: "main",
    from: "wa-contact@c.us",
  }), false);
  assert.deepEqual(localWhatsAppUnreadRecoveryBoundChats([thread], "main", {
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "main",
  }), []);
});

test("retired WhatsApp bindings block auto-provision resurrection", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-retired-binding-"));
  const env = externalBridgeEnv(home, { ORKESTR_WHATSAPP_AUTO_PROVISION_USERS: "1" });
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "http://wa.local",
    autoProvisionUsers: true,
  }, env);
  await createThread({
    id: "retired-thread",
    name: "Retired Thread",
    binding: {
      connector: "whatsapp",
      chatId: "retired-chat@g.us",
      responderAccountId: "main",
      outboundAccountId: "main",
      enabled: true,
      retired: true,
    },
  }, env);

  await assert.rejects(
    () => routeWhatsAppInbound({
      eventId: "wa-retired-1",
      chatId: "retired-chat@g.us",
      accountId: "main",
      from: "wa-contact@c.us",
      text: "do not resurrect",
    }, env),
    /whatsapp_target_required/,
  );

  assert.deepEqual((await listThreads(env)).map((thread) => thread.id), ["retired-thread"]);
});

test("local WhatsApp group creation defaults to the autostart responder account", async () => {
  const env = {
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender,responder",
    ORKESTR_WHATSAPP_AUTOSTART: "1",
    ORKESTR_WHATSAPP_AUTOSTART_ACCOUNT_IDS: "responder",
  };
  setLocalWhatsAppRuntimeForTest("responder", {
    client: {
      info: { wid: { _serialized: "responder@c.us" } },
    },
  }, { ready: true }, env);

  const created = await createLocalWhatsAppChat({ name: "Default Responder", env });

  assert.equal(created.responderAccountId, "responder");
  assert.equal(created.senderAccountId, "responder");
  assert.equal(created.chat.id, "responder@c.us");
});
