import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
// Same module instances the running server uses (the server loads dist/).
import {
  resetLocalWhatsAppBridgeForTest,
  setLocalWhatsAppRuntimeForTest,
} from "../dist/server/packages/connectors/src/whatsapp-local-bridge.js";
import { createThread, getThread } from "../dist/server/packages/core/src/threads.js";

// Route-level tests for the first-run "Start orkest" WhatsApp step
// (POST /api/connectors/whatsapp/thread-groups as sent by the wizard).
// Fake WhatsApp clients and synthetic numbers only.

const envKeys = [
  "ORKESTR_HOME", "ORKESTR_RECOVER_RUNNING_ON_START", "ORKESTR_WHATSAPP_ACCOUNT_IDS", "WHATSAPP_BRIDGE_MODE",
  "ORKESTR_WHATSAPP_DEFAULT_GROUP_PARTICIPANTS", "ORKESTR_WHATSAPP_DEFAULT_PARTICIPANT_IDS", "ORKESTR_WHATSAPP_OWNER_CONTACT_IDS",
  "ORKESTR_WHATSAPP_AUTOSTART", "ORKESTR_PUBLIC_SITE_URL",
];
// Populated operator defaults: the private onboarding chat must ignore all of them.
const defaults = {
  ORKESTR_WHATSAPP_DEFAULT_GROUP_PARTICIPANTS: "15559990001@c.us",
  ORKESTR_WHATSAPP_DEFAULT_PARTICIPANT_IDS: "15559990002@c.us",
  ORKESTR_WHATSAPP_OWNER_CONTACT_IDS: "15559990003@c.us",
};
const wid = (n) => ({ _serialized: `1555000000${n}@c.us`, user: `1555000000${n}`, server: "c.us" });

function fakeClient(n, createGroupCalls) {
  return {
    info: { wid: wid(n), pushname: `Synthetic ${n}` },
    async createGroup(title, participants) {
      createGroupCalls.push({ account: n, title, participants: [...participants] });
      return { gid: { _serialized: `12036300000000000${n}@g.us` }, title };
    },
    async getChatById(id) {
      return { id: { _serialized: id }, name: "synthetic", isGroup: id.endsWith("@g.us"), async setSubject() {}, async setDescription() {} };
    },
    async getState() {
      return "CONNECTED";
    },
    async destroy() {},
  };
}

async function withServer(t, extraEnv, run) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-onboarding-route-"));
  const prior = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  Object.assign(process.env, {
    ORKESTR_HOME: home,
    ORKESTR_RECOVER_RUNNING_ON_START: "0",
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "account-1,account-2",
    ORKESTR_WHATSAPP_AUTOSTART: "0",
    ...extraEnv,
  });
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    await createThread({ id: "orkest", name: "orkest" }, process.env);
    await run({ origin, env: process.env });
  } finally {
    await resetLocalWhatsAppBridgeForTest(process.env);
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
}

// Exactly what the wizard sends for the private onboarding chat.
async function requestPrivateChat(origin, pairedAccountId, pairedContactId) {
  const response = await fetch(`${origin}/api/connectors/whatsapp/thread-groups`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId: "orkest", name: "orkest", privateOwnerOnly: true, pairedAccountId, pairedContactId }),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

test("private onboarding chat never adds configured default participants", { timeout: 60_000 }, async (t) => {
  await withServer(t, defaults, async ({ origin, env }) => {
    const createGroupCalls = [];
    setLocalWhatsAppRuntimeForTest("account-1", { client: fakeClient(1, createGroupCalls) }, {}, env);
    const result = await requestPrivateChat(origin, "account-1", wid(1)._serialized);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual(createGroupCalls, [], "no group with other participants is created");
    assert.equal(result.body.binding?.chatId, wid(1)._serialized, "bound to the paired account's own chat only");
    assert.equal((await getThread("orkest", env)).binding.chatId, wid(1)._serialized);
  });
});

test("private onboarding chat uses the account paired in the wizard, not the first ready one", { timeout: 60_000 }, async (t) => {
  await withServer(t, defaults, async ({ origin, env }) => {
    const createGroupCalls = [];
    setLocalWhatsAppRuntimeForTest("account-1", { client: fakeClient(1, createGroupCalls) }, {}, env);
    setLocalWhatsAppRuntimeForTest("account-2", { client: fakeClient(2, createGroupCalls) }, {}, env);
    const result = await requestPrivateChat(origin, "account-2", wid(2)._serialized);
    assert.deepEqual(createGroupCalls, [], "no group is created by any account");
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.binding?.chatId, wid(2)._serialized, "participants == [paired account only]");
    assert.equal(result.body.binding?.senderAccountId, "account-2");
    assert.equal(result.body.binding?.outboundAccountId || result.body.binding?.responderAccountId, "account-2");
  });
});

test("private onboarding chat is refused when the paired account is no longer usable", { timeout: 60_000 }, async (t) => {
  await withServer(t, defaults, async ({ origin, env }) => {
    const createGroupCalls = [];
    setLocalWhatsAppRuntimeForTest("account-1", { client: fakeClient(1, createGroupCalls) }, {}, env);
    // account-2 was paired in the wizard as number 2, but is now linked to number 3.
    setLocalWhatsAppRuntimeForTest("account-2", { client: fakeClient(3, createGroupCalls) }, {}, env);
    const changed = await requestPrivateChat(origin, "account-2", wid(2)._serialized);
    assert.equal(changed.status, 409, JSON.stringify(changed.body));
    assert.match(JSON.stringify(changed.body), /whatsapp_paired_account_changed/);

    // account-2 (number 2) was paired in the wizard, then logged out.
    setLocalWhatsAppRuntimeForTest("account-2", { client: fakeClient(2, createGroupCalls) }, { state: "idle", ready: false, authenticated: false, runtimeUsable: false, verifiedLogoutAt: new Date().toISOString() }, env);
    const loggedOut = await requestPrivateChat(origin, "account-2", wid(2)._serialized);
    assert.deepEqual({ status: loggedOut.status, groups: createGroupCalls }, { status: 409, groups: [] }, "refused, nothing created");
    assert.match(JSON.stringify(loggedOut.body), /whatsapp_paired_account_unavailable/);

    const unknown = await requestPrivateChat(origin, "account-9", wid(9)._serialized);
    assert.equal(unknown.status, 409, JSON.stringify(unknown.body));
    const missing = await requestPrivateChat(origin, "", "");
    assert.equal(missing.status, 400, JSON.stringify(missing.body));

    assert.deepEqual(createGroupCalls, []);
    assert.equal((await getThread("orkest", env)).binding ?? null, null, "no chat was bound");
  });
});
