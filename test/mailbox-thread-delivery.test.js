import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { ingestMailboxMessage } from "../packages/connectors/src/mailbox-inbox.js";
import { runMailboxDeliveryPump } from "../packages/connectors/src/mailbox-delivery-pump.js";
import { listConnectorInboxEvents, markConnectorInboxEvent, resetConnectorInboxForTest } from "../packages/connectors/src/connector-inbox.js";
import {
  createMailbox,
  createMailboxThreadListener,
  dispatchMailboxThreadDeliveries,
  enqueueMailboxThreadDeliveries,
  listMailboxThreadListeners,
  mailboxThreadDeliveryStatus,
  revokeMailboxThreadListener,
  routeMailboxMessage,
} from "../packages/core/src/mailboxes.js";
import { adminPrincipal } from "../packages/core/src/principal.js";
import { approvePairingChallenge } from "../packages/core/src/security.js";
import { registerThreadResource, setThreadResourceGrants } from "../packages/core/src/thread-resource-grants.js";
import { readThreadResourcePolicyState, withThreadResourcePolicyTransaction } from "../packages/core/src/thread-resource-policy-store.js";
import { listThreadMessages, createThread } from "../packages/core/src/threads.js";
import { listEvents } from "../packages/storage/src/store.js";

async function fixture(extraEnv = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-mailbox-thread-delivery-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_ADMIN_USER_ID: "admin",
    ORKESTR_MAILBOX_DOMAIN: "mail.example.test",
    ORKESTR_MAILBOX_ACCESS_MODE: "enforce",
    ...extraEnv,
  };
  const principal = adminPrincipal("admin");
  const thread = await createThread({ id: "delivery-thread", ownerUserId: "admin", name: "Delivery" }, env);
  const mailbox = await createMailbox({ ownerUserId: "admin", purpose: "alerts", suffix: "listener", status: "active" }, env);
  return { env, principal, thread, mailbox };
}

async function grantListenerAccess({ env, principal, thread, mailbox }) {
  await registerThreadResource({ resourceType: "mailbox", resourceId: mailbox.id, ownerUserId: "admin", status: "active" }, { principal }, env);
  return setThreadResourceGrants(thread.id, "mailbox", [{ resourceId: mailbox.id, permissions: ["read", "subscribe", "manage"] }], { principal }, env);
}

function inbound(mailbox, messageId, extra = {}) {
  return {
    recipient: mailbox.address,
    headers: { messageId, from: "builds@example.test", subject: "Build failed" },
    envelope: { rcptTo: mailbox.address, mailFrom: "builds@example.test" },
    body: { text: "Build 42 failed." },
    ...extra,
  };
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function read(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

test.afterEach(() => resetConnectorInboxForTest());

test("mailbox listeners require exact registered subscribe/read/manage grants and reject legacy permissions", async () => {
  const scope = await fixture();
  await assert.rejects(
    () => createMailboxThreadListener({ mailbox: scope.mailbox, threadId: scope.thread.id, principal: scope.principal }, scope.env),
    /mailbox_resource_not_registered/,
  );
  await grantListenerAccess(scope);
  await assert.rejects(
    () => setThreadResourceGrants(scope.thread.id, "mailbox", [{ resourceId: scope.mailbox.id, permissions: ["route"] }], { principal: scope.principal }, scope.env),
    /thread_resource_permissions_invalid/,
  );
  await assert.rejects(
    () => setThreadResourceGrants(scope.thread.id, "mailbox", [{ resourceId: scope.mailbox.id, permissions: ["*"] }], { principal: scope.principal }, scope.env),
    /thread_resource_permissions_invalid/,
  );
  const created = await createMailboxThreadListener({ mailbox: scope.mailbox, threadId: scope.thread.id, filter: { fromIncludes: "builds@example.test" }, principal: scope.principal }, scope.env);
  assert.equal(created.listener.status, "active");
  assert.equal(created.listener.generation, 1);
  const listed = await listMailboxThreadListeners({ mailbox: scope.mailbox, threadId: scope.thread.id, principal: scope.principal }, scope.env);
  assert.equal(listed.length, 1);
  await assert.rejects(
    () => createMailboxThreadListener({ mailbox: scope.mailbox, threadId: scope.thread.id, filter: { wildcard: "*" }, principal: scope.principal }, scope.env),
    /mailbox_listener_filter_invalid/,
  );
});

test("enabled main mailbox ingress dedupes once and appends only to exact matching listener threads", async () => {
  const scope = await fixture();
  await grantListenerAccess(scope);
  await createMailboxThreadListener({ mailbox: scope.mailbox, threadId: scope.thread.id, filter: { subjectIncludes: "build" }, principal: scope.principal }, scope.env);

  const first = await ingestMailboxMessage(inbound(scope.mailbox, "<mailbox-thread-1@example.test>"), scope.env);
  const second = await ingestMailboxMessage(inbound(scope.mailbox, "<mailbox-thread-1@example.test>"), scope.env);
  assert.equal(first.action, "mailbox_thread_delivery_queued");
  assert.equal(first.dispatch.delivered, 1);
  assert.equal(second.action, "deduped");
  const messages = await listThreadMessages(scope.thread.id, scope.env);
  assert.equal(messages.filter((message) => message.source === "mailbox").length, 1);
  const inboxEvents = await listConnectorInboxEvents({}, scope.env);
  assert.equal(inboxEvents.length, 1);
  assert.equal(inboxEvents[0].state, "routed");
  const status = await mailboxThreadDeliveryStatus({ mailbox: scope.mailbox }, scope.env);
  assert.equal(status.listenerCount, 1);
  assert.equal(status.pending, 0);
  assert.equal(status.unrouted, 0);
});

test("shadow mailbox mode keeps legacy connector inbox ingress and only audits the unified would-deny", async () => {
  const scope = await fixture();
  await grantListenerAccess(scope);
  await createMailboxThreadListener({ mailbox: scope.mailbox, threadId: scope.thread.id, principal: scope.principal }, scope.env);
  await setThreadResourceGrants(scope.thread.id, "mailbox", [], { principal: scope.principal }, scope.env);
  scope.env.ORKESTR_MAILBOX_ACCESS_MODE = "shadow";

  const rawMessageId = "<mailbox-thread-shadow@example.test>";
  const result = await ingestMailboxMessage(inbound(scope.mailbox, rawMessageId), scope.env);

  assert.equal(result.action, "connector_inbox_queued");
  assert.equal(result.shadowEvaluation?.wouldAllow, false);
  assert.equal(result.shadowEvaluation?.reason, "mailbox_no_authorized_listener");
  const inboxEvents = await listConnectorInboxEvents({}, scope.env);
  assert.equal(inboxEvents.length, 1);
  assert.equal(inboxEvents[0].state, "pending");
  assert.equal((await listThreadMessages(scope.thread.id, scope.env)).length, 0);
  assert.equal((await readThreadResourcePolicyState(scope.env)).mailboxDeliveries.length, 0);
  const events = await listEvents(scope.env, 40);
  const evaluation = events.find((event) => event.type === "mailbox_thread_delivery_shadow_evaluated");
  assert.equal(evaluation?.outcome, "would_deny");
  assert.equal(evaluation?.mismatch, true);
  assert.equal(Object.hasOwn(evaluation || {}, "threadId"), false);
  assert.equal(Object.hasOwn(evaluation || {}, "text"), false);
  assert.match(evaluation?.idempotencyKeyHash || "", /^[a-f0-9]{24}$/);
  assert.equal(Object.hasOwn(evaluation || {}, "idempotencyKey"), false);
  assert.equal(JSON.stringify(evaluation).includes(rawMessageId), false);
  assert.equal(events.some((event) => event.type === "thread_resource_access_shadow_denied" && event.resourceType === "mailbox"), true);
});

test("the mailbox delivery pump is a no-op without opening policy storage when access mode is off", async () => {
  const scope = await fixture({
    ORKESTR_MAILBOX_ACCESS_MODE: "off",
    ORKESTR_THREAD_RESOURCE_POLICY_STORE: "json",
  });

  const pumped = await runMailboxDeliveryPump(scope.env);

  assert.deepEqual(pumped, { ok: true, skipped: "access_mode_off", deliveries: null, replay: null });
  await assert.rejects(fs.stat(path.join(scope.env.ORKESTR_HOME, "thread-resource-policy.sqlite")), /ENOENT/);
});

test("nonmatching or unregistered enabled mailboxes enter durable unrouted quarantine without inbox fallback", async () => {
  const scope = await fixture();
  await grantListenerAccess(scope);
  await createMailboxThreadListener({ mailbox: scope.mailbox, threadId: scope.thread.id, filter: { subjectIncludes: "only-this" }, principal: scope.principal }, scope.env);
  const unrouted = await ingestMailboxMessage(inbound(scope.mailbox, "<mailbox-thread-unrouted@example.test>"), scope.env);
  assert.equal(unrouted.action, "mailbox_thread_delivery_unrouted");
  assert.equal((await listThreadMessages(scope.thread.id, scope.env)).length, 0);
  assert.equal((await listConnectorInboxEvents({}, scope.env)).length, 1);
  assert.equal((await mailboxThreadDeliveryStatus({ mailbox: scope.mailbox }, scope.env)).unrouted, 1);
});

test("listener revoke advances generation and invalidates a queued delivery before thread append", async () => {
  const scope = await fixture();
  await grantListenerAccess(scope);
  const listener = await createMailboxThreadListener({ mailbox: scope.mailbox, threadId: scope.thread.id, principal: scope.principal }, scope.env);
  const routed = await routeMailboxMessage(inbound(scope.mailbox, "<mailbox-thread-revoke@example.test>"), scope.env);
  assert.equal(routed.action, "mailbox_thread_delivery_required");
  const queued = await enqueueMailboxThreadDeliveries(routed.mailboxDeliveryInput, scope.env);
  const revoked = await revokeMailboxThreadListener({ mailbox: scope.mailbox, listenerId: listener.listener.id, principal: scope.principal }, scope.env);
  assert.equal(revoked.listener.status, "revoked");
  assert.equal(revoked.listener.generation, 2);
  const dispatched = await dispatchMailboxThreadDeliveries({ deliveryIds: queued.deliveryIds }, scope.env);
  assert.equal(dispatched.delivered, 0);
  assert.equal((await listThreadMessages(scope.thread.id, scope.env)).length, 0);
  const state = await readThreadResourcePolicyState(scope.env);
  assert.equal(state.mailboxDeliveries[0].state, "revoked");
});

test("expired claims are recovered transactionally and retried with the same exact delivery id", async () => {
  const scope = await fixture();
  await grantListenerAccess(scope);
  await createMailboxThreadListener({ mailbox: scope.mailbox, threadId: scope.thread.id, principal: scope.principal }, scope.env);
  const routed = await routeMailboxMessage(inbound(scope.mailbox, "<mailbox-thread-lease@example.test>"), scope.env);
  const queued = await enqueueMailboxThreadDeliveries(routed.mailboxDeliveryInput, scope.env);
  await withThreadResourcePolicyTransaction((state) => {
    const delivery = state.mailboxDeliveries.find((item) => item.id === queued.deliveryIds[0]);
    delivery.state = "claimed";
    delivery.claimToken = "stale-claim";
    delivery.claimExpiresAt = new Date(Date.now() - 1_000).toISOString();
    delivery.attemptCount = 1;
    return { state };
  }, scope.env);
  const pumped = await runMailboxDeliveryPump(scope.env);
  assert.equal(pumped.deliveries.delivered, 1);
  const state = await readThreadResourcePolicyState(scope.env);
  assert.equal(state.mailboxDeliveries[0].state, "delivered");
  assert.equal(state.mailboxDeliveries[0].attemptCount, 2);
  assert.equal(state.mailboxDeliveries[0].epoch, 4);
});

test("a bounded single-run pump retries a transient append failure without another inbound email", async () => {
  const scope = await fixture();
  await grantListenerAccess(scope);
  await createMailboxThreadListener({ mailbox: scope.mailbox, threadId: scope.thread.id, principal: scope.principal }, scope.env);
  const routed = await routeMailboxMessage(inbound(scope.mailbox, "<mailbox-thread-transient@example.test>"), scope.env);
  const queued = await enqueueMailboxThreadDeliveries(routed.mailboxDeliveryInput, scope.env);
  const failed = await dispatchMailboxThreadDeliveries({
    deliveryIds: queued.deliveryIds,
    appendMessage: async () => { throw new Error("transient_append_failure"); },
  }, scope.env);
  assert.equal(failed.results[0].state, "pending");
  await withThreadResourcePolicyTransaction((state) => {
    const delivery = state.mailboxDeliveries.find((item) => item.id === queued.deliveryIds[0]);
    delivery.nextAttemptAt = new Date(Date.now() - 1_000).toISOString();
    return { state };
  }, scope.env);
  const first = runMailboxDeliveryPump(scope.env);
  const second = runMailboxDeliveryPump(scope.env);
  const [pumped, concurrent] = await Promise.all([first, second]);
  assert.equal(pumped.deliveries.delivered, 1);
  assert.equal(concurrent.skipped, "in_process");
  assert.equal((await listThreadMessages(scope.thread.id, scope.env)).filter((message) => message.source === "mailbox").length, 1);
});

test("bounded expired claims enter durable dead-letter state and status reports them", async () => {
  const scope = await fixture();
  await grantListenerAccess(scope);
  await createMailboxThreadListener({ mailbox: scope.mailbox, threadId: scope.thread.id, principal: scope.principal }, scope.env);
  const routed = await routeMailboxMessage(inbound(scope.mailbox, "<mailbox-thread-dlq@example.test>"), scope.env);
  const queued = await enqueueMailboxThreadDeliveries(routed.mailboxDeliveryInput, scope.env);
  await withThreadResourcePolicyTransaction((state) => {
    const delivery = state.mailboxDeliveries.find((item) => item.id === queued.deliveryIds[0]);
    delivery.state = "claimed";
    delivery.claimToken = "expired-final-claim";
    delivery.claimExpiresAt = new Date(Date.now() - 1_000).toISOString();
    delivery.attemptCount = delivery.maxAttempts;
    return { state };
  }, scope.env);
  await dispatchMailboxThreadDeliveries({ deliveryIds: queued.deliveryIds }, scope.env);
  const state = await readThreadResourcePolicyState(scope.env);
  assert.equal(state.mailboxDeliveries[0].state, "dead-letter");
  assert.equal((await mailboxThreadDeliveryStatus({ mailbox: scope.mailbox }, scope.env)).deadLetter, 1);
});

test("mailbox listener HTTP APIs expose create, list, status, and revoke", async () => {
  const scope = await fixture();
  await grantListenerAccess(scope);
  const prior = Object.fromEntries(["ORKESTR_HOME", "ORKESTR_ADMIN_USER_ID", "ORKESTR_MAILBOX_DOMAIN", "ORKESTR_MAILBOX_ACCESS_MODE", "ORKESTR_AUTH_REQUIRED", "ORKESTR_RECOVER_RUNNING_ON_START", "ORKESTR_RELEASE_DEPLOY", "ORKESTR_MAILBOX_REQUIRE_MTA_READY"].map((key) => [key, process.env[key]]));
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
    const challenge = await read(await fetch(`${baseUrl}/api/setup/security/challenges`, { method: "POST" }));
    await approvePairingChallenge(challenge.challengeId, { env: process.env, approvedBy: "node:test" });
    const pair = await fetch(`${baseUrl}/api/setup/security/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ challengeId: challenge.challengeId }) });
    const cookie = pair.headers.get("set-cookie") || "";
    const created = await fetch(`${baseUrl}/api/mailboxes/${scope.mailbox.id}/listeners`, {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ threadId: scope.thread.id, filter: { fromIncludes: "builds@example.test" }, idempotencyKey: "listener-http-create" }),
    });
    const listener = await read(created);
    assert.equal(created.status, 201);
    const listed = await fetch(`${baseUrl}/api/mailboxes/${scope.mailbox.id}/listeners?threadId=${scope.thread.id}`, { headers: { cookie } });
    assert.equal((await read(listed)).listeners.length, 1);
    const status = await fetch(`${baseUrl}/api/mailboxes/${scope.mailbox.id}/delivery-status`, { headers: { cookie } });
    assert.equal((await read(status)).status.listenerCount, 1);
    const revoked = await fetch(`${baseUrl}/api/mailboxes/${scope.mailbox.id}/listeners/${listener.listener.id}`, { method: "DELETE", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ reason: "test" }) });
    assert.equal(revoked.status, 200);
  } finally {
    await closeServer(server);
    for (const [key, value] of Object.entries(prior)) restoreEnv(key, value);
  }
});

test("a policy-store outage spools without thread delivery and replays exactly once after recovery", async () => {
  const scope = await fixture();
  await grantListenerAccess(scope);
  await createMailboxThreadListener({ mailbox: scope.mailbox, threadId: scope.thread.id, principal: scope.principal }, scope.env);
  const unavailable = { ...scope.env, ORKESTR_THREAD_RESOURCE_POLICY_STORE: "json" };
  const result = await ingestMailboxMessage(inbound(scope.mailbox, "<mailbox-thread-outage@example.test>"), unavailable);
  assert.equal(result.action, "mailbox_policy_unavailable_spooled");
  assert.equal((await listConnectorInboxEvents({}, unavailable)).length, 1);
  assert.equal((await listThreadMessages(scope.thread.id, unavailable)).length, 0);
  const [spooled] = await listConnectorInboxEvents({ states: ["policy-unavailable"] }, scope.env);
  await markConnectorInboxEvent(spooled.id, { nextAttemptAt: new Date(Date.now() - 1_000).toISOString() }, scope.env);
  const replayed = await runMailboxDeliveryPump(scope.env);
  assert.equal(replayed.replay.results[0].state, "routed");
  assert.equal((await listThreadMessages(scope.thread.id, scope.env)).filter((message) => message.source === "mailbox").length, 1);
  const duplicate = await runMailboxDeliveryPump(scope.env);
  assert.equal(duplicate.replay.attempted, 0);
  assert.equal((await listThreadMessages(scope.thread.id, scope.env)).filter((message) => message.source === "mailbox").length, 1);
});
