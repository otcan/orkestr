import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createThread, appendThreadMessage, updateThreadMessage, deleteThreadMessage, listThreadMessages, updateThread, listThreads } from "../packages/core/src/threads.js";
import { listBridgeThreads, readBridgeHistory, readBridgeChanges, replyToBridgeThread } from "../packages/core/src/thread-bridge.js";
import { closeThreadMessageRegistryCache, replaceThreadMessageRecords, threadBridgeChanges } from "../packages/storage/src/thread-message-registry.js";

import { createUser, disableUser } from "../packages/core/src/users.js";

const principal = { kind: "delegated-agent", ownerUserId: "owner-a", agentId: "agent-a", grantId: "grant-a", issuer: "test-adapter", authMethod: "test" };
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-thread-bridge-"));
  const env = { ORKESTR_HOME: home, ORKESTR_THREAD_STORE: "sqlite", ORKESTR_THREAD_MESSAGE_STORE: "sqlite", ORKESTR_THREAD_BRIDGE_ENABLED: "1" };
  const grant = { id: "grant-a", ownerUserId: "owner-a", agentId: "agent-a", issuer: "test-adapter", authMethod: "test", enabled: true, expiresAt: "2099-01-01T00:00:00Z", observe: "all", reply: ["thread-a"] };
  const writeGrant = (next = grant) => fs.writeFile(path.join(home, "thread-bridge-grants.json"), JSON.stringify([next]));
  await writeGrant();
  await createUser({ id: "owner-a" }, env);
  await createUser({ id: "owner-b" }, env);
  await createThread({ id: "thread-a", ownerUserId: "owner-a", name: "Example A" }, env);
  await createThread({ id: "thread-b", ownerUserId: "owner-b", name: "Example B" }, env);
  t.after(async () => { await closeThreadMessageRegistryCache(); await fs.rm(home, { recursive: true, force: true }); });
  return { env, grant, writeGrant };
}
const post = (id, text, env, extra = {}) => appendThreadMessage(id, { role: "assistant", phase: "final_answer", text, ...extra }, env);

test("bridge is disabled by default and refuses human/admin or forged scope", async t => {
  const { env, writeGrant, grant } = await fixture(t);
  await assert.rejects(listBridgeThreads(principal, { ...env, ORKESTR_THREAD_BRIDGE_ENABLED: "0" }), /thread_bridge_disabled/);
  for (const candidate of [null, { kind: "user", role: "admin", userId: "owner-a" }, { ...principal, ownerUserId: "owner-b" }, { ...principal, issuer: "untrusted" }]) {
    await assert.rejects(listBridgeThreads(candidate, env), /bridge_(authentication_required|grant_revoked|owner_inactive)/);
  }
  assert.deepEqual((await listBridgeThreads(principal, env)).threadIds, ["thread-a"]);
  await writeGrant({ ...grant, observe: [] });
  assert.deepEqual((await listBridgeThreads({ ...principal, observe: "all" }, env)).threadIds, []);
  await writeGrant({ ...grant, expiresAt: "2000-01-01T00:00:00Z" });
  await assert.rejects(listBridgeThreads(principal, env), /bridge_grant_revoked/);
});

test("all-current-and-future observation does not grant reply authority", async t => {
  const { env } = await fixture(t);
  await createThread({ id: "thread-future", ownerUserId: "owner-a" }, env);
  assert.deepEqual((await listBridgeThreads(principal, env)).threadIds.sort(), ["thread-a", "thread-future"]);
  await assert.rejects(replyToBridgeThread("thread-future", { requestId: "request-a", text: "Comment" }, principal, env), /bridge_thread_not_found/);
  await assert.rejects(readBridgeHistory("thread-b", principal, {}, env), /bridge_thread_not_found/);
});

test("history is allowlisted and includes only public completed conversation", async t => {
  const { env } = await fixture(t);
  await post("thread-a", "Visible response", env, { promptFile: "/synthetic/private.txt", attachments: [], externalPrincipal: { token: "synthetic-secret" } });
  await post("thread-a", "Private reasoning", env, { phase: "analysis" });
  await post("thread-a", "Hidden", env, { visibility: " Internal " });
  await post("thread-a", "NO_REPLY", env);
  const deleted = await post("thread-a", "Removed", env);
  await deleteThreadMessage("thread-a", deleted.id, {}, env);
  const history = await readBridgeHistory("thread-a", principal, {}, env);
  assert.equal(history.messages.length, 1);
  assert.equal(history.messages[0].text, "Visible response");
  assert.equal(history.messages[0].contextOnly, true);
  assert.doesNotMatch(JSON.stringify(history), /promptFile|synthetic-secret|Private reasoning|Hidden|Removed|attachments/);
});

test("ordered changes paginate without skipping, survive reopen, and capture edits and tombstones", async t => {
  const { env } = await fixture(t);
  const messages = [];
  for (let i = 0; i < 105; i++) messages.push(await post("thread-a", `Example ${i}`, env));
  await post("thread-b", "Other owner", env);
  const first = await readBridgeChanges(principal, {}, env);
  assert.equal(first.events.length, 100);
  assert.equal(first.hasMore, true);
  assert.equal(first.cursor, first.events.at(-1).cursor);
  assert.notEqual(first.cursor, first.currentCursor);
  await closeThreadMessageRegistryCache();
  const second = await readBridgeChanges(principal, { cursor: first.cursor }, env);
  assert.equal(second.events.length, 5);
  assert.equal(second.hasMore, false);
  await updateThreadMessage("thread-a", messages[0].id, { text: "Revised" }, env);
  await deleteThreadMessage("thread-a", messages[1].id, {}, env);
  const revisions = await readBridgeChanges(principal, { cursor: second.cursor }, env);
  assert.deepEqual(revisions.events.map(event => event.type), ["message.updated", "message.deleted"]);
  assert.doesNotMatch(JSON.stringify(revisions.events), /Revised|Example|Other owner/);
  await assert.rejects(readBridgeChanges(principal, { cursor: "wrong:1" }, env), /bridge_cursor_reset_required/);
  await assert.rejects(readBridgeChanges(principal, { limit: 101 }, env), /bridge_limit_invalid/);
});

test("grant revocation, retirement, ownership changes, and visibility removal take effect on replay", async t => {
  const { env, grant, writeGrant } = await fixture(t);
  const message = await post("thread-a", "Visible", env);
  const initial = await readBridgeChanges(principal, {}, env);
  await updateThreadMessage("thread-a", message.id, { visibility: "internal" }, env);
  assert.equal((await readBridgeChanges(principal, { cursor: initial.cursor }, env)).events[0].type, "message.deleted");
  await writeGrant({ ...grant, enabled: false });
  await assert.rejects(readBridgeChanges(principal, {}, env), /bridge_grant_revoked/);
  await writeGrant();
  await updateThread("thread-a", { ownerUserId: "owner-b" }, env);
  const replay = await readBridgeChanges(principal, {}, env);
  assert.deepEqual(replay.events, []);
  assert.deepEqual(replay.threadIds, []);
  await assert.rejects(readBridgeHistory("thread-a", principal, {}, env), /bridge_thread_not_found/);
});

test("reply is an atomic same-thread delegated comment with scoped idempotency and no human queue", async t => {
  const { env } = await fixture(t);
  const source = await post("thread-a", "Question context", env);
  const input = { requestId: "request-a", text: "A delegated comment", causedByMessageId: source.id };
  const [first, second] = await Promise.all([replyToBridgeThread("thread-a", input, principal, env), replyToBridgeThread("thread-a", input, principal, env)]);
  assert.equal(first.messageId, second.messageId);
  assert.equal([first, second].filter(result => result.duplicate).length, 1);
  await assert.rejects(replyToBridgeThread("thread-a", { ...input, text: "Different" }, principal, env), /bridge_idempotency_conflict/);
  await assert.rejects(replyToBridgeThread("thread-a", { ...input, role: "user" }, principal, env), /bridge_reply_invalid/);
  const messages = await listThreadMessages("thread-a", env);
  assert.equal(messages.length, 2);
  const reply = messages[1];
  assert.equal(reply.source, "thread_bridge_agent");
  assert.equal(reply.role, "assistant");
  assert.equal(reply.state, "completed");
  assert.equal(reply.phase, "delegated_comment");
  assert.equal(reply.contextOnly, true);
  assert.equal(reply.bridgeAgentId, principal.agentId);
  const feed = await readBridgeChanges(principal, {}, env);
  assert.equal(feed.events.length, 1, "agent's own reply must not echo back");
  assert.equal(feed.lastDeliveredCursor, feed.events[0].cursor);
  assert.notEqual(feed.cursor, feed.lastDeliveredCursor, "scan cursor must advance over suppressed echoes");
  await assert.rejects(replyToBridgeThread("thread-a", { requestId: "request-b", text: "Echo", causedByMessageId: reply.id }, principal, env), /bridge_cause_invalid/);
  await closeThreadMessageRegistryCache();
  assert.equal((await replyToBridgeThread("thread-a", input, principal, env)).duplicate, true);
});

test("replacement and physical deletion journal only changed public messages", async t => {
  const { env } = await fixture(t);
  await post("thread-a", "Keep", env);
  await post("thread-a", "Delete", env);
  const initial = await threadBridgeChanges("owner-a", {}, env);
  const messages = await listThreadMessages("thread-a", env);
  await replaceThreadMessageRecords("thread-a", [messages[0]], env);
  const page = await threadBridgeChanges("owner-a", { cursor: initial.cursor }, env);
  assert.deepEqual(page.events.map(event => [event.type, event.messageId]), [["message.deleted", messages[1].id]]);
});

test("retirement and deletion remove thread inventory and block comments", async t => {
  const { env } = await fixture(t);
  await post("thread-a", "Before retirement", env);
  await updateThread("thread-a", { lifecycleState: "retired", retiredAt: "2026-01-01T00:00:00Z" }, env);
  assert.deepEqual((await listBridgeThreads(principal, env)).threadIds, []);
  assert.deepEqual((await readBridgeChanges(principal, {}, env)).events, []);
  await assert.rejects(replyToBridgeThread("thread-a", { requestId: "request-a", text: "Comment" }, principal, env), /bridge_thread_not_found/);
});

test("metadata journal failure rolls back the source message and cursor", async t => {
  const { env } = await fixture(t);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(env.ORKESTR_HOME, "thread-messages.sqlite"));
  // Initialize tables before installing a synthetic fault in the same DB.
  await listBridgeThreads(principal, env);
  db.exec("create trigger bridge_test_failure before insert on orkestr_thread_bridge_changes begin select raise(abort, 'synthetic journal failure'); end");
  await assert.rejects(post("thread-a", "Must roll back", env), /synthetic journal failure/);
  assert.equal((await listThreadMessages("thread-a", env)).length, 0);
  assert.equal((await threadBridgeChanges("owner-a", {}, env)).events.length, 0);
  db.exec("drop trigger bridge_test_failure");
  db.close();
  await post("thread-a", "Committed", env);
  assert.match((await threadBridgeChanges("owner-a", {}, env)).events[0].cursor, /:1$/);
});

test("filtered pages advance without skipping later permitted events", async t => {
  const { env, grant, writeGrant } = await fixture(t);
  await createThread({ id: "thread-hidden", ownerUserId: "owner-a" }, env);
  for (let i = 0; i < 3; i++) await post("thread-hidden", `Excluded ${i}`, env);
  await post("thread-a", "Permitted", env);
  await writeGrant({ ...grant, observe: ["thread-a"] });
  const first = await readBridgeChanges(principal, { limit: 3 }, env);
  assert.deepEqual(first.events, []);
  assert.equal(first.hasMore, true);
  assert.equal(first.lastDeliveredCursor, null);
  const second = await readBridgeChanges(principal, { cursor: first.cursor }, env);
  assert.equal(second.events.length, 1);
  assert.equal(second.events[0].threadId, "thread-a");
  assert.equal(second.hasMore, false);
});

test("reply identity isolates idempotency and delegated comments cannot complete runtime turns", async t => {
  const { env, grant, writeGrant } = await fixture(t);
  const input = { requestId: "shared-request", text: "Comment" };
  const first = await replyToBridgeThread("thread-a", input, principal, env);
  const other = { ...principal, agentId: "agent-other", grantId: "grant-other" };
  await writeGrant({ ...grant, id: other.grantId, agentId: other.agentId });
  const second = await replyToBridgeThread("thread-a", input, other, env);
  assert.notEqual(first.messageId, second.messageId);
  const { assistantMessage, terminalAssistantMessage } = await import("../packages/core/src/thread-message-visibility.js");
  for (const message of await listThreadMessages("thread-a", env)) {
    assert.equal(assistantMessage(message), false);
    assert.equal(terminalAssistantMessage(message), false);
  }
  // Comment scope comes only from the stored grant: "all" (granted through the
  // owner's consent) allows every owned thread, an empty list allows none.
  await writeGrant({ ...grant, reply: "all" });
  assert.ok((await replyToBridgeThread("thread-a", { requestId: "all-scope", text: "Comment" }, principal, env)).messageId);
  await writeGrant({ ...grant, reply: [] });
  await assert.rejects(replyToBridgeThread("thread-a", { requestId: "no-scope", text: "Comment" }, principal, env), /bridge_thread_not_found/);
});

test("invalid grants, JSON store, bad history continuation, and absent feature all fail closed", async t => {
  const { env, writeGrant } = await fixture(t);
  const before = await post("thread-a", "Page one", env);
  await post("thread-a", "Page two", env);
  const first = await readBridgeHistory("thread-a", principal, { limit: 1 }, env);
  assert.equal(first.after, before.id);
  assert.equal(first.hasMore, true);
  assert.equal((await readBridgeHistory("thread-a", principal, { after: first.after }, env)).messages[0].text, "Page two");
  await assert.rejects(readBridgeHistory("thread-a", principal, { after: "missing" }, env), /bridge_history_reset_required/);
  await assert.rejects(listBridgeThreads(principal, { ...env, ORKESTR_THREAD_MESSAGE_STORE: "json" }), /bridge_requires_sqlite/);
  await assert.rejects(listBridgeThreads(principal, { ...env, ORKESTR_THREAD_BRIDGE_ENABLED: undefined }), /thread_bridge_disabled/);
  await writeGrant(null);
  await assert.rejects(listBridgeThreads(principal, env), /bridge_grant_revoked/);
});

test("disabling the owner revokes access independently of its delegated grant", async t => {
  const { env } = await fixture(t);
  await disableUser("owner-a", env);
  await assert.rejects(listBridgeThreads(principal, env), /bridge_owner_inactive/);
  await assert.rejects(replyToBridgeThread("thread-a", { requestId: "request-a", text: "Comment" }, principal, env), /bridge_owner_inactive/);
});

test("edits after ownership transfer invalidate the current owner's feed", async t => {
  const { env, grant, writeGrant } = await fixture(t);
  const message = await post("thread-a", "Original", env);
  await updateThread("thread-a", { ownerUserId: "owner-b" }, env);
  await updateThreadMessage("thread-a", message.id, { text: "Current owner's revision" }, env);
  const other = { ...principal, ownerUserId: "owner-b" };
  await writeGrant({ ...grant, ownerUserId: "owner-b" });
  const page = await readBridgeChanges(other, {}, env);
  assert.equal(page.events.length, 1);
  assert.equal(page.events[0].type, "message.updated");
  assert.equal(page.events[0].messageId, message.id);
  assert.equal((await readBridgeHistory("thread-a", other, {}, env)).messages[0].text, "Current owner's revision");
});

test("change cursor is owner-bound, not reusable across accounts", async t => {
  const { env } = await fixture(t);
  await post("thread-a", "Owner A", env);
  await post("thread-b", "Owner B", env);
  const page = await threadBridgeChanges("owner-a", {}, env);
  await assert.rejects(threadBridgeChanges("owner-b", { cursor: page.cursor }, env), /bridge_cursor_reset_required/);
});

test("delegated comments are never eligible for automatic WhatsApp forwarding", async () => {
  const { shouldMirrorWhatsAppReply, shouldMirrorWhatsAppProgress } = await import("../packages/connectors/src/whatsapp-mirror-policy.js");
  for (const phase of ["delegated_comment", "final_answer", "commentary", "signal"]) {
    const message = { role: "assistant", state: "completed", source: "thread_bridge_agent", phase, text: "Local comment" };
    assert.equal(shouldMirrorWhatsAppReply(message), false);
    assert.equal(shouldMirrorWhatsAppProgress(message), false);
  }
});

test("repair doctor cannot turn a delegated comment into an external delivery", async () => {
  const { whatsappAssistantFinal, orphanedWhatsAppFinalAnswerIssues, repairOrphanedWhatsAppFinalAnswer } = await import("../packages/core/src/router-doctor-whatsapp-final-mirror.js");
  const message = { id: "comment-example", role: "assistant", source: "thread_bridge_agent", state: "completed", phase: "final_answer", connector: "whatsapp", chatId: "example-chat", routerTraceId: "example-trace" };
  assert.equal(whatsappAssistantFinal(message), false);
  assert.deepEqual(orphanedWhatsAppFinalAnswerIssues({ messages: [message], thread: { id: "example-thread" } }), []);
  const repaired = await repairOrphanedWhatsAppFinalAnswer({ messageId: message.id }, {
    messages: [message], ensureConnectorOutboxJobFn: () => { assert.fail("must not enqueue delivery"); },
  });
  assert.equal(repaired, null);
});

test("doctor index cannot treat a delegated comment as a completed runtime reply", async () => {
  const { buildMessageIndex } = await import("../packages/core/src/router-doctor-indexes.js");
  const user = { id: "user-example", role: "user", state: "completed" };
  const comment = { id: "comment-example", role: "assistant", source: "thread_bridge_agent", phase: "delegated_comment", state: "completed" };
  assert.equal(buildMessageIndex([user, comment]).newerAssistant(user), null);
  assert.equal(buildMessageIndex([comment, user]).olderAssistant(user), null);
});
