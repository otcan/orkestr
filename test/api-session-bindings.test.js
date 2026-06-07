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
import { recordWatcherAlert } from "../packages/core/src/watcher-alerts.js";
import { createThread, listThreadMessages } from "../packages/core/src/threads.js";
import { whereAmI } from "../packages/core/src/whereiam.js";
import { deliverWhatsAppReplies } from "../packages/connectors/src/whatsapp.js";
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
  const delivery = await deliverWhatsAppReplies(runtimeEnv, async (_url, options = {}) => {
    calls.push(JSON.parse(String(options.body || "{}")));
    return response({ ok: true, ids: ["sent-1"] });
  });

  assert.equal(delivery.delivered.length, 1);
  assert.equal(delivery.delivered[0].messageId, assistant.message.id);
  assert.equal(calls[0].to, "chat-1");
  assert.match(calls[0].text, /router skipped the outbound intent/);
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
  const messages = await listThreadMessages(first.thread.id, runtimeEnv);

  assert.equal(first.ok, true);
  assert.equal(first.thread.name, "test-watcher");
  assert.equal(second.skipped, true);
  assert.equal(second.reason, "deduped");
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /\[watcher:error\] test\.router/);
  assert.match(messages[0].text, /routerTrace: trace-1/);
  assert.match(messages[0].text, /context: accountId=responder bindingId=thread:thread-1:whatsapp/);
  assert.match(messages[0].text, /token=\[redacted\]/);
  assert.doesNotMatch(messages[0].text, /secret-value/);
  assert.doesNotMatch(messages[0].text, /must-not-render/);
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
    mirrorToConnector: false,
  }, runtimeEnv);
  const messages = await listThreadMessages(watcherThread.id, runtimeEnv);

  assert.equal(result.ok, true);
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /\[watcher:error\] server\.whatsappDeliveryScheduler/);
  assert.equal(messages[0].connector || "", "");
  assert.equal(messages[0].chatId || "", "");
  assert.equal(messages[0].originSurface || "", "");
});
