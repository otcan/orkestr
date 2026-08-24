import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import {
  readWhatsAppBridgeResponse,
  sanitizeWhatsAppBridgeResponseExcerpt,
} from "../packages/connectors/src/whatsapp-bridge-diagnostics.js";
import { sendWhatsAppText } from "../packages/connectors/src/whatsapp.js";

const externalEnv = {
  ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1",
  ORKESTR_WHATSAPP_BRIDGE_DIAGNOSTIC_EXCERPT_MAX: "96",
};

async function captureSendFailure(body, { contentType, headers = {}, status = 404 } = {}) {
  try {
    await sendWhatsAppText({
      chatId: "diagnostic-chat",
      text: "outbound text must never enter diagnostics",
      config: { bridgeMode: "external", bridgeUrl: "http://bridge.example.test" },
      env: externalEnv,
      requestId: "tenant-request-1",
      correlationId: "router-trace-1",
      fetchImpl: async (url, options = {}) => {
        assert.equal(url.pathname, "/send-text");
        assert.equal(options.headers["x-request-id"], "tenant-request-1");
        assert.equal(options.headers["x-correlation-id"], "router-trace-1");
        return new Response(body, {
          status,
          statusText: status === 404 ? "Not Found" : "Denied",
          headers: { "content-type": contentType, ...headers },
        });
      },
    });
  } catch (error) {
    return error;
  }
  assert.fail("expected WhatsApp bridge send to fail");
}

test("raw-text and HTML WhatsApp 404s preserve bounded redacted diagnostics", async () => {
  const cases = [
    {
      contentType: "text/plain; charset=utf-8",
      body: "Cannot POST /send-text outbound text must never enter diagnostics token=super-secret 4917000000000@c.us " + "x".repeat(300),
      expected: /Cannot POST \/send-text/,
    },
    {
      contentType: "text/html; charset=utf-8",
      body: "<html><body><pre>Cannot POST /api/connectors/whatsapp/bridge/send-text</pre><script>secret()</script></body></html>",
      expected: /Cannot POST \/api\/connectors\/whatsapp\/bridge\/send-text/,
    },
  ];

  for (const item of cases) {
    const error = await captureSendFailure(item.body, {
      contentType: item.contentType,
      headers: {
        "x-request-id": "proxy-request-404",
        "x-correlation-id": "router-trace-1",
        "x-orkestr-upstream-request-id": "parent-request-404",
      },
    });
    assert.equal(error.statusCode, 404);
    assert.equal(error.retryable, false);
    assert.equal(error.failureCode, "whatsapp_bridge_route_not_found");
    assert.equal(error.failureClassification, "route_configuration");
    assert.equal(error.bridgeDiagnostics.status, 404);
    assert.equal(error.bridgeDiagnostics.statusText, "Not Found");
    assert.equal(error.bridgeDiagnostics.contentType, item.contentType);
    assert.equal(error.bridgeDiagnostics.upstreamPath, "/send-text");
    assert.equal(error.bridgeDiagnostics.requestId, "proxy-request-404");
    assert.equal(error.bridgeDiagnostics.correlationId, "router-trace-1");
    assert.equal(error.bridgeDiagnostics.upstreamRequestId, "parent-request-404");
    assert.equal(error.bridgeDiagnostics.bodyFingerprint, crypto.createHash("sha256").update(item.body).digest("hex"));
    assert.ok(error.bridgeDiagnostics.responseExcerpt.length <= 96);
    assert.match(error.bridgeDiagnostics.responseExcerpt, item.expected);
    assert.doesNotMatch(error.bridgeDiagnostics.responseExcerpt, /outbound text must never enter diagnostics|super-secret|4917000000000|secret\(\)/);
    assert.doesNotMatch(error.message, /^whatsapp_send_failed_404$/);
  }
});

test("JSON WhatsApp 404s preserve safe structured error details", async () => {
  const body = JSON.stringify({
    ok: false,
    error: { code: "missing_send_route", message: "Cannot POST /send-text" },
    requestId: "parent-json-404",
    token: "must-not-survive",
    text: "private outbound reply",
  });
  const error = await captureSendFailure(body, { contentType: "application/json" });

  assert.deepEqual(error.payload.error, { code: "missing_send_route", message: "Cannot POST /send-text" });
  assert.equal(error.payload.requestId, "parent-json-404");
  assert.equal(error.payload.token, "[redacted]");
  assert.equal(error.payload.text, "[redacted]");
  assert.match(error.message, /missing_send_route: Cannot POST \/send-text/);
  assert.equal(error.bridgeDiagnostics.classification, "route_configuration");
  assert.equal(error.bridgeDiagnostics.retryable, false);
  assert.doesNotMatch(JSON.stringify(error.bridgeDiagnostics), /must-not-survive|private outbound reply/);
});

test("WhatsApp bridge auth failures remain distinct from route 404s", async () => {
  const unauthorized = await captureSendFailure(JSON.stringify({ error: "bridge_token_invalid" }), {
    contentType: "application/json",
    status: 401,
  });
  const forbidden = await captureSendFailure(JSON.stringify({ error: "bridge_acl_denied" }), {
    contentType: "application/json",
    status: 403,
  });

  assert.equal(unauthorized.failureClassification, "authentication");
  assert.equal(unauthorized.failureCode, "bridge_token_invalid");
  assert.equal(unauthorized.retryable, false);
  assert.equal(forbidden.failureClassification, "authorization");
  assert.equal(forbidden.failureCode, "bridge_acl_denied");
  assert.equal(forbidden.retryable, false);
});

test("WhatsApp bridge throttling and server failures remain retryable", async () => {
  for (const status of [429, 503]) {
    const error = await captureSendFailure(JSON.stringify({ error: "temporarily_unavailable" }), {
      contentType: "application/json",
      status,
    });
    assert.equal(error.statusCode, status);
    assert.equal(error.retryable, true);
    assert.match(error.failureClassification, /transient/);
  }
});

test("diagnostic excerpts enforce a hard size bound even when configured larger", async () => {
  const raw = `Bearer top-secret ${"z".repeat(2000)}`;
  const parsed = await readWhatsAppBridgeResponse(new Response(raw, {
    status: 404,
    headers: { "content-type": "text/plain" },
  }), { excerptLimit: 100000, upstreamPath: "/send-text" });

  assert.ok(parsed.diagnostics.responseExcerpt.length <= 512);
  assert.doesNotMatch(parsed.diagnostics.responseExcerpt, /top-secret/);
  assert.ok(sanitizeWhatsAppBridgeResponseExcerpt(raw, null, 1).length <= 64);
});
