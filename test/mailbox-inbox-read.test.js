import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { ingestMailboxMessage } from "../packages/connectors/src/mailbox-inbox.js";
import { createMailbox, listMailboxInboxMessages } from "../packages/core/src/mailboxes.js";
import { adminPrincipal, userPrincipal } from "../packages/core/src/principal.js";
import { approvePairingChallenge } from "../packages/core/src/security.js";
import { mutateThreadResourcePolicy, readThreadResourcePolicy, registerThreadResource, setThreadResourceGrants } from "../packages/core/src/thread-resource-grants.js";
import { createThread, listThreadMessages } from "../packages/core/src/threads.js";

async function fixture(label, { ownerUserId = "owner", mode = "enforce" } = {}) {
  const env = {
    ORKESTR_HOME: await fs.mkdtemp(path.join(os.tmpdir(), `orkestr-mailbox-inbox-${label}-`)),
    ORKESTR_ADMIN_USER_ID: "admin",
    ORKESTR_MAILBOX_DOMAIN: "mail.example.test",
    ORKESTR_MAILBOX_ACCESS_MODE: mode,
  };
  const admin = adminPrincipal("admin");
  const owner = userPrincipal({ id: ownerUserId });
  const thread = await createThread({ id: `${label}-thread`, ownerUserId, name: "Managed inbox context" }, env);
  const mailbox = await createMailbox({ ownerUserId, purpose: label, suffix: "inbox", status: "active" }, env);
  await registerThreadResource({ resourceType: "mailbox", resourceId: mailbox.id, ownerUserId, status: "active" }, { principal: admin }, env);
  await setThreadResourceGrants(thread.id, "mailbox", [{ resourceId: mailbox.id, permissions: ["read"] }], { principal: admin }, env);
  return { env, admin, owner, thread, mailbox };
}

function inbound(mailbox, messageId, body, subject = "Forwarding confirmation") {
  return {
    recipient: mailbox.address,
    headers: { messageId, from: "mail-service@example.test", subject },
    envelope: { rcptTo: mailbox.address, mailFrom: "mail-service@example.test" },
    body: { text: body },
  };
}

async function ingest(scope, messageId, body, subject) {
  return ingestMailboxMessage(inbound(scope.mailbox, messageId, body, subject), scope.env);
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

test("managed mailbox inbox reads a retained forwarding code without thread delivery or mailbox-address leakage", async () => {
  const scope = await fixture("forwarding-code");
  await ingest(scope, "<forward-code@example.test>", "Your forwarding confirmation code is 246810.");
  const beforeMessages = await listThreadMessages(scope.thread.id, scope.env);
  const beforePolicy = await readThreadResourcePolicy(scope.env);

  const result = await listMailboxInboxMessages({ mailbox: scope.mailbox, threadId: scope.thread.id, principal: scope.owner }, scope.env);

  assert.equal(result.mode, "enforce");
  assert.equal(result.messages.length, 1);
  assert.match(result.messages[0].body, /246810/);
  assert.doesNotMatch(result.messages[0].body, new RegExp(scope.mailbox.address.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.deepEqual(await listThreadMessages(scope.thread.id, scope.env), beforeMessages);
  const afterPolicy = await readThreadResourcePolicy(scope.env);
  assert.equal(afterPolicy.mailboxRouteWork.length, beforePolicy.mailboxRouteWork.length);
  assert.equal(afterPolicy.mailboxContexts.length, beforePolicy.mailboxContexts.length);
  const audit = afterPolicy.policyAuditOutbox.find((item) => item.action === "mailbox_inbox_read");
  assert.equal(audit?.outcome, "allowed");
  assert.equal(JSON.stringify(audit).includes("246810"), false);
  assert.equal(JSON.stringify(audit).includes(scope.mailbox.address), false);
});

test("managed mailbox inbox requires the exact owner, thread, and read grant", async () => {
  const scope = await fixture("exact-access");
  await ingest(scope, "<exact-access@example.test>", "Code 654321");
  const wrongThread = await createThread({ id: "exact-access-wrong-thread", ownerUserId: "owner", name: "No grant" }, scope.env);

  await assert.rejects(
    () => listMailboxInboxMessages({ mailbox: scope.mailbox, principal: scope.owner }, scope.env),
    /mailbox_inbox_thread_required/,
  );
  await assert.rejects(
    () => listMailboxInboxMessages({ mailbox: scope.mailbox, threadId: wrongThread.id, principal: scope.owner }, scope.env),
    /mailbox_inbox_read_grant_required/,
  );
  await assert.rejects(
    () => listMailboxInboxMessages({ mailbox: scope.mailbox, threadId: scope.thread.id, principal: userPrincipal({ id: "other-user" }) }, scope.env),
    /mailbox_thread_owner_denied/,
  );
  await setThreadResourceGrants(scope.thread.id, "mailbox", [], { principal: scope.admin }, scope.env);
  await assert.rejects(
    () => listMailboxInboxMessages({ mailbox: scope.mailbox, threadId: scope.thread.id, principal: scope.owner }, scope.env),
    /mailbox_inbox_read_grant_required/,
  );
});

test("admin mailbox inbox access is still bound to an exact managed thread grant", async () => {
  const scope = await fixture("admin-managed", { ownerUserId: "admin" });
  await ingest(scope, "<admin-managed@example.test>", "Code 112233");
  await setThreadResourceGrants(scope.thread.id, "mailbox", [], { principal: scope.admin }, scope.env);
  await assert.rejects(
    () => listMailboxInboxMessages({ mailbox: scope.mailbox, threadId: scope.thread.id, principal: scope.admin }, scope.env),
    /mailbox_inbox_read_grant_required/,
  );
  await setThreadResourceGrants(scope.thread.id, "mailbox", [{ resourceId: scope.mailbox.id, permissions: ["read"] }], { principal: scope.admin }, scope.env);
  const result = await listMailboxInboxMessages({ mailbox: scope.mailbox, threadId: scope.thread.id, principal: scope.admin }, scope.env);
  assert.match(result.messages[0].body, /112233/);
});

test("managed mailbox inbox pagination is stable across deduplicated concurrent ingress", async () => {
  const scope = await fixture("paging");
  await Promise.all([
    ingest(scope, "<paging-1@example.test>", "Code 111111", "First"),
    ingest(scope, "<paging-1@example.test>", "Code 111111", "First"),
  ]);
  await ingest(scope, "<paging-2@example.test>", "Code 222222", "Second");
  await ingest(scope, "<paging-3@example.test>", "Code 333333", "Third");

  const first = await listMailboxInboxMessages({ mailbox: scope.mailbox, threadId: scope.thread.id, principal: scope.owner, limit: 2 }, scope.env);
  const second = await listMailboxInboxMessages({ mailbox: scope.mailbox, threadId: scope.thread.id, principal: scope.owner, cursor: first.nextCursor, limit: 2 }, scope.env);
  const ids = [...first.messages, ...second.messages].map((message) => message.messageId).sort();
  assert.deepEqual(ids, ["<paging-1@example.test>", "<paging-2@example.test>", "<paging-3@example.test>"]);
  assert.equal(new Set(ids).size, 3);
  assert.equal(second.nextCursor, null);
  await assert.rejects(
    () => listMailboxInboxMessages({ mailbox: scope.mailbox, threadId: scope.thread.id, principal: scope.owner, cursor: "not-a-cursor" }, scope.env),
    /mailbox_inbox_cursor_invalid/,
  );
});

test("managed mailbox inbox uses a 25-message default when HTTP supplies an empty limit", async () => {
  const scope = await fixture("default-limit");
  await ingest(scope, "<default-limit-1@example.test>", "First body", "First");
  await ingest(scope, "<default-limit-2@example.test>", "Second body", "Second");

  const result = await listMailboxInboxMessages({
    mailbox: scope.mailbox,
    threadId: scope.thread.id,
    principal: scope.owner,
    limit: "",
  }, scope.env);

  assert.equal(result.limit, 25);
  assert.deepEqual(result.messages.map((message) => message.subject), ["Second", "First"]);
});

test("managed mailbox inbox retains messages for the configured 90-day window", async () => {
  const scope = await fixture("retention-window");
  scope.env.ORKESTR_MAILBOX_MESSAGE_RETENTION_DAYS = "90";
  await ingest(scope, "<retention-old@example.test>", "Expired body", "Expired");
  await mutateThreadResourcePolicy((state) => {
    const source = state.mailboxSources.find((item) => item.payload?.messageId === "<retention-old@example.test>");
    source.createdAt = new Date(Date.now() - 91 * 24 * 60 * 60 * 1_000).toISOString();
    source.updatedAt = source.createdAt;
    return { changed: true, skipPolicyEpoch: true };
  }, scope.env);
  await ingest(scope, "<retention-current@example.test>", "Current body", "Current");

  const result = await listMailboxInboxMessages({ mailbox: scope.mailbox, threadId: scope.thread.id, principal: scope.owner }, scope.env);

  assert.deepEqual(result.messages.map((message) => message.subject), ["Current"]);
  const state = await readThreadResourcePolicy(scope.env);
  assert.equal(state.mailboxSources.some((source) => source.payload?.messageId === "<retention-old@example.test>"), false);
});

test("managed mailbox inbox fails closed on a revision race and redacts shadow/off modes", async () => {
  const scope = await fixture("modes");
  await ingest(scope, "<modes@example.test>", "Code 445566");
  await assert.rejects(
    () => listMailboxInboxMessages({ mailbox: scope.mailbox, threadId: scope.thread.id, principal: scope.owner }, scope.env, {
      beforeRead: () => mutateThreadResourcePolicy(() => ({ changed: true }), scope.env),
    }),
    /mailbox_inbox_authorization_stale/,
  );

  const shadowEnv = { ...scope.env, ORKESTR_MAILBOX_ACCESS_MODE: "shadow" };
  const shadow = await listMailboxInboxMessages({ mailbox: scope.mailbox, threadId: scope.thread.id, principal: scope.owner }, shadowEnv);
  assert.equal(shadow.shadowDenied, true);
  assert.deepEqual(shadow.messages, []);
  await assert.rejects(
    () => listMailboxInboxMessages({ mailbox: scope.mailbox, threadId: scope.thread.id, principal: scope.owner }, { ...scope.env, ORKESTR_MAILBOX_ACCESS_MODE: "off" }),
    /mailbox_inbox_policy_mode_required/,
  );
});

test("managed mailbox inbox HTTP projection requires thread context and never delivers into it", async () => {
  const scope = await fixture("http-projection", { ownerUserId: "admin" });
  await ingest(scope, "<http-projection@example.test>", "Forwarding code 778899");
  const previous = Object.fromEntries(["ORKESTR_HOME", "ORKESTR_ADMIN_USER_ID", "ORKESTR_MAILBOX_DOMAIN", "ORKESTR_MAILBOX_ACCESS_MODE", "ORKESTR_AUTH_REQUIRED", "ORKESTR_RECOVER_RUNNING_ON_START", "ORKESTR_RELEASE_DEPLOY", "ORKESTR_MAILBOX_REQUIRE_MTA_READY"].map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    ORKESTR_HOME: scope.env.ORKESTR_HOME,
    ORKESTR_ADMIN_USER_ID: "admin",
    ORKESTR_MAILBOX_DOMAIN: scope.env.ORKESTR_MAILBOX_DOMAIN,
    ORKESTR_MAILBOX_ACCESS_MODE: "enforce",
    ORKESTR_AUTH_REQUIRED: "1",
    ORKESTR_RECOVER_RUNNING_ON_START: "0",
    ORKESTR_RELEASE_DEPLOY: "0",
    ORKESTR_MAILBOX_REQUIRE_MTA_READY: "0",
  });
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const challenge = await (await fetch(`${baseUrl}/api/setup/security/challenges`, { method: "POST" })).json();
    await approvePairingChallenge(challenge.challengeId, { env: process.env, approvedBy: "node:test" });
    const pair = await fetch(`${baseUrl}/api/setup/security/pair`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challengeId: challenge.challengeId }),
    });
    const cookie = pair.headers.get("set-cookie") || "";
    const missingThread = await fetch(`${baseUrl}/api/mailboxes/${scope.mailbox.id}/messages`, { headers: { cookie } });
    assert.equal(missingThread.status, 400);
    assert.equal((await missingThread.json()).error, "mailbox_inbox_thread_required");

    const response = await fetch(`${baseUrl}/api/mailboxes/${scope.mailbox.id}/messages?threadId=${scope.thread.id}`, { headers: { cookie } });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.messages.length, 1);
    assert.match(payload.messages[0].body, /778899/);
    assert.equal(JSON.stringify(payload).includes(scope.mailbox.address), false);
    assert.deepEqual(await listThreadMessages(scope.thread.id, scope.env), []);
  } finally {
    await closeServer(server);
    for (const [key, value] of Object.entries(previous)) restoreEnv(key, value);
  }
});
