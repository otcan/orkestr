import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { agentMessageSchema, timerCreateSchema, whatsappInboundSchema } from "../packages/shared/src/api-schemas.js";

test("shared API schemas expose high-value request contracts", () => {
  assert.equal(whatsappInboundSchema.body.properties.eventId.type, "string");
  assert.equal(whatsappInboundSchema.body.properties.attachments.type, "array");
  assert.equal(agentMessageSchema.params.required[0], "agentId");
  assert.equal(timerCreateSchema.body.properties.promptFile.type, "string");
});

test("Fastify validates WhatsApp inbound request schema", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-schema-api-"));
  const priorHome = process.env.ORKESTR_HOME;
  process.env.ORKESTR_HOME = home;
  const server = await startServer({ port: 0, host: "127.0.0.1" });
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
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
  }
});
