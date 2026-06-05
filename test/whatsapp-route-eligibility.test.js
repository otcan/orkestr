import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deliverWhatsAppReplies, routeWhatsAppInbound } from "../packages/connectors/src/whatsapp.js";
import { listLocalWhatsAppChats, localWhatsAppUnreadRecoveryBoundChats } from "../packages/connectors/src/whatsapp-local-bridge.js";
import { appendThreadMessage, createThread, listThreadMessages, listThreads } from "../packages/core/src/threads.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";

async function testEnv(prefix, extra = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "main",
    ORKESTR_WHATSAPP_API_AGENT_AUTORUN: "0",
    ...extra,
  };
}

test("retired WhatsApp bindings are not routable or recovered", async () => {
  const env = await testEnv("orkestr-wa-retired-route-");
  await createThread({
    id: "retired-thread",
    name: "Retired WhatsApp Thread",
    binding: {
      connector: "whatsapp",
      chatId: "wa-group-retired@g.us",
      displayName: "Retired WhatsApp Thread",
      enabled: true,
      routeEligible: false,
      deprecated: true,
      responderAccountId: "main",
      outboundAccountId: "main",
    },
  }, env);

  await assert.rejects(
    () => routeWhatsAppInbound({
      eventId: "wa-retired-route-1",
      chatId: "wa-group-retired@g.us",
      accountId: "main",
      from: "wa-contact-user@c.us",
      text: "this must not route",
    }, env),
    /whatsapp_target_required/,
  );

  assert.equal((await listThreadMessages("retired-thread", env)).length, 0);
  assert.deepEqual(localWhatsAppUnreadRecoveryBoundChats(await listThreads(env), "main", env), []);
  assert.deepEqual((await listLocalWhatsAppChats("main", env)).chats, []);
});

test("retired WhatsApp bindings reserve the chat and block auto-provision resurrection", async () => {
  const env = await testEnv("orkestr-wa-retired-auto-");
  await writeConnectorConfig("whatsapp", {
    autoProvisionUsers: true,
  }, env);
  await createThread({
    id: "retired-generated-thread",
    name: "Retired Generated Thread",
    binding: {
      connector: "whatsapp",
      chatId: "wa-group-retired-auto@g.us",
      displayName: "Retired Generated Thread",
      enabled: true,
      routeEligible: false,
      retired: true,
      generated: true,
      senderAccountId: "main",
      responderAccountId: "main",
      outboundAccountId: "main",
      senderContactId: "wa-contact-original@c.us",
    },
  }, env);

  await assert.rejects(
    () => routeWhatsAppInbound({
      eventId: "wa-retired-auto-1",
      chatId: "wa-group-retired-auto@g.us",
      accountId: "main",
      from: "wa-contact-new@c.us",
      chatName: "Retired Generated Thread",
      text: "do not create another thread",
    }, env),
    /whatsapp_target_required/,
  );

  assert.deepEqual((await listThreads(env)).map((thread) => thread.id), ["retired-generated-thread"]);
});

test("legacy thread route config cannot target retired WhatsApp bindings", async () => {
  const env = await testEnv("orkestr-wa-retired-explicit-");
  await writeConnectorConfig("whatsapp", {
    threads: {
      "wa-group-retired-explicit@g.us": "retired-explicit-thread",
    },
  }, env);
  await createThread({
    id: "retired-explicit-thread",
    name: "Retired Explicit Thread",
    binding: {
      connector: "whatsapp",
      chatId: "wa-group-retired-explicit@g.us",
      displayName: "Retired Explicit Thread",
      enabled: true,
      routeEligible: false,
      deprecated: true,
      responderAccountId: "main",
      outboundAccountId: "main",
    },
  }, env);

  await assert.rejects(
    () => routeWhatsAppInbound({
      eventId: "wa-retired-explicit-1",
      chatId: "wa-group-retired-explicit@g.us",
      accountId: "main",
      from: "wa-contact-user@c.us",
      text: "legacy config must not route",
    }, env),
    /whatsapp_target_required/,
  );

  assert.equal((await listThreadMessages("retired-explicit-thread", env)).length, 0);
});

test("retired WhatsApp bindings cannot mirror old assistant output", async () => {
  const env = await testEnv("orkestr-wa-retired-mirror-");
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external",
    bridgeUrl: "https://wa.example.test",
  }, env);
  await createThread({
    id: "retired-mirror-thread",
    name: "Retired Mirror Thread",
    binding: {
      connector: "whatsapp",
      chatId: "wa-group-retired-mirror@g.us",
      displayName: "Retired Mirror Thread",
      enabled: true,
      routeEligible: false,
      deprecated: true,
      mirrorToWhatsApp: true,
      responderAccountId: "main",
      outboundAccountId: "main",
    },
  }, env);
  const user = await appendThreadMessage("retired-mirror-thread", {
    role: "user",
    source: "whatsapp_inbound",
    connector: "whatsapp",
    chatId: "wa-group-retired-mirror@g.us",
    accountId: "main",
    state: "completed",
    text: "old input",
  }, env);
  await appendThreadMessage("retired-mirror-thread", {
    role: "assistant",
    source: "codex-app-server",
    phase: "final_answer",
    state: "completed",
    parentMessageId: user.id,
    connector: "whatsapp",
    chatId: "wa-group-retired-mirror@g.us",
    accountId: "main",
    text: "old answer must not mirror",
  }, env);
  const calls = [];

  const delivery = await deliverWhatsAppReplies(env, async (url, options = {}) => {
    calls.push({ url, options });
    return { ok: true, async json() { return { ok: true }; } };
  });

  assert.equal(delivery.delivered.length, 0);
  assert.equal(calls.length, 0);
});

test("eligible WhatsApp bindings still route normally", async () => {
  const env = await testEnv("orkestr-wa-eligible-route-");
  await createThread({
    id: "eligible-thread",
    name: "Eligible WhatsApp Thread",
    binding: {
      connector: "whatsapp",
      chatId: "wa-group-eligible@g.us",
      displayName: "Eligible WhatsApp Thread",
      enabled: true,
      responderAccountId: "main",
      outboundAccountId: "main",
    },
  }, env);

  const routed = await routeWhatsAppInbound({
    eventId: "wa-eligible-route-1",
    chatId: "wa-group-eligible@g.us",
    accountId: "main",
    from: "wa-contact-user@c.us",
    text: "this should route",
  }, env);

  assert.equal(routed.threadId, "eligible-thread");
  assert.equal((await listThreadMessages("eligible-thread", env)).length, 1);
});
