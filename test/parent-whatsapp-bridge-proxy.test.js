import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import {
  assertParentWhatsAppBridgeSendAllowed,
  createParentWhatsAppBridgeProxy,
  parentWhatsAppBridgePolicyFromEnv,
} from "../scripts/parent-whatsapp-bridge-proxy.mjs";

test("parent WhatsApp bridge proxy enforces account and recipient allowlists", () => {
  const policy = parentWhatsAppBridgePolicyFromEnv({
    ORKESTR_PARENT_WA_BRIDGE_DEFAULT_ACCOUNT: "responder",
    ORKESTR_PARENT_WA_BRIDGE_ALLOWED_ACCOUNTS: "responder",
    ORKESTR_PARENT_WA_BRIDGE_ALLOWED_PHONE_NUMBERS: "+4917600000000",
    ORKESTR_PARENT_WA_BRIDGE_ALLOWED_RECIPIENTS: "66378837028965@lid",
  });

  assert.equal(assertParentWhatsAppBridgeSendAllowed({
    accountId: "responder",
    to: "4917600000000@c.us",
  }, policy), true);
  assert.equal(assertParentWhatsAppBridgeSendAllowed({
    accountId: "responder",
    to: "66378837028965@lid",
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
