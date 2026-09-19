import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createConnectorsMcpGateway } from "../scripts/orkestr-connectors-mcp.mjs";

async function listen(server) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

for (const legacy of [false, true]) test(`legacy REST gateway preserves sanitized partial evidence (wrapped=${legacy})`, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-gateway-evidence-"));
  let requests = 0;
  const worker = http.createServer(async (req, res) => {
    for await (const chunk of req) { /* consume only synthetic test input */ }
    requests++;
    assert.equal(req.url, "/send-media");
    res.writeHead(409, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: false,
      error: legacy ? 'HTTP 409: {"error":"whatsapp_partial_delivery"}' : "whatsapp_partial_delivery",
      partialDelivery: {
        sent: [{ id: "synthetic-text-id", kind: "text", filename: "PRIVATE_FIXTURE" }],
        attachments: [{ index: 0, outcome: "uncertain", path: "/PRIVATE_FIXTURE" }],
        failedKind: "attachment", failureCode: "provider_evaluation_failed", stage: "send_media",
        failureFingerprint: "abcdef012345abcdef012345", token: "PRIVATE_FIXTURE", ownerUserId: "PRIVATE_FIXTURE",
      },
    }));
  });
  const workerUrl = await listen(worker);
  const gateway = createConnectorsMcpGateway({ env: {
    ORKESTR_HOME: home, ORKESTR_CONNECTORS_MCP_HOST: "127.0.0.1",
    ORKESTR_CONNECTORS_MCP_ALLOWED_HOSTS: "127.0.0.1,localhost",
    ORKESTR_WA_SERVICE_TOKEN: "synthetic-token", ORKESTR_WA_WORKER_URL: workerUrl,
    ORKESTR_CONNECTOR_INBOX_RETRY_INTERVAL_MS: "60000",
  } });
  const server = http.createServer(gateway.app);
  try {
    const url = await listen(server);
    const response = await fetch(`${url}/send-media`, {
      method: "POST", headers: { authorization: "Bearer synthetic-token", "content-type": "application/json" },
      body: JSON.stringify({ to: "synthetic-chat", accountId: "synthetic-account" }),
    });
    const body = await response.json();
    assert.equal(response.status, 409);
    assert.equal(body.error, "whatsapp_partial_delivery");
    assert.equal(body.retryable, false);
    assert.equal(body.partialDelivery.stage, "send_media");
    assert.equal(body.partialDelivery.failureCode, "provider_evaluation_failed");
    assert.deepEqual(body.partialDelivery.sent, [{ id: "synthetic-text-id", kind: "text" }]);
    assert.deepEqual(body.partialDelivery.attachments, [{ index: 0, outcome: "uncertain" }]);
    assert.equal(JSON.stringify(body).includes("PRIVATE_FIXTURE"), false);
    assert.equal(requests, 1);
  } finally {
    gateway.close();
    await Promise.all([server, worker].map(s => new Promise(resolve => s.close(resolve))));
  }
});
