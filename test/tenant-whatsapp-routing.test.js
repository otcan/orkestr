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
    accountId: "tenant-wa",
  }, env);
  const calls = [];

  const forwarded = await forwardLocalWhatsAppInbound({
    eventId: "tenant-wa-event-1",
    chatId: "120363111111111111@g.us",
    accountId: "tenant-wa",
    from: "491700000000@c.us",
    text: "hello tenant",
  }, env, async (url, options) => {
    calls.push({ url, options, body: JSON.parse(options.body) });
    return response({ ok: true, threadId: "tenant-thread", messageId: "tenant-message" }, true, 202);
  });

  assert.equal(forwarded.forwarded, true);
  assert.equal(String(calls[0].url), "https://bob.example.test/api/connectors/whatsapp/inbound");
  assert.equal(calls[0].options.headers.authorization, `Bearer ${configured.route.token}`);
  assert.equal(calls[0].body.chatId, "120363111111111111@g.us");
  assert.equal(calls[0].body.accountId, "tenant-wa");
});
