import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createOrkestrWaService } from "../scripts/orkestr-wa-service.mjs";
import {
  checkWaServiceReadiness,
  evaluateWaServiceReadiness,
} from "../scripts/orkestr-wa-readiness.mjs";

async function withWaService(env, fn) {
  const server = createOrkestrWaService({ env });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const bridgeUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await fn({ bridgeUrl });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function testHome(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test("standalone WA service exposes sanitized health for configured accounts", async () => {
  const home = await testHome("orkestr-wa-service-health-");
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WA_SERVICE_AUTH_DISABLED: "1",
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender,responder",
    ORKESTR_WHATSAPP_ACCOUNT_CLIENT_IDS: "sender:private-client,responder:private-responder",
    ORKESTR_WHATSAPP_ACCOUNT_SESSION_ROOTS: `sender:${home}/sender,responder:${home}/responder`,
  };

  await withWaService(env, async ({ bridgeUrl }) => {
    const response = await fetch(`${bridgeUrl}/health`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.accounts.map((account) => account.accountId), ["sender", "responder"]);
    assert.doesNotMatch(JSON.stringify(payload), /private-client|private-responder|sessionRoot|clientId/);
  });
});

test("standalone WA service requires bearer auth when a token is configured", async () => {
  const home = await testHome("orkestr-wa-service-auth-");
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WA_SERVICE_TOKEN: "secret-token",
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender",
  };

  await withWaService(env, async ({ bridgeUrl }) => {
    const unauthorized = await fetch(`${bridgeUrl}/health`);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`${bridgeUrl}/health`, {
      headers: { authorization: "Bearer secret-token" },
    });
    assert.equal(authorized.status, 200);
  });
});

test("WA readiness checker reports missing and unready required accounts", () => {
  const result = evaluateWaServiceReadiness({
    ok: true,
    accounts: [
      { accountId: "sender", runtimeAccountId: "905555154214", ready: true, state: "ready" },
      { accountId: "responder", ready: false, state: "qr_required", qrAvailable: true },
    ],
  }, ["905555154214", "responder", "audit"]);

  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["audit"]);
  assert.deepEqual(result.notReady, [{
    account: "responder",
    state: "qr_required",
    qrAvailable: true,
    error: "",
  }]);
});

test("WA readiness checker can probe the standalone service", async () => {
  const home = await testHome("orkestr-wa-service-readiness-");
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WA_SERVICE_AUTH_DISABLED: "1",
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender",
  };

  await withWaService(env, async ({ bridgeUrl }) => {
    const result = await checkWaServiceReadiness({
      bridgeUrl,
      accounts: ["sender"],
      timeoutMs: 1000,
    });
    assert.equal(result.ok, false);
    assert.equal(result.missing.length, 0);
    assert.equal(result.notReady[0].account, "sender");
  });
});
