import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { auditLocalWhatsAppGroupPictures } from "../packages/connectors/src/whatsapp-group-picture-audit.js";
import { whatsappWorkerGroupPictureAudit } from "../packages/connectors/src/whatsapp-worker-client.js";

// ── Core audit logic ──────────────────────────────────────────────────────────

test("picture audit returns present when getProfilePicUrl returns a url", async () => {
  const client = {
    async getProfilePicUrl() {
      return "https://pps.whatsapp.net/v/t61.24694-24/pic.jpg";
    },
  };
  const results = await auditLocalWhatsAppGroupPictures({
    client,
    chatIds: ["120363429022300057@g.us"],
  });
  assert.deepEqual(results, [{ chatId: "120363429022300057@g.us", status: "present" }]);
});

test("picture audit returns missing when getProfilePicUrl returns undefined", async () => {
  const client = {
    async getProfilePicUrl() {
      return undefined;
    },
  };
  const results = await auditLocalWhatsAppGroupPictures({
    client,
    chatIds: ["120363429022300057@g.us"],
  });
  assert.deepEqual(results, [{ chatId: "120363429022300057@g.us", status: "missing" }]);
});

test("picture audit returns missing when getProfilePicUrl returns null", async () => {
  const client = {
    async getProfilePicUrl() {
      return null;
    },
  };
  const results = await auditLocalWhatsAppGroupPictures({
    client,
    chatIds: ["120363429022300057@g.us"],
  });
  assert.deepEqual(results, [{ chatId: "120363429022300057@g.us", status: "missing" }]);
});

test("picture audit returns unknown when getProfilePicUrl throws", async () => {
  const client = {
    async getProfilePicUrl() {
      throw new Error("chat_fetch_error");
    },
  };
  const results = await auditLocalWhatsAppGroupPictures({
    client,
    chatIds: ["120363429022300057@g.us"],
  });
  assert.deepEqual(results, [{ chatId: "120363429022300057@g.us", status: "unknown" }]);
});

test("picture audit excludes non-group chats from results", async () => {
  const visited = [];
  const client = {
    async getProfilePicUrl(chatId) {
      visited.push(chatId);
      return undefined;
    },
  };
  const results = await auditLocalWhatsAppGroupPictures({
    client,
    chatIds: ["1234567890@c.us", "120363429022300057@g.us", "9876543210@c.us"],
  });
  assert.equal(results.length, 1);
  assert.equal(results[0].chatId, "120363429022300057@g.us");
  assert.deepEqual(visited, ["120363429022300057@g.us"]);
});

test("picture audit returns empty array when all chatIds are non-groups", async () => {
  const client = {
    async getProfilePicUrl() {
      throw new Error("should not be called");
    },
  };
  const results = await auditLocalWhatsAppGroupPictures({
    client,
    chatIds: ["1234567890@c.us", "9876543210@c.us"],
  });
  assert.deepEqual(results, []);
});

test("picture audit returns empty array when chatIds is empty", async () => {
  const client = {
    async getProfilePicUrl() {
      throw new Error("should not be called");
    },
  };
  const results = await auditLocalWhatsAppGroupPictures({ client, chatIds: [] });
  assert.deepEqual(results, []);
});

test("picture audit isolates errors so one group failure does not affect others", async () => {
  const client = {
    async getProfilePicUrl(chatId) {
      if (chatId === "fail@g.us") throw new Error("network_error");
      if (chatId === "nopic@g.us") return undefined;
      return "https://pps.whatsapp.net/pic.jpg";
    },
  };
  const results = await auditLocalWhatsAppGroupPictures({
    client,
    chatIds: ["ok@g.us", "fail@g.us", "nopic@g.us"],
  });
  assert.equal(results.length, 3);
  assert.equal(results.find((r) => r.chatId === "ok@g.us")?.status, "present");
  assert.equal(results.find((r) => r.chatId === "fail@g.us")?.status, "unknown");
  assert.equal(results.find((r) => r.chatId === "nopic@g.us")?.status, "missing");
});

test("picture audit preserves chatId ordering in results with concurrency 1", async () => {
  const order = [];
  const client = {
    async getProfilePicUrl(chatId) {
      order.push(chatId);
      return "https://pps.whatsapp.net/pic.jpg";
    },
  };
  const chatIds = ["a@g.us", "b@g.us", "c@g.us"];
  const results = await auditLocalWhatsAppGroupPictures({ client, chatIds, concurrency: 1 });
  assert.deepEqual(results.map((r) => r.chatId), chatIds);
  assert.deepEqual(order, chatIds);
});

test("picture audit rejects when client is not provided", async () => {
  await assert.rejects(
    () => auditLocalWhatsAppGroupPictures({ chatIds: ["group@g.us"] }),
    (error) => {
      assert.equal(error.message, "whatsapp_picture_client_required");
      assert.equal(error.statusCode, 400);
      return true;
    },
  );
});

// ── Worker client ─────────────────────────────────────────────────────────────

test("whatsapp worker group picture audit sends POST to picture-audit route", async () => {
  let capturedBody = null;
  let capturedPath = null;
  const server = http.createServer((req, res) => {
    capturedPath = req.url;
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      capturedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, accountId: "sender", results: [{ chatId: "group@g.us", status: "present" }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    const result = await whatsappWorkerGroupPictureAudit("sender", ["group@g.us"], {
      ORKESTR_WA_WORKER_URL: `http://127.0.0.1:${port}`,
    });
    assert.equal(capturedPath, "/accounts/sender/chats/picture-audit");
    assert.deepEqual(capturedBody.chatIds, ["group@g.us"]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.results, [{ chatId: "group@g.us", status: "present" }]);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("whatsapp worker group picture audit url-encodes account id", async () => {
  let capturedPath = null;
  const server = http.createServer((req, res) => {
    capturedPath = req.url;
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, accountId: "my account", results: [] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    await whatsappWorkerGroupPictureAudit("my account", [], {
      ORKESTR_WA_WORKER_URL: `http://127.0.0.1:${port}`,
    });
    assert.equal(capturedPath, "/accounts/my%20account/chats/picture-audit");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("whatsapp worker group picture audit sends bearer auth token", async () => {
  let capturedAuth = null;
  const server = http.createServer((req, res) => {
    capturedAuth = req.headers.authorization;
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, accountId: "sender", results: [] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    await whatsappWorkerGroupPictureAudit("sender", [], {
      ORKESTR_WA_WORKER_URL: `http://127.0.0.1:${port}`,
      ORKESTR_WA_WORKER_TOKEN: "my-auth-token",
    });
    assert.equal(capturedAuth, "Bearer my-auth-token");
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("whatsapp worker group picture audit propagates ok false errors", async () => {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "whatsapp_local_bridge_not_ready" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  try {
    await assert.rejects(
      () => whatsappWorkerGroupPictureAudit("sender", [], {
        ORKESTR_WA_WORKER_URL: `http://127.0.0.1:${port}`,
      }),
      (error) => {
        assert.equal(error.message, "whatsapp_local_bridge_not_ready");
        assert.equal(error.statusCode, 503);
        return true;
      },
    );
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
