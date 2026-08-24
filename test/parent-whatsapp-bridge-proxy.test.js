import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { sendWhatsAppText } from "../packages/connectors/src/whatsapp.js";
import {
  assertParentWhatsAppBridgeSendAllowed,
  createParentWhatsAppBridgeProxy,
  parentWhatsAppBridgeProxyLaunchedAsMain,
  parentWhatsAppBridgePolicyFromEnv,
} from "../scripts/parent-whatsapp-bridge-proxy.mjs";

test("parent WhatsApp bridge proxy recognizes a symlinked executable path", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-parent-wa-proxy-"));
  const target = path.resolve("scripts/parent-whatsapp-bridge-proxy.mjs");
  const link = path.join(temp, "parent-whatsapp-bridge-proxy.mjs");
  try {
    await fs.symlink(target, link);
    assert.equal(parentWhatsAppBridgeProxyLaunchedAsMain(link), true);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("parent WhatsApp bridge proxy enforces account and recipient allowlists", () => {
  const policy = parentWhatsAppBridgePolicyFromEnv({
    ORKESTR_PARENT_WA_BRIDGE_DEFAULT_ACCOUNT: "responder",
    ORKESTR_PARENT_WA_BRIDGE_ALLOWED_ACCOUNTS: "responder",
    ORKESTR_PARENT_WA_BRIDGE_ALLOWED_PHONE_NUMBERS: "+4917600000000",
    ORKESTR_PARENT_WA_BRIDGE_ALLOWED_RECIPIENTS: "90000000000001@lid",
  });

  assert.equal(assertParentWhatsAppBridgeSendAllowed({
    accountId: "responder",
    to: "4917600000000@c.us",
  }, policy), true);
  assert.equal(assertParentWhatsAppBridgeSendAllowed({
    accountId: "responder",
    to: "90000000000001@lid",
  }, policy), true);

  assert.throws(
    () => assertParentWhatsAppBridgeSendAllowed({ accountId: "other", to: "4917600000000@c.us" }, policy),
    (error) => error.message === "parent_wa_bridge_account_denied" && error.statusCode === 403,
  );
  assert.throws(
    () => assertParentWhatsAppBridgeSendAllowed({ accountId: "responder", to: "4917700000000@c.us" }, policy),
    (error) => error.message === "parent_wa_bridge_recipient_denied" && error.statusCode === 403,
  );
});

test("parent WhatsApp bridge proxy remains permissive when no allowlist is configured", () => {
  const policy = parentWhatsAppBridgePolicyFromEnv({});
  assert.equal(assertParentWhatsAppBridgeSendAllowed({ accountId: "any", to: "4917700000000@c.us" }, policy), true);
});

test("parent WhatsApp bridge proxy forwards scoped upstream bearer tokens", async () => {
  const upstreamRequests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamRequests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, ids: ["sent-by-parent"] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;
  const proxy = createParentWhatsAppBridgeProxy({
    token: "proxy-token",
    allowUpstreamBearer: true,
    upstreamBase: `http://127.0.0.1:${upstreamPort}/api/connectors/whatsapp/bridge`,
    policy: parentWhatsAppBridgePolicyFromEnv({
      ORKESTR_PARENT_WA_BRIDGE_ALLOWED_ACCOUNTS: "sender",
      ORKESTR_PARENT_WA_BRIDGE_ALLOWED_CHAT_IDS: "tenant-chat@g.us",
    }),
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = proxy.address().port;
  try {
    const response = await fetch(`http://127.0.0.1:${proxyPort}/send-text`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wa_scoped_tenant_token",
      },
      body: JSON.stringify({ to: "tenant-chat@g.us", accountId: "sender", text: "hello" }),
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.ids[0], "sent-by-parent");
    assert.equal(upstreamRequests.length, 1);
    assert.equal(upstreamRequests[0].url, "/api/connectors/whatsapp/bridge/send-text");
    assert.equal(upstreamRequests[0].authorization, "Bearer wa_scoped_tenant_token");
    assert.equal(upstreamRequests[0].body.to, "tenant-chat@g.us");
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("parent WhatsApp bridge proxy preserves 404 bodies and correlates the configured send route", async () => {
  const upstreamRequests = [];
  const responseBody = "<html><body>Cannot POST /send-text</body></html>";
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamRequests.push({
      method: req.method,
      url: req.url,
      requestId: req.headers["x-request-id"],
      correlationId: req.headers["x-correlation-id"],
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null,
    });
    res.writeHead(404, {
      "content-type": "text/html; charset=utf-8",
      "x-request-id": "parent-controller-request-404",
    });
    res.end(responseBody);
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const logs = [];
  const proxy = createParentWhatsAppBridgeProxy({
    env: {
      ORKESTR_PARENT_WA_BRIDGE_UPSTREAM: `http://127.0.0.1:${upstream.address().port}/api/connectors/whatsapp/bridge`,
    },
    logger: { info(line) { logs.push(JSON.parse(line)); } },
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.address().port}/send-text`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": "tenant-request-404",
        "x-correlation-id": "router-trace-404",
      },
      body: JSON.stringify({ to: "example-chat", accountId: "example-account", text: "private message" }),
    });

    assert.equal(response.status, 404);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(response.headers.get("x-request-id"), "tenant-request-404");
    assert.equal(response.headers.get("x-correlation-id"), "router-trace-404");
    assert.equal(response.headers.get("x-orkestr-upstream-request-id"), "parent-controller-request-404");
    assert.equal(await response.text(), responseBody);
    assert.equal(upstreamRequests.length, 1);
    assert.equal(upstreamRequests[0].method, "POST");
    assert.equal(upstreamRequests[0].url, "/api/connectors/whatsapp/bridge/send-text");
    assert.equal(upstreamRequests[0].requestId, "tenant-request-404");
    assert.equal(upstreamRequests[0].correlationId, "router-trace-404");
    assert.equal(upstreamRequests[0].body.text, "private message");
    assert.deepEqual(logs, [{
      event: "parent_whatsapp_bridge_proxy_request",
      requestId: "tenant-request-404",
      correlationId: "router-trace-404",
      upstreamRequestId: "parent-controller-request-404",
      method: "POST",
      route: "/send-text",
      upstreamPath: "/api/connectors/whatsapp/bridge/send-text",
      status: 404,
      contentType: "text/html; charset=utf-8",
      failureCode: "whatsapp_bridge_route_not_found",
      classification: "route_configuration",
      retryable: false,
      durationMs: logs[0].durationMs,
    }]);
    assert.ok(Number.isInteger(logs[0].durationMs));
    assert.doesNotMatch(JSON.stringify(logs), /private message|example-chat/);
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("tenant to proxy to parent controller contract reaches one mocked worker send route", async () => {
  const workerRequests = [];
  const worker = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    workerRequests.push({
      method: req.method,
      url: req.url,
      requestId: req.headers["x-request-id"],
      correlationId: req.headers["x-correlation-id"],
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, ids: ["mock-worker-ack"] }));
  });
  await new Promise((resolve) => worker.listen(0, "127.0.0.1", resolve));
  const parentRequests = [];
  const parent = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    parentRequests.push({ method: req.method, url: req.url });
    if (req.method !== "POST" || req.url !== "/api/connectors/whatsapp/bridge/send-text") {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: false, error: "controller_route_missing" }));
    }
    const workerResponse = await fetch(`http://127.0.0.1:${worker.address().port}/send-text`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": String(req.headers["x-request-id"] || ""),
        "x-correlation-id": String(req.headers["x-correlation-id"] || ""),
      },
      body,
    });
    res.writeHead(workerResponse.status, {
      "content-type": workerResponse.headers.get("content-type") || "application/json",
      "x-request-id": "parent-controller-contract",
    });
    res.end(await workerResponse.text());
  });
  await new Promise((resolve) => parent.listen(0, "127.0.0.1", resolve));
  const proxy = createParentWhatsAppBridgeProxy({
    env: {
      ORKESTR_PARENT_WA_BRIDGE_UPSTREAM: `http://127.0.0.1:${parent.address().port}/api/connectors/whatsapp/bridge`,
    },
    logger: null,
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  try {
    const result = await sendWhatsAppText({
      chatId: "contract-chat",
      text: "contract-only payload",
      requestId: "tenant-contract-request",
      correlationId: "router-contract-trace",
      config: { bridgeMode: "external", bridgeUrl: `http://127.0.0.1:${proxy.address().port}` },
      env: { ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1" },
    });

    assert.deepEqual(result, { ok: true, ids: ["mock-worker-ack"] });
    assert.deepEqual(parentRequests, [{ method: "POST", url: "/api/connectors/whatsapp/bridge/send-text" }]);
    assert.equal(workerRequests.length, 1);
    assert.equal(workerRequests[0].method, "POST");
    assert.equal(workerRequests[0].url, "/send-text");
    assert.equal(workerRequests[0].requestId, "tenant-contract-request");
    assert.equal(workerRequests[0].correlationId, "router-contract-trace");
    assert.equal(workerRequests[0].body.to, "contract-chat");
    assert.equal(workerRequests[0].body.text, "contract-only payload");
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
    await new Promise((resolve) => parent.close(resolve));
    await new Promise((resolve) => worker.close(resolve));
  }
});

test("parent WhatsApp bridge proxy lets upstream scoped bearer enforce recipient scope", async () => {
  const upstreamRequests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamRequests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null,
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, ids: ["sent-by-scoped-token"] }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstream.address().port;
  const proxy = createParentWhatsAppBridgeProxy({
    token: "proxy-token",
    allowUpstreamBearer: true,
    upstreamBase: `http://127.0.0.1:${upstreamPort}/api/connectors/whatsapp/bridge`,
    policy: parentWhatsAppBridgePolicyFromEnv({
      ORKESTR_PARENT_WA_BRIDGE_ALLOWED_ACCOUNTS: "sender",
      ORKESTR_PARENT_WA_BRIDGE_ALLOWED_CHAT_IDS: "old-tenant-chat@g.us",
    }),
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = proxy.address().port;
  try {
    const masterTokenResponse = await fetch(`http://127.0.0.1:${proxyPort}/send-text`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer proxy-token",
      },
      body: JSON.stringify({ to: "new-tenant-chat@g.us", accountId: "sender", text: "hello" }),
    });
    const masterTokenPayload = await masterTokenResponse.json();
    assert.equal(masterTokenResponse.status, 403);
    assert.equal(masterTokenPayload.error, "parent_wa_bridge_recipient_denied");
    assert.equal(upstreamRequests.length, 0);

    const scopedTokenResponse = await fetch(`http://127.0.0.1:${proxyPort}/send-text`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wa_scoped_tenant_token",
      },
      body: JSON.stringify({ to: "new-tenant-chat@g.us", accountId: "sender", text: "hello" }),
    });
    const scopedTokenPayload = await scopedTokenResponse.json();

    assert.equal(scopedTokenResponse.status, 200);
    assert.equal(scopedTokenPayload.ids[0], "sent-by-scoped-token");
    assert.equal(upstreamRequests.length, 1);
    assert.equal(upstreamRequests[0].authorization, "Bearer wa_scoped_tenant_token");
    assert.equal(upstreamRequests[0].body.to, "new-tenant-chat@g.us");
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test("parent WhatsApp bridge proxy exposes the connector MCP endpoint with the tenant bearer", async () => {
  const upstreamRequests = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamRequests.push({
      url: req.url,
      authorization: req.headers.authorization,
      protocolVersion: req.headers["mcp-protocol-version"],
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }));
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const proxy = createParentWhatsAppBridgeProxy({
    token: "proxy-token",
    allowUpstreamBearer: true,
    mcpUpstream: `http://127.0.0.1:${upstream.address().port}/mcp`,
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.address().port}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "mcp-protocol-version": "2025-11-25",
        authorization: "Bearer wa_scoped_tenant_token",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    assert.equal(response.status, 200);
    assert.equal(upstreamRequests[0].url, "/mcp");
    assert.equal(upstreamRequests[0].authorization, "Bearer wa_scoped_tenant_token");
    assert.equal(upstreamRequests[0].protocolVersion, "2025-11-25");
  } finally {
    await new Promise((resolve) => proxy.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
});
