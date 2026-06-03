import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { forwardLocalWhatsAppInbound } from "../packages/connectors/src/whatsapp-local-bridge.js";
import { createTenantVm, getTenantVm } from "../packages/core/src/tenant-vm-registry.js";
import {
  configureTenantWhatsAppRoute,
  disableTenantWhatsAppRoute,
  listTenantWhatsAppRoutes,
  tenantWhatsAppInboundForwardRoute,
} from "../packages/core/src/tenant-whatsapp-routing.js";

function response(payload = {}, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() {
      return payload;
    },
  };
}

test("tenant WhatsApp routes store scoped tokens outside the public VM registry", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-tenant-wa-route-"));
  const env = { ORKESTR_HOME: home };
  await createTenantVm({
    id: "alice-tenant",
    ownerUserId: "alice",
    endpoint: { baseUrl: "https://alice.example.test" },
    connectors: { whatsappChatName: "Alice WA", whatsappAccountId: "responder" },
  }, env);

  const configured = await configureTenantWhatsAppRoute("alice-tenant", {
    chatId: "120363000000000000@g.us",
    accountId: "responder",
  }, env);
  const vm = await getTenantVm("alice-tenant", env);
  const route = await tenantWhatsAppInboundForwardRoute({
    chatId: "120363000000000000@g.us",
    accountId: "responder",
  }, env);
  const accountMismatch = await tenantWhatsAppInboundForwardRoute({
    chatId: "120363000000000000@g.us",
    accountId: "other-account",
  }, env);
  const listed = await listTenantWhatsAppRoutes(env);
  const tenantVmFile = await fs.readFile(path.join(home, "tenant-vms.json"), "utf8");

  assert.equal(configured.route.target, "https://alice.example.test/api/connectors/whatsapp/inbound");
  assert.match(configured.route.token, /^owt_/);
  assert.equal(configured.route.tokenConfigured, true);
  assert.equal(vm.connectors.whatsappChatId, "120363000000000000@g.us");
  assert.equal(vm.connectors.whatsappRouteEnabled, true);
  assert.equal(route.tenantVmId, "alice-tenant");
  assert.equal(route.target, configured.route.target);
  assert.equal(route.token, configured.route.token);
  assert.equal(accountMismatch, null);
  assert.equal(listed[0].token, undefined);
  assert.equal(listed[0].tokenPreview.includes("..."), true);
  assert.equal(tenantVmFile.includes(configured.route.token), false);

  const disabled = await disableTenantWhatsAppRoute("alice-tenant", env);
  assert.equal(disabled.route.enabled, false);
  assert.equal(await tenantWhatsAppInboundForwardRoute({ chatId: "120363000000000000@g.us" }, env), null);

  await createTenantVm({
    id: "credentialed-tenant",
    ownerUserId: "charlie",
    endpoint: { baseUrl: "https://token@example.test" },
  }, env);
  await assert.rejects(
    () => configureTenantWhatsAppRoute("credentialed-tenant", { chatId: "120363222222222222@g.us" }, env),
    /tenant_vm_base_url_required/,
  );
});

test("local WhatsApp bridge forwards tenant-routed chats with the scoped tenant token", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-tenant-wa-forward-"));
  const env = { ORKESTR_HOME: home };
  await createTenantVm({
    id: "bob-tenant",
    ownerUserId: "bob",
    endpoint: { baseUrl: "https://bob.example.test" },
  }, env);
  const configured = await configureTenantWhatsAppRoute("bob-tenant", {
    chatId: "120363111111111111@g.us",
    chatName: "Bob tenant WA",
    accountId: "tenant-wa",
  }, env);
  const calls = [];

  const forwarded = await forwardLocalWhatsAppInbound({
    eventId: "tenant-wa-event-1",
    chatId: "120363111111111111@g.us",
    accountId: "tenant-wa",
    from: "491700000000@c.us",
    text: "hello tenant",
  }, env, async (url, options = {}) => {
    calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
    if (String(url) === "https://bob.example.test/api/health") return response({ ok: true }, true, 200);
    return response({ ok: true, threadId: "tenant-thread", messageId: "tenant-message" }, true, 202);
  });

  assert.equal(forwarded.forwarded, true);
  assert.equal(String(calls[0].url), "https://bob.example.test/api/health");
  assert.equal(String(calls[1].url), "https://bob.example.test/api/connectors/whatsapp/inbound");
  assert.equal(calls[1].options.headers.authorization, `Bearer ${configured.route.token}`);
  assert.equal(calls[1].body.chatId, "120363111111111111@g.us");
  assert.equal(calls[1].body.accountId, "tenant-wa");
  assert.equal(calls[1].body.displayName, "Bob tenant WA");
  assert.equal(calls[1].body.chatName, "Bob tenant WA");
});

test("local WhatsApp tenant forwards block unhealthy target instances before routing", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-tenant-wa-forward-health-"));
  const env = { ORKESTR_HOME: home, ORKESTR_WHATSAPP_INBOUND_FORWARD_HEALTH_CACHE_MS: "0" };
  await createTenantVm({
    id: "down-tenant",
    ownerUserId: "down",
    endpoint: { baseUrl: "https://down.example.test" },
  }, env);
  await configureTenantWhatsAppRoute("down-tenant", {
    chatId: "120363444444444444@g.us",
    accountId: "tenant-wa",
  }, env);
  const calls = [];

  await assert.rejects(
    () => forwardLocalWhatsAppInbound({
      eventId: "tenant-wa-event-down",
      chatId: "120363444444444444@g.us",
      accountId: "tenant-wa",
      from: "491700000000@c.us",
      text: "hello tenant",
    }, env, async (url) => {
      calls.push(String(url));
      return response({ ok: false }, false, 502);
    }),
    (error) => {
      assert.equal(error.routingFailure.code, "target_instance_unhealthy");
      assert.equal(error.routingFailure.instanceId, "down-tenant");
      assert.equal(error.routingFailure.retryable, true);
      return true;
    },
  );
  assert.deepEqual(calls, ["https://down.example.test/api/health"]);
});

test("local WhatsApp tenant forwards allow sanitizer-backed targets enough time by default", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-tenant-wa-forward-timeout-"));
  const env = { ORKESTR_HOME: home };
  await createTenantVm({
    id: "slow-tenant",
    ownerUserId: "slow",
    endpoint: { baseUrl: "https://slow.example.test" },
  }, env);
  await configureTenantWhatsAppRoute("slow-tenant", {
    chatId: "120363333333333333@g.us",
    accountId: "tenant-wa",
  }, env);
  const originalTimeout = AbortSignal.timeout;
  const timeouts = [];
  AbortSignal.timeout = (ms) => {
    timeouts.push(ms);
    return new AbortController().signal;
  };
  try {
    await forwardLocalWhatsAppInbound({
      eventId: "tenant-wa-event-slow",
      chatId: "120363333333333333@g.us",
      accountId: "tenant-wa",
      from: "491700000000@c.us",
      text: "hello tenant",
    }, env, async (url) => {
      if (String(url) === "https://slow.example.test/api/health") return response({ ok: true }, true, 200);
      return response({ ok: true, threadId: "tenant-thread", messageId: "tenant-message" }, true, 202);
    });
  } finally {
    AbortSignal.timeout = originalTimeout;
  }

  assert.equal(timeouts[0], 5000);
  assert.equal(timeouts[1], 60_000);
});
