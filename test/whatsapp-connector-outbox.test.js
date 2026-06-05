import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendThreadMessage, createThread } from "../packages/core/src/threads.js";
import { readConnectorOutbox } from "../packages/connectors/src/connector-outbox.js";
import { deliverWhatsAppReplies } from "../packages/connectors/src/whatsapp.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";

function response(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() {
      return payload;
    },
  };
}

function env(home, extra = {}) {
  return {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1",
    ORKESTR_WHATSAPP_DEBUG_FOOTER: "0",
    ORKESTR_WHATSAPP_API_AGENT_AUTORUN: "0",
    ...extra,
  };
}

test("whatsapp delivery terminalizes a tenant-scoped connector outbox job", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-connector-outbox-"));
  const runtimeEnv = env(home);
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, runtimeEnv);
  await createThread({
    id: "thread-wa-outbox",
    ownerUserId: "tenant-a",
    name: "WA Connector Outbox Thread",
    binding: {
      connector: "whatsapp",
      chatId: "shared-chat",
      responderAccountId: "responder",
      outboundAccountId: "responder",
      mirrorToWhatsApp: true,
    },
  }, runtimeEnv);
  const parent = await appendThreadMessage("thread-wa-outbox", {
    role: "user",
    source: "whatsapp_inbound",
    state: "completed",
    connector: "whatsapp",
    chatId: "shared-chat",
    accountId: "responder",
    text: "status?",
  }, runtimeEnv);
  const reply = await appendThreadMessage("thread-wa-outbox", {
    role: "assistant",
    source: "codex-app-server",
    phase: "final_answer",
    state: "completed",
    parentMessageId: parent.id,
    chatId: "shared-chat",
    accountId: "responder",
    text: "All routed messages are accounted for.",
  }, runtimeEnv);

  const delivery = await deliverWhatsAppReplies(runtimeEnv, async () => response({ ok: true, ids: ["wa-sent-1"] }));
  const outbox = await readConnectorOutbox(runtimeEnv);
  const job = outbox.jobs.find((item) => item.sourceMessageId === reply.id);

  assert.equal(delivery.delivered.length, 1);
  assert.equal(job?.state, "delivered");
  assert.equal(job.tenantId, "tenant-a");
  assert.equal(job.connector, "whatsapp");
  assert.equal(job.accountId, "responder");
  assert.equal(job.chatId, "shared-chat");
  assert.equal(job.threadId, "thread-wa-outbox");
  assert.equal(job.deliveryType, "final");
  assert.equal(job.payload.text, "All routed messages are accounted for.");
  assert.equal(job.brokerAck.ids[0], "wa-sent-1");
});
