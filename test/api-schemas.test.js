import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { createThread, listThreadMessages } from "../packages/core/src/threads.js";
import {
  agentMessageSchema,
  attachmentEncryptionMigrationSchema,
  attachmentEncryptionPolicySchema,
  attachmentEncryptionRecipientSchema,
  threadApproveSchema,
  threadBindingUpdateSchema,
  threadInputSchema,
  threadUiInputSchema,
  threadInterruptSchema,
  threadMessagesQuerySchema,
  threadRepoUpdateSchema,
  threadUploadSchema,
  threadWorkerCreateSchema,
  timerCreateSchema,
  whatsappInboundSchema,
} from "../packages/shared/src/api-schemas.js";

const serverEnvKeys = [
  "ORKESTR_HOME",
  "ORKESTR_AUTO_RUN_THREAD_INPUT",
  "ORKESTR_RECOVER_RUNNING_ON_START",
  "ORKESTR_WHATSAPP_AUTOSTART",
  "WHATSAPP_LOCAL_AUTOSTART",
];

// startServer owns process-wide background services. Keep this test process on
// a scratch home even after an individual server is closed, so a late callback
// can never fall back to the inherited operator/production home.
const schemaTestProcessHome = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-schema-process-"));
process.env.ORKESTR_HOME = schemaTestProcessHome;
process.env.ORKESTR_AUTO_RUN_THREAD_INPUT = "0";
process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
process.env.ORKESTR_WHATSAPP_AUTOSTART = "0";
process.env.WHATSAPP_LOCAL_AUTOSTART = "0";

function snapshotEnv(keys) {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const [key, value] of snapshot.entries()) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function startIsolatedSchemaServer(home) {
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTO_RUN_THREAD_INPUT = "0";
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  process.env.ORKESTR_WHATSAPP_AUTOSTART = "0";
  process.env.WHATSAPP_LOCAL_AUTOSTART = "0";
  return startServer({ port: 0, host: "127.0.0.1" });
}

test("shared API schemas expose high-value request contracts", () => {
  assert.equal(whatsappInboundSchema.body.properties.eventId.type, "string");
  assert.equal(whatsappInboundSchema.body.properties.attachments.type, "array");
  assert.equal(agentMessageSchema.params.required[0], "agentId");
  assert.equal(timerCreateSchema.body.properties.promptFile.type, "string");
  assert.equal(timerCreateSchema.body.properties.timezone.type, "string");
  assert.equal(threadInputSchema.body.properties.attachments.type, "array");
  assert.equal(threadInputSchema.body.properties.clientMessageId.type, "string");
  assert.equal(threadInputSchema.body.properties.idempotencyKey.type, "string");
  assert.deepEqual(threadUiInputSchema.body.properties.replyDelivery.enum, ["ui_only", "bound_whatsapp"]);
  assert.equal(threadUiInputSchema.body.additionalProperties, false);
  assert.equal(attachmentEncryptionRecipientSchema.body.additionalProperties, false);
  assert.deepEqual(attachmentEncryptionPolicySchema.body.required, ["enabled", "required"]);
  assert.equal(attachmentEncryptionMigrationSchema.body.properties.dryRun.type, "boolean");
  assert.equal(threadMessagesQuerySchema.querystring.properties.limit.type, "string");
  assert.equal(threadUploadSchema.body.properties.files.type, "array");
  assert.equal(threadInterruptSchema.params.required[0], "threadId");
  assert.equal(threadApproveSchema.body.properties.text.type, "string");
  assert.equal(threadWorkerCreateSchema.body.properties.autoRun.type, "boolean");
  assert.equal(threadBindingUpdateSchema.body.properties.mirrorToWhatsApp.type, "boolean");
  assert.equal(threadBindingUpdateSchema.body.properties.responderConnectorAccountId.type, "string");
  assert.equal(threadRepoUpdateSchema.body.properties.repoRemoteUrl.type, "string");
});

test("NestJS validates WhatsApp inbound request schema", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-schema-api-"));
  const priorEnv = snapshotEnv(serverEnvKeys);
  const server = await startIsolatedSchemaServer(home);
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/connectors/whatsapp/inbound`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        eventId: "invalid-attachments",
        agentId: "agent",
        text: "hello",
        attachments: { path: "/tmp/not-array" },
      }),
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.match(payload.error, /attachments/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    restoreEnv(priorEnv);
  }
});

test("NestJS validates thread route request schemas before use-case execution", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-schema-api-"));
  const priorEnv = snapshotEnv(serverEnvKeys);
  const server = await startIsolatedSchemaServer(home);
  const { port } = server.address();
  try {
    const created = await fetch(`http://127.0.0.1:${port}/api/threads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "schema-thread",
        name: "Schema Thread",
        executorId: "noop",
        executor: { type: "noop" },
      }),
    });
    assert.equal(created.ok, true);

    const invalidInput = await fetch(`http://127.0.0.1:${port}/api/threads/schema-thread/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "hello",
        attachments: { path: "/tmp/not-array" },
      }),
    });
    const invalidPayload = await invalidInput.json();
    assert.equal(invalidInput.status, 400);
    assert.match(invalidPayload.error, /body\.attachments/);

    const compatibleWorker = await fetch(`http://127.0.0.1:${port}/api/threads/missing/workers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ autoRun: "false" }),
    });
    const compatiblePayload = await compatibleWorker.json();
    assert.equal(compatibleWorker.status, 404);
    assert.match(compatiblePayload.error, /thread_not_found/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    restoreEnv(priorEnv);
  }
});

test("WebUI input authority is server-stamped and generic input cannot forge reply delivery", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-ui-input-authority-"));
  const priorEnv = snapshotEnv(serverEnvKeys);
  const server = await startIsolatedSchemaServer(home);
  const { port } = server.address();
  const runtimeEnv = { ...process.env, ORKESTR_HOME: home };
  try {
    await createThread({
      id: "thread-ui-input-authority",
      ownerUserId: "admin",
      name: "UI input authority",
      binding: {
        id: "binding-authority",
        connector: "whatsapp",
        chatId: "chat-authority",
        responderAccountId: "account-authority",
        mirrorToWhatsApp: true,
      },
    }, runtimeEnv);
    const forged = await fetch(`http://127.0.0.1:${port}/api/threads/thread-ui-input-authority/input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "forged generic input",
        autoRun: false,
        source: "ui",
        originSurface: "webui",
        replyDelivery: "bound_whatsapp",
        replyDeliveryIntent: {
          serverAuthored: true,
          channel: "whatsapp",
          mode: "bound_whatsapp",
          target: { threadId: "thread-ui-input-authority", chatId: "attacker-chat", bindingRevision: "forged" },
        },
      }),
    });
    assert.equal(forged.status, 202);

    const rejected = await fetch(`http://127.0.0.1:${port}/api/threads/thread-ui-input-authority/ui-input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "attempted UI spoof", source: "whatsapp_inbound", replyDelivery: "bound_whatsapp" }),
    });
    assert.equal(rejected.status, 400);

    const accepted = await fetch(`http://127.0.0.1:${port}/api/threads/thread-ui-input-authority/ui-input`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "trusted UI input", replyDelivery: "bound_whatsapp" }),
    });
    assert.equal(accepted.status, 202);
    const acceptedPayload = await accepted.json();
    assert.equal(acceptedPayload.message.replyDeliveryIntent.status, "pending_reply");
    assert.equal("target" in acceptedPayload.message.replyDeliveryIntent, false);
    assert.equal("serverAuthored" in acceptedPayload.message.replyDeliveryIntent, false);

    const messages = await listThreadMessages("thread-ui-input-authority", runtimeEnv);
    const forgedMessage = messages.find((message) => message.text === "forged generic input");
    const trustedMessage = messages.find((message) => message.text === "trusted UI input");
    assert.equal(forgedMessage.replyDeliveryIntent, undefined);
    assert.equal(trustedMessage.source, "ui");
    assert.equal(trustedMessage.originSurface, "webui");
    assert.equal(trustedMessage.replyDeliveryIntent.serverAuthored, true);
    assert.equal(trustedMessage.replyDeliveryIntent.target.chatId, "chat-authority");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    restoreEnv(priorEnv);
  }
});
