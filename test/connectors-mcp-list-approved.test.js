import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { runConnectorMcpTool } from "../packages/connectors/src/connectors-mcp-operations.js";

async function fakeWorker(chats) {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(req.url.startsWith("/accounts/sender/direct-chats/summary") ? { ok: true, ready: true, chats } : { ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { calls, server, url: `http://127.0.0.1:${server.address().port}` };
}

const auth = (scopes) => ({
  tokenId: "swing", scopes, principalKind: "thread", ownerUserId: "admin", threadId: "thread-swing", accountId: "sender", accountService: "whatsapp",
  allowedChatIds: ["120000000001@g.us"], allowedRecipients: ["15550000001@c.us", "15550000002@c.us"], operator: false,
});

test("list_approved needs its own scope, returns only allowlisted chats as metadata, newest first", async (t) => {
  const worker = await fakeWorker([
    { chatId: "15550000001@c.us", label: "A", unreadCount: 0, lastMessageAt: "2026-10-20T10:00:00.000Z", lastFromThem: false, body: "leak" },
    { chatId: "15550000002@c.us", label: "B", unreadCount: 3, lastMessageAt: "2026-10-21T06:00:00.000Z", lastFromThem: true },
    { chatId: "15559999999@c.us", label: "Not approved", unreadCount: 9, lastMessageAt: "2026-10-21T07:00:00.000Z", lastFromThem: true },
  ]);
  t.after(() => worker.server.close());
  const env = { ...process.env, ORKESTR_WA_WORKER_URL: worker.url, ORKESTR_WA_WORKER_SOCKET: "", ORKESTR_WA_WORKER_TOKEN: "worker-token" };
  await assert.rejects(runConnectorMcpTool("orkestr_conversation", { service: "whatsapp", action: "list_approved" }, { auth: auth(["whatsapp:read", "whatsapp:send"]), env }), /scope_denied/);
  assert.equal(worker.calls.length, 0);
  const result = await runConnectorMcpTool("orkestr_conversation", { service: "whatsapp", action: "list_approved" }, { auth: auth(["whatsapp:read", "whatsapp:list-approved"]), env });
  const text = JSON.stringify(result);
  const chats = result.data.chats;
  assert.deepEqual(chats.map((chat) => chat.chatId), ["15550000002@c.us", "15550000001@c.us"]);
  assert.deepEqual(Object.keys(chats[0]).sort(), ["chatId", "label", "lastFromThem", "lastMessageAt", "unreadCount"]);
  assert.doesNotMatch(text, /leak|Not approved|15559999999/);
  assert.match(worker.calls[0], /thread_id=thread-swing/);
  assert.doesNotMatch(worker.calls.join(" "), /mark_seen/);
  const unread = await runConnectorMcpTool("orkestr_conversation", { service: "whatsapp", action: "list_approved", unread_only: true }, { auth: auth(["whatsapp:list-approved"]), env });
  assert.deepEqual(unread.data.chats.map((chat) => chat.chatId), ["15550000002@c.us"]);
  await assert.rejects(runConnectorMcpTool("orkestr_conversation", { service: "whatsapp", action: "list_approved" }, { auth: { ...auth(["whatsapp:list-approved"]), threadId: "" }, env }), /thread_required/);
});
