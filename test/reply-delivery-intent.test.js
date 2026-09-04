import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createHushReplyDeliveryIntent,
  createUiReplyDeliveryIntent,
  replyDeliveryProjectionParent,
  replyDeliveryBindingFence,
  trustedHushReplyDeliveryIntent,
  trustedUiReplyDeliveryIntent,
  uiReplyDeliveryProjectionParent,
} from "../packages/core/src/reply-delivery-intent.js";
import { appendThreadMessage, createThread, getThread, listThreadMessages, updateThread } from "../packages/core/src/threads.js";
import { deliverWhatsAppReplies } from "../packages/connectors/src/whatsapp.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";

function env(home) {
  return {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1",
    ORKESTR_WHATSAPP_DEBUG_FOOTER: "0",
    ORKESTR_WHATSAPP_API_AGENT_AUTORUN: "0",
  };
}

function binding(chatId = "chat-a", updatedAt = "2026-09-01T10:00:00.000Z") {
  return {
    id: "binding-a",
    connector: "whatsapp",
    chatId,
    responderAccountId: "account-a",
    outboundAccountId: "account-a",
    enabled: true,
    routeEligible: true,
    mirrorToWhatsApp: true,
    updatedAt,
  };
}

function response(payload, ok = true, status = 200) {
  return { ok, status, async json() { return payload; } };
}

test("server-authored UI reply intent snapshots the WhatsApp target and rejects spoofed origins", () => {
  const thread = { id: "thread-a", ownerUserId: "tenant-a", binding: binding() };
  const intent = createUiReplyDeliveryIntent(thread, {
    mode: "bound_whatsapp",
    requestedByUserId: "tenant-a",
    id: "intent-a",
    requestedAt: "2026-09-01T10:01:00.000Z",
  });
  const message = { role: "user", source: "ui", originSurface: "webui", replyDeliveryIntent: intent };

  assert.equal(intent.status, "pending_reply");
  assert.equal(intent.target.chatId, "chat-a");
  assert.equal(intent.target.accountId, "account-a");
  assert.equal(trustedUiReplyDeliveryIntent(message)?.id, "intent-a");
  assert.equal(uiReplyDeliveryProjectionParent(message)?.connector, "whatsapp");
  assert.equal(trustedUiReplyDeliveryIntent({ ...message, source: "cli" }), null);
  assert.equal(trustedUiReplyDeliveryIntent({ ...message, replyDeliveryIntent: { ...intent, serverAuthored: false } }), null);
  assert.equal(createUiReplyDeliveryIntent(thread, {
    mode: "bound_whatsapp",
    env: { ORKESTR_WEBUI_WHATSAPP_REPLY_DELIVERY: "0" },
  }).reason, "feature_disabled");
  assert.equal(createUiReplyDeliveryIntent(thread, {
    mode: "bound_whatsapp",
    env: { ORKESTR_WEBUI_WHATSAPP_REPLY_DELIVERY_THREAD_IDS: "another-thread" },
  }).reason, "thread_not_selected");
});

test("server-authored Hush reply intent is explicit, origin-bound, and projects the configured target", () => {
  const thread = { id: "thread-hush", ownerUserId: "tenant-a", binding: binding("chat-hush") };
  const intent = createHushReplyDeliveryIntent(thread, {
    enabled: true,
    requestedByUserId: "tenant-a",
    id: "intent-hush",
    requestedAt: "2026-09-01T10:01:00.000Z",
  });
  const message = {
    role: "user",
    source: "hush",
    originSurface: "mobile",
    originTransport: "hush-mobile",
    replyDeliveryIntent: intent,
  };

  assert.equal(intent.status, "pending_reply");
  assert.equal(intent.issuedFor, "hush-mobile");
  assert.equal(intent.target.chatId, "chat-hush");
  assert.equal(trustedHushReplyDeliveryIntent(message)?.id, "intent-hush");
  assert.equal(trustedUiReplyDeliveryIntent(message), null);
  assert.equal(replyDeliveryProjectionParent(message)?.connector, "whatsapp");
  assert.equal(replyDeliveryProjectionParent(message)?.chatId, "chat-hush");
  assert.equal(createHushReplyDeliveryIntent(thread, { enabled: false }), null);
  assert.equal(trustedHushReplyDeliveryIntent({ ...message, source: "cli" }), null);
  assert.equal(trustedHushReplyDeliveryIntent({ ...message, originTransport: "authenticated-http" }), null);
  assert.equal(trustedHushReplyDeliveryIntent({
    ...message,
    replyDeliveryIntent: { ...intent, serverAuthored: false },
  }), null);
  const disabledThread = {
    ...thread,
    binding: { ...thread.binding, mirrorToWhatsApp: false },
  };
  const disabledIntent = createHushReplyDeliveryIntent(disabledThread, { enabled: true });
  assert.equal(disabledIntent.status, "policy_skipped");
  assert.equal(replyDeliveryProjectionParent({
    ...message,
    replyDeliveryIntent: disabledIntent,
  }), null);
});

test("binding fence permits the immutable target and terminally rejects binding changes", () => {
  const thread = { id: "thread-a", ownerUserId: "tenant-a", binding: binding() };
  const parent = {
    source: "ui",
    originSurface: "webui",
    replyDeliveryIntent: createUiReplyDeliveryIntent(thread, { mode: "bound_whatsapp", id: "intent-a" }),
  };

  assert.equal(replyDeliveryBindingFence(parent, thread).allowed, true);
  const changed = { ...thread, binding: binding("chat-b", "2026-09-01T10:02:00.000Z") };
  assert.deepEqual(
    { allowed: replyDeliveryBindingFence(parent, changed).allowed, reason: replyDeliveryBindingFence(parent, changed).reason },
    { allowed: false, reason: "binding_changed" },
  );
});

test("UI-requested Codex final is delivered once and records durable intent completion", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-ui-reply-delivery-"));
  const runtimeEnv = env(home);
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, runtimeEnv);
  await createThread({ id: "thread-ui-reply", ownerUserId: "tenant-a", name: "UI reply", binding: binding() }, runtimeEnv);
  const thread = await getThread("thread-ui-reply", runtimeEnv);
  const parent = await appendThreadMessage(thread.id, {
    role: "user",
    source: "ui",
    originSurface: "webui",
    state: "completed",
    text: "Send the result here and to WhatsApp",
    replyDeliveryIntent: createUiReplyDeliveryIntent(thread, { mode: "bound_whatsapp", id: "intent-ui" }),
  }, runtimeEnv);
  const projected = uiReplyDeliveryProjectionParent(parent);
  const reply = await appendThreadMessage(thread.id, {
    role: "assistant",
    source: "codex-app-server",
    phase: "final_answer",
    state: "completed",
    parentMessageId: parent.id,
    connector: "whatsapp",
    chatId: projected.chatId,
    accountId: projected.accountId,
    text: "Completed from the WebUI request.",
  }, runtimeEnv);
  let sends = 0;
  const fetchImpl = async (_url, options = {}) => {
    if (options.method === "POST") sends += 1;
    return response({ ok: true, ids: ["wa-ui-final-1"] });
  };

  const first = await deliverWhatsAppReplies(runtimeEnv, fetchImpl);
  const duplicate = await deliverWhatsAppReplies(runtimeEnv, fetchImpl);
  const messages = await listThreadMessages(thread.id, runtimeEnv);
  const storedParent = messages.find((message) => message.id === parent.id);

  assert.equal(first.delivered.some((delivery) => delivery.messageId === reply.id), true);
  assert.equal(duplicate.delivered.length, 0);
  assert.equal(sends, 1);
  assert.equal(storedParent.replyDeliveryIntent.status, "delivered");
  assert.equal(storedParent.replyDeliveryIntent.connectorMessageId, "wa-ui-final-1");
  assert.equal(storedParent.replyDeliveryIntent.target.chatId, "chat-a");
});

test("Hush-requested Codex final is delivered once and records durable intent completion", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-hush-reply-delivery-"));
  const runtimeEnv = env(home);
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, runtimeEnv);
  await createThread({ id: "thread-hush-reply", ownerUserId: "tenant-a", name: "Hush reply", binding: binding() }, runtimeEnv);
  const thread = await getThread("thread-hush-reply", runtimeEnv);
  const parent = await appendThreadMessage(thread.id, {
    role: "user",
    source: "hush",
    originSurface: "mobile",
    originTransport: "hush-mobile",
    state: "completed",
    text: "Send the Hush result to WhatsApp",
    replyDeliveryIntent: createHushReplyDeliveryIntent(thread, {
      enabled: true,
      requestedByUserId: "tenant-a",
      id: "intent-hush-delivery",
    }),
  }, runtimeEnv);
  const projected = replyDeliveryProjectionParent(parent);
  const reply = await appendThreadMessage(thread.id, {
    role: "assistant",
    source: "codex-app-server",
    phase: "final_answer",
    state: "completed",
    parentMessageId: parent.id,
    connector: "whatsapp",
    chatId: projected.chatId,
    accountId: projected.accountId,
    text: "Completed from the Hush request.",
  }, runtimeEnv);
  let sends = 0;
  const fetchImpl = async (_url, options = {}) => {
    if (options.method === "POST") sends += 1;
    return response({ ok: true, ids: ["wa-hush-final-1"] });
  };

  const first = await deliverWhatsAppReplies(runtimeEnv, fetchImpl);
  const duplicate = await deliverWhatsAppReplies(runtimeEnv, fetchImpl);
  const messages = await listThreadMessages(thread.id, runtimeEnv);
  const storedParent = messages.find((message) => message.id === parent.id);

  assert.equal(first.delivered.some((delivery) => delivery.messageId === reply.id), true);
  assert.equal(duplicate.delivered.length, 0);
  assert.equal(sends, 1);
  assert.equal(storedParent.replyDeliveryIntent.status, "delivered");
  assert.equal(storedParent.replyDeliveryIntent.connectorMessageId, "wa-hush-final-1");
});

test("UI-requested reply remains durably queued across a retryable WhatsApp outage", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-ui-reply-queued-"));
  const runtimeEnv = env(home);
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, runtimeEnv);
  await createThread({ id: "thread-ui-queued", ownerUserId: "tenant-a", name: "UI queued", binding: binding() }, runtimeEnv);
  const thread = await getThread("thread-ui-queued", runtimeEnv);
  const parent = await appendThreadMessage(thread.id, {
    role: "user",
    source: "ui",
    originSurface: "webui",
    state: "completed",
    text: "Queue this for WhatsApp",
    replyDeliveryIntent: createUiReplyDeliveryIntent(thread, { mode: "bound_whatsapp", id: "intent-queued" }),
  }, runtimeEnv);
  const projected = uiReplyDeliveryProjectionParent(parent);
  await appendThreadMessage(thread.id, {
    role: "assistant",
    source: "codex-app-server",
    phase: "final_answer",
    state: "completed",
    parentMessageId: parent.id,
    connector: "whatsapp",
    chatId: projected.chatId,
    accountId: projected.accountId,
    text: "Persist me until transport recovers.",
  }, runtimeEnv);

  const result = await deliverWhatsAppReplies(runtimeEnv, async () => response({ error: "bridge_unavailable" }, false, 503));
  const storedParent = (await listThreadMessages(thread.id, runtimeEnv)).find((message) => message.id === parent.id);

  assert.equal(result.failed.length, 1);
  assert.equal(storedParent.replyDeliveryIntent.status, "queued");
  assert.equal(Boolean(storedParent.replyDeliveryIntent.outboxId), true);
});

test("UI-requested final never retargets after the thread binding changes", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-ui-reply-fence-"));
  const runtimeEnv = env(home);
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, runtimeEnv);
  await createThread({ id: "thread-ui-fence", ownerUserId: "tenant-a", name: "UI fence", binding: binding() }, runtimeEnv);
  const thread = await getThread("thread-ui-fence", runtimeEnv);
  const parent = await appendThreadMessage(thread.id, {
    role: "user",
    source: "ui",
    originSurface: "webui",
    state: "completed",
    text: "Do not retarget this reply",
    replyDeliveryIntent: createUiReplyDeliveryIntent(thread, { mode: "bound_whatsapp", id: "intent-fence" }),
  }, runtimeEnv);
  const projected = uiReplyDeliveryProjectionParent(parent);
  const reply = await appendThreadMessage(thread.id, {
    role: "assistant",
    source: "codex-app-server",
    phase: "final_answer",
    state: "completed",
    parentMessageId: parent.id,
    connector: "whatsapp",
    chatId: projected.chatId,
    accountId: projected.accountId,
    text: "This result belongs only to the original target.",
  }, runtimeEnv);
  await updateThread(thread.id, { binding: binding("chat-b", "2026-09-01T10:03:00.000Z") }, runtimeEnv);
  let sends = 0;
  const result = await deliverWhatsAppReplies(runtimeEnv, async () => {
    sends += 1;
    return response({ ok: true, ids: ["unexpected"] });
  });
  const messages = await listThreadMessages(thread.id, runtimeEnv);
  const storedParent = messages.find((message) => message.id === parent.id);

  assert.equal(result.delivered.length, 0);
  assert.equal(result.skipped.some((item) => item.messageId === reply.id && item.reason === "binding_changed"), true);
  assert.equal(sends, 0);
  assert.equal(storedParent.replyDeliveryIntent.status, "policy_skipped");
  assert.equal(storedParent.replyDeliveryIntent.reason, "binding_changed");
  assert.equal(storedParent.replyDeliveryIntent.target.chatId, "chat-a");
});
