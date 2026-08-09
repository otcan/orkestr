import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ingestMailboxMessage } from "../packages/connectors/src/mailbox-inbox.js";
import { resetConnectorInboxForTest } from "../packages/connectors/src/connector-inbox.js";
import { createMailbox } from "../packages/core/src/mailboxes.js";
import { readThreadResourcePolicyState } from "../packages/core/src/thread-resource-policy-store.js";
import { createMailboxRoute, dispatchMailboxRouteWork, enqueueMailboxRouteSource, mailboxRouteStatus, reserveMailboxContextsForHumanTurn, revokeMailboxRoute } from "../packages/core/src/mailbox-routes.js";
import { appendThreadMessage, createThread, enqueueThreadInputForPrincipal, listThreadMessages } from "../packages/core/src/threads.js";
import { adminPrincipal } from "../packages/core/src/principal.js";
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
  const created = await createMailboxRoute({ mailbox: scope.mailbox, newThread: { name: "New mailbox route" }, mode: "process_immediately", principal: scope.principal }, scope.env);
  assert.equal(created.route.mode, "process_immediately");
  const state = await readThreadResourcePolicyState(scope.env);
  const grant = state.grants.find((item) => item.threadId === created.route.threadId && item.resourceId.endsWith(scope.mailbox.id) && !item.revokedAt);
  assert.deepEqual([...grant.permissions].sort(), ["manage", "process", "read", "subscribe"]);
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

test("process-immediately requires the exact process grant", async () => {
  const scope = await fixture("process");
  await assert.rejects(
    () => createMailboxRoute({ mailbox: scope.mailbox, threadId: scope.thread.id, mode: "process_immediately", principal: scope.principal }, scope.env),
    /mailbox_route_process_grant_required/,
  );
  await setThreadResourceGrants(scope.thread.id, "mailbox", [{ resourceId: scope.mailbox.id, permissions: ["read", "subscribe", "process", "manage"] }], { principal: scope.principal }, scope.env);
  const route = await createMailboxRoute({ mailbox: scope.mailbox, threadId: scope.thread.id, mode: "process_immediately", principal: scope.principal }, scope.env);
  assert.equal(route.route.mode, "process_immediately");
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
  await createMailboxRoute({ mailbox: scope.mailbox, threadId: scope.thread.id, mode: "process_immediately", principal: scope.principal }, scope.env);
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
