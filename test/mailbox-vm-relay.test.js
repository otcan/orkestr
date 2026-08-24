import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ingestMailboxMessage } from "../packages/connectors/src/mailbox-inbox.js";
import { dispatchVmMailboxRelay } from "../packages/connectors/src/mailbox-vm-relay.js";
import { ingestVmMailboxRelay } from "../packages/core/src/mailbox-vm-inbox.js";
import { createMailbox, getMailbox, listMailboxInboxMessages, listMailboxes } from "../packages/core/src/mailboxes.js";
import { userPrincipal } from "../packages/core/src/principal.js";
import { authorizeHttpRequest } from "../packages/core/src/security.js";
import { createTenantVm } from "../packages/core/src/tenant-vm-registry.js";
import { createThread } from "../packages/core/src/threads.js";

async function home(label) {
  return fs.mkdtemp(path.join(os.tmpdir(), `orkestr-mailbox-vm-relay-${label}-`));
}

test("VM mailbox relay retains history in the target instance and deduplicates retries", async () => {
  const token = "mailbox-relay-test-token";
  const centralEnv = {
    ORKESTR_HOME: await home("central"),
    ORKESTR_MAILBOX_DOMAIN: "mail.example.test",
    ORKESTR_MAILBOX_RELAY_TOKEN: token,
  };
  const tenantEnv = {
    ORKESTR_HOME: await home("tenant"),
    ORKESTR_ADMIN_USER_ID: "firat",
    ORKESTR_TENANT_VM_ID: "firat-jobs-vm",
    ORKESTR_MAILBOX_ACCESS_MODE: "enforce",
    ORKESTR_MAILBOX_RELAY_TOKEN: token,
  };
  const thread = await createThread({ id: "firat-jobs", name: "Fırat Jobs", ownerUserId: "firat" }, tenantEnv);
  await createTenantVm({
    id: "firat-jobs-vm",
    ownerUserId: "firat",
    status: "running",
    capabilities: ["mailboxes"],
    endpoint: { baseUrl: "https://firat.example.test" },
    bootstrap: { firstThreadId: thread.id },
  }, centralEnv);
  const mailbox = await createMailbox({
    id: "mbx-firat-forwarding",
    ownerUserId: "firat",
    purpose: "forwarding",
    address: "firat-forwarding@mail.example.test",
    status: "active",
    targetType: "vm",
    tenantVmId: "firat-jobs-vm",
  }, centralEnv);
  const longBody = `Confirmation 246810\n${"historical mailbox content ".repeat(40)}`;
  const queued = await ingestMailboxMessage({
    recipient: mailbox.address,
    headers: { messageId: "<firat-forwarding@example.test>", from: "sender@example.test", subject: "Forwarding confirmation" },
    envelope: { rcptTo: mailbox.address, mailFrom: "sender@example.test" },
    body: { text: longBody },
  }, centralEnv);
  assert.equal(queued.action, "vm_relay_queued");

  const calls = [];
  const deliver = async (url, options = {}) => {
    calls.push({ url: String(url), authorization: options.headers.authorization });
    const result = await ingestVmMailboxRelay(JSON.parse(options.body), tenantEnv);
    return new Response(JSON.stringify(result), { status: 202, headers: { "content-type": "application/json" } });
  };
  const first = await dispatchVmMailboxRelay(queued.relayAudit, centralEnv, deliver);
  const duplicate = await dispatchVmMailboxRelay(queued.relayAudit, centralEnv, deliver);
  assert.equal(first.ok, true);
  assert.equal(duplicate.ok, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].authorization, `Bearer ${token}`);

  const mirrored = await getMailbox(mailbox.id, tenantEnv);
  assert.equal(mirrored.source, "vm-relay");
  assert.equal(mirrored.target.type, "main");
  assert.equal((await listMailboxes(tenantEnv)).length, 1);
  const inbox = await listMailboxInboxMessages({
    mailbox: mirrored,
    threadId: thread.id,
    principal: userPrincipal({ id: "firat" }),
  }, tenantEnv);
  assert.equal(inbox.messages.length, 1);
  assert.match(inbox.messages[0].body, /Confirmation 246810/);
  assert.ok(inbox.messages[0].body.length > 500);
});

test("VM mailbox relay endpoint requires its dedicated bearer token", async () => {
  const env = {
    ORKESTR_HOME: await home("auth"),
    ORKESTR_MAILBOX_RELAY_TOKEN: "expected-relay-token",
    ORKESTR_DISABLE_AUTH: "0",
  };
  const request = (authorization = "") => ({
    method: "POST",
    url: "/api/mailboxes/relay-inbound",
    originalUrl: "/api/mailboxes/relay-inbound",
    headers: { authorization, host: "127.0.0.1:19812" },
    socket: { remoteAddress: "127.0.0.1" },
  });
  assert.equal((await authorizeHttpRequest(request(), env)).error, "mailbox_vm_relay_auth_required");
  assert.equal((await authorizeHttpRequest(request("Bearer wrong"), env)).error, "mailbox_vm_relay_auth_invalid");
  const allowed = await authorizeHttpRequest(request("Bearer expected-relay-token"), env);
  assert.equal(allowed.ok, true);
  assert.equal(allowed.machineAuth, "mailbox_vm_relay");
  assert.deepEqual(allowed.machineAuthContext.scopes, ["mailbox:relay:ingest"]);
});
