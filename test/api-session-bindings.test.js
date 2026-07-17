import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendApiSessionMessage,
  bindApiSessionToThread,
  getApiSessionBinding,
} from "../packages/core/src/api-session-bindings.js";
import { listWatcherAlerts, recordWatcherAlert, updateWatcherAlertLifecycle } from "../packages/core/src/watcher-alerts.js";
import { createThread, listThreadMessages } from "../packages/core/src/threads.js";
import { whereAmI } from "../packages/core/src/whereiam.js";
import {
  deliverWhatsAppReplies,
  waitForWhatsAppOutboundDeliveryResultForMessage,
} from "../packages/connectors/src/whatsapp.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";

function env(home, extra = {}) {
  return {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1",
    ORKESTR_WHATSAPP_DEBUG_FOOTER: "0",
    ORKESTR_WHATSAPP_API_AGENT_AUTORUN: "0",
    ...extra,
  };
}

function response(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() {
      return payload;
    },
  };
}

test("api session binding persists and mirrors assistant output through the bound WhatsApp thread", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-session-"));
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-session-repo-"));
  const runtimeEnv = env(home);
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, runtimeEnv);
  await createThread({
    id: "api-session-thread",
    name: "API Session Thread",
    cwd: repo,
    repoPath: repo,
    binding: {
      connector: "whatsapp",
      chatId: "chat-1",
      responderAccountId: "responder-1",
      mirrorToWhatsApp: true,
    },
  }, runtimeEnv);

  const bound = await bindApiSessionToThread({
    apiSessionId: "api-session-1",
    threadId: "api-session-thread",
    cwd: repo,
    metadata: {
      client: "test-client",
      token: "must-not-persist",
    },
  }, runtimeEnv);
  const stored = await getApiSessionBinding("api-session-1", runtimeEnv);
  const where = await whereAmI({ apiSessionId: "api-session-1", cwd: "/tmp/elsewhere" }, runtimeEnv);

  assert.equal(bound.binding.threadId, "api-session-thread");
  assert.equal(stored.metadata.client, "test-client");
  assert.equal(stored.metadata.token, undefined);
  assert.equal(where.matchedBy, "apiSessionId");
  assert.equal(where.thread.id, "api-session-thread");

  const user = await appendApiSessionMessage({
    apiSessionId: "api-session-1",
    role: "user",
    text: "What happened?",
  }, runtimeEnv);
  assert.equal(user.message.connector, undefined);

  const assistant = await appendApiSessionMessage({
    apiSessionId: "api-session-1",
    role: "assistant",
    text: "The router skipped the outbound intent.",
  }, runtimeEnv);
  assert.equal(assistant.deliveryExpected, true);
  assert.equal(assistant.message.connector, "whatsapp");
  assert.equal(assistant.message.chatId, "chat-1");
  assert.equal(assistant.message.accountId, "responder-1");
  assert.equal(assistant.message.apiSessionId, "api-session-1");

  const calls = [];
  const delivery = await deliverWhatsAppReplies(runtimeEnv, async (url, options = {}) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(options.body || "{}")),
    });
    return response({ ok: true, ids: ["sent-1"] });
  });
  const sendCall = calls.find((call) => call.url.endsWith("/send-text"));

  assert.equal(delivery.delivered.length, 1);
  assert.equal(delivery.delivered[0].messageId, assistant.message.id);
  assert.ok(sendCall);
  assert.equal(sendCall.body.to, "chat-1");
  assert.match(sendCall.body.text, /router skipped the outbound intent/);
});

test("api session assistant output delivers after the WhatsApp mirror cursor advanced", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-session-cursor-"));
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-session-cursor-repo-"));
  const runtimeEnv = env(home);
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, runtimeEnv);
  await createThread({
    id: "api-session-cursor-thread",
    name: "API Session Cursor Thread",
    cwd: repo,
    repoPath: repo,
    binding: {
      connector: "whatsapp",
      chatId: "chat-cursor",
      responderAccountId: "responder-cursor",
      mirrorToWhatsApp: true,
    },
  }, runtimeEnv);
  await bindApiSessionToThread({
    apiSessionId: "api-session-cursor",
    threadId: "api-session-cursor-thread",
    cwd: repo,
  }, runtimeEnv);
  await fs.writeFile(path.join(home, "whatsapp.json"), JSON.stringify({
    inboundEvents: [],
    outboundDeliveries: [],
    outboundDeliveryClaims: [],
    outboundIntents: [],
    outboundMirrorCursors: [{
      messageSetKey: "thread||api-session-cursor-thread",
      kind: "thread",
      threadId: "api-session-cursor-thread",
      cursor: 999,
      updatedAt: new Date().toISOString(),
    }],
  }, null, 2), "utf8");

  const assistant = await appendApiSessionMessage({
    apiSessionId: "api-session-cursor",
    role: "assistant",
    phase: "final_answer",
    text: "This final answer must still reach WhatsApp.",
  }, runtimeEnv);

  const calls = [];
  const delivery = await deliverWhatsAppReplies(runtimeEnv, async (url, options = {}) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(options.body || "{}")),
    });
    return response({ ok: true, ids: ["sent-cursor"] });
  });
  const sendCalls = calls.filter((call) => call.url.endsWith("/send-text"));
  const state = JSON.parse(await fs.readFile(path.join(home, "whatsapp.json"), "utf8"));
  const intent = state.outboundIntents.find((item) => item.messageId === assistant.message.id);

  assert.equal(assistant.deliveryExpected, true);
  assert.equal(delivery.delivered.length, 1);
  assert.equal(delivery.delivered[0].messageId, assistant.message.id);
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].body.to, "chat-cursor");
  assert.match(sendCalls[0].body.text, /must still reach WhatsApp/);
  assert.equal(intent.status, "delivered");
  assert.equal(intent.createdReason, "live_bound_recovery");
});

test("api session delivery confirmation observes persisted WhatsApp delivery", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-session-delivery-confirm-"));
  const runtimeEnv = env(home);
  const whatsappFile = path.join(home, "whatsapp.json");
  await fs.writeFile(whatsappFile, JSON.stringify({
    inboundEvents: [],
    outboundDeliveries: [],
    outboundDeliveryClaims: [],
    outboundIntents: [{
      messageId: "api-session-message-1",
      messageSetKey: "thread||api-session-thread",
      threadId: "api-session-thread",
      chatId: "chat-1",
      status: "pending",
      createdAt: new Date().toISOString(),
    }],
    outboundMirrorCursors: [],
  }, null, 2), "utf8");

  const markDelivered = (async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    await fs.writeFile(whatsappFile, JSON.stringify({
      inboundEvents: [],
      outboundDeliveries: [],
      outboundDeliveryClaims: [],
      outboundIntents: [{
        messageId: "api-session-message-1",
        messageSetKey: "thread||api-session-thread",
        threadId: "api-session-thread",
        chatId: "chat-1",
        status: "delivered",
        deliveredAt: "2026-06-30T19:23:09.184Z",
        updatedAt: "2026-06-30T19:23:09.184Z",
      }],
      outboundMirrorCursors: [],
    }, null, 2), "utf8");
  })();

  const result = await waitForWhatsAppOutboundDeliveryResultForMessage("api-session-message-1", {
    env: runtimeEnv,
    timeoutMs: 500,
    intervalMs: 10,
  });
  await markDelivered;

  assert.equal(result.ok, true);
  assert.equal(result.state, "delivered");
  assert.equal(result.delivered.messageId, "api-session-message-1");
  assert.equal(result.delivered.threadId, "api-session-thread");
});

test("watcher alerts create the configured watcher thread, redact secrets, and dedupe repeats", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-watcher-alert-"));
  const runtimeEnv = env(home, {
    ORKESTR_WATCHER_THREAD_NAME: "test-watcher",
    ORKESTR_WATCHER_DEDUPE_MS: "60000",
  });

  const first = await recordWatcherAlert({
    source: "test.router",
    code: "test_failure",
    message: "bridge failed token=secret-value",
    threadId: "thread-1",
    routerTraceId: "trace-1",
    details: {
      accountId: "responder",
      bindingId: "thread:thread-1:whatsapp",
      apiToken: "must-not-render",
    },
  }, runtimeEnv);
  const second = await recordWatcherAlert({
    source: "test.router",
    code: "test_failure",
    message: "bridge failed token=secret-value",
    threadId: "thread-1",
    routerTraceId: "trace-1",
  }, runtimeEnv);
  const listed = await listWatcherAlerts({ limit: 10 }, runtimeEnv);
  const messages = await listThreadMessages(first.thread.id, runtimeEnv);

  assert.equal(first.ok, true);
  assert.equal(first.thread.name, "test-watcher");
  assert.equal(second.skipped, true);
  assert.equal(second.reason, "deduped");
  assert.equal(listed.total, 1);
  assert.equal(listed.alerts[0].id, first.alert.id);
  assert.equal(listed.alerts[0].details.accountId, "responder");
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /\[watcher:error\] test\.router/);
  assert.match(messages[0].text, /routerTrace: trace-1/);
  assert.match(messages[0].text, /context: accountId=responder bindingId=thread:thread-1:whatsapp/);
  assert.match(messages[0].text, /token=\[redacted\]/);
  assert.doesNotMatch(messages[0].text, /secret-value/);
  assert.doesNotMatch(messages[0].text, /must-not-render/);
  assert.doesNotMatch(JSON.stringify(listed), /must-not-render|secret-value/);
});

test("watcher alerts group unresolved repeats beyond the time window and reopen after resolution", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-watcher-alert-active-"));
  const runtimeEnv = env(home, {
    ORKESTR_WATCHER_THREAD_NAME: "test-watcher-active",
    ORKESTR_WATCHER_DEDUPE_MS: "1",
  });
  const input = {
    source: "test.delivery",
    code: "stale_untracked_reply",
    message: "same unresolved delivery anomaly",
    threadId: "thread-1",
  };

  const first = await recordWatcherAlert(input, runtimeEnv);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const repeated = await recordWatcherAlert(input, runtimeEnv);
  const grouped = await listWatcherAlerts({ limit: 10 }, runtimeEnv);
  await updateWatcherAlertLifecycle(first.alert.id, "resolve", { actorUserId: "ops-admin" }, runtimeEnv);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const reopened = await recordWatcherAlert(input, runtimeEnv);
  const finalList = await listWatcherAlerts({ limit: 10 }, runtimeEnv);
  const messages = await listThreadMessages(first.thread.id, runtimeEnv);

  assert.equal(repeated.skipped, true);
  assert.equal(repeated.reason, "active_alert");
  assert.equal(grouped.total, 1);
  assert.equal(reopened.skipped, undefined);
  assert.equal(reopened.alert.status, "recorded");
  assert.equal(finalList.total, 1);
  assert.equal(messages.length, 2);
});

test("watcher alerts compact persisted duplicate rows during an active repeat", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-watcher-alert-compact-"));
  const runtimeEnv = env(home, {
    ORKESTR_WATCHER_THREAD_NAME: "test-watcher-compact",
    ORKESTR_WATCHER_DEDUPE_MS: "1",
  });
  const input = {
    source: "test.delivery",
    code: "stale_untracked_reply",
    message: "same persisted delivery anomaly",
    threadId: "thread-1",
  };

  const first = await recordWatcherAlert(input, runtimeEnv);
  const storePath = path.join(home, "watcher-alerts.json");
  const stored = JSON.parse(await fs.readFile(storePath, "utf8"));
  await fs.writeFile(storePath, JSON.stringify({
    ...stored,
    alerts: [
      stored.alerts[0],
      { ...stored.alerts[0], createdAt: new Date(Date.parse(stored.alerts[0].createdAt) + 1).toISOString() },
    ],
  }, null, 2), "utf8");
  await new Promise((resolve) => setTimeout(resolve, 5));

  const repeated = await recordWatcherAlert(input, runtimeEnv);
  const compacted = JSON.parse(await fs.readFile(storePath, "utf8"));

  assert.equal(repeated.skipped, true);
  assert.equal(repeated.reason, "active_alert");
  assert.equal(repeated.alert.id, first.alert.id);
  assert.equal(compacted.alerts.length, 1);
  assert.equal(compacted.alerts[0].id, first.alert.id);
});

test("watcher alert lifecycle actions update status and escalate to watcher thread", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-watcher-alert-lifecycle-"));
  const runtimeEnv = env(home, {
    ORKESTR_WATCHER_THREAD_NAME: "test-watcher-lifecycle",
    ORKESTR_WATCHER_DEDUPE_MS: "0",
  });

  const recorded = await recordWatcherAlert({
    source: "test.lifecycle",
    code: "needs_operator",
    message: "operator review needed",
    threadId: "thread-1",
  }, runtimeEnv);
  const acknowledged = await updateWatcherAlertLifecycle(recorded.alert.id, "acknowledge", {
    actorUserId: "ops-admin",
    reason: "investigating",
  }, runtimeEnv);
  const escalated = await updateWatcherAlertLifecycle(recorded.alert.id, "escalate", {
    actorUserId: "ops-admin",
    reason: "notify owner",
  }, runtimeEnv);
  const resolved = await updateWatcherAlertLifecycle(recorded.alert.id, "resolve", {
    actorUserId: "ops-admin",
    reason: "fixed",
  }, runtimeEnv);
  const resolvedList = await listWatcherAlerts({ status: "resolved", limit: 10 }, runtimeEnv);
  const reopened = await updateWatcherAlertLifecycle(recorded.alert.id, "reopen", {
    actorUserId: "ops-admin",
    reason: "regressed",
  }, runtimeEnv);
  const messages = await listThreadMessages(recorded.thread.id, runtimeEnv);

  assert.equal(acknowledged.alert.status, "acknowledged");
  assert.equal(acknowledged.alert.acknowledgedBy, "ops-admin");
  assert.equal(escalated.alert.status, "escalated");
  assert.equal(escalated.alert.escalatedBy, "ops-admin");
  assert.ok(escalated.alert.escalationMessageId);
  assert.equal(resolved.alert.status, "resolved");
  assert.equal(resolved.alert.resolvedBy, "ops-admin");
  assert.equal(resolvedList.total, 1);
  assert.equal(resolvedList.alerts[0].id, recorded.alert.id);
  assert.equal(reopened.alert.status, "recorded");
  assert.equal(reopened.alert.reopenedBy, "ops-admin");
  assert.ok(reopened.alert.lifecycle.length >= 4);
  assert.equal(messages.length, 2);
  assert.match(messages[1].text, /\[watcher:escalate\] test\.lifecycle/);
  assert.match(messages[1].text, /operator: ops-admin/);
  assert.match(messages[1].text, /reason: notify owner/);
});

test("watcher alerts can stay out of WhatsApp mirroring for delivery anomalies", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-watcher-alert-no-wa-"));
  const runtimeEnv = env(home, {
    ORKESTR_WATCHER_THREAD_NAME: "test-watcher-wa",
  });
  const watcherThread = await createThread({
    id: "test-watcher-wa-thread",
    name: "test-watcher-wa",
    title: "Test watcher WA",
    state: "ready",
    binding: {
      connector: "whatsapp",
      chatId: "watcher-chat",
      responderAccountId: "responder",
      outboundAccountId: "responder",
      mirrorToWhatsApp: true,
    },
  }, runtimeEnv);

  const result = await recordWatcherAlert({
    source: "server.whatsappDeliveryScheduler",
    code: "whatsapp_delivery_failed",
    message: "WhatsApp delivery anomaly: bridge_not_ready",
    threadId: "thread-1",
    messageId: "message-1",
  }, runtimeEnv);
  const messages = await listThreadMessages(watcherThread.id, runtimeEnv);

  assert.equal(result.ok, true);
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /\[watcher:error\] server\.whatsappDeliveryScheduler/);
  assert.equal(messages[0].connector || "", "");
  assert.equal(messages[0].chatId || "", "");
  assert.equal(messages[0].originSurface || "", "");
});

test("watcher alerts suppress WhatsApp mirroring when bridge is unavailable", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-watcher-alert-wa-loop-"));
  const runtimeEnv = env(home, {
    ORKESTR_WATCHER_THREAD_NAME: "test-watcher-wa-loop",
  });
  const watcherThread = await createThread({
    id: "test-watcher-wa-loop-thread",
    name: "test-watcher-wa-loop",
    title: "Test watcher WA loop",
    state: "ready",
    binding: {
      connector: "whatsapp",
      chatId: "watcher-chat",
      responderAccountId: "responder",
      outboundAccountId: "responder",
      mirrorToWhatsApp: true,
    },
  }, runtimeEnv);

  const result = await recordWatcherAlert({
    source: "server.deliverWhatsAppReplies",
    code: "whatsapp_reply_delivery_failed",
    message: "whatsapp_local_bridge_not_ready: Local bridge is restarting",
    mirrorToConnector: true,
    details: {
      reason: "whatsapp_local_bridge_not_ready",
      chatId: "watcher-chat",
    },
  }, runtimeEnv);
  const messages = await listThreadMessages(watcherThread.id, runtimeEnv);

  assert.equal(result.ok, true);
  assert.equal(result.alert.mirrorToConnector, true);
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /\[watcher:error\] server\.deliverWhatsAppReplies/);
  assert.equal(messages[0].connector || "", "");
  assert.equal(messages[0].chatId || "", "");
  assert.equal(messages[0].originSurface || "", "");
});
