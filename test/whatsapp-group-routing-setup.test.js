import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { whatsappBindingInboundAccountPolicy } from "../packages/connectors/src/whatsapp-binding-account-policy.js";
import { classifyConnectorInboxDelivery } from "../packages/connectors/src/connector-inbox-outcomes.js";
import { promoteLocalWhatsAppGroupParticipants, setLocalWhatsAppRuntimeForTest, resetLocalWhatsAppBridgeForTest } from "../packages/connectors/src/whatsapp-local-bridge.js";
import { routeWhatsAppInbound } from "../packages/connectors/src/whatsapp.js";
import { createThread } from "../packages/core/src/threads.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";

const canonical = "15550000001";
const accounts = [{ id: canonical, runtimeAccountId: "sender", contactId: `${canonical}@c.us` }];

test("binding policy uses trusted canonical/runtime aliases without widening receiving scope", () => {
  const binding = { senderAccountId: canonical, responderAccountId: "other", accountIds: ["untrusted"] };
  const state = { connectorAccounts: accounts };
  assert.equal(whatsappBindingInboundAccountPolicy({ accountId: "sender" }, binding, state).allowed, true);
  for (const id of ["other", "untrusted", "15550000002", "responder"]) {
    assert.equal(whatsappBindingInboundAccountPolicy({ accountId: id }, binding, state).allowed, false);
  }
  assert.equal(whatsappBindingInboundAccountPolicy({ accountId: "sender", accounts }, binding, {}).allowed, false);
  assert.equal(whatsappBindingInboundAccountPolicy({ accountId: "sender" }, binding, {
    connectorAccounts: [{ ...accounts[0], deletedAt: "2026-01-01" }],
  }).allowed, false);
});

test("explicit non-sender skip cannot be recorded as accepted HTTP 200", () => {
  const result = classifyConnectorInboxDelivery({ response: { ok: true, status: 200 }, payload: {
    ignoredNonSenderAccount: true, skipped: "non_sender_account", messageId: null,
  } });
  assert.equal(result.state, "rejected_terminal");
  assert.equal(result.retryable, false);
});

test("promotion excludes existing admins and is a no-op once applied", async () => {
  const env = { ORKESTR_HOME: await fs.mkdtemp(path.join(os.tmpdir(), "wa-admin-idempotent-")), ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender" };
  const creator = { id: { _serialized: "15550000001@lid" }, isAdmin: true, isSuperAdmin: true };
  const member = { id: { _serialized: "15550000002@lid" }, isAdmin: false };
  const participants = [creator, member];
  const calls = [];
  const chat = { groupMetadata: { participants: {
    get: id => participants.find(p => p.id._serialized === id), serialize: () => participants,
  } } };
  const modules = {
    WAWebCollections: { Chat: { get: () => chat } },
    WAWebWidFactory: { createWid: id => ({ _serialized: id }) },
    WAWebModifyParticipantsGroupAction: { async promoteParticipants(_chat, changes) {
      assert.equal(changes.length, 1);
      assert.equal(changes[0], member);
      calls.push(changes);
      member.isAdmin = true;
      return { status: 200 };
    } },
  };
  try {
    setLocalWhatsAppRuntimeForTest("sender", { client: { pupPage: { evaluate(fn, ...args) {
      return vm.runInNewContext(`(${fn.toString()})(...args)`, { args, window: { require: name => modules[name] } });
    } } } }, {}, env);
    for (let n = 0; n < 2; n++) {
      const result = await promoteLocalWhatsAppGroupParticipants({ accountId: "sender", chatId: "fixture@g.us", participantIds: participants.map(p => p.id._serialized), env });
      assert.equal(result.ok, true);
    }
    assert.equal(calls.length, 1);
  } finally { await resetLocalWhatsAppBridgeForTest(env); }
});

test("new-group metadata lag never falls through to SDK lookup or runtime recovery", async () => {
  const env = { ORKESTR_HOME: await fs.mkdtemp(path.join(os.tmpdir(), "wa-admin-metadata-lag-")), ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender" };
  try {
    setLocalWhatsAppRuntimeForTest("sender", { client: {
      pupPage: { async evaluate() { return { ok: false, error: "whatsapp_group_chat_required" }; } },
      async getChatById() { assert.fail("metadata lag must not enter SDK lookup"); },
    } }, {}, env);
    await assert.rejects(promoteLocalWhatsAppGroupParticipants({ accountId: "sender", chatId: "fixture@g.us", participantIds: ["15550000002@lid"], env }), /whatsapp_group_metadata_pending/);
  } finally { await resetLocalWhatsAppBridgeForTest(env); }
});

for (const explicit of [false, true]) {
  test(`inbound routing uses live account mapping when legacy account cache is empty: explicit=${explicit}`, async () => {
    const env = { ORKESTR_HOME: await fs.mkdtemp(path.join(os.tmpdir(), "wa-live-account-routing-")), ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender", WHATSAPP_BRIDGE_MODE: "local" };
    const id = "fixture-account-thread", chatId = "fixture-account@g.us";
    try {
      setLocalWhatsAppRuntimeForTest("sender", { client: { info: { wid: { _serialized: `${canonical}@c.us` } }, async getChats() { return []; } } }, { contactId: `${canonical}@c.us`, phoneNumber: canonical }, env);
      await writeConnectorConfig("whatsapp", { bridgeMode: "local" }, env);
      await createThread({ id, name: "Fixture", binding: {
        connector: "whatsapp", chatId, senderAccountId: canonical, responderAccountId: canonical,
        enabled: true, allowOtherPeople: false, ownerContactIds: ["15550000002@c.us"], authorizedContactIds: ["15550000002@c.us"],
      } }, env);
      const result = await routeWhatsAppInbound({ eventId: "fixture-input", chatId, accountId: "sender", from: "15550000002@c.us", text: "Fixture question", ...(explicit ? { threadId: id } : {}) }, env);
      assert.equal(result.threadId, id);
      assert.ok(result.message?.id, JSON.stringify(result));
    } finally { await resetLocalWhatsAppBridgeForTest(env); }
  });
}
