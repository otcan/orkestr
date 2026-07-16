import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createOrkestrWaService, waServiceRoutingPolicy } from "../scripts/orkestr-wa-service.mjs";
import {
  checkWaServiceReadiness,
  evaluateWaServiceReadiness,
} from "../scripts/orkestr-wa-readiness.mjs";

async function withWaService(env, fn, bridge) {
  const server = createOrkestrWaService({ env, bridge });
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

function mockBridge(overrides = {}) {
  return {
    createLocalWhatsAppChat: async (payload) => ({ ok: true, chatId: "demo-group@g.us", ...payload }),
    getLocalWhatsAppBridgeStatus: async () => ({ ok: true, ready: true, state: "ready", accounts: [] }),
    getLocalWhatsAppQrSvg: async () => "<svg></svg>",
    listLocalWhatsAppChatMessages: async () => ({ ok: true, messages: [] }),
    listLocalWhatsAppChats: async () => ({ ok: true, chats: [] }),
    listLocalWhatsAppChatParticipants: async () => ({ ok: true, participants: [] }),
    logoutLocalWhatsAppAccount: async (accountId) => ({ accountId, ready: false }),
    recoverLocalWhatsAppChatMessages: async () => ({ ok: true, messages: [] }),
    sendLocalWhatsAppMessage: async (payload) => ({ ok: true, id: "sent-1", ...payload }),
    startLocalWhatsAppAccount: async (accountId) => ({ accountId, ready: true }),
    startLocalWhatsAppTyping: async ({ accountId, chatId }) => ({ ok: true, active: true, accountId, chatId }),
    stopLocalWhatsAppTyping: async ({ accountId, chatId }) => ({ ok: true, active: false, accountId, chatId }),
    ...overrides,
  };
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
    assert.deepEqual(payload.routingPolicy, {
      name: "sender-queues-responder-tools",
      inboundQueueAccountId: "sender",
      outboundAccountId: "responder",
      toolAccountId: "responder",
      injectedInboundAccountId: "responder",
      injectedRouteAccountId: "sender",
      responderQueuesInbound: false,
    });
    assert.doesNotMatch(JSON.stringify(payload), /private-client|private-responder|sessionRoot|clientId/);
  });
});

test("standalone WA service derives operational readiness from a ready live account", async () => {
  const home = await testHome("orkestr-wa-service-operational-readiness-");
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WA_SERVICE_AUTH_DISABLED: "1",
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender",
  };

  await withWaService(env, async ({ bridgeUrl }) => {
    const response = await fetch(`${bridgeUrl}/health`);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.accounts[0].ready, true);
    assert.equal(payload.accounts[0].runtimeUsable, true);
    assert.equal(payload.accounts[0].chatOpsReady, true);
    assert.equal(payload.accounts[0].sendReady, true);
    assert.equal(payload.accounts[0].inboundReady, true);
  }, mockBridge({
    getLocalWhatsAppBridgeStatus: async () => ({
      ok: true,
      ready: true,
      state: "ready",
      accounts: [{ accountId: "sender", ready: true, runtimeUsable: true, chatOpsReady: true }],
    }),
  }));
});

test("standalone WA service routing policy honors configured sender and responder roles", () => {
  assert.deepEqual(waServiceRoutingPolicy({
    ORKESTR_WHATSAPP_SENDER_ROLE: "inbound-phone",
    ORKESTR_WHATSAPP_RESPONDER_ROLE: "tool-phone",
  }), {
    name: "sender-queues-responder-tools",
    inboundQueueAccountId: "inbound-phone",
    outboundAccountId: "tool-phone",
    toolAccountId: "tool-phone",
    injectedInboundAccountId: "tool-phone",
    injectedRouteAccountId: "inbound-phone",
    responderQueuesInbound: false,
  });
});

test("standalone WA service denies account use outside the client routing policy", async () => {
  const home = await testHome("orkestr-wa-service-policy-account-");
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WA_SERVICE_AUTH_DISABLED: "1",
    ORKESTR_WA_SERVICE_POLICY_JSON: JSON.stringify({
      clients: {
        "demo-instance": {
          accounts: ["sender"],
          sendRecipients: ["15550001111@c.us"],
        },
      },
    }),
  };

  await withWaService(env, async ({ bridgeUrl }) => {
    const response = await fetch(`${bridgeUrl}/send-text`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-orkestr-instance-id": "demo-instance",
      },
      body: JSON.stringify({
        accountId: "responder",
        to: "15550001111@c.us",
        text: "hello",
      }),
    });
    assert.equal(response.status, 403);
    const payload = await response.json();
    assert.equal(payload.error, "wa_service_policy_denied:account_not_allowed");
    assert.equal(payload.auditEvent.clientId, "demo-instance");
    assert.equal(payload.auditEvent.accountId, "responder");
  }, mockBridge());
});

test("standalone WA service denies recipient use outside the client routing policy", async () => {
  const home = await testHome("orkestr-wa-service-policy-recipient-");
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WA_SERVICE_AUTH_DISABLED: "1",
    ORKESTR_WA_SERVICE_POLICY_JSON: JSON.stringify({
      clients: {
        "demo-instance": {
          accounts: ["sender"],
          sendRecipients: ["15550001111@c.us"],
        },
      },
    }),
  };

  await withWaService(env, async ({ bridgeUrl }) => {
    const response = await fetch(`${bridgeUrl}/send-text`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-orkestr-instance-id": "demo-instance",
      },
      body: JSON.stringify({
        accountId: "sender",
        to: "15550002222@c.us",
        text: "hello",
      }),
    });
    assert.equal(response.status, 403);
    const payload = await response.json();
    assert.equal(payload.error, "wa_service_policy_denied:recipient_not_allowed");
    assert.equal(payload.auditEvent.recipient, "15550002222@c.us");
    assert.equal(payload.auditEvent.scope, "send");
  }, mockBridge());
});

test("standalone WA service allows demo onboarding send within routing policy", async () => {
  const home = await testHome("orkestr-wa-service-policy-allowed-");
  const sent = [];
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WA_SERVICE_AUTH_DISABLED: "1",
    ORKESTR_WA_SERVICE_POLICY_JSON: JSON.stringify({
      clients: {
        "demo-instance": {
          accounts: ["sender"],
          sendRecipients: ["15550001111@c.us"],
        },
      },
    }),
  };

  await withWaService(env, async ({ bridgeUrl }) => {
    const response = await fetch(`${bridgeUrl}/send-text`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-orkestr-instance-id": "demo-instance",
      },
      body: JSON.stringify({
        accountId: "sender",
        to: "15550001111@c.us",
        text: "Open your demo setup link.",
      }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.ok, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].accountId, "sender");
    assert.equal(sent[0].chatId, "15550001111@c.us");
    assert.equal(sent[0].text, "Open your demo setup link.");
  }, mockBridge({
    sendLocalWhatsAppMessage: async (payload) => {
      sent.push(payload);
      return { ok: true, id: "sent-demo-onboarding" };
    },
  }));
});

test("standalone WA service applies transient typing without sending a message", async () => {
  const home = await testHome("orkestr-wa-service-typing-");
  const calls = [];
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WA_SERVICE_AUTH_DISABLED: "1",
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender",
  };

  await withWaService(env, async ({ bridgeUrl }) => {
    const composing = await fetch(`${bridgeUrl}/typing`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: "sender", to: "jobs@g.us", state: "composing" }),
    });
    const paused = await fetch(`${bridgeUrl}/typing`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: "sender", to: "jobs@g.us", state: "paused" }),
    });

    assert.equal(composing.status, 200);
    assert.equal((await composing.json()).active, true);
    assert.equal(paused.status, 200);
    assert.equal((await paused.json()).active, false);
    assert.deepEqual(calls, [["start", "sender", "jobs@g.us"], ["stop", "sender", "jobs@g.us"]]);
  }, mockBridge({
    startLocalWhatsAppTyping: async ({ accountId, chatId }) => {
      calls.push(["start", accountId, chatId]);
      return { ok: true, active: true, accountId, chatId };
    },
    stopLocalWhatsAppTyping: async ({ accountId, chatId }) => {
      calls.push(["stop", accountId, chatId]);
      return { ok: true, active: false, accountId, chatId };
    },
  }));
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

test("private WA worker token takes precedence over the legacy service token", async () => {
  const home = await testHome("orkestr-wa-worker-auth-");
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WA_WORKER_TOKEN: "worker-secret",
    ORKESTR_WA_SERVICE_TOKEN: "gateway-secret",
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "sender",
  };

  await withWaService(env, async ({ bridgeUrl }) => {
    const legacy = await fetch(`${bridgeUrl}/health`, {
      headers: { authorization: "Bearer gateway-secret" },
    });
    assert.equal(legacy.status, 401);

    const worker = await fetch(`${bridgeUrl}/health`, {
      headers: { authorization: "Bearer worker-secret" },
    });
    assert.equal(worker.status, 200);
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
  assert.equal(result.routingPolicy.required, false);
});

test("WA readiness checker enforces sender/responder routing policy when required", () => {
  const result = evaluateWaServiceReadiness({
    ok: true,
    ready: true,
    accounts: [
      { accountId: "sender", ready: true, state: "ready" },
      { accountId: "responder", ready: true, state: "ready" },
    ],
    routingPolicy: {
      name: "sender-queues-responder-tools",
      inboundQueueAccountId: "sender",
      outboundAccountId: "responder",
      toolAccountId: "responder",
      injectedInboundAccountId: "responder",
      injectedRouteAccountId: "sender",
      responderQueuesInbound: false,
    },
  }, ["sender", "responder"], { requireRoutingPolicy: true, inboundAccount: "sender", outboundAccount: "responder" });

  assert.equal(result.ok, true);
  assert.equal(result.routingPolicy.required, true);
  assert.equal(result.routingPolicy.ok, true);
});

test("WA readiness checker accepts routing policy account ids that match requested aliases", () => {
  const result = evaluateWaServiceReadiness({
    ok: true,
    ready: true,
    accounts: [
      { accountId: "491760000001", runtimeAccountId: "sender", ready: true, state: "ready" },
      { accountId: "491760000002", runtimeAccountId: "responder", ready: true, state: "ready" },
    ],
    routingPolicy: {
      name: "sender-queues-responder-tools",
      inboundQueueAccountId: "491760000001",
      outboundAccountId: "491760000002",
      toolAccountId: "491760000002",
      injectedInboundAccountId: "491760000002",
      injectedRouteAccountId: "491760000001",
      responderQueuesInbound: false,
    },
  }, ["sender", "responder"], { requireRoutingPolicy: true, inboundAccount: "sender", outboundAccount: "responder" });

  assert.equal(result.ok, true);
  assert.deepEqual(result.routingPolicy.errors, []);
});

test("WA readiness checker rejects responder inbound queueing policy", () => {
  const result = evaluateWaServiceReadiness({
    ok: true,
    ready: true,
    accounts: [
      { accountId: "sender", ready: true, state: "ready" },
      { accountId: "responder", ready: true, state: "ready" },
    ],
    routingPolicy: {
      name: "legacy",
      inboundQueueAccountId: "responder",
      outboundAccountId: "responder",
      toolAccountId: "responder",
      responderQueuesInbound: true,
    },
  }, ["sender", "responder"], { requireRoutingPolicy: true, inboundAccount: "sender", outboundAccount: "responder" });

  assert.equal(result.ok, false);
  assert.equal(result.routingPolicy.ok, false);
  assert.deepEqual(result.routingPolicy.errors, [
    "inbound_queue_account_mismatch:responder",
    "injected_inbound_account_mismatch:missing",
    "injected_route_account_mismatch:missing",
    "responder_must_not_queue_inbound",
  ]);
});

test("WA readiness checker enforces access policy when required", () => {
  const missing = evaluateWaServiceReadiness({
    ok: true,
    ready: true,
    accounts: [{ accountId: "sender", ready: true, state: "ready" }],
    accessPolicy: { enforced: false, clients: {} },
  }, ["sender"], { requireAccessPolicy: true, accessPolicyClient: "demo-instance" });

  assert.equal(missing.ok, false);
  assert.equal(missing.accessPolicy.required, true);
  assert.deepEqual(missing.accessPolicy.errors, [
    "access_policy_not_enforced",
    "access_policy_client_missing:demo-instance",
  ]);

  const allowed = evaluateWaServiceReadiness({
    ok: true,
    ready: true,
    accounts: [{ accountId: "sender", ready: true, state: "ready" }],
    accessPolicy: {
      enforced: true,
      clients: {
        "demo-instance": { accounts: ["sender"], sendRecipients: ["15550001111@c.us"] },
      },
    },
  }, ["sender"], { requireAccessPolicy: true, accessPolicyClient: "demo-instance" });

  assert.equal(allowed.ok, true);
  assert.equal(allowed.accessPolicy.enforced, true);
  assert.equal(allowed.accessPolicy.clientCount, 1);
  assert.deepEqual(allowed.accessPolicy.errors, []);
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
