import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { callConnectorsMcpTool, connectorsMcpClientConfig, listConnectorsMcpTools } from "../packages/connectors/src/connectors-mcp-client.js";
import { listConnectorInboxEvents, resetConnectorInboxForTest } from "../packages/connectors/src/connector-inbox.js";
import { listConnectorOutboxJobs } from "../packages/connectors/src/connector-outbox.js";
import { deliverConnectorInboxEvent, routeWhatsAppInboundFromWorker } from "../packages/connectors/src/connectors-mcp-router.js";
import { approvePairingChallenge } from "../packages/core/src/security.js";
import { createThread } from "../packages/core/src/threads.js";
import { isMainModule } from "../scripts/main-module.mjs";
import { createConnectorsMcpGateway } from "../scripts/orkestr-connectors-mcp.mjs";
import { assessConnectorHealth, runConnectorDoctor } from "../scripts/orkestr-connectors-doctor.mjs";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve));
}

function fakeWorker() {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    calls.push({ method: req.method, url: req.url, body });
    res.setHeader("content-type", "application/json");
    if (req.url === "/health") {
      res.end(JSON.stringify({ ok: true, state: "ready", accounts: [{ accountId: "sender", ready: true }] }));
      return;
    }
    if (req.url === "/send-text") {
      res.end(JSON.stringify({ ok: true, messageId: "wa-message-1", chatId: body.to }));
      return;
    }
    if (req.url === "/typing") {
      res.end(JSON.stringify({ ok: true, active: body.state === "composing", chatId: body.to }));
      return;
    }
    if (req.url === "/accounts/sender/logout") {
      res.end(JSON.stringify({ ok: true, account: { accountId: "sender", state: "idle" } }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: "worker_route_missing" }));
  });
  return { server, calls };
}

async function fixture({ scoped = false } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-connectors-mcp-"));
  const worker = fakeWorker();
  const workerUrl = await listen(worker.server);
  const token = scoped ? "scoped-token" : "operator-token";
  const env = {
    ...process.env,
    ORKESTR_HOME: home,
    ORKESTR_CONNECTORS_MCP_HOST: "127.0.0.1",
    ORKESTR_CONNECTORS_MCP_PORT: "0",
    ORKESTR_CONNECTORS_MCP_ALLOWED_HOSTS: "127.0.0.1,localhost",
    ORKESTR_WA_WORKER_URL: workerUrl,
    ORKESTR_WA_WORKER_SOCKET: "",
    ORKESTR_WA_WORKER_TOKEN: "worker-token",
    ORKESTR_CONNECTORS_MCP_TOKEN: scoped ? "" : token,
    ORKESTR_CONNECTORS_MCP_TOKENS_JSON: scoped ? JSON.stringify({
      tenant: {
        token,
        scopes: ["connectors:read", "connectors:send"],
        principalKind: "tenant_vm",
        ownerUserId: "firat",
        instanceId: "vm-firat",
        accountId: "sender",
        allowedChatIds: ["firat-jobs@g.us"],
      },
    }) : "",
    ORKESTR_CONNECTORS_MCP_BEARER_TOKEN: token,
    ORKESTR_CONNECTOR_INBOX_RETRY_INTERVAL_MS: "60000",
  };
  const gateway = createConnectorsMcpGateway({ env });
  const gatewayServer = http.createServer(gateway.app);
  const gatewayUrl = await listen(gatewayServer);
  env.ORKESTR_CONNECTORS_MCP_URL = `${gatewayUrl}/mcp`;
  return {
    env,
    worker,
    async close() {
      gateway.close();
      await close(gatewayServer);
      await close(worker.server);
    },
  };
}

test("connector MCP derives its endpoint from the parent bridge for legacy tenant slices", () => {
  const derived = connectorsMcpClientConfig({
    WHATSAPP_BRIDGE_URL: "http://10.42.0.1:18913/",
    WHATSAPP_BRIDGE_TOKEN: "scoped-token",
  });
  assert.deepEqual(derived, {
    url: "http://10.42.0.1:18913/mcp",
    token: "scoped-token",
  });

  const explicit = connectorsMcpClientConfig({
    ORKESTR_CONNECTORS_MCP_URL: "http://mcp.internal/mcp",
    ORKESTR_CONNECTORS_MCP_BEARER_TOKEN: "mcp-token",
    WHATSAPP_BRIDGE_URL: "http://bridge.internal",
    WHATSAPP_BRIDGE_TOKEN: "bridge-token",
  });
  assert.deepEqual(explicit, {
    url: "http://mcp.internal/mcp",
    token: "mcp-token",
  });
});

test("connector MCP exposes the canonical tools and scoped account status", async () => {
  const item = await fixture();
  try {
    const listed = await listConnectorsMcpTools(item.env);
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
      "orkestr_auth",
      "orkestr_conversation",
      "orkestr_messaging",
      "orkestr_routing",
    ]);
    const status = await callConnectorsMcpTool("orkestr_auth", {
      service: "whatsapp",
      action: "status",
      account_id: "sender",
    }, item.env);
    assert.equal(status.contract_version, "1.0");
    assert.equal(status.status, "ok");
    assert.equal(status.data.accounts[0].accountId, "sender");
  } finally {
    await item.close();
  }
});

test("connector MCP messaging uses the durable idempotency ledger", async () => {
  const item = await fixture({ scoped: true });
  const input = {
    service: "whatsapp",
    action: "send_text",
    account_id: "sender",
    instance_id: "vm-firat",
    user_id: "firat",
    conversation_id: "firat-jobs@g.us",
    text: "Status check",
    idempotency_key: "turn-123:reply-1",
  };
  try {
    const first = await callConnectorsMcpTool("orkestr_messaging", input, item.env);
    const second = await callConnectorsMcpTool("orkestr_messaging", input, item.env);
    assert.equal(first.status, "delivered");
    assert.equal(second.status, "delivered");
    assert.equal(second.data.duplicate, true);
    assert.equal(item.worker.calls.filter((call) => call.url === "/send-text").length, 1);
  } finally {
    await item.close();
  }
});

test("connector MCP typing is transient and scoped to the existing conversation", async () => {
  const item = await fixture({ scoped: true });
  try {
    const composing = await callConnectorsMcpTool("orkestr_messaging", {
      service: "whatsapp",
      action: "set_typing",
      account_id: "sender",
      instance_id: "vm-firat",
      user_id: "firat",
      conversation_id: "firat-jobs@g.us",
      typing_state: "composing",
    }, item.env);
    const paused = await callConnectorsMcpTool("orkestr_messaging", {
      service: "whatsapp",
      action: "set_typing",
      account_id: "sender",
      instance_id: "vm-firat",
      user_id: "firat",
      conversation_id: "firat-jobs@g.us",
      typing_state: "paused",
    }, item.env);

    assert.equal(composing.status, "active");
    assert.equal(composing.data.active, true);
    assert.equal(paused.status, "inactive");
    assert.equal(paused.data.active, false);
    assert.deepEqual(item.worker.calls.filter((call) => call.url === "/typing").map((call) => call.body.state), ["composing", "paused"]);
    assert.equal(item.worker.calls.some((call) => call.url === "/send-text"), false);
    assert.deepEqual((await listConnectorOutboxJobs({ connector: "whatsapp" }, item.env)).jobs, []);
  } finally {
    await item.close();
  }
});

test("connector MCP routing evaluates bindings against live worker health", async () => {
  const item = await fixture();
  try {
    await createThread({
      id: "thread-live-routing",
      name: "Live routing",
      binding: {
        connector: "whatsapp",
        chatId: "live-routing@g.us",
        responderAccountId: "sender",
        outboundAccountId: "sender",
        enabled: true,
        routeEligible: true,
        mirrorToWhatsApp: true,
      },
    }, item.env);

    const status = await callConnectorsMcpTool("orkestr_routing", {
      service: "whatsapp",
      action: "status",
      account_id: "sender",
    }, item.env);
    const binding = status.data.bindings.find((item) => item.threadId === "thread-live-routing");

    assert.equal(binding.state, "ready");
    assert.equal(binding.reason, "ready");
    assert.equal(binding.account.ready, true);
    assert.ok(item.worker.calls.some((call) => call.url === "/health"));
  } finally {
    await item.close();
  }
});

test("connector MCP administrative writes consume an exact attended challenge", async () => {
  const item = await fixture();
  try {
    const pending = await callConnectorsMcpTool("orkestr_auth", {
      service: "whatsapp",
      action: "logout",
      account_id: "sender",
    }, item.env);
    assert.equal(pending.status, "approval_required");
    assert.match(pending.challenge.approve_command, /^orkestr security approve /);
    await approvePairingChallenge(pending.challenge.approve_code, { env: item.env, approvedBy: "test" });
    const completed = await callConnectorsMcpTool("orkestr_auth", {
      service: "whatsapp",
      action: "logout",
      account_id: "sender",
      approval: pending.challenge.approve_code,
    }, item.env);
    assert.equal(completed.status, "ok");
    assert.equal(item.worker.calls.filter((call) => call.url === "/accounts/sender/logout").length, 1);
  } finally {
    await item.close();
  }
});

test("the same orkestr_auth tool starts attended Gmail OAuth without an account hint", async () => {
  const item = await fixture();
  Object.assign(item.env, {
    GMAIL_OAUTH_CLIENT_ID: "google-client",
    GMAIL_OAUTH_CLIENT_SECRET: "google-secret",
    GMAIL_OAUTH_REDIRECT_URI: "https://connect.orkestr.test/oauth/gmail/callback",
  });
  try {
    const pending = await callConnectorsMcpTool("orkestr_auth", {
      service: "gmail",
      action: "connect",
      user_id: "admin",
    }, item.env);
    assert.equal(pending.status, "approval_required");
    await approvePairingChallenge(pending.challenge.approve_code, { env: item.env, approvedBy: "test" });
    const started = await callConnectorsMcpTool("orkestr_auth", {
      service: "gmail",
      action: "connect",
      user_id: "admin",
      approval: pending.challenge.approve_code,
    }, item.env);
    assert.equal(started.status, "ok");
    assert.match(started.data.authorizeUrl, /^https:\/\/accounts\.google\.com\//);
    assert.equal(started.data.account, "");
  } finally {
    await item.close();
  }
});

test("connector MCP inbound routing is idempotent and has a finite retry budget", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-connectors-inbox-"));
  const env = {
    ...process.env,
    ORKESTR_HOME: home,
    ORKESTR_CONNECTORS_MCP_INBOUND_TARGET_URL: "http://orkestr-ui.test/api/connectors/whatsapp/inbound",
    ORKESTR_CONNECTOR_INBOX_MAX_ATTEMPTS: "2",
  };
  let calls = 0;
  const payload = { eventId: "wa-event-1", accountId: "sender", chatId: "jobs@g.us", text: "hello" };
  try {
    const first = await routeWhatsAppInboundFromWorker(payload, env, async () => {
      calls += 1;
      return { ok: true, status: 200, json: async () => ({ ok: true, messageId: "thread-message-1" }) };
    });
    const duplicate = await routeWhatsAppInboundFromWorker(payload, env, async () => {
      calls += 1;
      throw new Error("duplicate_should_not_forward");
    });
    assert.equal(first.ok, true);
    assert.equal(duplicate.duplicate, true);
    assert.equal(calls, 1);

    const failed = await routeWhatsAppInboundFromWorker({ ...payload, eventId: "wa-event-2" }, env, async () => {
      throw new Error("target_offline");
    });
    assert.equal(failed.state, "failed_retryable");
    const retryable = (await listConnectorInboxEvents({ states: ["failed_retryable"] }, env))[0];
    const terminal = await deliverConnectorInboxEvent(retryable, env, async () => {
      throw new Error("target_still_offline");
    });
    assert.equal(terminal.state, "dead_letter");
    assert.equal(terminal.attemptCount, 2);
  } finally {
    resetConnectorInboxForTest();
  }
});

test("connector MCP gateway modules remain browser-free", async () => {
  const files = [
    "scripts/orkestr-connectors-mcp.mjs",
    "packages/connectors/src/connectors-mcp-server.js",
    "packages/connectors/src/connectors-mcp-operations.js",
    "packages/connectors/src/connectors-mcp-router.js",
    "packages/connectors/src/whatsapp-worker-client.js",
  ];
  const source = (await Promise.all(files.map((file) => fs.readFile(new URL(`../${file}`, import.meta.url), "utf8")))).join("\n");
  assert.doesNotMatch(source, /whatsapp-local-bridge|whatsapp-web\.js/);
});

test("connector service entrypoints remain executable through a release symlink", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-connectors-main-"));
  const target = path.join(root, "target.mjs");
  const current = path.join(root, "current.mjs");
  await fs.writeFile(target, "export default true;\n");
  await fs.symlink(target, current);
  assert.equal(isMainModule(new URL(`file://${target}`).href, current), true);
});

test("connector doctor evaluates the worker and queue rather than UI process health", () => {
  assert.deepEqual(assessConnectorHealth({
    ok: true,
    gateway: { ok: true },
    worker: { ok: true, state: "ready" },
    accounts: [{ accountId: "sender", ready: true, runtimeUsable: true, sendReady: true, inboundReady: true }],
    queue: { deadLetter: 0 },
  }, { ORKESTR_CONNECTORS_REQUIRED_WA_ACCOUNTS: "sender" }).issues, []);
  assert.deepEqual(assessConnectorHealth({
    ok: true,
    gateway: { ok: true },
    worker: { ok: false, state: "unavailable" },
    accounts: [{ accountId: "sender", ready: false }],
    queue: { deadLetter: 2 },
  }, { ORKESTR_CONNECTORS_REQUIRED_WA_ACCOUNTS: "sender" }).issues, [
    "worker_unhealthy",
    "required_accounts_unavailable",
    "dead_letter_events",
  ]);
  assert.deepEqual(assessConnectorHealth({
    ok: true,
    gateway: { ok: true },
    worker: { ok: true, state: "ready" },
    accounts: [{ accountId: "sender", ready: true, runtimeUsable: true, sendReady: false, inboundReady: false }],
    queue: { deadLetter: 0 },
  }, { ORKESTR_CONNECTORS_REQUIRED_WA_ACCOUNTS: "sender" }).issues, [
    "required_accounts_unavailable",
  ]);
});

test("connector doctor recognizes phone identities through their runtime alias", () => {
  const result = assessConnectorHealth({
    ok: true,
    gateway: { ok: true },
    worker: { ok: true, state: "ready" },
    accounts: [{
      accountId: "905555154214",
      runtimeAccountId: "sender",
      legacyRoleAliases: ["sender"],
      ready: false,
      runtimeUsable: true,
      sendReady: true,
      inboundReady: true,
    }],
    queue: { deadLetter: 0 },
  }, { ORKESTR_CONNECTORS_REQUIRED_WA_ACCOUNTS: "sender" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.missingAccounts, []);
  assert.deepEqual(result.unavailableAccounts, []);
});

test("connector doctor does not restart an authenticated account during startup grace", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-connectors-doctor-startup-"));
  const updatedAt = new Date().toISOString();
  const result = await runConnectorDoctor({
    repair: true,
    env: {
      ORKESTR_HOME: home,
      ORKESTR_CONNECTORS_REQUIRED_WA_ACCOUNTS: "sender",
      ORKESTR_CONNECTORS_DOCTOR_STARTUP_GRACE_MS: "180000",
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        gateway: { ok: true },
        worker: { ok: true, state: "authenticated" },
        accounts: [{
          accountId: "sender",
          state: "authenticated",
          ready: false,
          authenticated: true,
          runtimeUsable: false,
          sendReady: false,
          inboundReady: false,
          updatedAt,
        }],
        queue: { deadLetter: 0 },
      }),
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.repaired, false);
  assert.equal(result.repairSuppressed, "startup_grace");
  assert.deepEqual(result.recoveringAccounts, ["sender"]);
});

test("connector doctor leaves dead letters for explicit recovery", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-connectors-doctor-"));
  const result = await runConnectorDoctor({
    repair: true,
    env: {
      ORKESTR_HOME: home,
      ORKESTR_CONNECTORS_REQUIRED_WA_ACCOUNTS: "sender",
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        gateway: { ok: true },
        worker: { ok: true, state: "ready" },
        accounts: [{ accountId: "sender", ready: true, runtimeUsable: true, sendReady: true, inboundReady: true }],
        queue: { deadLetter: 1 },
      }),
    }),
  });
  assert.equal(result.repaired, false);
  assert.equal(result.repairSuppressed, "manual_intervention");
  assert.deepEqual(result.issues, ["dead_letter_events"]);
});
