import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import {
  agentMessageSchema,
  threadApproveSchema,
  threadBindingUpdateSchema,
  threadInputSchema,
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
  "ORKESTR_RECOVER_RUNNING_ON_START",
  "ORKESTR_WHATSAPP_AUTOSTART",
  "WHATSAPP_LOCAL_AUTOSTART",
];

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
