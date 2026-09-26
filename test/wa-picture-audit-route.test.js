import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createOrkestrWaService } from "../scripts/orkestr-wa-service.mjs";

async function withService(env, bridge, fn) {
  const server = createOrkestrWaService({ env, bridge });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

async function testEnv(prefix, overrides = {}) {
  return {
    ORKESTR_HOME: await fs.mkdtemp(path.join(os.tmpdir(), prefix)),
    ...overrides,
  };
}

test("picture audit service route requires configured bearer auth", async () => {
  const env = await testEnv("wa-picture-audit-auth-", { ORKESTR_WA_WORKER_TOKEN: "worker-secret" });
  let called = false;
  await withService(env, {
    getLocalWhatsAppGroupPictureAudit: async () => {
      called = true;
      return { ok: true, results: [] };
    },
  }, async (baseUrl) => {
    const unauthorized = await fetch(`${baseUrl}/accounts/sender/chats/picture-audit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatIds: [] }),
    });
    assert.equal(unauthorized.status, 401);
    assert.equal(called, false);

    const authorized = await fetch(`${baseUrl}/accounts/sender/chats/picture-audit`, {
      method: "POST",
      headers: { authorization: "Bearer worker-secret", "content-type": "application/json" },
      body: JSON.stringify({ chatIds: [] }),
    });
    assert.equal(authorized.status, 200);
    assert.equal(called, true);
  });
});

test("picture audit service route enforces account history policy", async () => {
  const env = await testEnv("wa-picture-audit-policy-", {
    ORKESTR_WA_SERVICE_AUTH_DISABLED: "1",
    ORKESTR_WA_SERVICE_POLICY_JSON: JSON.stringify({
      clients: {
        "audit-client": {
          accounts: ["sender"],
          historyRecipients: ["allowed@g.us"],
        },
      },
    }),
  });
  await withService(env, {
    getLocalWhatsAppGroupPictureAudit: async () => ({ ok: true, results: [] }),
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/accounts/responder/chats/picture-audit`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-orkestr-instance-id": "audit-client" },
      body: JSON.stringify({ chatIds: [] }),
    });
    assert.equal(response.status, 403);
    const payload = await response.json();
    assert.equal(payload.error, "wa_service_policy_denied:account_not_allowed");

    const disallowedChat = await fetch(`${baseUrl}/accounts/sender/chats/picture-audit`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-orkestr-instance-id": "audit-client" },
      body: JSON.stringify({ chatIds: ["blocked@g.us"] }),
    });
    assert.equal(disallowedChat.status, 403);
    const disallowedPayload = await disallowedChat.json();
    assert.equal(disallowedPayload.error, "wa_service_policy_denied:recipient_not_allowed");

    const bulkAudit = await fetch(`${baseUrl}/accounts/sender/chats/picture-audit`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-orkestr-instance-id": "audit-client" },
      body: JSON.stringify({ chatIds: [] }),
    });
    assert.equal(bulkAudit.status, 403);
    const bulkPayload = await bulkAudit.json();
    assert.equal(bulkPayload.error, "wa_service_policy_denied:recipient_not_allowed");
  });
});

test("picture audit service route preserves partial per-group results", async () => {
  const env = await testEnv("wa-picture-audit-partial-", { ORKESTR_WA_SERVICE_AUTH_DISABLED: "1" });
  const received = [];
  await withService(env, {
    getLocalWhatsAppGroupPictureAudit: async (payload) => {
      received.push(payload);
      return {
        ok: true,
        accountId: payload.accountId,
        results: [
          { chatId: "present@g.us", status: "present" },
          { chatId: "missing@g.us", status: "missing" },
          { chatId: "unknown@g.us", status: "unknown" },
        ],
      };
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/accounts/sender/chats/picture-audit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatIds: ["present@g.us", "missing@g.us", "unknown@g.us"] }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.results.map((entry) => entry.status), ["present", "missing", "unknown"]);
    assert.equal(received.length, 1);
    assert.equal(received[0].accountId, "sender");
    assert.deepEqual(received[0].chatIds, ["present@g.us", "missing@g.us", "unknown@g.us"]);
  });
});

test("picture audit service route sanitizes bridge errors", async () => {
  const env = await testEnv("wa-picture-audit-error-", { ORKESTR_WA_SERVICE_AUTH_DISABLED: "1" });
  await withService(env, {
    getLocalWhatsAppGroupPictureAudit: async () => {
      throw Object.assign(new Error("whatsapp_group_picture_audit_failed"), { statusCode: 503 });
    },
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/accounts/sender/chats/picture-audit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatIds: [] }),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { ok: false, error: "whatsapp_group_picture_audit_failed" });
  });
});
