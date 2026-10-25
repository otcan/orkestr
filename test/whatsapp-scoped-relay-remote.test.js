import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deliverWhatsAppReplies } from "../packages/connectors/src/whatsapp.js";
import {
  forwardScopedRelayInputToRemote,
  recordScopedRelayRemoteDelivery,
  scopedRelayRemoteBinding,
} from "../packages/connectors/src/whatsapp-scoped-relay-remote.js";
import { appendThreadMessage, createThread, getThread, listThreadMessages } from "../packages/core/src/threads.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";

const relayBody = { source: "whatsapp_group_relay", text: "[WhatsApp: Example]\n\nhello", parseCommands: false, controlAllowed: false };

// A synthetic acknowledging runtime plus a legacy bridge that must stay unused.
async function fixture(t, { binding = {} } = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "scoped-relay-remote-"));
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
    id: "example-thread", name: "Example thread", ownerUserId: "admin",
    binding: {
      connector: "whatsapp", chatId: "example-group@g.us", enabled: true, mirrorToWhatsApp: false,
      inboundAccountId: "example-account", responderAccountId: "example-account",
      remoteBackend: "example", remoteThreadId: "example-remote-thread", ...binding,
    },
  }, env);
  const runtime = { inputs: [], acks: [], exports: [], user: null, inputStatus: 0, sends: 0 };
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    if (parsed.host === "bridge.example.test") {
      runtime.sends += 1;
      return Response.json({ ok: true, messageId: "legacy-send" });
    }
    assert.equal(parsed.host, "runtime.example.test");
    assert.equal(options.headers.authorization, "Bearer public-test-token");
    const body = options.body ? JSON.parse(options.body) : null;
    if (parsed.pathname.endsWith("/input")) {
      runtime.inputs.push(body);
      if (runtime.inputStatus) return Response.json({ ok: false, error: "synthetic_refusal" }, { status: runtime.inputStatus });
      runtime.user = {
        id: "example-remote-user", role: "user", source: "whatsapp_inbound", connector: "whatsapp",
        publicMessageId: body.publicMessageId, publicThreadId: body.publicThreadId, state: "delivered",
      };
      return Response.json({ ok: true, message: { id: runtime.user.id, state: "delivered", deliveryState: "delivered" } }, { status: 202 });
    }
    if (parsed.pathname.endsWith("/mirror-acks")) {
      runtime.acks.push(body);
      const row = runtime.exports.find((item) => item.id === body.remoteMessageId);
      if (body.outcome === "delivered") row.acked = true;
      return Response.json({ ok: true, sequence: row.exportSequence, ackedThrough: row.exportSequence });
    }
    if (parsed.pathname.endsWith("/messages")) {
      const rows = runtime.user ? [runtime.user, ...runtime.exports.filter((row) => !row.acked)] : [];
      return Response.json({ ok: true, messages: rows, mirrorAck: { version: 1, ackedThrough: 0 } });
    }
    throw new Error(`unexpected synthetic request ${parsed.href}`);
  };
  const relayInput = async (text = relayBody.text) => appendThreadMessage("example-thread", {
    role: "user", state: "queued", source: "whatsapp_group_relay", text, clientMessageId: "group:example-input",
  }, env);
  return { env, runtime, fetchImpl, relayInput };
}

test("relay input on a delegated thread requires the legacy mirror off and a verified author", async (t) => {
  const { env } = await fixture(t);
  const thread = await getThread("example-thread", env);
  assert.equal(scopedRelayRemoteBinding(thread, { ...relayBody, source: "ui" }, env), null);
  assert.equal(scopedRelayRemoteBinding(thread, relayBody, env).remoteThreadId, "example-remote-thread");
  assert.throws(() => scopedRelayRemoteBinding(thread, { ...relayBody, scopedParticipant: { id: "proof" } }, env),
    /scoped_relay_participant_unverified/);
  const mirrored = { ...thread, binding: { ...thread.binding, mirrorToWhatsApp: true } };
  assert.throws(() => scopedRelayRemoteBinding(mirrored, relayBody, env), /scoped_relay_delegation_requires_mirror_disabled/);
  const local = { ...thread, binding: { ...thread.binding, remoteRuntimeEnabled: false } };
  assert.equal(scopedRelayRemoteBinding(local, relayBody, env), null);
});

test("relay input is forwarded once as owner input in the exact thread scope", async (t) => {
  const { env, runtime, fetchImpl, relayInput } = await fixture(t);
  const thread = await getThread("example-thread", env);
  const remote = scopedRelayRemoteBinding(thread, relayBody, env);
  const message = await relayInput();
  const first = await forwardScopedRelayInputToRemote({ thread, message, remote }, env, fetchImpl);
  assert.equal(first.forwarded, true);
  assert.equal(runtime.inputs.length, 1);
  const sent = runtime.inputs[0];
  assert.equal(sent.source, "whatsapp_inbound");
  assert.equal(sent.connector, "whatsapp");
  assert.equal(sent.role, "user");
  assert.equal(sent.chatId, "example-group@g.us");
  assert.equal(sent.accountId, "example-account");
  assert.equal(sent.publicThreadId, "example-thread");
  assert.equal(sent.publicMessageId, message.id);
  assert.equal(sent.text, relayBody.text);
  assert.equal(sent.senderParticipantId, "scoped-owner:admin");
  assert.equal(sent.from, "scoped-owner:admin");
  assert.equal(sent.senderTrustLevel, "owner");
  assert.equal(sent.senderEffectiveRole, "owner");
  assert.deepEqual(
    { ...sent.externalPrincipal },
    { connector: "whatsapp", accountId: "example-account", chatId: "example-group@g.us", threadId: "example-thread",
      senderId: "scoped-owner:admin", participantId: "scoped-owner:admin", fromMe: true },
  );
  const [stored] = await listThreadMessages("example-thread", env);
  assert.equal(stored.remoteMessageId, "example-remote-user");
  assert.equal(stored.remoteBackend, "example");
  assert.equal(stored.state, "delivered");
  const again = await forwardScopedRelayInputToRemote({ thread, message: stored, remote }, env, fetchImpl);
  assert.equal(again.duplicate, true);
  assert.equal(runtime.inputs.length, 1);
});

test("a transient runtime failure is retried by the relay; a definite refusal is answered once", async (t) => {
  const { env, runtime, fetchImpl, relayInput } = await fixture(t);
  const thread = await getThread("example-thread", env);
  const remote = scopedRelayRemoteBinding(thread, relayBody, env);
  const message = await relayInput();
  runtime.inputStatus = 503;
  await assert.rejects(forwardScopedRelayInputToRemote({ thread, message, remote }, env, fetchImpl), (error) =>
    error.message === "scoped_relay_remote_unavailable" && error.statusCode === 502);
  let [stored] = await listThreadMessages("example-thread", env);
  assert.equal(stored.remoteMessageId, undefined);
  assert.equal(stored.state, "queued");
  runtime.inputStatus = 422;
  const refused = await forwardScopedRelayInputToRemote({ thread, message: stored, remote }, env, fetchImpl);
  assert.equal(refused.refused, true);
  const rows = await listThreadMessages("example-thread", env);
  assert.equal(rows.length, 2);
  [stored] = rows;
  assert.equal(stored.state, "failed");
  assert.equal(stored.observedVia, "remote_runtime_refused");
  assert.equal(rows[1].role, "assistant");
  assert.equal(rows[1].phase, "final_answer");
  assert.equal(rows[1].parentMessageId, stored.id);
  assert.match(rows[1].text, /did not accept this message \(synthetic_refusal\)/);
  const repeat = await forwardScopedRelayInputToRemote({ thread, message: stored, remote }, env, fetchImpl);
  assert.equal(repeat.refused, true);
  assert.equal(runtime.inputs.length, 2);
  assert.equal((await listThreadMessages("example-thread", env)).length, 2);
});

test("the mirrored reply is never sent by the legacy outbox and is acknowledged after the relay's receipt", async (t) => {
  const { env, runtime, fetchImpl, relayInput } = await fixture(t);
  const thread = await getThread("example-thread", env);
  const remote = scopedRelayRemoteBinding(thread, relayBody, env);
  const message = await relayInput();
  await forwardScopedRelayInputToRemote({ thread, message, remote }, env, fetchImpl);
  runtime.exports.push({
    id: "example-remote-reply", role: "assistant", phase: "final_answer", state: "completed", kind: "final",
    text: "Synthetic Rust answer", parentMessageId: "example-remote-user", exportSequence: 1,
  });
  await deliverWhatsAppReplies(env, fetchImpl);
  const reply = (await listThreadMessages("example-thread", env)).find((row) => row.role === "assistant");
  assert.equal(reply.parentMessageId, message.id);
  assert.equal(reply.remoteMessageId, "example-remote-reply");
  assert.equal(runtime.sends, 0, "legacy outbox must not send a relay-owned reply");
  assert.equal(runtime.acks.length, 0, "no report before the relay confirms the send");

  await assert.rejects(recordScopedRelayRemoteDelivery({ thread, messageId: message.id, body: { requestIds: ["r"] } }, env),
    /scoped_relay_delivery_target_invalid/);
  await assert.rejects(recordScopedRelayRemoteDelivery({ thread, messageId: reply.id, body: { requestIds: [] } }, env),
    /scoped_relay_delivery_invalid/);
  const body = { requestIds: ["reply:one", "reply:two"], connectorMessageIds: ["provider-1", "provider-2"], deliveredAt: "2026-01-01T00:00:00Z" };
  const recorded = await recordScopedRelayRemoteDelivery({ thread, messageId: reply.id, body }, env);
  assert.equal(recorded.duplicate, false);
  assert.equal((await recordScopedRelayRemoteDelivery({ thread, messageId: reply.id, body }, env)).duplicate, true);
  await assert.rejects(recordScopedRelayRemoteDelivery({ thread, messageId: reply.id, body: { requestIds: ["reply:other"] } }, env),
    /scoped_relay_delivery_conflict/);

  await deliverWhatsAppReplies(env, fetchImpl);
  assert.equal(runtime.sends, 0);
  assert.equal(runtime.acks.length, 1);
  const [ack] = runtime.acks;
  assert.equal(ack.outcome, "delivered");
  assert.equal(ack.remoteMessageId, "example-remote-reply");
  assert.equal(ack.parentPublicMessageId, message.id);
  assert.equal(ack.localMessageId, reply.id);
  assert.match(ack.outboxJobId, /^scoped-relay:[0-9a-f]{40}$/);
  assert.deepEqual(ack.connectorMessageIds, ["provider-1", "provider-2"]);
  await deliverWhatsAppReplies(env, fetchImpl);
  assert.equal(runtime.acks.length, 1, "a settled report is not repeated");
});

test("a relay input the runtime keeps refusing transiently is closed with a notice once it is too old", async (t) => {
  const { env, runtime, fetchImpl, relayInput } = await fixture(t);
  const thread = await getThread("example-thread", env);
  const remote = scopedRelayRemoteBinding(thread, relayBody, env);
  const message = await relayInput();
  runtime.inputStatus = 503;
  await assert.rejects(forwardScopedRelayInputToRemote({ thread, message, remote }, env, fetchImpl), /scoped_relay_remote_unavailable/);
  const old = { ...message, createdAt: new Date(Date.now() - 31 * 60 * 1000).toISOString() };
  const expired = await forwardScopedRelayInputToRemote({ thread, message: old, remote }, env, fetchImpl);
  assert.equal(expired.refused, true);
  assert.equal(expired.error, "remote_runtime_input_expired:503");
  const rows = await listThreadMessages("example-thread", env);
  assert.equal(rows[0].state, "failed");
  assert.equal(rows[0].observedVia, "remote_runtime_refused");
  assert.equal(rows[1].parentMessageId, message.id);
  assert.match(rows[1].text, /did not accept this message \(remote_runtime_input_expired:503\)\. It was not run\./);
  // Closed: not forwarded again.
  await forwardScopedRelayInputToRemote({ thread, message: rows[0], remote }, env, fetchImpl);
  assert.equal(runtime.inputs.length, 2);
  // The age limit is configurable and never below one minute.
  const shortEnv = { ...env, ORKESTR_REMOTE_RELAY_INPUT_MAX_AGE_MS: "1000" };
  const recent = { ...message, id: "example-other", createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString() };
  await assert.rejects(forwardScopedRelayInputToRemote({ thread, message: recent, remote }, shortEnv, fetchImpl), /scoped_relay_remote_unavailable/);
});

test("an expired or rejected relay notification is recorded as not sent and acknowledged so the input settles", async (t) => {
  const { env, runtime, fetchImpl, relayInput } = await fixture(t);
  const thread = await getThread("example-thread", env);
  const remote = scopedRelayRemoteBinding(thread, relayBody, env);
  const message = await relayInput();
  await forwardScopedRelayInputToRemote({ thread, message, remote }, env, fetchImpl);
  runtime.exports.push({
    id: "example-remote-reply", role: "assistant", phase: "final_answer", state: "completed", kind: "final",
    text: "Synthetic Rust answer", parentMessageId: "example-remote-user", exportSequence: 1,
  });
  await deliverWhatsAppReplies(env, fetchImpl);
  const reply = (await listThreadMessages("example-thread", env)).find((row) => row.role === "assistant");
  await assert.rejects(recordScopedRelayRemoteDelivery({ thread, messageId: reply.id, body: { outcome: "uncertain" } }, env),
    /scoped_relay_delivery_invalid/);
  const body = { outcome: "suppressed", reason: "expired" };
  const recorded = await recordScopedRelayRemoteDelivery({ thread, messageId: reply.id, body }, env);
  assert.equal(recorded.message.deliveryState, "suppressed");
  assert.equal(recorded.message.deliveryReason, "expired");
  assert.equal((await recordScopedRelayRemoteDelivery({ thread, messageId: reply.id, body }, env)).duplicate, true);
  await assert.rejects(recordScopedRelayRemoteDelivery({ thread, messageId: reply.id, body: { requestIds: ["reply:one"] } }, env),
    /scoped_relay_delivery_conflict/);
  await assert.rejects(recordScopedRelayRemoteDelivery({ thread, messageId: reply.id, body: { outcome: "failed" } }, env),
    /scoped_relay_delivery_conflict/);
  await deliverWhatsAppReplies(env, fetchImpl);
  assert.equal(runtime.sends, 0);
  assert.equal(runtime.acks.length, 1);
  assert.equal(runtime.acks[0].outcome, "suppressed");
  assert.equal(runtime.acks[0].parentPublicMessageId, message.id);
});

test("a V2 timer reply on a delegated relay thread is never sent by the outbox and settles from the relay's report", async (t) => {
  const { env, runtime, fetchImpl } = await fixture(t);
  const thread = await getThread("example-thread", env);
  const timerId = "0b6c1f5e-8f3a-4c2d-9e7b-1a2b3c4d5e6f";
  runtime.user = {
    id: timerId, role: "user", text: "Scheduled timer: Morning brief", publicMessageId: `v2timer-${timerId}`,
    publicThreadId: "example-thread", chatId: "example-group@g.us", accountId: "example-account",
    source: "orkestr-v2-timer", connector: "orkestr-v2-timer", origin: "timer", state: "delivered", createdAt: "2026-10-20T08:00:00.000Z",
  };
  runtime.exports.push({
    id: "example-timer-final", role: "assistant", phase: "final_answer", state: "completed", kind: "final",
    text: "Good morning.", parentMessageId: timerId, exportSequence: 1, source: "rust-v2-pilot",
  });
  await deliverWhatsAppReplies(env, fetchImpl);
  const reply = (await listThreadMessages("example-thread", env)).find((row) => row.role === "assistant");
  assert.equal(reply.parentMessageId, `v2timer-${timerId}`);
  assert.equal(runtime.sends, 0, "the legacy outbox never sends on a relay-delegated thread");
  assert.equal(runtime.acks.length, 0);
  await recordScopedRelayRemoteDelivery({ thread, messageId: reply.id,
    body: { requestIds: ["timer:example:0"], connectorMessageIds: ["provider-1"] } }, env);
  await deliverWhatsAppReplies(env, fetchImpl);
  assert.equal(runtime.sends, 0);
  assert.equal(runtime.acks.length, 1);
  assert.equal(runtime.acks[0].outcome, "delivered");
  assert.equal(runtime.acks[0].parentPublicMessageId, `v2timer-${timerId}`);
  assert.deepEqual(runtime.acks[0].connectorMessageIds, ["provider-1"]);
});

// A participant the server admitted (checkScopedParticipant ran in /input).
const lid = "100000000000001@lid";
const phone = "491700000001@c.us";
const participantBody = (changes = {}) => ({
  ...relayBody, from: lid, senderParticipantId: lid, senderTrustLevel: "trusted", senderEffectiveRole: "trusted",
  senderPolicyMode: "this-thread-only", originOwner: false, controlAllowed: false, parseCommands: false,
  scopedParticipant: { version: 1, inputId: "event-1", authorId: lid, phoneId: phone, chatId: "example-group@g.us",
    threadId: "example-thread", createdAt: "2026-01-01T00:00:00.000Z" },
  ...changes,
});

test("an admitted group participant is forwarded with its own author and no owner authority", async (t) => {
  const { env, runtime, fetchImpl, relayInput } = await fixture(t, { binding: { additionalParticipantLabels: { [phone]: "Ayse" } } });
  const thread = await getThread("example-thread", env);
  const remote = scopedRelayRemoteBinding(thread, participantBody(), env);
  assert.deepEqual(remote.participant, { authorId: lid, phoneId: phone, label: "Ayse" });
  const message = await relayInput();
  const result = await forwardScopedRelayInputToRemote({ thread, message, remote }, env, fetchImpl);
  assert.equal(result.forwarded, true);
  const [sent] = runtime.inputs;
  assert.equal(sent.from, lid);
  assert.equal(sent.senderParticipantId, lid);
  assert.equal(sent.senderPhoneId, phone);
  assert.equal(sent.senderLabel, "Ayse");
  assert.equal(sent.senderTrustLevel, "trusted");
  assert.equal(sent.senderEffectiveRole, "trusted");
  assert.equal(sent.originOwner, false);
  assert.equal(sent.controlAllowed, false);
  assert.equal(sent.parseCommands, false);
  assert.deepEqual({ ...sent.externalPrincipal }, {
    connector: "whatsapp", accountId: "example-account", chatId: "example-group@g.us", threadId: "example-thread",
    senderId: lid, participantId: lid, fromMe: false, phoneId: phone,
  });
});

test("a phone-JID participant needs no label, and an unverified or owner-claiming participant is refused", async (t) => {
  const { env } = await fixture(t);
  const thread = await getThread("example-thread", env);
  const direct = participantBody({ from: phone, senderParticipantId: phone,
    scopedParticipant: { ...participantBody().scopedParticipant, authorId: phone } });
  assert.deepEqual(scopedRelayRemoteBinding(thread, direct, env).participant, { authorId: phone, phoneId: phone, label: "" });
  for (const forged of [
    participantBody({ controlAllowed: true }),
    participantBody({ originOwner: true }),
    participantBody({ senderTrustLevel: "owner" }),
    participantBody({ from: "100000000000009@lid" }),
    participantBody({ scopedParticipant: { ...participantBody().scopedParticipant, phoneId: lid } }),
    participantBody({ scopedParticipant: { ...participantBody().scopedParticipant, threadId: "other-thread" } }),
  ]) {
    assert.throws(() => scopedRelayRemoteBinding(thread, forged, env), /scoped_relay_participant_unverified/);
  }
});

test("a participant the remote runtime does not list is answered once with a visible notice", async (t) => {
  const { env, runtime, fetchImpl, relayInput } = await fixture(t);
  const thread = await getThread("example-thread", env);
  const remote = scopedRelayRemoteBinding(thread, participantBody(), env);
  const message = await relayInput();
  runtime.inputStatus = 409;
  const refused = await forwardScopedRelayInputToRemote({ thread, message, remote }, env, fetchImpl);
  assert.equal(refused.refused, true);
  const rows = await listThreadMessages("example-thread", env);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].parentMessageId, message.id);
  assert.match(rows[1].text, /did not accept this message/);
  assert.equal(runtime.inputs.length, 1);
});

test("a quoted-reply context is stored on the V1 message and forwarded to the remote runtime", async (t) => {
  const { env, runtime, fetchImpl } = await fixture(t);
  const thread = await getThread("example-thread", env);
  const remote = scopedRelayRemoteBinding(thread, relayBody, env);
  const replyTo = { messageId: "true_group_ABC", author: "orkestr", sentAt: "2026-01-02T21:50:00.000Z", text: "x".repeat(900), isOwnReply: true, junk: "dropped" };
  const message = await appendThreadMessage("example-thread", {
    role: "user", state: "queued", source: "whatsapp_group_relay", text: "[Replying to Orkestr message from 21:50: \"x\"]\n\nno need",
    clientMessageId: "group:quoted", replyTo,
  }, env);
  assert.equal(message.replyTo.text.length, 500);
  assert.equal(message.replyTo.isOwnReply, true);
  assert.equal(message.replyTo.junk, undefined);
  await forwardScopedRelayInputToRemote({ thread, message, remote }, env, fetchImpl);
  assert.deepEqual(runtime.inputs[0].replyTo, message.replyTo);
  const plain = await appendThreadMessage("example-thread", { role: "user", state: "queued", source: "whatsapp_group_relay", text: "hi", clientMessageId: "group:plain", replyTo: "nope" }, env);
  assert.equal(plain.replyTo, undefined);
});
