import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { whatsappWorkerConfig, whatsappWorkerHealth, whatsappWorkerSend } from "../packages/connectors/src/whatsapp-worker-client.js";

async function closeServer(server, sockets = new Set()) {
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test("whatsapp worker config keeps health timeout separate from operations", () => {
  const long = whatsappWorkerConfig({ ORKESTR_WA_WORKER_TIMEOUT_MS: "60000" });
  assert.equal(long.operationTimeoutMs, 60000);
  assert.equal(long.timeoutMs, 60000);
  assert.equal(long.healthTimeoutMs, 5000);

  const explicitHealth = whatsappWorkerConfig({
    ORKESTR_WA_WORKER_TIMEOUT_MS: "60000",
    ORKESTR_WA_WORKER_HEALTH_TIMEOUT_MS: "50",
  });
  assert.equal(explicitHealth.operationTimeoutMs, 60000);
  assert.equal(explicitHealth.healthTimeoutMs, 50);
});

test("whatsapp worker health returns 503 for ok false payloads", async () => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: "worker_socket_stalled" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  try {
    await assert.rejects(
      () => whatsappWorkerHealth({ ORKESTR_WA_WORKER_URL: `http://127.0.0.1:${address.port}` }),
      (error) => {
        assert.equal(error.message, "worker_socket_stalled");
        assert.equal(error.statusCode, 503);
        assert.equal(error.payload.ok, false);
        return true;
      },
    );
  } finally {
    await closeServer(server);
  }
});

test("whatsapp worker health times out stalled unix sockets with 503", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-worker-stall-"));
  const socketPath = path.join(home, "worker.sock");
  const sockets = new Set();
  const server = http.createServer(() => {});
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const started = Date.now();

  try {
    await assert.rejects(
      () => whatsappWorkerHealth({
        ORKESTR_WA_WORKER_SOCKET: socketPath,
        ORKESTR_WA_WORKER_TIMEOUT_MS: "25",
      }),
      (error) => {
        assert.equal(error.message, "whatsapp_worker_timeout");
        assert.equal(error.statusCode, 503);
        return true;
      },
    );
    assert.equal(Date.now() - started < 1000, true);
  } finally {
    await closeServer(server, sockets);
  }
});

test("whatsapp worker health uses an absolute timeout for trickle responses", async () => {
  const sockets = new Set();
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write("{");
    const interval = setInterval(() => response.write(" "), 5);
    response.on("close", () => clearInterval(interval));
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const started = Date.now();

  try {
    await assert.rejects(
      () => whatsappWorkerHealth({
        ORKESTR_WA_WORKER_URL: `http://127.0.0.1:${address.port}`,
        ORKESTR_WA_WORKER_HEALTH_TIMEOUT_MS: "40",
      }),
      (error) => {
        assert.equal(error.message, "whatsapp_worker_timeout");
        assert.equal(error.statusCode, 503);
        return true;
      },
    );
    assert.equal(Date.now() - started < 1000, true);
  } finally {
    await closeServer(server, sockets);
  }
});

test("whatsapp worker send is not capped by the short health deadline", async () => {
  const server = http.createServer((request, response) => {
    if (request.url !== "/send-text") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: false, error: "missing" }));
      return;
    }
    setTimeout(() => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, messageId: "sent-after-health-deadline" }));
    }, 80);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  try {
    const result = await whatsappWorkerSend({
      accountId: "sender",
      conversationId: "chat@g.us",
      text: "hello",
    }, {
      ORKESTR_WA_WORKER_URL: `http://127.0.0.1:${address.port}`,
      ORKESTR_WA_WORKER_HEALTH_TIMEOUT_MS: "20",
      ORKESTR_WA_WORKER_TIMEOUT_MS: "500",
    });
    assert.equal(result.messageId, "sent-after-health-deadline");
  } finally {
    await closeServer(server);
  }
});
