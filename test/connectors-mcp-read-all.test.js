import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { runConnectorMcpTool } from "../packages/connectors/src/connectors-mcp-operations.js";
import { assertConnectorMcpScope } from "../packages/connectors/src/connectors-mcp-auth.js";

async function fakeWorker() {
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url.startsWith("/accounts/sender/chats/page")) {
      const cursor = new URL(req.url, "http://x").searchParams.get("cursor");
      res.end(JSON.stringify(cursor
        ? { ok: true, ready: true, source: "chats", chats: [{ chatId: "c@c.us", unreadCount: 0 }], hasMore: false, nextCursor: null, total: 3 }
        : { ok: true, ready: true, source: "chats", chats: [{ chatId: "a@c.us", unreadCount: 2 }, { chatId: "b@c.us", unreadCount: 0 }], hasMore: true, nextCursor: "next-1", total: 3 }));
      return;
    }
    if (req.url.includes("/history")) { res.end(JSON.stringify({ ok: true, ready: true, messages: [{ id: "m1" }], hasMore: true, nextCursor: "m1" })); return; }
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { calls, server, url: `http://127.0.0.1:${server.address().port}` };
}

const auth = (scopes, extra = {}) => ({
  tokenId: "swing", scopes, principalKind: "thread", ownerUserId: "admin", threadId: "thread-swing", accountId: "sender", accountService: "whatsapp",
  allowedChatIds: ["120000000001@g.us"], allowedRecipients: ["15550000001@c.us"], operator: false, ...extra,
});
const run = (input, a, env) => runConnectorMcpTool("orkestr_conversation", { service: "whatsapp", ...input }, { auth: a, env });

test("read-all pages every chat and any history; plain read stays on the allowlist", async (t) => {
  const worker = await fakeWorker();
  t.after(() => worker.server.close());
  const env = { ...process.env, ORKESTR_WA_WORKER_URL: worker.url, ORKESTR_WA_WORKER_SOCKET: "", ORKESTR_WA_WORKER_TOKEN: "worker-token" };
  const readAll = auth(["whatsapp:read", "whatsapp:send", "whatsapp:read-all"]);
  const first = await run({ action: "list_all", limit: 2 }, readAll, env);
  assert.deepEqual([first.data.chats.length, first.data.hasMore, first.data.nextCursor, first.data.total], [2, true, "next-1", 3]);
  const second = await run({ action: "list_all", cursor: first.data.nextCursor }, readAll, env);
  assert.deepEqual([second.data.chats.length, second.data.hasMore, second.data.nextCursor], [1, false, null]);
  assert.match(worker.calls[1], /cursor=next-1/);
  assert.match(worker.calls[0], /thread_id=thread-swing/);
  await run({ action: "list_all", unread_only: true }, readAll, env);
  assert.match(worker.calls.at(-1), /unread=1/, "unread filtering happens in the worker, before paging");
  const history = await run({ action: "history", conversation_id: "19990000000@c.us", limit: 1, before: "m9" }, readAll, env);
  assert.equal(history.status, "ok");
  assert.match(worker.calls.at(-1), /page=1&mark_seen=false&before=m9/);

  // Without read-all: no listing, and non-approved history is refused.
  const plain = auth(["whatsapp:read", "whatsapp:send"]);
  const before = worker.calls.length;
  await assert.rejects(run({ action: "list_all" }, plain, env), /scope_denied/);
  await assert.rejects(run({ action: "history", conversation_id: "19990000000@c.us" }, plain, env), /conversation_scope_denied/);
  assert.equal(worker.calls.length, before);
  // A threadless token cannot use read-all.
  // A threadless bearer cannot use read-all, even by naming a thread in the request.
  const calls = worker.calls.length;
  for (const input of [{ action: "list_all" }, { action: "list_all", thread_id: "thread-swing" }]) {
    const threadless = await run(input, auth(["whatsapp:read-all"], { threadId: "" }), env);
    assert.equal(threadless.status, "error", JSON.stringify(input));
  }
  await assert.rejects(run({ action: "history", conversation_id: "19990000000@c.us", thread_id: "thread-swing" }, auth(["whatsapp:read", "whatsapp:read-all"], { threadId: "" }), env), /conversation_scope_denied/);
  assert.equal(worker.calls.length, calls);
});

test("read-all never widens sending: send to a non-approved chat stays denied", () => {
  const readAll = auth(["whatsapp:read", "whatsapp:send", "whatsapp:read-all"]);
  assert.throws(() => assertConnectorMcpScope(readAll, "orkestr_messaging", { service: "whatsapp", action: "send", conversation_id: "19990000000@c.us" }), /conversation_scope_denied/);
  assert.doesNotThrow(() => assertConnectorMcpScope(readAll, "orkestr_messaging", { service: "whatsapp", action: "send", conversation_id: "15550000001@c.us" }));
  for (const action of ["create", "participants", "recover"]) {
    assert.throws(() => assertConnectorMcpScope(readAll, "orkestr_conversation", { service: "whatsapp", action, conversation_id: "19990000000@c.us" }), /denied/, action);
  }
});
