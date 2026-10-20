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

test("relay input on a delegated thread requires the legacy mirror off and owner authorship", async (t) => {
  const { env } = await fixture(t);
  const thread = await getThread("example-thread", env);
  assert.equal(scopedRelayRemoteBinding(thread, { ...relayBody, source: "ui" }, env), null);
  assert.equal(scopedRelayRemoteBinding(thread, relayBody, env).remoteThreadId, "example-remote-thread");
  assert.throws(() => scopedRelayRemoteBinding(thread, { ...relayBody, scopedParticipant: { id: "proof" } }, env),
    /scoped_relay_delegation_owner_only/);
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
