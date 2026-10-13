import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listAgentMessages } from "../packages/core/src/messages.js";
import { createThread, listThreadMessages } from "../packages/core/src/threads.js";
import { routeWhatsAppInbound } from "../packages/connectors/src/whatsapp.js";
import { handleInboundMessage, resetLocalWhatsAppBridgeForTest, sendLocalWhatsAppMessage, setLocalWhatsAppRuntimeForTest } from "../packages/connectors/src/whatsapp-local-bridge.js";
import { deliverConnectorInboxEvent, retryConnectorInbox } from "../packages/connectors/src/connectors-mcp-router.js";
import { ensureConnectorInboxEvent, getConnectorInboxEvent } from "../packages/storage/src/connector-inbox.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";

// Regression for an incident: an assistant reply with ten screenshots was sent
// to the owner's WhatsApp chat; every image came back as `fromMe` before
// sendMessage returned, downloaded fine (PNG recompressed to JPEG, no
// filename), and reached the thread as owner input. One image also reached the
// thread three times through concurrent gateway redeliveries.

async function boundThread(env, threadId, chatId) {
  return createThread({
    id: threadId,
    name: threadId,
    binding: { connector: "whatsapp", chatId, responderAccountId: "responder", outboundAccountId: "responder", enabled: true },
  }, env);
}

function ownImageCallback(chatId, id, downloads) {
  return {
    id: { _serialized: `true_${chatId}_${id}`, id, remote: chatId },
    from: "responder@lid",
    to: chatId,
    fromMe: true,
    body: "",
    hasMedia: true,
    type: "image",
    timestamp: 1_780_000_000,
    _data: {},
    async downloadMedia() {
      downloads.push(id);
      // Succeeds, with a recompressed JPEG whose size differs from the source PNG.
      return { mimetype: "image/jpeg", data: Buffer.from("recompressed-jpeg-bytes").toString("base64") };
    },
  };
}

test("own image echo that arrives before sendMessage returns is dropped even when its download would succeed", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-echo-race-"));
  const env = { ORKESTR_HOME: home, ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder" };
  const chatId = "chat-echo-race@g.us";
  await boundThread(env, "echo-race-thread", chatId);
  const files = [];
  for (const name of ["one.png", "two.png"]) {
    const file = path.join(home, name);
    await fs.writeFile(file, `png-bytes-${name}-${"x".repeat(200)}`);
    files.push({ path: file, filename: name, mimetype: "image/png" });
  }
  const downloads = [];
  const callbacks = [];
  let sends = 0;
  const runtime = {
    MessageMedia: Object.assign(function MessageMedia(mimetype, data) { return { mimetype, data }; }, {
      fromFilePath(filePath) { return { filePath, mimetype: "image/png", data: "" }; },
    }),
    client: {
      async sendMessage(to) {
        sends += 1;
        const id = `3EB0ECHO${sends}`;
        // WhatsApp reports our own message before the send call returns.
        callbacks.push(handleInboundMessage("responder", ownImageCallback(to, id, downloads), env, { ownOnly: true }));
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { id: { _serialized: `true_${to}_${id}`, id } };
      },
    },
  };
  try {
    setLocalWhatsAppRuntimeForTest("responder", runtime, {}, env);
    await sendLocalWhatsAppMessage({ accountId: "responder", chatId, attachments: files, env });
    const results = await Promise.all(callbacks);
    assert.deepEqual(results.map((result) => result.skipped), ["outbound_echo_attachment_pending_send", "outbound_echo_attachment_pending_send"]);
    assert.deepEqual(downloads, [], "echoes are dropped before any download");
    assert.equal((await listThreadMessages("echo-race-thread", env)).length, 0);
    const media = await fs.readdir(path.join(home, "whatsapp-bridge", "inbound-media")).catch(() => []);
    assert.deepEqual(media, [], "nothing is written to inbound media");
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("the in-flight marker ends with the send, so a later own photo is not swallowed", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-echo-marker-"));
  const env = { ORKESTR_HOME: home, ORKESTR_WHATSAPP_ACCOUNT_IDS: "responder" };
  const chatId = "chat-echo-marker@g.us";
  await boundThread(env, "echo-marker-thread", chatId);
  const file = path.join(home, "sent.png");
  await fs.writeFile(file, "png-bytes");
  const runtime = {
    MessageMedia: Object.assign(function MessageMedia(mimetype, data) { return { mimetype, data }; }, {
      fromFilePath(filePath) { return { filePath, mimetype: "image/png", data: "" }; },
    }),
    client: {
      async sendMessage(to) {
        return { id: { _serialized: `true_${to}_3EB0SENT`, id: "3EB0SENT" } };
      },
    },
  };
  try {
    setLocalWhatsAppRuntimeForTest("responder", runtime, {}, env);
    await sendLocalWhatsAppMessage({ accountId: "responder", chatId, attachments: [{ path: file, filename: "sent.png", mimetype: "image/png" }], env });
    const later = await handleInboundMessage("responder", ownImageCallback(chatId, "3EB0OWNERPHOTO", []), env, { ownOnly: true });
    assert.notEqual(later.skipped, "outbound_echo_attachment_pending_send");
  } finally {
    await resetLocalWhatsAppBridgeForTest(env);
  }
});

test("the gateway delivers one inbox event once, even when the retry pass overlaps a running delivery", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-connector-inbox-inflight-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_CONNECTOR_INBOUND_TARGET_URL: "http://127.0.0.1:9/api/connectors/whatsapp/inbound",
    ORKESTR_CONNECTOR_INBOUND_TOKEN: "test-token",
  };
  const { event } = await ensureConnectorInboxEvent({
    id: "3EB0EF69TEST",
    connector: "whatsapp",
    accountId: "responder",
    conversationId: "chat-inflight@g.us",
    payload: { eventId: "3EB0EF69TEST", chatId: "chat-inflight@g.us", accountId: "responder", text: "hi" },
  }, env);
  let posts = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetchImpl = async () => {
    posts += 1;
    await gate;
    return new Response(JSON.stringify({ ok: true, duplicate: false }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const first = deliverConnectorInboxEvent(event, env, fetchImpl);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const leased = await getConnectorInboxEvent(event.id, env);
  assert.ok(Date.parse(leased.nextAttemptAt) > Date.now(), "a running delivery holds a lease");
  const retry = await retryConnectorInbox(env, fetchImpl);
  assert.equal(retry.attempted, 0, "the retry pass skips the event while it is being delivered");
  const second = deliverConnectorInboxEvent(event, env, fetchImpl);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(posts, 1);
  assert.equal(a.state, "delivered");
  assert.equal(b.state, "delivered");
});

test("concurrent routes of the same WhatsApp event add one message", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-route-lock-"));
  const env = { ORKESTR_HOME: home, ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1", ORKESTR_WHATSAPP_API_AGENT_AUTORUN: "0" };
  await writeConnectorConfig("whatsapp", { routes: { "chat-1": "agent-1" } }, env);
  const input = (n) => ({
    eventId: "wa-evt-concurrent",
    chatId: "chat-1",
    from: "sender-1",
    text: "",
    attachments: [{ kind: "image", path: `/tmp/broker-copy-${n}.jpg` }],
  });
  const results = await Promise.all([1, 2, 3].map((n) => routeWhatsAppInbound(input(n), env)));
  const messages = await listAgentMessages("agent-1", env);
  assert.equal(messages.length, 1);
  assert.equal(results.filter((result) => result.duplicate === false).length, 1);
  assert.equal(results.filter((result) => result.duplicate === true).length, 2);
});
