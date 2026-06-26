import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { routeWhatsAppInbound } from "../packages/connectors/src/whatsapp.js";
import { resolveWhatsAppBinding } from "../packages/connectors/src/whatsapp-account-bindings.js";
import { maybeBindApprovedBrokerChat } from "../packages/connectors/src/whatsapp-security-approval.js";
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
import {
  __brokerInstanceRegistryTestInternals,
  registerBrokerInstance,
} from "../packages/core/src/broker-instance-registry.js";
import { createPairingChallenge } from "../packages/core/src/security.js";
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

test("brokered WhatsApp approval automatically binds the approved direct chat to the setup thread", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-broker-approval-bind-"));
  const env = externalBridgeEnv(home, {
    ORKESTR_BROKER_REGISTRATION_TOKEN: "register-secret",
    ORKESTR_BROKER_INSTANCE_STORE: "json",
    ORKESTR_WHATSAPP_API_AGENT_AUTORUN: "0",
  });
  const client = __brokerInstanceRegistryTestInternals.createX25519Identity();
  const registration = await registerBrokerInstance({
    env,
    request: {
      method: "POST",
      url: "/api/broker/instances/register",
      ip: "198.51.100.42",
      headers: {
        authorization: "Bearer register-secret",
        "user-agent": "node:test",
      },
    },
    body: {
      displayName: "demo vm",
      encryptionPublicKey: client.publicKey,
      whatsappNumber: "+49 176 32400662",
    },
  });
  await createThread({
    id: "onboarding-admin-orkestr-de",
    ownerUserId: "admin",
    name: "orkestr.de",
    bindingName: "orkestr.de",
    state: "ready",
    binding: {
      connector: "whatsapp",
      chatId: "120363425280218500@g.us",
      responderAccountId: "responder",
      outboundAccountId: "responder",
      enabled: true,
    },
  }, env);
  const challenge = await createPairingChallenge({ env, instanceId: registration.instanceId });

  const approval = await routeWhatsAppInbound({
    eventId: "false_4917632400662@c.us_auto_bind_1",
    chatId: "4917632400662@c.us",
    accountId: "sender",
    from: "4917632400662@c.us",
    text: `orkestr connect approve ${challenge.challenge.approveCode}`,
  }, env);

  assert.equal(approval.approvedSecurityChallenge, true);
  assert.equal(approval.event.autoBinding.threadId, "onboarding-admin-orkestr-de");
  const resolved = await resolveWhatsAppBinding({
    chatId: "4917632400662@c.us",
    accountId: "sender",
  }, { env, status: { mode: "external", accounts: [{ accountId: "sender", ready: true }] } });
  assert.equal(resolved.selected.threadId, "onboarding-admin-orkestr-de");
  assert.equal(resolved.selected.level, "chat");
  assert.equal(resolved.selected.chatId, "4917632400662@c.us");
  assert.equal(resolved.selected.responderAccountId, "sender");
});

test("approved brokered WhatsApp chats self-heal missing bindings on the next message", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-broker-bind-heal-"));
  const env = externalBridgeEnv(home, {
    ORKESTR_BROKER_REGISTRATION_TOKEN: "register-secret",
    ORKESTR_BROKER_INSTANCE_STORE: "json",
  });
  const client = __brokerInstanceRegistryTestInternals.createX25519Identity();
  const registration = await registerBrokerInstance({
    env,
    request: {
      method: "POST",
      url: "/api/broker/instances/register",
      ip: "198.51.100.43",
      headers: {
        authorization: "Bearer register-secret",
        "user-agent": "node:test",
      },
    },
    body: {
      displayName: "demo vm",
      encryptionPublicKey: client.publicKey,
      whatsappNumber: "+49 176 32400662",
    },
  });
  await createThread({
    id: "onboarding-admin-orkestr-de",
    ownerUserId: "admin",
    name: "orkestr.de",
    bindingName: "orkestr.de",
    state: "ready",
    binding: {
      connector: "whatsapp",
      chatId: "120363425280218500@g.us",
      responderAccountId: "responder",
      outboundAccountId: "responder",
      enabled: true,
    },
  }, env);

  const result = await maybeBindApprovedBrokerChat({
    env,
    state: {
      inboundEvents: [{
        ignoredReason: "security_approval_command",
        challengeId: "old-challenge",
        instanceId: registration.instanceId,
        chatId: "4917632400662@c.us",
        accountId: "sender",
        from: "4917632400662@c.us",
      }],
    },
    input: {
      chatId: "4917632400662@c.us",
      accountId: "sender",
      from: "4917632400662@c.us",
      text: "hi",
    },
    chatId: "4917632400662@c.us",
    accountId: "sender",
  });

  assert.equal(result.ok, true);
  assert.equal(result.binding.threadId, "onboarding-admin-orkestr-de");
  const resolved = await resolveWhatsAppBinding({
    chatId: "4917632400662@c.us",
    accountId: "sender",
  }, { env, status: { mode: "external", accounts: [{ accountId: "sender", ready: true }] } });
  assert.equal(resolved.selected.threadId, "onboarding-admin-orkestr-de");
});
