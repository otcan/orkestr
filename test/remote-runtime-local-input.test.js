// V1-local input on a delegated thread is forwarded to the remote runtime
// (Orkestr V2) instead of being dropped. Synthetic ids, a fake adapter, no
// network.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { forwardLocalInputToRemote, resetLocalInputKindsCacheForTest } from "../packages/connectors/src/whatsapp-remote-local-input.js";
import { syncRemoteWhatsAppThreadMessages } from "../packages/connectors/src/whatsapp-remote-runtime.js";
import { routeHeldLocalInputs } from "../packages/core/src/remote-runtime-held-inputs.js";
import { deliverPendingThreadInputs, resetThreadInputDeliveryTimersForTest } from "../packages/core/src/runtime-leases.js";
import { processThreadWatch } from "../packages/core/src/thread-watch-pump.js";
import { createThreadWatch, readThreadWatches } from "../packages/core/src/thread-watches.js";
import { appendThreadMessage, createThread, getThreadMessage, listThreadMessages, updateThread } from "../packages/core/src/threads.js";
import { listEvents } from "../packages/storage/src/store.js";

const binding = {
  connector: "whatsapp",
  chatId: "example-chat@g.us",
  responderAccountId: "example-account",
  remoteBackend: "example-backend",
  remoteThreadId: "example-remote-thread",
  remoteRuntimeEnabled: true,
  mirrorToWhatsApp: false,
};

// A minimal adapter: idempotent intake keyed by public message id, health,
// listing and acknowledgements.
function fakeAdapter({ kinds = ["whatsapp_inbound", "v1_local"] } = {}) {
  const state = { kinds, inputs: new Map(), posts: [], acks: [], replies: [], fail: null, loseResponse: false };
  state.fetch = async (url, options = {}) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.host, "adapter.example.test");
    assert.equal(options.headers.authorization, "Bearer public-test-token");
    if (parsed.pathname.endsWith("/health")) return Response.json({ ok: true, state: "enabled", inputKinds: state.kinds });
    if (parsed.pathname.endsWith("/input")) {
      const body = JSON.parse(options.body);
      state.posts.push(body);
      if (state.fail) return Response.json({ ok: false, error: state.fail.error }, { status: state.fail.status });
      const prior = state.inputs.get(body.publicMessageId);
      if (prior && prior.text !== body.text) return Response.json({ ok: false, error: "input_identity_changed" }, { status: 409 });
      const row = prior || { id: `remote-${state.inputs.size + 1}`, body, text: body.text };
      state.inputs.set(body.publicMessageId, row);
      if (state.loseResponse) { state.loseResponse = false; throw new Error("synthetic_lost_response"); }
      return Response.json({ ok: true, duplicate: Boolean(prior), message: { id: row.id, role: "user", state: "delivered", deliveryState: "delivered", observedVia: "rust-pilot-ledger" } }, { status: prior ? 200 : 202 });
    }
    if (parsed.pathname.endsWith("/messages")) {
      const messages = [];
      for (const [publicId, row] of state.inputs) {
        messages.push({ id: row.id, role: "user", text: row.text, publicMessageId: publicId, publicThreadId: row.body.publicThreadId,
          chatId: row.body.chatId, accountId: row.body.accountId, source: row.body.source, connector: "orkestr-v1", origin: "v1_local",
          state: "delivered", deliveryState: "delivered" });
        messages.push(...state.replies.filter(reply => reply.parentMessageId === row.id));
      }
      return Response.json({ ok: true, messages, mirrorAck: { version: 1, ackedThrough: 0, outstandingInputs: state.inputs.size } });
    }
    if (parsed.pathname.endsWith("/mirror-acks")) {
      state.acks.push(JSON.parse(options.body));
      return Response.json({ ok: true, sequence: state.acks.length, ackedThrough: state.acks.length, settled: true });
    }
    throw new Error(`unexpected ${parsed.pathname}`);
  };
  state.reply = (publicId, text, extra = {}) => {
    const input = state.inputs.get(publicId);
    state.replies.push({ id: `reply-${state.replies.length + 1}`, role: "assistant", state: "completed", phase: "final_answer",
      kind: "final", source: "rust-v2-pilot", parentMessageId: input.id, text, exportSequence: state.replies.length + 1, ...extra });
  };
  return state;
}

async function fixture(t, extraBinding = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "remote-local-input-"));
  const env = {
    HOME: home, ORKESTR_HOME: home, PATH: process.env.PATH,
    ORKESTR_CLAUDE_CODE_ENABLED: "0", ORKESTR_AUTO_RUN_THREAD_INPUT: "0",
    ORKESTR_CODEX_BIN: path.join(home, "missing-codex"),
    ORKESTR_REMOTE_THREAD_BACKENDS_JSON: JSON.stringify({
      "example-backend": { baseUrl: "http://adapter.example.test", token: "public-test-token" },
    }),
  };
  await createThread({ id: "example-thread", name: "Example PA", ownerUserId: "admin", binding: { ...binding, ...extraBinding } }, env);
  await createThread({ id: "example-requester", name: "Example KDP", ownerUserId: "admin" }, env);
  resetLocalInputKindsCacheForTest();
  t.after(async () => {
    resetThreadInputDeliveryTimersForTest();
    resetLocalInputKindsCacheForTest();
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  return env;
}

const thread = async env => (await import("../packages/core/src/threads.js")).getThread("example-thread", env);
const queue = (env, fields) => appendThreadMessage("example-thread", { role: "user", state: "queued", ...fields }, env);
const events = async (env, type) => (await listEvents(env, 500)).filter(e => e.type === type);

test("every non-WhatsApp input type is forwarded with its source and origin; V1 timers stay fenced", async t => {
  const env = await fixture(t);
  const adapter = fakeAdapter();
  const rows = {
    mail: await queue(env, { source: "mailbox_route", connector: "mailbox", text: "Example mail signal", clientMessageId: "mailbox-route-work:example" }),
    watch: await queue(env, { source: "thread_watch", text: "Example watch result", threadWatchId: "watch_example", threadWatchSourceThreadId: "example-requester" }),
    report: await queue(env, { source: "cli", text: "Example agent report", reportSourceThreadId: "example-requester", reportKind: "result" }),
    cli: await queue(env, { source: "cli", text: "Example CLI send" }),
    ui: await queue(env, { source: "ui", text: "Example UI message" }),
    bridge: await queue(env, { source: "thread_bridge_message", text: "Example bridge message", bridgeAgentId: "example-agent" }),
    worker: await queue(env, { source: "worker_assignment", text: "Example assignment" }),
    prompt: await queue(env, { source: "cli", text: "", promptFile: "/example/prompt.md" }),
    timer: await queue(env, { source: "timer_due", timerId: "example-timer", text: "Example timer run" }),
    executor: await queue(env, { source: "ui", text: "/codex" }),
  };
  const routed = await routeHeldLocalInputs(await thread(env), env, { fetchImpl: adapter.fetch, forward: forwardLocalInputToRemote });
  assert.deepEqual(routed.dropped.sort(), [rows.timer.id, rows.executor.id].sort());
  assert.equal(routed.forwarded.length, 8);
  const posted = Object.fromEntries(adapter.posts.map(body => [body.publicMessageId, body]));
  for (const body of adapter.posts) {
    assert.equal(body.inputKind, "v1_local");
    assert.equal(body.connector, "orkestr-v1");
    assert.equal(body.publicThreadId, "example-thread");
    assert.equal(body.chatId, "example-chat@g.us");
    assert.equal(body.accountId, "example-account");
  }
  assert.deepEqual(posted[rows.mail.id].origin, { role: "external", label: "Mailbox route" });
  assert.equal(posted[rows.mail.id].source, "mailbox_route");
  assert.equal(posted[rows.mail.id].externalId, "mailbox-route-work:example");
  assert.deepEqual(posted[rows.watch.id].origin, { role: "agent", label: "Example KDP", senderRef: "example-requester" });
  assert.deepEqual(posted[rows.report.id].origin, { role: "agent", label: "Example KDP", senderRef: "example-requester" });
  assert.deepEqual(posted[rows.cli.id].origin, { role: "agent", label: "Orkestr CLI" });
  assert.deepEqual(posted[rows.ui.id].origin, { role: "owner", label: "Orkestr web UI" });
  assert.deepEqual(posted[rows.bridge.id].origin, { role: "agent", label: "Connected assistant", senderRef: "example-agent" });
  assert.deepEqual(posted[rows.worker.id].origin, { role: "agent", label: "Worker assignment" });
  assert.equal(posted[rows.prompt.id].text, "Run the prompt file: /example/prompt.md");
  for (const key of ["mail", "watch", "report", "cli", "ui", "bridge", "worker", "prompt"]) {
    const current = await getThreadMessage("example-thread", rows[key].id, env);
    assert.equal(current.state, "delivered", key);
    assert.equal(current.remoteInputKind, "v1_local");
    assert.equal(current.remoteMessageId, adapter.inputs.get(rows[key].id).id);
    assert.equal(current.remoteBackend, "example-backend");
  }
  for (const key of ["timer", "executor"]) {
    const current = await getThreadMessage("example-thread", rows[key].id, env);
    assert.equal(current.state, "failed");
    assert.equal(current.error, "thread_delegated_to_remote_runtime");
  }
  assert.equal((await events(env, "remote_runtime_local_input_forwarded")).length, 8);
  // Acknowledged inputs are never forwarded again.
  await routeHeldLocalInputs(await thread(env), env, { fetchImpl: adapter.fetch, forward: forwardLocalInputToRemote });
  await deliverPendingThreadInputs("example-thread", env);
  assert.equal(adapter.posts.length, 8);
});

test("a lost acknowledgement is re-sent once and the adapter answers with the same remote id", async t => {
  const env = await fixture(t);
  const adapter = fakeAdapter();
  const row = await queue(env, { source: "mailbox_route", connector: "mailbox", text: "Example mail signal" });
  adapter.loseResponse = true;
  const first = await routeHeldLocalInputs(await thread(env), env, { fetchImpl: adapter.fetch, forward: forwardLocalInputToRemote });
  assert.deepEqual(first.held, [row.id]);
  assert.equal((await getThreadMessage("example-thread", row.id, env)).state, "queued");
  // The periodic sync (as after a restart) retries the same idempotent input.
  await syncRemoteWhatsAppThreadMessages(env, adapter.fetch);
  assert.equal(adapter.posts.length, 2);
  assert.equal(adapter.inputs.size, 1);
  const current = await getThreadMessage("example-thread", row.id, env);
  assert.equal(current.remoteMessageId, "remote-1");
  assert.equal(current.state, "delivered");
});

test("a lost acknowledgement is also recovered from the adapter listing without a re-send", async t => {
  const env = await fixture(t);
  const adapter = fakeAdapter();
  const row = await queue(env, { source: "ui", text: "Example UI message" });
  adapter.loseResponse = true;
  await routeHeldLocalInputs(await thread(env), env, { fetchImpl: adapter.fetch, forward: forwardLocalInputToRemote });
  // An operator hold stops forwarding; the listing still maps the parent.
  await updateThread("example-thread", { queueDispatchHold: { paused: true } }, env);
  await syncRemoteWhatsAppThreadMessages(env, adapter.fetch);
  assert.equal(adapter.posts.length, 1);
  const current = await getThreadMessage("example-thread", row.id, env);
  assert.equal(current.remoteMessageId, "remote-1");
  assert.equal(current.remoteInputKind, "v1_local");
});

test("the reply reaches the requesting thread as its watch result, stays off WhatsApp and settles as suppressed", async t => {
  const env = await fixture(t);
  const adapter = fakeAdapter();
  await createThreadWatch({ watcherThreadId: "example-requester", targetThreadId: "example-thread", mode: "once", on: "final" }, env);
  const request = await queue(env, { source: "cli", text: "What is the KDP status?", reportSourceThreadId: "example-requester" });
  const silent = await queue(env, { source: "mailbox_route", connector: "mailbox", text: "Example mail signal" });
  await routeHeldLocalInputs(await thread(env), env, { fetchImpl: adapter.fetch, forward: forwardLocalInputToRemote });
  adapter.reply(request.id, "KDP is on track.");
  adapter.reply(silent.id, "NO_REPLY", { noReply: true });
  await syncRemoteWhatsAppThreadMessages(env, adapter.fetch);
  const replies = (await listThreadMessages("example-thread", env)).filter(m => m.role === "assistant");
  const answer = replies.find(m => m.parentMessageId === request.id);
  assert.equal(answer.text, "KDP is on track.");
  assert.equal(answer.phase, "final_answer");
  assert.equal(answer.deliveryState, "suppressed");
  assert.equal(answer.connector || "", "");
  assert.equal(answer.chatId || "", "");
  // Mirror acknowledgements settle both inputs without a WhatsApp send.
  await syncRemoteWhatsAppThreadMessages(env, adapter.fetch);
  const acks = Object.fromEntries(adapter.acks.map(ack => [ack.parentPublicMessageId, ack]));
  assert.equal(acks[request.id].outcome, "suppressed");
  assert.equal(acks[silent.id].outcome, "no_reply");
  assert.equal(adapter.acks.length, 2);
  // The requester's watch fires with the reply, as for a V1 reply.
  const [watch] = await readThreadWatches(env);
  const patch = await processThreadWatch(watch, env);
  assert.equal(patch.status, "fired");
  const delivered = (await listThreadMessages("example-requester", env)).find(m => m.source === "thread_watch");
  assert.match(delivered.text, /KDP is on track\./);
  assert.equal(delivered.threadWatchSourceMessageId, answer.id);
});

test("an adapter without v1_local holds input queued, then fails it visibly after the maximum age", async t => {
  const env = await fixture(t);
  const adapter = fakeAdapter({ kinds: ["whatsapp_inbound"] });
  const row = await queue(env, { source: "ui", text: "Example UI message" });
  const first = await routeHeldLocalInputs(await thread(env), env, { fetchImpl: adapter.fetch, forward: forwardLocalInputToRemote });
  assert.deepEqual(first.held, [row.id]);
  await routeHeldLocalInputs(await thread(env), env, { fetchImpl: adapter.fetch, forward: forwardLocalInputToRemote });
  assert.equal(adapter.posts.length, 0);
  const held = await getThreadMessage("example-thread", row.id, env);
  assert.equal(held.state, "queued");
  assert.equal(held.remoteForwardHeld, "remote_runtime_local_input_unsupported");
  assert.equal((await events(env, "remote_runtime_local_input_held")).length, 1);
  const later = new Date(Date.parse(row.createdAt) + 25 * 60 * 60 * 1000);
  resetLocalInputKindsCacheForTest();
  const expired = await routeHeldLocalInputs(await thread(env), env, { fetchImpl: adapter.fetch, forward: forwardLocalInputToRemote, now: later });
  assert.deepEqual(expired.failed, [row.id]);
  const failed = await getThreadMessage("example-thread", row.id, env);
  assert.equal(failed.state, "failed");
  assert.equal(failed.error, "remote_runtime_input_expired:remote_runtime_local_input_unsupported");
});

test("transient refusals keep input queued; a definite refusal fails it visibly", async t => {
  const env = await fixture(t);
  const adapter = fakeAdapter();
  const row = await queue(env, { source: "ui", text: "Example UI message" });
  for (const fail of [{ status: 503, error: "binding_disabled" }, { status: 409, error: "binding_capacity_reached" }]) {
    adapter.fail = fail;
    await routeHeldLocalInputs(await thread(env), env, { fetchImpl: adapter.fetch, forward: forwardLocalInputToRemote });
    assert.equal((await getThreadMessage("example-thread", row.id, env)).state, "queued");
  }
  adapter.fail = { status: 422, error: "invalid_text" };
  const refused = await routeHeldLocalInputs(await thread(env), env, { fetchImpl: adapter.fetch, forward: forwardLocalInputToRemote });
  assert.deepEqual(refused.failed, [row.id]);
  const current = await getThreadMessage("example-thread", row.id, env);
  assert.equal(current.state, "failed");
  assert.equal(current.error, "remote_runtime_refused:invalid_text");
});

test("an operator queue hold holds forwarding", async t => {
  const env = await fixture(t);
  const adapter = fakeAdapter();
  await queue(env, { source: "ui", text: "Example UI message" });
  await updateThread("example-thread", { queueDispatchHold: { paused: true } }, env);
  const routed = await routeHeldLocalInputs(await thread(env), env, { fetchImpl: adapter.fetch, forward: forwardLocalInputToRemote });
  assert.deepEqual(routed, { forwarded: [], dropped: [], failed: [], held: [] });
  assert.equal(adapter.posts.length, 0);
});
