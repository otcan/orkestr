// Replies to V2 timer turns relayed by the multi-chat adapter get one local,
// non-executing parent so they are mirrored and acknowledged like any reply.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deliverWhatsAppReplies } from "../packages/connectors/src/whatsapp.js";
import { appendThreadMessage, createThread, listThreadMessages } from "../packages/core/src/threads.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";
import { listEvents } from "../packages/storage/src/store.js";
import { upsertWhatsAppConnectorAccount } from "../packages/connectors/src/whatsapp-account-registry.js";

const timerRowId = "0b6c1f5e-8f3a-4c2d-9e7b-1a2b3c4d5e6f";

function timerRow(overrides = {}) {
  return {
    id: timerRowId, role: "user", text: "Scheduled check-in (synthetic timer).",
    publicMessageId: `v2timer-${timerRowId}`, publicThreadId: "example-thread",
    chatId: "example-chat", accountId: "example-account",
    source: "orkestr-v2-timer", connector: "orkestr-v2-timer", origin: "timer",
    timerNamespace: "5d4c3b2a-1f0e-4d9c-8b7a-6f5e4d3c2b1a", timerSourceId: "example-timer",
    state: "delivered", deliveryState: "delivered", observedVia: "rust-pilot-ledger",
    createdAt: "2026-10-20T08:00:00.000Z",
    ...overrides,
  };
}

async function fixture(t, rows, binding = {}, health = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "remote-timer-parent-"));
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
      ...binding,
    },
  }, env);
  const runtime = { inputs: [], acks: [], other: [], healthReads: 0 };
  const sends = [];
  const reply = {
    id: "example-timer-final", role: "assistant", state: "completed", phase: "final_answer",
    parentMessageId: rows[0]?.id || timerRowId, exportSequence: 1, source: "rust-v2-pilot", text: "Timer check-in done.",
  };
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    const body = options.body ? JSON.parse(options.body) : null;
    if (parsed.host === "runtime.example.test") {
      if (parsed.pathname.endsWith("/messages")) {
        return Response.json({ ok: true, messages: reply.acked ? rows : [...rows, reply], mirrorAck: { version: 1, ackedThrough: 0 } });
      }
      if (parsed.pathname.endsWith("/mirror-acks")) {
        runtime.acks.push(body);
        if (body.outcome === "delivered") reply.acked = true;
        return Response.json({ ok: true, sequence: 1, ackedThrough: 1 });
      }
      if (parsed.pathname.endsWith("/input")) runtime.inputs.push(body);
      else runtime.other.push(parsed.pathname);
      return Response.json({ ok: true });
    }
    if (parsed.host === "bridge.example.test" && parsed.pathname === "/send-text") {
      sends.push(body);
      return Response.json({ ok: true, ids: [`example-sent-${sends.length}`] });
    }
    if (parsed.host === "bridge.example.test" && parsed.pathname === "/health") {
      runtime.healthReads += 1;
      return Response.json({ ok: true, ready: true, accounts: [], ...health });
    }
    throw new Error(`unexpected synthetic request ${parsed.href}`);
  };
  return { env, runtime, sends, deliver: () => deliverWhatsAppReplies(env, fetchImpl) };
}

test("unresolvable timer identities share one bridge lookup per poll and refresh on the next", async t => {
  const otherId = "0b6c1f5e-8f3a-4c2d-9e7b-1a2b3c4d5e70";
  const f = await fixture(t, [timerRow({ accountId: "sender" }),
    timerRow({ id: otherId, publicMessageId: `v2timer-${otherId}`, accountId: "sender" })],
    { responderAccountId: "15550001001" });
  await upsertWhatsAppConnectorAccount({ accountId: "sender", runtimeAccountId: "sender" }, f.env);
  await f.deliver();
  assert.equal(f.runtime.healthReads, 1);
  await f.deliver();
  assert.equal(f.runtime.healthReads, 2);
  assert.deepEqual(await listThreadMessages("example-thread", f.env), []);
  assert.equal(f.sends.length, 0);
});

test("foreign timer shape is refused before bridge account lookup", async t => {
  const f = await fixture(t, [timerRow({ accountId: "sender", publicThreadId: "other-thread" })],
    { responderAccountId: "15550001001" }, { accounts: [{ accountId: "sender", phoneNumber: "15550001001", ready: true }] });
  await upsertWhatsAppConnectorAccount({ accountId: "sender", runtimeAccountId: "sender" }, f.env);
  await f.deliver();
  assert.equal(f.runtime.healthReads, 0);
  assert.equal(f.sends.length, 0);
});

for (const [bound, received] of [["15550001001", "sender"], ["sender", "15550001001"]]) {
  test(`legacy alias-only registry resolves verified bridge identity ${bound} → ${received}`, async t => {
    const f = await fixture(t, [timerRow({ accountId: received })], { responderAccountId: bound },
      { accounts: [{ accountId: "sender", phoneNumber: "15550001001", ready: true }] });
    await upsertWhatsAppConnectorAccount({ accountId: "sender", runtimeAccountId: "sender" }, f.env);
    await f.deliver();
    await f.deliver();
    assert.equal(f.sends.length, 1);
    assert.equal(f.runtime.acks.length, 1);
    assert.deepEqual(f.runtime.inputs, []);
    assert.equal((await listThreadMessages("example-thread", f.env)).length, 2);
  });
}

for (const reason of ["not ready", "wrong physical account", "ambiguous bridge", "unregistered", "foreign owner", "ambiguous registry"]) {
  test(`legacy timer alias bridge proof refuses ${reason}`, async t => {
    const observed = { accountId: "sender", phoneNumber: reason === "wrong physical account" ? "15550001002" : "15550001001", ready: reason !== "not ready" };
    const f = await fixture(t, [timerRow({ accountId: "sender" })], { responderAccountId: "15550001001" },
      { accounts: reason === "ambiguous bridge" ? [observed, observed] : [observed] });
    if (reason !== "unregistered") await upsertWhatsAppConnectorAccount({ accountId: "sender", runtimeAccountId: "sender",
      ...(reason === "foreign owner" ? { ownerUserId: "another-owner" } : {}) }, f.env);
    if (reason === "ambiguous registry") await upsertWhatsAppConnectorAccount({ accountId: "other-account", runtimeAccountId: "sender" }, f.env);
    await f.deliver();
    assert.deepEqual(await listThreadMessages("example-thread", f.env), []);
    assert.equal(f.sends.length, 0);
    assert.deepEqual(f.runtime.acks, []);
  });
}

test("a V2 timer row gives its reply one local parent that is mirrored and acknowledged", async t => {
  const f = await fixture(t, [timerRow()]);
  await f.deliver();
  await f.deliver();

  const messages = await listThreadMessages("example-thread", f.env);
  const users = messages.filter((row) => row.role === "user");
  assert.equal(users.length, 1);
  const [parent] = users;
  assert.equal(parent.id, `v2timer-${timerRowId}`);
  assert.equal(parent.source, "orkestr-v2-timer");
  assert.equal(parent.state, "completed");
  assert.equal(parent.connector, undefined);
  assert.equal(parent.chatId, undefined);
  assert.equal(parent.remoteBackend, "example");
  assert.equal(parent.remoteThreadId, "example-remote-thread");
  assert.equal(parent.remoteMessageId, timerRowId);
  assert.equal(parent.timerId, "example-timer");
  assert.equal(parent.createdAt, "2026-10-20T08:00:00.000Z");

  const replies = messages.filter((row) => row.role === "assistant");
  assert.equal(replies.length, 1);
  assert.equal(replies[0].parentMessageId, parent.id);
  assert.equal(replies[0].remoteMessageId, "example-timer-final");

  // Only the reply reaches WhatsApp; the timer row is never sent or forwarded.
  assert.equal(f.sends.length, 1);
  assert.match(f.sends[0].text, /Timer check-in done\./);
  assert.doesNotMatch(f.sends[0].text, /Scheduled check-in/);
  assert.deepEqual(f.runtime.inputs, []);
  assert.deepEqual(f.runtime.other, []);

  assert.equal(f.runtime.acks.length, 1);
  assert.equal(f.runtime.acks[0].outcome, "delivered");
  assert.equal(f.runtime.acks[0].parentPublicMessageId, `v2timer-${timerRowId}`);
  assert.equal(f.runtime.acks[0].remoteMessageId, "example-timer-final");

  // Re-sync is idempotent: no second parent, reply, send, or ack.
  await f.deliver();
  await f.deliver();
  const again = await listThreadMessages("example-thread", f.env);
  assert.equal(again.filter((row) => row.role === "user").length, 1);
  assert.equal(again.filter((row) => row.role === "assistant").length, 1);
  assert.equal(again.find((row) => row.role === "user").state, "completed");
  assert.equal(f.sends.length, 1);
  assert.equal(f.runtime.acks.length, 1);
});

test("a V2 conversation post row keeps its known author on the local parent", async t => {
  for (const [postAuthor, expected] of [["operator", "operator"], ["coordinator", "coordinator"], ["someone-else", undefined]]) {
    const f = await fixture(t, [timerRow({ text: "Operator", timerSourceId: "post", postAuthor })]);
    await f.deliver();
    const parent = (await listThreadMessages("example-thread", f.env)).find((row) => row.role === "user");
    assert.equal(parent.timerId, "post");
    assert.equal(parent.postAuthor, expected);
    const reply = (await listThreadMessages("example-thread", f.env)).find((row) => row.role === "assistant");
    assert.equal(reply.remoteLayer, expected === "coordinator" ? "coordinator" : undefined,
      "the first import uses its just-materialized post parent and never labels a post Deep");
    if (expected === "coordinator") {
      assert.equal(reply.remoteProvider, undefined);
      assert.equal(reply.remoteModel, undefined);
    }
  }
});

for (const [boundAccount, remoteAccount] of [["example-account", "example-runtime"], ["example-runtime", "example-account"]]) {
test(`registered timer account identities ${boundAccount} → ${remoteAccount} deliver exactly once`, async t => {
  const f = await fixture(t, [timerRow({ accountId: remoteAccount })], { responderAccountId: boundAccount });
  await upsertWhatsAppConnectorAccount({ accountId: "example-account", runtimeAccountId: "example-runtime" }, f.env);
  await f.deliver();
  await f.deliver();
  const messages = await listThreadMessages("example-thread", f.env);
  assert.equal(messages.filter(row => row.role === "user").length, 1);
  assert.equal(messages.filter(row => row.role === "assistant").length, 1);
  assert.equal(f.sends.length, 1);
  assert.equal(f.runtime.acks.length, 1);
  assert.equal(f.runtime.acks[0].parentPublicMessageId, `v2timer-${timerRowId}`);
  assert.deepEqual(f.runtime.inputs, []);
});
}

for (const reason of ["unregistered", "ambiguous", "foreign owner", "disabled", "revoked", "foreign chat", "foreign thread"]) {
  test(`a timer account alias is refused when ${reason}`, async t => {
    const f = await fixture(t, [timerRow({ accountId: "example-runtime",
      ...(reason === "foreign chat" ? { chatId: "other-chat" } : {}),
      ...(reason === "foreign thread" ? { publicThreadId: "other-thread" } : {}),
    })]);
    if (reason !== "unregistered") await upsertWhatsAppConnectorAccount({
      accountId: "example-account", runtimeAccountId: "example-runtime",
      ...(reason === "foreign owner" ? { ownerUserId: "another-owner" } : {}),
      ...(["disabled", "revoked"].includes(reason) ? { status: reason } : {}),
    }, f.env);
    if (reason === "ambiguous") await upsertWhatsAppConnectorAccount({ accountId: "other-account", runtimeAccountId: "example-runtime" }, f.env);
    await f.deliver();
    assert.deepEqual(await listThreadMessages("example-thread", f.env), []);
    assert.equal(f.sends.length, 0);
    assert.deepEqual(f.runtime.acks, []);
    assert.deepEqual(f.runtime.inputs, []);
  });
}

test("materializing a V2 timer parent records one server event for the relay's notification proof", async t => {
  const f = await fixture(t, [timerRow()]);
  await f.deliver();
  await f.deliver();
  const events = (await listEvents(f.env, 500)).filter((event) => event.type === "whatsapp_remote_timer_parent_materialized");
  assert.equal(events.length, 1);
  assert.equal(events[0].target, "example-thread");
  assert.equal(events[0].targetType, "thread");
  assert.equal(events[0].messageId, `v2timer-${timerRowId}`);
  assert.equal(events[0].remoteThreadId, "example-remote-thread");
  assert.equal(events[0].remoteMessageId, timerRowId);
});

for (const [name, overrides] of [
  ["another thread", { publicThreadId: "other-thread" }],
  ["another chat", { chatId: "other-chat" }],
  ["another account", { accountId: "other-account" }],
  ["a wrong public id prefix", { publicMessageId: `timer-${timerRowId}` }],
  ["a non-timer origin", { origin: "whatsapp" }],
  ["a non-uuid id", { id: "not-a-uuid", publicMessageId: "v2timer-not-a-uuid" }],
]) {
  test(`a V2 timer row for ${name} is ignored and its reply stays an orphan`, async t => {
    const f = await fixture(t, [timerRow(overrides)]);
    await f.deliver();
    await f.deliver();
    const messages = await listThreadMessages("example-thread", f.env);
    assert.deepEqual(messages, []);
    assert.equal(f.sends.length, 0);
    assert.deepEqual(f.runtime.acks, []);
    assert.deepEqual(f.runtime.inputs, []);
  });
}

for (const store of ["json", "sqlite"]) {
  test(`appendThreadMessage honors a requested message id once (${store} store)`, async t => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "requested-message-id-"));
    t.after(() => fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }));
    const env = { HOME: home, ORKESTR_HOME: home, ORKESTR_AUTO_RUN_THREAD_INPUT: "0",
      ...(store === "sqlite" ? { ORKESTR_THREAD_STORE: "sqlite", ORKESTR_THREAD_MESSAGE_STORE: "sqlite" } : {}) };
    await createThread({ id: "example-thread", name: "Example thread" }, env);
    const input = { requestedMessageId: "v2timer-example", role: "user", source: "orkestr-v2-timer", state: "completed", text: "tick" };
    const first = await appendThreadMessage("example-thread", input, env);
    assert.equal(first.id, "v2timer-example");
    assert.equal(first.duplicate, undefined);
    const second = await appendThreadMessage("example-thread", { ...input, text: "tock" }, env);
    assert.equal(second.duplicate, true);
    assert.equal(second.text, "tick");
    assert.equal((await listThreadMessages("example-thread", env)).length, 1);
    await assert.rejects(appendThreadMessage("example-thread", { ...input, requestedMessageId: "bad id/" }, env), /invalid_message_id/);
  });
}
