import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../apps/cli/src/commands.js";
import { ingestMailboxMessage } from "../packages/connectors/src/mailbox-inbox.js";
import { listConnectorInboxEvents, resetConnectorInboxForTest } from "../packages/connectors/src/connector-inbox.js";
import {
  createMailbox,
  deleteMailboxForPrincipal,
  getMailbox,
  listMailboxDeadLetters,
  listMailboxRelayAudits,
  mailboxInfrastructureStatus,
  replayMailboxDeadLetterForPrincipal,
  retryMailboxRelayForPrincipal,
  rotateMailboxForPrincipal,
  verifyMailboxForPrincipal,
} from "../packages/core/src/mailboxes.js";
import { adminPrincipal, userPrincipal } from "../packages/core/src/principal.js";
import { createTenantVm, updateTenantVm } from "../packages/core/src/tenant-vm-registry.js";

async function fixture(extraEnv = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-mailbox-lifecycle-"));
  return {
    ORKESTR_HOME: home,
    ORKESTR_MAILBOX_DOMAIN: "mail.example.test",
    ...extraEnv,
  };
}

test.afterEach(() => {
  resetConnectorInboxForTest();
});

test("mailbox lifecycle operations are scoped, idempotent, and disable old aliases", async () => {
  const env = await fixture();
  const mailbox = await createMailbox({
    ownerUserId: "alice",
    purpose: "alerts",
    suffix: "one",
    status: "verification-pending",
    idempotencyKey: "create-alerts",
  }, env);
  const repeated = await createMailbox({
    ownerUserId: "alice",
    purpose: "alerts",
    suffix: "one",
    status: "verification-pending",
    idempotencyKey: "create-alerts",
  }, env);
  assert.equal(repeated.id, mailbox.id);

  await assert.rejects(
    () => deleteMailboxForPrincipal(mailbox.id, {}, userPrincipal({ id: "bob" }), env),
    /mailbox_access_forbidden/,
  );

  const verified = await verifyMailboxForPrincipal(mailbox.id, {
    provider: "gmail",
    state: "verified",
    idempotencyKey: "verify-alerts",
  }, userPrincipal({ id: "alice" }), env);
  assert.equal(verified.status, "active");
  assert.equal(verified.verification.state, "verified");

  const rotated = await rotateMailboxForPrincipal(mailbox.id, {
    suffix: "two",
    idempotencyKey: "rotate-alerts",
  }, userPrincipal({ id: "alice" }), env);
  assert.equal(rotated.oldMailbox.status, "rotated");
  assert.equal(rotated.mailbox.ownerUserId, "alice");
  assert.equal(rotated.mailbox.address, "alerts-two@mail.example.test");

  await assert.rejects(
    () => ingestMailboxMessage({
      recipient: mailbox.address,
      headers: { messageId: "<old@example.test>" },
      body: { text: "old address should not be accepted" },
    }, env),
    /mailbox_not_accepting/,
  );

  const deleted = await deleteMailboxForPrincipal(rotated.mailbox.id, {
    idempotencyKey: "delete-rotated",
  }, userPrincipal({ id: "alice" }), env);
  assert.equal(deleted.status, "deleted");
  assert.equal((await getMailbox(rotated.mailbox.id, env)).status, "deleted");
});

test("production mailbox creation fails closed until MTA readiness is explicit", async () => {
  const missing = await fixture({ ORKESTR_MAILBOX_REQUIRE_MTA_READY: "1" });
  await assert.rejects(
    () => createMailbox({ ownerUserId: "owner", purpose: "prod", suffix: "blocked" }, missing),
    /mailbox_infrastructure_not_ready/,
  );

  const ready = await fixture({
    ORKESTR_MAILBOX_REQUIRE_MTA_READY: "1",
    ORKESTR_MAILBOX_MTA_READY: "1",
    ORKESTR_MAILBOX_MTA_ADAPTER: "postfix",
    ORKESTR_MAILBOX_MTA_PROPAGATION: "recipient-map",
    ORKESTR_MAILBOX_MTA_REVISION: "rev-001",
  });
  const mailbox = await createMailbox({ ownerUserId: "owner", purpose: "prod", suffix: "ready" }, ready);
  assert.equal(mailbox.lifecycle.propagationState, "complete");
  assert.equal(mailbox.lifecycle.mtaRevision, "rev-001");
  assert.equal(mailbox.lifecycle.lastError, "");
});

test("production mailbox creation rejects the default reserved mailbox domain", async () => {
  const env = await fixture({
    NODE_ENV: "production",
    ORKESTR_MAILBOX_DOMAIN: "",
    ORKESTR_MAILBOX_MTA_READY: "1",
    ORKESTR_MAILBOX_MTA_ADAPTER: "postfix",
  });
  const status = mailboxInfrastructureStatus({}, env);
  assert.equal(status.productionMode, true);
  assert.equal(status.reservedDomain, true);
  assert.equal(status.ready, false);
  assert.equal(status.reason, "mailbox_reserved_domain_in_production");

  await assert.rejects(
    () => createMailbox({ ownerUserId: "owner", purpose: "prod", suffix: "reserved" }, env),
    /mailbox_infrastructure_not_ready/,
  );
});

test("versioned release deployments enforce production mailbox readiness", async () => {
  const env = await fixture({
    ORKESTR_RELEASE_DEPLOY: "1",
    ORKESTR_MAILBOX_DOMAIN: "",
  });
  const status = mailboxInfrastructureStatus({}, env);
  assert.equal(status.productionMode, true);
  assert.equal(status.ready, false);
  assert.equal(status.reason, "mailbox_reserved_domain_in_production");
});

test("production reserved mailbox domains require an explicit development override", async () => {
  const env = await fixture({
    NODE_ENV: "production",
    ORKESTR_MAILBOX_DOMAIN: "",
    ORKESTR_MAILBOX_ALLOW_DEVELOPMENT_DOMAIN: "1",
  });
  const mailbox = await createMailbox({ ownerUserId: "owner", purpose: "dev", suffix: "override" }, env);
  assert.equal(mailbox.address, "dev-override@in.example.test");
  assert.equal(mailbox.lifecycle.propagationState, "development");
});

test("mailbox ingest enforces public-safe message and attachment limits before routing", async () => {
  const env = await fixture();
  const mailbox = await createMailbox({
    ownerUserId: "owner",
    purpose: "limits",
    suffix: "small",
    status: "active",
    limits: { maxMessageBytes: 1024, maxAttachments: 0 },
  }, env);

  await assert.rejects(
    () => ingestMailboxMessage({
      recipient: mailbox.address,
      headers: { messageId: "<too-large@example.test>" },
      sizeBytes: 2048,
      body: { text: "small text but oversized transport" },
    }, env),
    /mailbox_message_too_large/,
  );

  await assert.rejects(
    () => ingestMailboxMessage({
      recipient: mailbox.address,
      headers: { messageId: "<attachment-limit@example.test>" },
      body: { text: "attachment" },
      attachments: [{ filename: "blocked.pdf", contentType: "application/pdf", sizeBytes: 1 }],
    }, env),
    /mailbox_attachment_limit_exceeded/,
  );
  assert.deepEqual(await listConnectorInboxEvents({}, env), []);
});

test("forwarding verification ingest updates only scoped mailbox verification metadata", async () => {
  const env = await fixture();
  const mailbox = await createMailbox({ ownerUserId: "owner", purpose: "verify", suffix: "candidate", status: "pending" }, env);

  await ingestMailboxMessage({
    recipient: mailbox.address,
    headers: { messageId: "<verify-candidate@example.test>", subject: "Outlook forwarding code", from: "account-security@example.test" },
    body: { text: "Forwarding verification code: ABC12345" },
  }, env);

  const updated = await getMailbox(mailbox.id, env);
  assert.equal(updated.status, "verification-pending");
  assert.equal(updated.verification.state, "candidate-detected");
  assert.deepEqual(updated.verification.lastCandidates, [{ type: "code", value: "ABC12345", href: "" }]);
  assert.equal(JSON.stringify(updated).includes("Forwarding verification code"), false);
});

test("VM relay retry and dead-letter replay revalidate exact targets without main inbox processing", async () => {
  const env = await fixture();
  await createTenantVm({ id: "relay-vm", ownerUserId: "owner", status: "running", capabilities: ["mailboxes"] }, env);
  const mailbox = await createMailbox({
    ownerUserId: "owner",
    purpose: "vm",
    suffix: "retry",
    status: "active",
    targetType: "vm",
    tenantVmId: "relay-vm",
  }, env);

  const routed = await ingestMailboxMessage({
    recipient: mailbox.address,
    headers: { messageId: "<retry@example.test>", from: "sender@example.test", subject: "Retry me" },
    envelope: { rcptTo: mailbox.address, mailFrom: "sender@example.test" },
    body: { text: "tenant-only payload" },
  }, env);
  assert.equal(routed.action, "vm_relay_queued");

  await updateTenantVm("relay-vm", { status: "stopped" }, env);
  await assert.rejects(
    () => retryMailboxRelayForPrincipal(routed.relayAudit.id, { idempotencyKey: "retry-stopped" }, adminPrincipal(), env),
    /target_stale/,
  );

  const deadLetters = await listMailboxDeadLetters({ tenantVmId: "relay-vm" }, env);
  assert.equal(deadLetters.length, 1);
  assert.equal(deadLetters[0].relayAuditId, routed.relayAudit.id);
  assert.equal(JSON.stringify(deadLetters[0]).includes("tenant-only payload"), false);
  assert.deepEqual(await listConnectorInboxEvents({}, env), []);

  await updateTenantVm("relay-vm", { status: "running" }, env);
  const replay = await replayMailboxDeadLetterForPrincipal(deadLetters[0].id, {
    confirm: true,
    idempotencyKey: "replay-fixed",
  }, adminPrincipal(), env);
  assert.equal(replay.state, "queued");
  assert.equal(replay.tenantVmId, "relay-vm");
  assert.equal(replay.targetSelection.selectedInstanceId, "relay-vm");
  assert.deepEqual(await listConnectorInboxEvents({}, env), []);
});

test("mailbox CLI exposes stable lifecycle and relay request contracts", async () => {
  const calls = [];
  let stdout = "";
  const code = await runCli([
    "mailboxes",
    "rotate",
    "mbx-one",
    "--suffix",
    "next",
    "--idempotency-key",
    "rotate-cli",
    "--json",
  ], {
    baseUrl: "http://orkestr.test",
    env: { ORKESTR_DISABLE_CLI_AUTH: "1" },
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: () => {} },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({
        ok: true,
        mailbox: { id: "mbx-next", address: "next@mail.example.test", status: "verification-pending", target: { type: "main" } },
        oldMailbox: { id: "mbx-one", status: "rotated" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(code, 0);
  assert.equal(calls[0].url, "http://orkestr.test/api/mailboxes/mbx-one/rotate");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    idempotencyKey: "rotate-cli",
    suffix: "next",
  });
  assert.equal(JSON.parse(stdout).mailbox.id, "mbx-next");
});
