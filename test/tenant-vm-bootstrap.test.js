import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { routeWhatsAppInbound } from "../packages/connectors/src/whatsapp.js";
import { bootstrapTenantVmFromProfile, tenantVmBootstrapThreadInput } from "../packages/core/src/tenant-vm-bootstrap.js";
import { getThread, listThreadMessages } from "../packages/core/src/threads.js";

function profile() {
  return {
    schemaVersion: 1,
    generatedBy: "orkestr",
    tenantVmId: "tenant-demo-slice-vm",
    ownerUserId: "tenant-demo",
    displayName: "Tenant Demo Slice VM",
    workspace: {
      root: "/opt/orkestr/workspace/tenant-demo-slice",
      filesRoot: "/opt/orkestr/workspace/tenant-demo-slice/files",
    },
    codex: {
      provider: "codex",
      model: "gpt-5.5",
      reasoningEffort: "medium",
      mode: "code",
    },
    firstChat: {
      id: "tenant-demo-slice",
      name: "Tenant Demo Slice",
      title: "Tenant Demo Slice",
      autoWake: true,
      whatsappChatName: "Tenant Demo Slice",
    },
    connectors: {
      whatsapp: {
        enabled: true,
        chatId: "120363425486269879@g.us",
        chatName: "Tenant Demo Slice",
        accountId: "sender",
        routeMode: "control-plane-forward",
      },
    },
  };
}

test("tenant VM bootstrap builds the first WhatsApp-bound Codex thread input", () => {
  const input = tenantVmBootstrapThreadInput(profile(), { ORKESTR_ADMIN_USER_ID: "tenant-demo" });

  assert.equal(input.id, "tenant-demo-slice");
  assert.equal(input.ownerUserId, "tenant-demo");
  assert.equal(input.runtimeKind, "codex-app-server");
  assert.equal(input.executor.transport, "app-server");
  assert.equal(input.binding.chatId, "120363425486269879@g.us");
  assert.equal(input.binding.senderAccountId, "sender");
  assert.equal(input.binding.acl.receive.mode, "all-users");
});

test("tenant VM bootstrap creates an idempotent route target for forwarded WhatsApp inbound", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-tenant-vm-bootstrap-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_ADMIN_USER_ID: "tenant-demo",
    ORKESTR_TENANT_VM_ID: "tenant-demo-slice-vm",
    ORKESTR_TENANT_BOUNDARY: "tenant-vm",
    ORKESTR_TENANT_BOOTSTRAP_START_CODEX: "0",
  };

  const first = await bootstrapTenantVmFromProfile(profile(), env);
  const second = await bootstrapTenantVmFromProfile(profile(), env);

  assert.equal(first.ok, true);
  assert.equal(first.created, true);
  assert.equal(second.ok, true);
  assert.equal(second.created, false);

  const thread = await getThread("tenant-demo-slice", env);
  assert.equal(thread.binding.chatId, "120363425486269879@g.us");
  assert.equal(thread.binding.tenantVmBootstrap, true);
  assert.equal(thread.runtimeKind, "codex-app-server");

  const routed = await routeWhatsAppInbound({
    eventId: "tenant-demo-forwarded-1",
    chatId: "120363425486269879@g.us",
    accountId: "sender",
    from: "491700000001@c.us",
    text: "hello from the tenant VM slice",
    machineAuthContext: {
      routeKind: "whatsapp_inbound",
      principalKind: "external_instance",
      principalId: "configured-inbound-token",
    },
  }, env);
  assert.equal(routed.threadId, "tenant-demo-slice");

  const messages = await listThreadMessages("tenant-demo-slice", env);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].source, "whatsapp_inbound");
  assert.equal(messages[0].text, "hello from the tenant VM slice");
});

test("tenant VM bootstrap binding follows a new parent-forwarded WhatsApp chat", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-tenant-vm-rebind-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_ADMIN_USER_ID: "tenant-demo",
    ORKESTR_TENANT_VM_ID: "tenant-demo-slice-vm",
    ORKESTR_TENANT_BOUNDARY: "tenant-vm",
    ORKESTR_TENANT_BOOTSTRAP_START_CODEX: "0",
  };

  await bootstrapTenantVmFromProfile(profile(), env);

  const routed = await routeWhatsAppInbound({
    eventId: "tenant-demo-forwarded-rebound-1",
    chatId: "120363499999999999@g.us",
    chatName: "Tenant Demo Slice New",
    accountId: "sender",
    from: "491700000001@c.us",
    text: "hello after chat rotation",
    machineAuthContext: {
      routeKind: "whatsapp_inbound",
      scopes: ["whatsapp:inbound"],
      principalKind: "external_instance",
      principalId: "configured-inbound-token",
    },
  }, env);

  const thread = await getThread("tenant-demo-slice", env);
  const messages = await listThreadMessages("tenant-demo-slice", env);

  assert.equal(routed.threadId, "tenant-demo-slice");
  assert.equal(thread.binding.chatId, "120363499999999999@g.us");
  assert.equal(thread.binding.displayName, "Tenant Demo Slice New");
  assert.equal(thread.binding.tenantVmBootstrap, true);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].chatId, "120363499999999999@g.us");
  assert.equal(messages[0].text, "hello after chat rotation");
});
