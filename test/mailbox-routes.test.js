import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ingestMailboxMessage } from "../packages/connectors/src/mailbox-inbox.js";
import { resetConnectorInboxForTest } from "../packages/connectors/src/connector-inbox.js";
import { createMailbox, createMailboxThreadListener, revokeMailboxThreadListener } from "../packages/core/src/mailboxes.js";
import { readThreadResourcePolicyState } from "../packages/core/src/thread-resource-policy-store.js";
import { createMailboxRoute, dispatchMailboxRouteWork, enqueueMailboxRouteSource, mailboxRouteStatus, moveMailboxRoute, reconcileMailboxRouteWorkRuntime, recordMailboxRouteWorkRuntime, reserveMailboxContextsForHumanTurn, revokeMailboxRoute } from "../packages/core/src/mailbox-routes.js";
import { appendThreadMessage, createThread, enqueueThreadInputForPrincipal, getThread, listThreadMessages, updateThread } from "../packages/core/src/threads.js";
import { adminPrincipal } from "../packages/core/src/principal.js";
import { approvePairingChallenge } from "../packages/core/src/security.js";
import { mutateThreadResourcePolicy, registerThreadResource, setThreadResourceGrants } from "../packages/core/src/thread-resource-grants.js";
import { turnStartParams } from "../packages/core/src/codex-app-server-common.js";

async function fixture(label, permissions = ["read", "subscribe", "manage"]) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), `orkestr-mailbox-route-${label}-`));
  const env = { ORKESTR_HOME: home, ORKESTR_MAILBOX_DOMAIN: "mail.example.test", ORKESTR_MAILBOX_ACCESS_MODE: "enforce" };
  const principal = adminPrincipal();
  const thread = await createThread({ id: `${label}-thread`, ownerUserId: "admin", name: "Route destination" }, env);
  const mailbox = await createMailbox({ ownerUserId: "admin", purpose: label, suffix: "inbox", status: "active" }, env);
  await registerThreadResource({ resourceType: "mailbox", resourceId: mailbox.id, ownerUserId: "admin", status: "active" }, { principal }, env);
  await setThreadResourceGrants(thread.id, "mailbox", [{ resourceId: mailbox.id, permissions }], { principal }, env);
  return { env, principal, thread, mailbox };
}

function inbound(mailbox, messageId, text = "Build 42 failed") {
  return {
    recipient: mailbox.address,
    headers: { messageId, from: "builds@example.test", subject: "Build failed" },
    envelope: { rcptTo: mailbox.address, mailFrom: "builds@example.test" },
    body: { text },
  };
}

async function createApprovedRoute(input, env, operations) {
  const pending = await createMailboxRoute(input, env, operations);
  if (pending.status !== "approval_required") return pending;
  assert.equal(pending.challenge.authIntent.mailboxRouteAction, "create_process_immediately");
  await approvePairingChallenge(pending.challenge.id, { env, approvedBy: "node:test" });
  return createMailboxRoute({ ...input, approval: pending.challenge.approveCode }, env, operations);
}

test.afterEach(() => resetConnectorInboxForTest());

test("an active route is singleton, exact, and keeps append-only route delivery separate from the source", async () => {
  const scope = await fixture("append");
  const route = await createMailboxRoute({ mailbox: scope.mailbox, threadId: scope.thread.id, mode: "append_only", principal: scope.principal }, scope.env);
  assert.equal(route.route.mode, "append_only");
  const ungranted = await createThread({ id: "append-ungranted", ownerUserId: "admin", name: "No mailbox grant" }, scope.env);
  await assert.rejects(
    () => createMailboxRoute({ mailbox: scope.mailbox, threadId: ungranted.id, mode: "append_only", principal: scope.principal }, scope.env),
    /mailbox_route_subscribe_grant_required/,
  );
  const routed = await ingestMailboxMessage(inbound(scope.mailbox, "<append-route@example.test>"), scope.env);
  assert.equal(routed.routeDispatch.delivered, 1);
  const messages = await listThreadMessages(scope.thread.id, scope.env);
  assert.equal(messages.filter((message) => message.source === "mailbox_route").length, 1);
  const state = await readThreadResourcePolicyState(scope.env);
  assert.equal(state.mailboxSources.length, 1);
  assert.equal(state.mailboxRouteWork[0].state, "delivered");
  assert.equal(state.mailboxSources[0].payload.attachments.length, 0);
});

test("an admin can provision a new destination with only the exact route grant", async () => {
  const scope = await fixture("new-thread");
  const created = await createApprovedRoute({ mailbox: scope.mailbox, newThread: { name: "New mailbox route" }, mode: "process_immediately", principal: scope.principal }, scope.env);
  assert.equal(created.route.mode, "process_immediately");
  const thread = await getThread(created.route.threadId, scope.env);
  assert.equal(thread.mailboxRouteProvisioning?.status, "ready");
  const state = await readThreadResourcePolicyState(scope.env);
  const grant = state.grants.find((item) => item.threadId === created.route.threadId && item.resourceId.endsWith(scope.mailbox.id) && !item.revokedAt);
  assert.deepEqual([...grant.permissions].sort(), ["manage", "process", "read", "subscribe"]);
});

test("route provisioning compensates a fault-injected grant failure without an orphan thread or grant", async () => {
  const scope = await fixture("new-thread-cleanup");
  const freshId = "provisioning-failure-thread";
  await assert.rejects(
    () => createMailboxRoute({ mailbox: scope.mailbox, newThread: { id: freshId, name: "Fresh route destination" }, principal: scope.principal }, scope.env, {
      setThreadResourceGrants: async () => { throw new Error("injected_grant_write_failure"); },
    }),
    /injected_grant_write_failure/,
  );
  assert.equal(await getThread(freshId, scope.env), null);
  const state = await readThreadResourcePolicyState(scope.env);
  assert.equal(state.grants.some((grant) => grant.threadId === freshId && !grant.revokedAt), false);
  assert.equal(state.mailboxRoutes.length, 0);
});

test("route provisioning compensates its fresh thread when a concurrent route wins", async () => {
  const scope = await fixture("new-thread-concurrent");
  const freshId = "provisioning-concurrent-thread";
  let competingRouteCreated = false;
  await assert.rejects(
    () => createMailboxRoute({ mailbox: scope.mailbox, newThread: { id: freshId, name: "Concurrent route destination" }, principal: scope.principal }, scope.env, {
      setThreadResourceGrants: async (...args) => {
        const result = await setThreadResourceGrants(...args);
        if (!competingRouteCreated) {
          competingRouteCreated = true;
          await createMailboxRoute({ mailbox: scope.mailbox, threadId: scope.thread.id, mode: "append_only", principal: scope.principal }, scope.env);
        }
        return result;
      },
    }),
    /mailbox_route_active_exists/,
  );
  assert.equal(competingRouteCreated, true);
  assert.equal(await getThread(freshId, scope.env), null);
  const state = await readThreadResourcePolicyState(scope.env);
  assert.equal(state.grants.some((grant) => grant.threadId === freshId && !grant.revokedAt), false);
  assert.equal(state.mailboxRoutes.filter((route) => route.status === "active").length, 1);
  assert.equal(state.mailboxRoutes.find((route) => route.status === "active")?.threadId, scope.thread.id);
});

test("new route provisioning never reuses an existing destination identity", async () => {
  const scope = await fixture("new-thread-existing");
  await createThread({ id: "existing-mailbox-route-thread", ownerUserId: "admin", name: "Existing mailbox route" }, scope.env);
  await assert.rejects(
    () => createMailboxRoute({ mailbox: scope.mailbox, newThread: { name: "Existing mailbox route" }, principal: scope.principal }, scope.env),
    /mailbox_route_new_thread_exists/,
  );
});

test("context-next-turn stores no immediate turn and consumes an exact reserved context once with the next human queue item", async () => {
  const scope = await fixture("context");
  await createMailboxRoute({ mailbox: scope.mailbox, threadId: scope.thread.id, mode: "context_next_turn", principal: scope.principal }, scope.env);
  const routed = await ingestMailboxMessage(inbound(scope.mailbox, "<context-route@example.test>", "Mail-only context"), scope.env);
  assert.equal(routed.routeDispatch.delivered, 0);
  assert.equal((await listThreadMessages(scope.thread.id, scope.env)).length, 0);
  const before = await mailboxRouteStatus({ mailbox: scope.mailbox }, scope.env);
  assert.equal(before.context.pending, 1);
  const human = await enqueueThreadInputForPrincipal(scope.thread.id, { text: "Please summarize" }, scope.principal, scope.env);
  assert.equal(human.codexDeliveryMode, "passive");
  assert.equal(human.steerActiveTurn, false);
  assert.match(human.text, /Mail-only context/);
  const after = await mailboxRouteStatus({ mailbox: scope.mailbox }, scope.env);
  assert.equal(after.context.pending, 0);
  assert.equal(after.context.consumed, 1);
});

test("context-next-turn recovers an expired reservation before a later human request claims it", async () => {
  const scope = await fixture("context-recovery");
  await createMailboxRoute({ mailbox: scope.mailbox, threadId: scope.thread.id, mode: "context_next_turn", principal: scope.principal }, scope.env);
  await ingestMailboxMessage(inbound(scope.mailbox, "<context-recovery@example.test>", "Recoverable context"), scope.env);
  const first = await reserveMailboxContextsForHumanTurn({ threadId: scope.thread.id, claimId: "interrupted-turn" }, scope.env);
  assert.equal(first.contexts.length, 1);
  await mutateThreadResourcePolicy((state) => {
    const context = state.mailboxContexts.find((item) => item.id === first.contexts[0].id);
    context.reservedAt = "2000-01-01T00:00:00.000Z";
    return { updated: true, skipPolicyEpoch: true };
  }, scope.env);
  const recovered = await reserveMailboxContextsForHumanTurn({ threadId: scope.thread.id, claimId: "later-human-turn" }, scope.env);
  assert.equal(recovered.contexts.length, 1);
  assert.equal(recovered.contexts[0].reservedFor, "later-human-turn");
});

test("context-next-turn binds duplicate client inputs to the original message and consumes the context only once", async () => {
  const scope = await fixture("context-duplicate");
  await createMailboxRoute({ mailbox: scope.mailbox, threadId: scope.thread.id, mode: "context_next_turn", principal: scope.principal }, scope.env);
  await ingestMailboxMessage(inbound(scope.mailbox, "<context-duplicate@example.test>", "Single-use context"), scope.env);

  const first = await enqueueThreadInputForPrincipal(scope.thread.id, { text: "Summarize", clientMessageId: "same-human-request" }, scope.principal, scope.env);
  const duplicate = await enqueueThreadInputForPrincipal(scope.thread.id, { text: "Summarize", clientMessageId: "same-human-request" }, scope.principal, scope.env);
  const later = await enqueueThreadInputForPrincipal(scope.thread.id, { text: "A different request", clientMessageId: "later-human-request" }, scope.principal, scope.env);

  assert.match(first.text, /Single-use context/);
  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.duplicate, true);
  assert.doesNotMatch(later.text, /Single-use context/);
  const state = await readThreadResourcePolicyState(scope.env);
  assert.equal(state.mailboxContexts.filter((item) => item.status === "consumed" && item.messageId === first.id).length, 1);
  assert.equal(state.mailboxContexts.some((item) => item.status === "reserved"), false);
});

test("context-next-turn reconciles a reserved record after a crash between append and consume", async () => {
  const scope = await fixture("context-crash");
  await createMailboxRoute({ mailbox: scope.mailbox, threadId: scope.thread.id, mode: "context_next_turn", principal: scope.principal }, scope.env);
  await ingestMailboxMessage(inbound(scope.mailbox, "<context-crash@example.test>", "Crash-safe context"), scope.env);
  const reservation = await reserveMailboxContextsForHumanTurn({ threadId: scope.thread.id, claimId: "crash-before-consume" }, scope.env);
  assert.equal(reservation.contexts.length, 1);
  const appended = await appendThreadMessage(scope.thread.id, {
    role: "user",
    source: "ui",
    state: "queued",
    clientMessageId: "crashed-human-request",
    mailboxContextClaimId: "crash-before-consume",
    text: `Please handle this.\n\n${reservation.text}`,
  }, scope.env);

  const later = await enqueueThreadInputForPrincipal(scope.thread.id, { text: "A later request", clientMessageId: "after-crash" }, scope.principal, scope.env);
  assert.doesNotMatch(later.text, /Crash-safe context/);
  const state = await readThreadResourcePolicyState(scope.env);
  assert.equal(state.mailboxContexts.find((item) => item.id === reservation.contexts[0].id)?.status, "consumed");
  assert.equal(state.mailboxContexts.find((item) => item.id === reservation.contexts[0].id)?.messageId, appended.id);
});

test("route revocation cancels context_pending work and its reserved delivery context", async () => {
  const scope = await fixture("context-revoke");
  const route = await createMailboxRoute({ mailbox: scope.mailbox, threadId: scope.thread.id, mode: "context_next_turn", principal: scope.principal }, scope.env);
  await ingestMailboxMessage(inbound(scope.mailbox, "<context-revoke@example.test>", "Cancel this context"), scope.env);
  await revokeMailboxRoute({ mailbox: scope.mailbox, routeId: route.route.id, principal: scope.principal }, scope.env);

  const state = await readThreadResourcePolicyState(scope.env);
  assert.equal(state.mailboxRouteWork[0].state, "cancelled");
  assert.equal(state.mailboxContexts[0].status, "cancelled");
});

test("active legacy listeners and routes cannot be co-enabled for a mailbox", async () => {
  const scope = await fixture("legacy-coexistence");
  const listener = await createMailboxThreadListener({ mailbox: scope.mailbox, threadId: scope.thread.id, principal: scope.principal }, scope.env);
  await assert.rejects(
    () => createMailboxRoute({ mailbox: scope.mailbox, threadId: scope.thread.id, mode: "append_only", principal: scope.principal }, scope.env),
    /mailbox_route_legacy_listener_active/,
  );
  await revokeMailboxThreadListener({ mailbox: scope.mailbox, listenerId: listener.listener.id, principal: scope.principal }, scope.env);
  await createMailboxRoute({ mailbox: scope.mailbox, threadId: scope.thread.id, mode: "append_only", principal: scope.principal }, scope.env);
  await assert.rejects(
    () => createMailboxThreadListener({ mailbox: scope.mailbox, threadId: scope.thread.id, principal: scope.principal }, scope.env),
    /mailbox_listener_route_active/,
  );
});

test("process-immediately requires the exact process grant", async () => {
  const scope = await fixture("process");
  await assert.rejects(
    () => createMailboxRoute({ mailbox: scope.mailbox, threadId: scope.thread.id, mode: "process_immediately", principal: scope.principal }, scope.env),
    /mailbox_route_process_grant_required/,
  );
  await setThreadResourceGrants(scope.thread.id, "mailbox", [{ resourceId: scope.mailbox.id, permissions: ["read", "subscribe", "process", "manage"] }], { principal: scope.principal }, scope.env);
  const route = await createApprovedRoute({ mailbox: scope.mailbox, threadId: scope.thread.id, mode: "process_immediately", principal: scope.principal }, scope.env);
  assert.equal(route.route.mode, "process_immediately");
});

test("process route creation and every route move require an exact attended approval", async () => {
  const scope = await fixture("attended", ["read", "subscribe", "process", "manage"]);
  const pendingCreate = await createMailboxRoute({ mailbox: scope.mailbox, threadId: scope.thread.id, mode: "process_immediately", principal: scope.principal }, scope.env);
  assert.equal(pendingCreate.status, "approval_required");
  const resourceId = (await readThreadResourcePolicyState(scope.env)).resources.find((resource) => resource.resourceType === "mailbox")?.id;
  assert.deepEqual(pendingCreate.challenge.authIntent, {
    mailboxRouteAction: "create_process_immediately",
    mailboxId: scope.mailbox.id,
    mailboxResourceId: resourceId,
    routeId: "",
    sourceThreadId: "",
    sourceMode: "",
    destinationThreadId: scope.thread.id,
    destinationMode: "process_immediately",
  });
  assert.equal((await readThreadResourcePolicyState(scope.env)).mailboxRoutes.length, 0);
  await approvePairingChallenge(pendingCreate.challenge.id, { env: scope.env, approvedBy: "node:test" });
  const created = await createMailboxRoute({ mailbox: scope.mailbox, threadId: scope.thread.id, mode: "process_immediately", principal: scope.principal, approval: pendingCreate.challenge.approveCode }, scope.env);
  assert.equal(created.route.mode, "process_immediately");

  const destination = await createThread({ id: "attended-move-destination", ownerUserId: "admin", name: "Moved route destination" }, scope.env);
  await setThreadResourceGrants(destination.id, "mailbox", [{ resourceId: scope.mailbox.id, permissions: ["read", "subscribe", "process", "manage"] }], { principal: scope.principal }, scope.env);
  const pendingMove = await moveMailboxRoute({ mailbox: scope.mailbox, routeId: created.route.id, threadId: destination.id, mode: "append_only", principal: scope.principal }, scope.env);
  assert.equal(pendingMove.status, "approval_required");
  assert.deepEqual(pendingMove.challenge.authIntent, {
    mailboxRouteAction: "move",
    mailboxId: scope.mailbox.id,
    mailboxResourceId: resourceId,
    routeId: created.route.id,
    sourceThreadId: scope.thread.id,
    sourceMode: "process_immediately",
    destinationThreadId: destination.id,
    destinationMode: "append_only",
  });
  assert.equal((await readThreadResourcePolicyState(scope.env)).mailboxRoutes.find((route) => route.status === "active")?.id, created.route.id);
  await approvePairingChallenge(pendingMove.challenge.id, { env: scope.env, approvedBy: "node:test" });
  const moved = await moveMailboxRoute({ mailbox: scope.mailbox, routeId: created.route.id, threadId: destination.id, mode: "append_only", principal: scope.principal, approval: pendingMove.challenge.approveCode }, scope.env);
  assert.equal(moved.route.id, created.route.id);
  assert.equal(moved.route.generation, created.route.generation + 1);
  assert.equal(moved.route.threadId, destination.id);
  assert.equal(moved.route.mode, "append_only");
});

test("process new-thread approval is bound to the exact canonical destination identity", async () => {
  const scope = await fixture("new-thread-intent");
  const input = {
    mailbox: scope.mailbox,
    newThread: { id: "approved-new-thread", name: "Approved mailbox destination" },
    mode: "process_immediately",
    principal: scope.principal,
  };
  const pending = await createMailboxRoute(input, scope.env);
  assert.equal(pending.status, "approval_required");
  assert.deepEqual({
    id: pending.challenge.authIntent.newThreadId,
    name: pending.challenge.authIntent.newThreadName,
    canonical: pending.challenge.authIntent.newThreadIdentity,
  }, {
    id: "approved-new-thread",
    name: "Approved mailbox destination",
    canonical: JSON.stringify({ id: "approved-new-thread", name: "Approved mailbox destination" }),
  });
  await approvePairingChallenge(pending.challenge.id, { env: scope.env, approvedBy: "node:test" });
  await assert.rejects(
    () => createMailboxRoute({ ...input, newThread: { id: "approved-new-thread", name: "Different mailbox destination" }, approval: pending.challenge.approveCode }, scope.env),
    /pairing_challenge_intent_scope_denied/,
  );
  assert.equal(await getThread("approved-new-thread", scope.env), null);
  const created = await createMailboxRoute({ ...input, approval: pending.challenge.approveCode }, scope.env);
  assert.equal(created.route.threadId, "approved-new-thread");
});

test("an approved move atomically replaces the route and leaves it active on a policy race", async () => {
  const scope = await fixture("move-atomic");
  const route = await createMailboxRoute({ mailbox: scope.mailbox, threadId: scope.thread.id, mode: "context_next_turn", principal: scope.principal }, scope.env);
  await ingestMailboxMessage(inbound(scope.mailbox, "<move-atomic@example.test>", "Cancel old context"), scope.env);
  const destination = await createThread({ id: "move-atomic-destination", ownerUserId: "admin", name: "Atomic move destination" }, scope.env);
  await setThreadResourceGrants(destination.id, "mailbox", [{ resourceId: scope.mailbox.id, permissions: ["read", "subscribe", "manage"] }], { principal: scope.principal }, scope.env);
  const pending = await moveMailboxRoute({ mailbox: scope.mailbox, routeId: route.route.id, threadId: destination.id, mode: "append_only", principal: scope.principal }, scope.env);
  await approvePairingChallenge(pending.challenge.id, { env: scope.env, approvedBy: "node:test" });
  const moved = await moveMailboxRoute({ mailbox: scope.mailbox, routeId: route.route.id, threadId: destination.id, mode: "append_only", principal: scope.principal, approval: pending.challenge.approveCode }, scope.env);
  let state = await readThreadResourcePolicyState(scope.env);
  assert.equal(state.mailboxRoutes.length, 1);
  assert.equal(moved.route.id, route.route.id);
  assert.equal(moved.route.generation, route.route.generation + 1);
  assert.equal(state.mailboxRouteWork[0].state, "cancelled");
  assert.equal(state.mailboxContexts[0].status, "cancelled");

  const race = await moveMailboxRoute({ mailbox: scope.mailbox, routeId: moved.route.id, threadId: scope.thread.id, mode: "append_only", principal: scope.principal }, scope.env);
  await approvePairingChallenge(race.challenge.id, { env: scope.env, approvedBy: "node:test" });
  await assert.rejects(
    () => moveMailboxRoute({ mailbox: scope.mailbox, routeId: moved.route.id, threadId: scope.thread.id, mode: "append_only", principal: scope.principal, approval: race.challenge.approveCode }, scope.env, {
      beforeMutation: async () => mutateThreadResourcePolicy(() => ({ raced: true }), scope.env),
    }),
    /mailbox_route_policy_revision_conflict/,
  );
  state = await readThreadResourcePolicyState(scope.env);
  assert.equal(state.mailboxRoutes.length, 1);
  assert.equal(state.mailboxRoutes[0].status, "active");
  assert.equal(state.mailboxRoutes[0].threadId, destination.id);
});

test("raw MIME ingress preserves loop headers and suppresses each loop signal before route work", async () => {
  const scope = await fixture("raw-loop");
  scope.env.ORKESTR_MAILBOX_ROUTE_MAX_ANCESTRY = "2";
  await createMailboxRoute({ mailbox: scope.mailbox, threadId: scope.thread.id, mode: "append_only", principal: scope.principal }, scope.env);
  const rawMime = (messageId, headers) => [
    `Message-ID: ${messageId}`,
    "From: Sender <sender@example.test>",
    "Subject: Route loop regression",
    ...headers,
    "",
    "This message must never become route work.",
  ].join("\r\n");
  await ingestMailboxMessage({ recipient: scope.mailbox.address, rawMime: rawMime("<auto-loop@example.test>", ["Auto-Submitted: auto-replied"]), envelope: { rcptTo: scope.mailbox.address } }, scope.env);
  await ingestMailboxMessage({ recipient: scope.mailbox.address, rawMime: rawMime("<origin-loop@example.test>", ["X-Orkestr-Origin: mailbox-route"]), envelope: { rcptTo: scope.mailbox.address } }, scope.env);
  await ingestMailboxMessage({ recipient: scope.mailbox.address, rawMime: rawMime("<ancestry-loop@example.test>", ["References: <first@example.test> <second@example.test> <third@example.test>", "In-Reply-To: <first@example.test>"]), envelope: { rcptTo: scope.mailbox.address } }, scope.env);
  const state = await readThreadResourcePolicyState(scope.env);
  assert.deepEqual(state.mailboxSources.map((source) => source.suppressionReason).sort(), ["ancestry_limit", "auto_submitted", "orkestr_origin"]);
  assert.equal(state.mailboxRouteWork.length, 0);
  assert.equal((await listThreadMessages(scope.thread.id, scope.env)).filter((message) => message.source === "mailbox_route").length, 0);
});

test("route source retention compacts only terminal records and backpressures active work", async () => {
  const terminal = await fixture("source-retention");
  terminal.env.ORKESTR_MAILBOX_ROUTE_SOURCE_RETENTION_LIMIT = "2";
  await createMailboxRoute({ mailbox: terminal.mailbox, threadId: terminal.thread.id, mode: "append_only", principal: terminal.principal }, terminal.env);
  for (const number of [1, 2, 3]) await ingestMailboxMessage(inbound(terminal.mailbox, `<source-retention-${number}@example.test>`), terminal.env);
  let state = await readThreadResourcePolicyState(terminal.env);
  assert.equal(state.mailboxSources.length, 2);
  assert.equal(state.mailboxRouteWork.length, 2);
  assert.deepEqual(state.mailboxSources.map((source) => source.payload.messageId).sort(), ["<source-retention-2@example.test>", "<source-retention-3@example.test>"]);

  const active = await fixture("source-backpressure");
  active.env.ORKESTR_MAILBOX_ROUTE_SOURCE_RETENTION_LIMIT = "1";
  await createMailboxRoute({ mailbox: active.mailbox, threadId: active.thread.id, mode: "context_next_turn", principal: active.principal }, active.env);
  const first = await ingestMailboxMessage(inbound(active.mailbox, "<source-active@example.test>"), active.env);
  assert.equal(first.action, "mailbox_thread_delivery_unrouted");
  const blocked = await ingestMailboxMessage(inbound(active.mailbox, "<source-blocked@example.test>"), active.env);
  assert.equal(blocked.action, "mailbox_policy_unavailable_spooled");
  state = await readThreadResourcePolicyState(active.env);
  assert.equal(state.mailboxSources.length, 1);
  assert.equal(state.mailboxRouteWork.length, 1);
  assert.equal(state.mailboxRouteWork[0].state, "context_pending");
});

test("route revoke linearizes with an append-only acceptance fence", async () => {
  const scope = await fixture("route-fence");
  const route = await createMailboxRoute({ mailbox: scope.mailbox, threadId: scope.thread.id, mode: "append_only", principal: scope.principal }, scope.env);
  const source = await enqueueMailboxRouteSource({ mailbox: scope.mailbox, message: inbound(scope.mailbox, "<route-fence@example.test>"), idempotencyKey: "route-fence" }, scope.env);
  let entered;
  const appendEntered = new Promise((resolve) => { entered = resolve; });
  let release;
  const appendRelease = new Promise((resolve) => { release = resolve; });
  const dispatching = dispatchMailboxRouteWork({
    workIds: [source.workId],
    appendMessage: async (threadId, message, env) => { entered(); await appendRelease; return appendThreadMessage(threadId, message, env); },
  }, scope.env);
  await appendEntered;
  let revokeFinished = false;
  const revoking = revokeMailboxRoute({ mailbox: scope.mailbox, routeId: route.route.id, principal: scope.principal }, scope.env).then((value) => { revokeFinished = true; return value; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(revokeFinished, false);
  release();
  const [delivered, revoked] = await Promise.all([dispatching, revoking]);
  assert.equal(delivered.delivered, 1);
  assert.equal(revoked.route.status, "revoked");
  assert.equal((await listThreadMessages(scope.thread.id, scope.env)).filter((message) => message.source === "mailbox_route").length, 1);
});

test("process-immediately sanitizes as an external mailbox actor and creates one passive read-only input", async () => {
  const scope = await fixture("passive", ["read", "subscribe", "process", "manage"]);
  const sanitizerLog = path.join(scope.env.ORKESTR_HOME, "sanitizer.json");
  const sanitizer = path.join(scope.env.ORKESTR_HOME, "allow-sanitizer.mjs");
  await fs.writeFile(sanitizer, [
    "import fs from 'node:fs';",
    "let input = ''; process.stdin.on('data', (chunk) => { input += chunk; });",
    `process.stdin.on('end', () => { fs.writeFileSync(${JSON.stringify(sanitizerLog)}, input); console.log(JSON.stringify({ allow: true, reason: 'test-allow' })); });`,
  ].join("\n"));
  scope.env.ORKESTR_LLM_SANITIZER_COMMAND_JSON = JSON.stringify([process.execPath, sanitizer]);
  await createApprovedRoute({ mailbox: scope.mailbox, threadId: scope.thread.id, mode: "process_immediately", principal: scope.principal }, scope.env);
  const routed = await ingestMailboxMessage(inbound(scope.mailbox, "<passive-route@example.test>", "Untrusted mailbox body"), scope.env);
  assert.equal(routed.routeDispatch.accepted, 1, JSON.stringify(routed.routeDispatch));
  const messages = await listThreadMessages(scope.thread.id, scope.env);
  const queued = messages.find((message) => message.source === "mailbox_route");
  assert.equal(queued.codexDeliveryMode, "passive");
  assert.equal(queued.steerActiveTurn, false);
  assert.equal(queued.mailboxExecutionPolicy, "read_only_no_network_no_connectors_no_messaging_no_auth_no_browser_no_desktop");
  const params = turnStartParams(scope.thread, queued, scope.env);
  assert.deepEqual(params.sandboxPolicy, { type: "readOnly", networkAccess: false });
  const sanitizerPayload = JSON.parse(await fs.readFile(sanitizerLog, "utf8"));
  assert.equal(sanitizerPayload.action, "mailbox.route.process");
  assert.equal(sanitizerPayload.actor.role, "external");
  assert.notEqual(sanitizerPayload.actor.kind, "admin");
});

test("process work keeps a durable queue-message and Codex-turn link through reconciliation without replaying acceptance", async () => {
  const scope = await fixture("process-runtime", ["read", "subscribe", "process", "manage"]);
  await createApprovedRoute({ mailbox: scope.mailbox, threadId: scope.thread.id, mode: "process_immediately", principal: scope.principal }, scope.env);
  const source = await enqueueMailboxRouteSource({ mailbox: scope.mailbox, message: inbound(scope.mailbox, "<process-runtime@example.test>"), idempotencyKey: "process-runtime" }, scope.env);
  const queued = await appendThreadMessage(scope.thread.id, {
    role: "user",
    source: "mailbox_route",
    connector: "mailbox",
    state: "queued",
    clientMessageId: `mailbox-route-work:${source.workId}`,
    text: "Durably accepted mailbox work",
    mailboxExecutionPolicy: "read_only_no_network_no_connectors_no_messaging_no_auth_no_browser_no_desktop",
  }, scope.env);
  await mutateThreadResourcePolicy((policy) => {
    const work = policy.mailboxRouteWork.find((item) => item.id === source.workId);
    work.state = "accepted";
    work.executionState = "accepted";
    work.messageId = queued.id;
    work.acceptedAt = new Date().toISOString();
    return { accepted: true, skipPolicyEpoch: true };
  }, scope.env);

  let state = await readThreadResourcePolicyState(scope.env);
  const work = state.mailboxRouteWork.find((item) => item.id === source.workId);
  assert.equal(work.state, "accepted");
  assert.ok(work.messageId);
  await recordMailboxRouteWorkRuntime({ threadId: scope.thread.id, messageId: work.messageId, codexTurnId: "mailbox-turn-1", state: "running" }, scope.env);
  state = await readThreadResourcePolicyState(scope.env);
  assert.equal(state.mailboxRouteWork.find((item) => item.id === source.workId)?.state, "running");
  assert.equal(state.mailboxRouteWork.find((item) => item.id === source.workId)?.codexTurnId, "mailbox-turn-1");

  await updateThread(scope.thread.id, { runtime: { lastTurnId: "mailbox-turn-1", lastTurnStatus: "completed", state: "ready" } }, scope.env);
  const reconciled = await reconcileMailboxRouteWorkRuntime(scope.env);
  assert.equal(reconciled.reconciled, 1);
  state = await readThreadResourcePolicyState(scope.env);
  assert.equal(state.mailboxRouteWork.find((item) => item.id === source.workId)?.state, "completed");
  assert.equal((await dispatchMailboxRouteWork({ workIds: [source.workId] }, scope.env)).results.length, 0);
});
