import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { runCli } from "../apps/cli/src/commands.js";
import { listConnectorInboxEvents, resetConnectorInboxForTest } from "../packages/connectors/src/connector-inbox.js";
import { ingestMailboxMessage } from "../packages/connectors/src/mailbox-inbox.js";
import {
  createMailbox,
  createMailboxForPrincipal,
  extractForwardingVerificationCandidates,
  listMailboxDeadLetters,
  listMailboxRelayAudits,
  listMailboxesForPrincipal,
  mailboxMessageIdempotencyKey,
  normalizeInboundMailboxMessage,
} from "../packages/core/src/mailboxes.js";
import { adminPrincipal, userPrincipal } from "../packages/core/src/principal.js";
import { approvePairingChallenge } from "../packages/core/src/security.js";
import { createTenantVm, deleteTenantVm } from "../packages/core/src/tenant-vm-registry.js";

async function fixture(extraEnv = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-mailboxes-"));
  return {
    ORKESTR_HOME: home,
    ORKESTR_MAILBOX_DOMAIN: "mail.example.test",
    ...extraEnv,
  };
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function read(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

test.afterEach(() => {
  resetConnectorInboxForTest();
});

test("mailbox registry creates public-safe main mailboxes", async () => {
  const env = await fixture();

  const mailbox = await createMailbox({
    ownerUserId: "Alice",
    purpose: "jobs",
    suffix: "abc123",
    status: "active",
  }, env);

  assert.equal(mailbox.id, "mbx-jobs-abc123");
  assert.equal(mailbox.ownerUserId, "alice");
  assert.equal(mailbox.address, "jobs-abc123@mail.example.test");
  assert.equal(mailbox.target.type, "main");
  assert.equal(mailbox.status, "active");

  const alice = await listMailboxesForPrincipal(userPrincipal({ id: "alice" }), env);
  const bob = await listMailboxesForPrincipal(userPrincipal({ id: "bob" }), env);
  assert.deepEqual(alice.map((item) => item.address), ["jobs-abc123@mail.example.test"]);
  assert.deepEqual(bob, []);
});

test("VM self-service mailbox creation is owner, capability, and generated-address scoped", async () => {
  const env = await fixture();
  await createTenantVm({
    id: "alice-vm",
    ownerUserId: "alice",
    status: "running",
    capabilities: ["codex", "mailboxes"],
  }, env);
  await createTenantVm({
    id: "bob-vm",
    ownerUserId: "bob",
    status: "running",
    capabilities: ["codex"],
  }, env);

  const mailbox = await createMailboxForPrincipal({
    targetType: "vm",
    tenantVmId: "alice-vm",
    purpose: "crm",
    suffix: "q1",
    address: "ignored-admin-only@mail.example.test",
  }, userPrincipal({ id: "alice" }), env);

  assert.equal(mailbox.ownerUserId, "alice");
  assert.equal(mailbox.target.type, "vm");
  assert.equal(mailbox.target.tenantVmId, "alice-vm");
  assert.equal(mailbox.address, "alice-vm-crm-q1@mail.example.test");
  assert.equal(mailbox.source, "vm-self-service");

  await assert.rejects(
    () => createMailboxForPrincipal({ targetType: "vm", tenantVmId: "alice-vm", purpose: "cross" }, userPrincipal({ id: "mallory" }), env),
    /target_unauthorized/,
  );
  await assert.rejects(
    () => createMailboxForPrincipal({ targetType: "vm", tenantVmId: "bob-vm", purpose: "alerts" }, userPrincipal({ id: "bob" }), env),
    /mailbox_vm_self_service_capability_required/,
  );
});

test("VM self-service mailbox creation enforces per-VM quota", async () => {
  const env = await fixture({ ORKESTR_VM_MAILBOX_QUOTA: "2" });
  await createTenantVm({
    id: "quota-vm",
    ownerUserId: "quota-owner",
    status: "running",
    capabilities: ["mailboxes"],
  }, env);
  const principal = userPrincipal({ id: "quota-owner" });

  await createMailboxForPrincipal({ targetType: "vm", tenantVmId: "quota-vm", purpose: "one", suffix: "a" }, principal, env);
  await createMailboxForPrincipal({ targetType: "vm", tenantVmId: "quota-vm", purpose: "two", suffix: "b" }, principal, env);

  await assert.rejects(
    () => createMailboxForPrincipal({ targetType: "vm", tenantVmId: "quota-vm", purpose: "three", suffix: "c" }, principal, env),
    /mailbox_vm_quota_reached/,
  );
});

test("VM mailbox creation infers one authorized VM and records selection provenance", async () => {
  const env = await fixture();
  await createTenantVm({
    id: "single-vm",
    ownerUserId: "single-owner",
    status: "running",
    capabilities: ["mailboxes"],
  }, env);

  const mailbox = await createMailboxForPrincipal({
    targetType: "vm",
    purpose: "inbox",
    suffix: "solo",
  }, userPrincipal({ id: "single-owner" }), env);

  assert.equal(mailbox.target.tenantVmId, "single-vm");
  assert.equal(mailbox.targetSelection.selectedInstanceId, "single-vm");
  assert.equal(mailbox.targetSelection.selectionSource, "single_authorized_target");
  assert.equal(mailbox.targetSelection.ambiguityResult, "single_match");
});

test("VM mailbox creation without target fails closed when admin can see multiple VMs", async () => {
  const env = await fixture();
  await createTenantVm({ id: "first-vm", ownerUserId: "first-owner", status: "running", capabilities: ["mailboxes"] }, env);
  await createTenantVm({ id: "second-vm", ownerUserId: "second-owner", status: "running", capabilities: ["mailboxes"] }, env);

  await assert.rejects(
    () => createMailboxForPrincipal({ targetType: "vm", purpose: "ambiguous" }, adminPrincipal(), env),
    /instance_selection_required/,
  );
  assert.deepEqual(await listMailboxesForPrincipal(adminPrincipal(), env), []);
});

test("main mailbox ingest appends one durable connector inbox event and dedupes provider retries", async () => {
  const env = await fixture();
  const mailbox = await createMailbox({ ownerUserId: "owner", purpose: "alerts", suffix: "main", status: "active" }, env);

  const first = await ingestMailboxMessage({
    recipient: mailbox.address,
    headers: { messageId: "<msg-1@example.test>", from: "sender@example.test", subject: "Build failed" },
    envelope: { mailFrom: "sender@example.test", rcptTo: mailbox.address, sourceIp: "192.0.2.10", helo: "mx.example.test" },
    body: { text: "The build failed with exit code 1. This is the full body." },
    providerMessageId: "delivery-a",
  }, env);
  const second = await ingestMailboxMessage({
    recipient: mailbox.address,
    headers: { messageId: "<msg-1@example.test>", from: "sender@example.test", subject: "Build failed" },
    envelope: { mailFrom: "sender@example.test", rcptTo: mailbox.address, sourceIp: "192.0.2.10", helo: "mx.example.test" },
    body: { text: "The build failed with exit code 1. This is the full body." },
    providerMessageId: "delivery-b",
  }, env);

  assert.equal(first.action, "connector_inbox_queued");
  assert.equal(second.action, "deduped");
  const events = await listConnectorInboxEvents({}, env);
  assert.equal(events.length, 1);
  assert.equal(events[0].connector, "mailbox");
  assert.equal(events[0].accountId, mailbox.id);
  assert.equal(events[0].payload.snippet, "The build failed with exit code 1. This is the full body.");
  assert.equal(Object.hasOwn(events[0].payload, "text"), false);
  assert.equal(Object.hasOwn(events[0].payload, "html"), false);
});

test("missing Message-ID falls back to deterministic content idempotency", async () => {
  const env = await fixture();
  const mailbox = await createMailbox({ ownerUserId: "owner", purpose: "fallback", suffix: "dedupe", status: "active" }, env);
  const input = {
    recipient: mailbox.address,
    headers: { from: "forwarder@example.test", subject: "Forwarded lead" },
    envelope: { mailFrom: "forwarder@example.test", rcptTo: mailbox.address },
    body: { text: "Candidate profile update" },
  };

  const firstKey = await mailboxMessageIdempotencyKey({ ...input, providerMessageId: "provider-1" }, mailbox);
  const secondKey = await mailboxMessageIdempotencyKey({ ...input, providerMessageId: "provider-2" }, mailbox);
  assert.equal(firstKey, secondKey);

  await ingestMailboxMessage({ ...input, providerMessageId: "provider-1" }, env);
  const duplicate = await ingestMailboxMessage({ ...input, providerMessageId: "provider-2" }, env);
  assert.equal(duplicate.action, "deduped");
  assert.equal((await listConnectorInboxEvents({}, env)).length, 1);
});

test("same forwarded email can be processed independently for multiple recipients", async () => {
  const env = await fixture();
  const firstMailbox = await createMailbox({ ownerUserId: "owner", purpose: "first", suffix: "in", status: "active" }, env);
  const secondMailbox = await createMailbox({ ownerUserId: "owner", purpose: "second", suffix: "in", status: "active" }, env);
  const base = {
    headers: { messageId: "<multi@example.test>", from: "sender@example.test", subject: "Shared forward" },
    body: { text: "Forwarded to two Orkestr mailboxes" },
  };

  const first = await ingestMailboxMessage({ ...base, recipient: firstMailbox.address, envelope: { rcptTo: firstMailbox.address } }, env);
  const second = await ingestMailboxMessage({ ...base, recipient: secondMailbox.address, envelope: { rcptTo: secondMailbox.address } }, env);

  assert.notEqual(first.idempotencyKey, second.idempotencyKey);
  assert.equal((await listConnectorInboxEvents({}, env)).length, 2);
});

test("raw MIME ingest extracts safe headers, body alternatives, attachments, and verification candidates", async () => {
  const env = await fixture();
  const mailbox = await createMailbox({ ownerUserId: "owner", purpose: "mime", suffix: "raw", status: "active" }, env);
  const rawMime = [
    "Message-ID: <raw-mime@example.test>",
    "From: Forwarder <forwarder@example.test>",
    "Subject: Gmail forwarding verification",
    "Date: Thu, 06 Aug 2026 10:00:00 +0000",
    "Content-Type: multipart/mixed; boundary=\"outer\"",
    "",
    "--outer",
    "Content-Type: multipart/alternative; boundary=\"alt\"",
    "",
    "--alt",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Forwarding verification code: MIME12345",
    "--alt",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>Forwarding verification code: MIME12345</p>",
    "--alt--",
    "--outer",
    "Content-Type: application/pdf; name=\"lead.pdf\"",
    "Content-Disposition: attachment; filename=\"lead.pdf\"",
    "Content-Transfer-Encoding: base64",
    "",
    "cGRmLXBheWxvYWQ=",
    "--outer--",
    "",
  ].join("\r\n");

  const normalized = await normalizeInboundMailboxMessage({ recipient: mailbox.address, rawMime }, mailbox);
  assert.equal(normalized.headers.messageId, "<raw-mime@example.test>");
  assert.equal(normalized.snippet, "Forwarding verification code: MIME12345");
  assert.deepEqual(normalized.verificationCandidates, [{ type: "code", value: "MIME12345" }]);
  assert.equal(normalized.attachments.length, 1);
  assert.equal(normalized.attachments[0].filename, "lead.pdf");
  assert.equal(normalized.attachments[0].quarantined, true);
  assert.equal(Object.hasOwn(normalized, "rawMime"), false);

  const ingested = await ingestMailboxMessage({ recipient: mailbox.address, rawMime, envelope: { rcptTo: mailbox.address } }, env);
  const duplicate = await ingestMailboxMessage({ recipient: mailbox.address, rawMime, envelope: { rcptTo: mailbox.address } }, env);
  assert.equal(ingested.action, "connector_inbox_queued");
  assert.equal(duplicate.action, "deduped");
  assert.equal((await listConnectorInboxEvents({}, env)).length, 1);
});

test("raw MIME parser preserves UTF-8 fields and binary attachment bytes", async () => {
  const env = await fixture();
  const mailbox = await createMailbox({ ownerUserId: "owner", purpose: "mime", suffix: "binary", status: "active" }, env);
  const binary = Buffer.from([0, 1, 2, 255, 254, 253, 65, 66]);
  const rawMime = [
    "Message-ID: <utf8-binary@example.test>",
    "From: =?UTF-8?Q?J=C3=B6rg?= <joerg@example.test>",
    "Subject: =?UTF-8?Q?R=C3=A9sum=C3=A9_=E2=9C=93?=",
    "Content-Type: multipart/mixed; boundary=\"utf8\"",
    "",
    "--utf8",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Caf=C3=A9 =E2=9C=93",
    "--utf8",
    "Content-Type: application/octet-stream",
    "Content-Disposition: attachment; filename*=utf-8''r%C3%A9sum%C3%A9.bin",
    "Content-Transfer-Encoding: base64",
    "",
    binary.toString("base64"),
    "--utf8--",
    "",
  ].join("\r\n");

  const normalized = await normalizeInboundMailboxMessage({ recipient: mailbox.address, rawMime }, mailbox);
  assert.equal(normalized.headers.subject, "Résumé ✓");
  assert.equal(normalized.headers.from, "Jörg <joerg@example.test>");
  assert.equal(normalized.snippet, "Café ✓");
  assert.equal(normalized.attachments.length, 1);
  assert.equal(normalized.attachments[0].filename, "résumé.bin");
  assert.equal(normalized.attachments[0].sizeBytes, binary.length);
  assert.equal(normalized.attachments[0].contentHash, createHash("sha256").update(binary).digest("hex"));
  assert.equal(normalized.attachments[0].quarantined, true);
});

test("malformed raw MIME boundaries do not fabricate attachment metadata", async () => {
  const env = await fixture();
  const mailbox = await createMailbox({ ownerUserId: "owner", purpose: "mime", suffix: "malformed", status: "active" }, env);
  const rawMime = [
    "Message-ID: <malformed-mime@example.test>",
    "Content-Type: multipart/mixed; boundary=\"expected\"",
    "",
    "--unexpected",
    "Content-Type: application/octet-stream",
    "Content-Disposition: attachment; filename=\"ghost.bin\"",
    "Content-Transfer-Encoding: base64",
    "",
    "AAEC",
    "--unexpected--",
    "",
  ].join("\r\n");

  const normalized = await normalizeInboundMailboxMessage({ recipient: mailbox.address, rawMime }, mailbox);
  assert.equal(normalized.headers.messageId, "<malformed-mime@example.test>");
  assert.deepEqual(normalized.attachments, []);
});

test("VM-target mailbox ingest records relay audit only and never enters main connector inbox", async () => {
  const env = await fixture();
  await createTenantVm({
    id: "relay-vm",
    ownerUserId: "relay-owner",
    status: "running",
    capabilities: ["mailboxes"],
  }, env);
  const mailbox = await createMailboxForPrincipal({
    targetType: "vm",
    tenantVmId: "relay-vm",
    purpose: "leads",
    suffix: "in",
    status: "active",
  }, userPrincipal({ id: "relay-owner" }), env);

  const first = await ingestMailboxMessage({
    recipient: mailbox.address,
    headers: { messageId: "<relay@example.test>", from: "lead@example.test", subject: "Sensitive lead" },
    envelope: { mailFrom: "lead@example.test", rcptTo: mailbox.address, sourceIp: "198.51.100.7" },
    body: { text: "full secret body that belongs only on the tenant VM" },
    attachments: [{ filename: "lead.pdf", contentType: "application/pdf", sizeBytes: 1234, quarantined: true }],
  }, env);
  const second = await ingestMailboxMessage({
    recipient: mailbox.address,
    headers: { messageId: "<relay@example.test>", from: "lead@example.test", subject: "Sensitive lead" },
    envelope: { mailFrom: "lead@example.test", rcptTo: mailbox.address, sourceIp: "198.51.100.7" },
    body: { text: "full secret body that belongs only on the tenant VM" },
  }, env);

  assert.equal(first.action, "vm_relay_queued");
  assert.equal(second.action, "deduped");
  assert.deepEqual(await listConnectorInboxEvents({}, env), []);

  const audits = await listMailboxRelayAudits({ tenantVmId: "relay-vm" }, env);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].mailboxId, mailbox.id);
  assert.equal(audits[0].tenantVmId, "relay-vm");
  assert.equal(audits[0].targetSelection.selectedInstanceId, "relay-vm");
  assert.equal(audits[0].targetSelection.selectionSource, "mailbox_record");
  assert.equal(audits[0].attachmentCount, 1);
  assert.equal(Object.hasOwn(audits[0], "payload"), false);
  assert.equal(Object.hasOwn(audits[0], "snippet"), false);
  assert.equal(JSON.stringify(audits[0]).includes("full secret body"), false);
  assert.equal(JSON.stringify(audits[0]).includes("Sensitive lead"), false);
});

test("VM-target mailbox relay dead-letters stale target instead of re-inferring another VM", async () => {
  const env = await fixture();
  await createTenantVm({
    id: "stale-vm",
    ownerUserId: "stale-owner",
    status: "running",
    capabilities: ["mailboxes"],
  }, env);
  const mailbox = await createMailboxForPrincipal({
    targetType: "vm",
    tenantVmId: "stale-vm",
    purpose: "alerts",
    suffix: "stale",
  }, userPrincipal({ id: "stale-owner" }), env);
  await deleteTenantVm("stale-vm", env);
  await createTenantVm({
    id: "replacement-vm",
    ownerUserId: "stale-owner",
    status: "running",
    capabilities: ["mailboxes"],
  }, env);

  const routed = await ingestMailboxMessage({
    recipient: mailbox.address,
    headers: { messageId: "<stale@example.test>", from: "sender@example.test", subject: "Do not reroute" },
    envelope: { mailFrom: "sender@example.test", rcptTo: mailbox.address },
    body: { text: "must not move to replacement-vm" },
  }, env);

  assert.equal(routed.action, "vm_relay_dead_lettered");
  assert.equal(routed.relayAudit.state, "dead-lettered");
  assert.deepEqual(await listConnectorInboxEvents({}, env), []);
  assert.deepEqual(await listMailboxRelayAudits({ tenantVmId: "replacement-vm" }, env), []);
  const deadLetters = await listMailboxDeadLetters({ tenantVmId: "stale-vm" }, env);
  assert.equal(deadLetters.length, 1);
  assert.equal(deadLetters[0].reason, "target_stale");
  assert.equal(deadLetters[0].targetSelection.selectedInstanceId, "");
  assert.equal(JSON.stringify(deadLetters[0]).includes("must not move"), false);
});

test("forwarding verification candidates are extracted without storing full body fields", async () => {
  const env = await fixture();
  const mailbox = await createMailbox({ ownerUserId: "owner", purpose: "verify", suffix: "gmail", status: "verification-pending" }, env);
  const text = "Use forwarding confirmation code 123456789 or visit https://mail-settings.google.com/mail/vf-abc123 to confirm.";

  const candidates = await extractForwardingVerificationCandidates({
    headers: { subject: "Gmail Forwarding Confirmation" },
    body: { text },
  });
  assert.deepEqual(candidates, [
    { type: "code", value: "123456789" },
    { type: "link", href: "https://mail-settings.google.com/mail/vf-abc123" },
  ]);

  await ingestMailboxMessage({
    recipient: mailbox.address,
    headers: { messageId: "<verify@example.test>", subject: "Gmail Forwarding Confirmation", from: "forwarding-noreply@google.com" },
    body: { text },
  }, env);
  const [event] = await listConnectorInboxEvents({}, env);
  assert.equal(event.payload.verificationCandidates.length, 2);
  assert.equal(Object.hasOwn(event.payload, "body"), false);
  assert.equal(Object.hasOwn(event.payload, "raw"), false);
});

test("unknown mailbox recipient is rejected with a generic error", async () => {
  const env = await fixture();

  await assert.rejects(
    () => ingestMailboxMessage({
      recipient: "missing@mail.example.test",
      headers: { messageId: "<missing@example.test>" },
      body: { text: "hello" },
    }, env),
    /mailbox_recipient_rejected/,
  );
});

test("mailbox API exposes admin list and create surface", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-mailboxes-api-"));
  const priorHome = process.env.ORKESTR_HOME;
  const priorAuth = process.env.ORKESTR_AUTH_REQUIRED;
  const priorRecover = process.env.ORKESTR_RECOVER_RUNNING_ON_START;
  const priorDomain = process.env.ORKESTR_MAILBOX_DOMAIN;
  const priorReservedDomain = process.env.ORKESTR_MAILBOX_ALLOW_RESERVED_DOMAIN;
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  process.env.ORKESTR_MAILBOX_DOMAIN = "api.example.test";
  process.env.ORKESTR_MAILBOX_ALLOW_RESERVED_DOMAIN = "1";
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const challenge = await read(await fetch(`${baseUrl}/api/setup/security/challenges`, { method: "POST" }));
    await approvePairingChallenge(challenge.challengeId, { env: process.env, approvedBy: "node:test" });
    const pair = await fetch(`${baseUrl}/api/setup/security/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: challenge.challengeId }),
    });
    const cookie = pair.headers.get("set-cookie") || "";
    assert.equal(pair.status, 200);

    const created = await fetch(`${baseUrl}/api/mailboxes`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ purpose: "ops", suffix: "api", status: "active" }),
    });
    const createdPayload = await created.json();
    assert.equal(created.status, 201);
    assert.equal(createdPayload.mailbox.address, "ops-api@api.example.test");
    assert.equal(createdPayload.mailbox.target.type, "main");

    const listed = await fetch(`${baseUrl}/api/mailboxes`, { headers: { cookie } });
    const listedPayload = await listed.json();
    assert.equal(listed.status, 200);
    assert.deepEqual(listedPayload.mailboxes.map((mailbox) => mailbox.address), ["ops-api@api.example.test"]);
  } finally {
    await closeServer(server);
    restoreEnv("ORKESTR_HOME", priorHome);
    restoreEnv("ORKESTR_AUTH_REQUIRED", priorAuth);
    restoreEnv("ORKESTR_RECOVER_RUNNING_ON_START", priorRecover);
    restoreEnv("ORKESTR_MAILBOX_DOMAIN", priorDomain);
    restoreEnv("ORKESTR_MAILBOX_ALLOW_RESERVED_DOMAIN", priorReservedDomain);
  }
});

test("mailbox CLI create sends explicit target request body", async () => {
  const calls = [];
  let stdout = "";
  let stderr = "";
  const code = await runCli([
    "mailboxes",
    "create",
    "--purpose",
    "leads",
    "--target",
    "vm",
    "--tenant-vm-id",
    "tenant-one",
    "--suffix",
    "in",
    "--json",
  ], {
    baseUrl: "http://orkestr.test",
    env: { ORKESTR_DISABLE_CLI_AUTH: "1" },
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } },
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({
        ok: true,
        mailbox: {
          id: "mbx-tenant-one-leads-in",
          address: "tenant-one-leads-in@mail.example.test",
          ownerUserId: "admin",
          status: "pending",
          target: { type: "vm", tenantVmId: "tenant-one", ownerUserId: "admin" },
          targetSelection: { selectionSource: "explicit_request", ambiguityResult: "explicit_match" },
        },
      }), { status: 201, headers: { "content-type": "application/json" } });
    },
  });

  assert.equal(code, 0);
  assert.equal(stderr, "");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://orkestr.test/api/mailboxes");
  assert.equal(calls[0].options.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    purpose: "leads",
    suffix: "in",
    targetType: "vm",
    tenantVmId: "tenant-one",
  });
  assert.equal(JSON.parse(stdout).mailbox.target.tenantVmId, "tenant-one");
});
