import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deliverWhatsAppReplies, routeWhatsAppInbound } from "../packages/connectors/src/whatsapp.js";
import { syncRemoteWhatsAppThreadMessages } from "../packages/connectors/src/whatsapp-remote-runtime.js";
import { createThread, getThreadMessage, listThreadMessages, updateThreadMessage } from "../packages/core/src/threads.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "remote-parent-recovery-"));
  t.after(() => fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
  const env = {
    HOME: home,
    ORKESTR_HOME: home,
    ORKESTR_THREAD_STORE: "sqlite",
    ORKESTR_THREAD_MESSAGE_STORE: "sqlite",
    ORKESTR_CONNECTOR_OUTBOX_STORE: "sqlite",
    ORKESTR_AUTO_RUN_THREAD_INPUT: "0",
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1",
    ORKESTR_WHATSAPP_API_AGENT_AUTORUN: "0",
    ORKESTR_WHATSAPP_DEBUG_FOOTER: "0",
    ORKESTR_REMOTE_THREAD_BACKENDS_JSON: JSON.stringify({
      example: { baseUrl: "http://runtime.example.test", token: "public-test-token" },
    }),
  };
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "external", bridgeUrl: "http://bridge.example.test", apiToken: "public-test-token",
  }, env);
  await createThread({
    id: "example-thread", name: "Example thread",
    binding: {
      connector: "whatsapp", chatId: "example-chat", responderAccountId: "example-account",
      remoteBackend: "example", remoteThreadId: "example-remote-thread",
    },
  }, env);
  const calls = { input: 0, send: [] };
  let remoteUser;
  let rows = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.host === "runtime.example.test" && parsed.pathname.endsWith("/input")) {
      calls.input += 1;
      const body = JSON.parse(options.body);
      remoteUser = {
        id: "example-remote-user", role: "user", source: body.source, connector: body.connector,
        publicMessageId: body.publicMessageId, publicThreadId: body.publicThreadId,
        chatId: body.chatId, accountId: body.accountId, text: body.text,
        state: "completed", deliveryState: "delivered",
      };
      throw new Error("synthetic_lost_response_after_durable_intake");
    }
    if (parsed.host === "runtime.example.test" && parsed.pathname.endsWith("/messages")) {
      return Response.json({ messages: rows });
    }
    if (parsed.host === "bridge.example.test" && parsed.pathname === "/send-text") {
      calls.send.push(JSON.parse(options.body));
      return Response.json({ ok: true, ids: [`example-sent-${calls.send.length}`] });
    }
    throw new Error(`unexpected synthetic request ${parsed.href}`);
  };
  const input = {
    eventId: "example-source-event", chatId: "example-chat", accountId: "example-account",
    from: "example-participant@lid", text: "An exact synthetic input.",
  };
  const routed = await routeWhatsAppInbound(input, env, fetchImpl);
  assert.equal(routed.remoteRuntime, true);
  assert.equal(routed.message.state, "failed");
  assert.equal(routed.message.remoteMessageId || "", "");
  assert.equal(calls.input, 1);
  const assistant = {
    id: "example-remote-answer", role: "assistant", state: "completed", phase: "final_answer",
    text: "The accepted synthetic answer.", parentMessageId: remoteUser.id,
    chatId: input.chatId, accountId: input.accountId,
  };
  return {
    env, calls, input, routed, remoteUser, assistant, fetchImpl,
    setRows(next) { rows = next; },
  };
}

test("lost POST acknowledgement recovers the exact parent, then mirrors one reply without redispatch", async t => {
  const f = await fixture(t);
  // The response need not be sorted: correlate all users before importing replies.
  f.setRows([f.assistant, f.remoteUser]);
  const first = await deliverWhatsAppReplies(f.env, f.fetchImpl);
  const duplicate = await routeWhatsAppInbound(f.input, f.env, f.fetchImpl);
  const second = await deliverWhatsAppReplies(f.env, f.fetchImpl);
  assert.equal(duplicate.duplicate, true);
  assert.equal(f.calls.input, 1);
  assert.equal(first.delivered.length, 1);
  assert.equal(second.delivered.length, 0);
  assert.equal(f.calls.send.length, 1);
  assert.equal(f.calls.send[0].to, f.input.chatId);
  assert.match(f.calls.send[0].text, /The accepted synthetic answer/);
  const rows = await listThreadMessages("example-thread", f.env);
  assert.equal(rows.filter(row => row.role === "user").length, 1);
  const parent = rows.find(row => row.id === f.routed.message.id);
  assert.equal(parent.remoteMessageId, f.remoteUser.id);
  assert.equal(parent.state, "completed");
  assert.equal(parent.deliveryState, "delivered");
  const replies = rows.filter(row => row.role === "assistant");
  assert.equal(replies.length, 1);
  assert.equal(replies[0].parentMessageId, parent.id);
});

for (const [field, value] of [
  ["publicMessageId", "unrelated-local-message"],
  ["publicThreadId", "unrelated-thread"],
  ["chatId", "unrelated-chat"],
  ["accountId", "unrelated-account"],
  ["source", "ui"],
  ["connector", "other"],
  ["text", "An exact synthetic input. "],
]) {
  test(`lost acknowledgement recovery refuses a remote ${field} mismatch`, async t => {
    const f = await fixture(t);
    f.setRows([{ ...f.remoteUser, [field]: value }, f.assistant]);
    await syncRemoteWhatsAppThreadMessages(f.env, f.fetchImpl);
    const rows = await listThreadMessages("example-thread", f.env);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].remoteMessageId || "", "");
    assert.equal(rows[0].state, "failed");
    assert.equal(f.calls.input, 1);
    assert.equal(f.calls.send.length, 0);
  });
}

for (const [field, value] of [
  ["remoteBackend", "different-backend"],
  ["remoteThreadId", "different-remote-thread"],
  ["remoteMessageId", "already-mapped-other-id"],
  ["source", "ui"],
  ["connector", "other"],
  ["chatId", "different-chat"],
  ["accountId", "different-account"],
  ["text", "Edited local input"],
]) {
  test(`lost acknowledgement recovery preserves a conflicting local ${field}`, async t => {
    const f = await fixture(t);
    const before = await updateThreadMessage("example-thread", f.routed.message.id, { [field]: value }, f.env);
    f.setRows([f.remoteUser, f.assistant]);
    await syncRemoteWhatsAppThreadMessages(f.env, f.fetchImpl);
    assert.deepEqual(await getThreadMessage("example-thread", before.id, f.env), before);
    assert.equal((await listThreadMessages("example-thread", f.env)).length, 1);
  });
}

test("two remote identities cannot claim the same previously unacknowledged parent", async t => {
  const f = await fixture(t);
  f.setRows([f.remoteUser, { ...f.remoteUser, id: "another-remote-user" }, f.assistant]);
  await syncRemoteWhatsAppThreadMessages(f.env, f.fetchImpl);
  const rows = await listThreadMessages("example-thread", f.env);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].remoteMessageId || "", "");
});

test("a stale recovery snapshot cannot overwrite a concurrently recorded acknowledgement", async t => {
  const f = await fixture(t);
  const stale = await getThreadMessage("example-thread", f.routed.message.id, f.env);
  const current = await updateThreadMessage("example-thread", stale.id, {
    remoteMessageId: "a-different-acknowledgement",
  }, f.env);
  await assert.rejects(updateThreadMessage("example-thread", stale.id, {
    remoteMessageId: f.remoteUser.id, state: "completed",
  }, f.env, { expectedFields: { remoteMessageId: stale.remoteMessageId } }), {
    message: "message_fields_conflict", statusCode: 409,
  });
  assert.deepEqual(await getThreadMessage("example-thread", stale.id, f.env), current);
});

test("durable remote intake clears the forwarding error before model completion", async t => {
  const f = await fixture(t);
  f.setRows([{ ...f.remoteUser, state: "delivered" }]);
  await syncRemoteWhatsAppThreadMessages(f.env, f.fetchImpl);
  const parent = await getThreadMessage("example-thread", f.routed.message.id, f.env);
  assert.equal(parent.remoteMessageId, f.remoteUser.id);
  assert.equal(parent.state, "delivered");
  assert.equal(parent.deliveryState, "delivered");
  assert.equal(parent.error, null);
  assert.equal(f.calls.input, 1);
  assert.equal(f.calls.send.length, 0);
});
