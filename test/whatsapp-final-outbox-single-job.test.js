import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendThreadMessage, createThread, getThread, getThreadMessage } from "../packages/core/src/threads.js";
import { reconcileCodexFinalProjection } from "../packages/core/src/codex-final-projection.js";
import "../packages/core/src/runtime-leases.js";
import { claimConnectorOutboxJob, ensureConnectorOutboxJob, markConnectorOutboxJob, readConnectorOutbox } from "../packages/connectors/src/connector-outbox.js";
import { deliverWhatsAppReplies } from "../packages/connectors/src/whatsapp.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";
import { ensureDataDirs } from "../packages/storage/src/paths.js";
import { runtimeOutputMetadata } from "../packages/shared/src/runtime-output-identity.js";

// All chats, accounts and identities below are synthetic fixtures; the bridge
// transport is an in-memory fake, so nothing is ever sent.
const generation = "generation-a";
const answer = (extra = {}) => ({ role: "assistant", phase: "final_answer", state: "completed", text: "Synthetic final answer",
  codexThreadId: generation, codexTurnId: "turn-a", codexItemId: "item-a", ...extra });

async function fixture(t, backend = "sqlite") {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "final-outbox-single-"));
  t.after(() => fs.rm(home, { recursive: true, force: true, maxRetries: 5 }));
  return { ORKESTR_HOME: home, ORKESTR_CONNECTOR_OUTBOX_STORE: backend, ORKESTR_CODEX_ROLLOUT_GENERATION_MODE: "off",
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1", ORKESTR_WHATSAPP_DEBUG_FOOTER: "0",
    ORKESTR_WHATSAPP_API_AGENT_AUTORUN: "0", ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_LOCAL_ATTACHMENTS: "0" };
}

const response = (payload, status = 200) => ({ ok: status < 400, status, async json() { return payload; } });

function fakeBridge() {
  const sends = [];
  const transport = async (url, options) => {
    if (url.pathname === "/health") {
      return response({ ok: true, ready: true, accounts: ["account-a", "account-b"].map(id => ({ id, ready: true })) });
    }
    sends.push(JSON.parse(options.body));
    return response({ ok: true, ids: [`receipt-${sends.length}`] });
  };
  return { sends, transport };
}

// The inbound message arrived on account-a while the binding replies from
// account-b: the projection and the scanner used to key the final differently.
async function boundFinal(t, finalExtra = {}) {
  const env = await fixture(t);
  await ensureDataDirs(env);
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.invalid" }, env);
  const thread = await createThread({ id: "single-job", ownerUserId: "tenant-a", name: "Synthetic single job", cwd: env.ORKESTR_HOME,
    codexThreadId: generation, executor: { type: "codex", codexThreadId: generation },
    runtime: { runtimeKind: "codex-app-server", codexThreadId: generation, runtimeGeneration: generation },
    binding: { connector: "whatsapp", chatId: "chat-a", responderAccountId: "account-b", outboundAccountId: "account-b", mirrorToWhatsApp: true } }, env);
  const inbound = await appendThreadMessage(thread.id, { role: "user", source: "whatsapp_inbound", text: "Synthetic request",
    state: "completed", deliveryState: "delivered", connector: "whatsapp", chatId: "chat-a", accountId: "account-a",
    codexThreadId: generation, codexTurnId: "turn-a", timestamp: new Date(Date.now() - 60_000).toISOString() }, env);
  const final = await appendThreadMessage(thread.id, answer({ source: "codex-app-server", eventId: "native-event",
    parentMessageId: inbound.id, connector: "whatsapp", chatId: "chat-a", accountId: "account-a",
    timestamp: new Date(Date.now() - 55_000).toISOString(), ...finalExtra }), env);
  return { env, thread, final };
}

const finalJobs = async env => (await readConnectorOutbox(env)).jobs.filter(job => job.deliveryType === "final");

test("projection first, then a revision-bumped projection, then the scanner: one job, one send", async t => {
  const { env, thread, final } = await boundFinal(t);
  const first = await reconcileCodexFinalProjection({ thread, message: final, runtimeGeneration: generation, env });
  // A second projection path holding its own upserted copy at a newer revision.
  const second = await reconcileCodexFinalProjection({ thread, message: { ...final, revision: Number(final.revision || 1) + 1 },
    runtimeGeneration: generation, env });
  assert.equal(second.outboxJob.id, first.outboxJob.id);
  assert.equal((await finalJobs(env)).length, 1);
  const bridge = fakeBridge();
  await deliverWhatsAppReplies(env, bridge.transport);
  await deliverWhatsAppReplies(env, bridge.transport);
  assert.equal(bridge.sends.length, 1);
  const jobs = await finalJobs(env);
  assert.equal(jobs.length, 1, "the scanner must complete the projection job instead of forking another");
  assert.equal(jobs[0].id, first.outboxJob.id);
  assert.equal(jobs[0].state, "delivered");
});

test("scanner first, then a late projection at a bumped revision: no orphan and no resend", async t => {
  const { env, thread, final } = await boundFinal(t);
  const bridge = fakeBridge();
  await deliverWhatsAppReplies(env, bridge.transport);
  assert.equal(bridge.sends.length, 1);
  const [delivered] = await finalJobs(env);
  assert.equal(delivered.state, "delivered");
  const stored = await getThreadMessage(thread.id, final.id, env);
  const late = await reconcileCodexFinalProjection({ thread, message: { ...stored, revision: Number(stored.revision || 1) + 1 },
    runtimeGeneration: generation, env });
  assert.equal(late.outboxJob.id, delivered.id);
  assert.equal(late.outboxCreated, false);
  await deliverWhatsAppReplies(env, bridge.transport);
  assert.equal(bridge.sends.length, 1);
  const jobs = await finalJobs(env);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].state, "delivered");
});

test("a NO_REPLY final creates no outbox job and still settles the turn's final delivery", async t => {
  const { env, thread, final } = await boundFinal(t, { text: "NO_REPLY" });
  const result = await reconcileCodexFinalProjection({ thread, message: final, runtimeGeneration: generation, env });
  assert.equal(result.noReply, true);
  assert.equal(result.outboxJob, null);
  assert.equal((await finalJobs(env)).length, 0);
  const delivery = (await getThread(thread.id, env)).runtime?.finalDelivery;
  assert.equal(delivery?.messageId, final.id);
  assert.equal(delivery?.status, "delivered", "the pending acknowledgement must not linger for a silent final");
  const bridge = fakeBridge();
  await deliverWhatsAppReplies(env, bridge.transport);
  assert.equal(bridge.sends.length, 0);
  assert.equal((await finalJobs(env)).length, 0);
});

test("a normal final still leaves its delivery pending until the scanner sends it", async t => {
  const { env, thread, final } = await boundFinal(t);
  const result = await reconcileCodexFinalProjection({ thread, message: final, runtimeGeneration: generation, env });
  assert.ok(result.outboxJob?.id);
  assert.equal((await getThread(thread.id, env)).runtime?.finalDelivery?.status, "pending");
  const bridge = fakeBridge();
  await deliverWhatsAppReplies(env, bridge.transport);
  assert.equal(bridge.sends.length, 1);
  assert.equal((await getThread(thread.id, env)).runtime?.finalDelivery?.status, "delivered");
});

const job = (extra = {}) => {
  const message = answer({ eventId: "native-event" });
  return { tenantId: "tenant-a", ownerUserId: "tenant-a", connector: "whatsapp", accountId: "account-a", chatId: "chat-a",
    threadId: "thread-a", sourceMessageId: "message-a", sourceEventId: "native-event", sourceRevision: "1", deliveryType: "final",
    payload: { text: message.text }, metadata: { runtimeGeneration: generation, ...runtimeOutputMetadata(message) }, ...extra };
};

for (const backend of ["json", "sqlite"]) {
  test(`${backend}: account and revision drift for one message keep one claimable job`, async t => {
    const env = await fixture(t, backend);
    const projection = await ensureConnectorOutboxJob(job({ metadata: { ...job().metadata, finalProjection: true } }), env);
    const bumped = await ensureConnectorOutboxJob(job({ sourceRevision: "2" }), env);
    const scanner = await ensureConnectorOutboxJob(job({ accountId: "account-b", sourceRevision: "3" }), env);
    assert.equal(bumped.job.id, projection.job.id);
    assert.equal(scanner.job.id, projection.job.id);
    assert.equal(scanner.created, false);
    assert.equal(scanner.job.accountId, "account-b");
    assert.equal((await claimConnectorOutboxJob(scanner.job.id, { claimant: "test" }, env)).acquired, true);
    await markConnectorOutboxJob(scanner.job.id, { state: "delivered", brokerAck: { ids: ["receipt"] } }, env);
    const replay = await ensureConnectorOutboxJob(job({ sourceRevision: "4" }), env);
    assert.equal(replay.job.id, projection.job.id);
    assert.equal(replay.job.state, "delivered");
    assert.equal((await readConnectorOutbox(env)).jobs.length, 1);
  });

  test(`${backend}: a different message or chat still gets its own final job`, async t => {
    const env = await fixture(t, backend);
    const first = await ensureConnectorOutboxJob(job(), env);
    const otherItem = answer({ codexItemId: "item-b" });
    const otherMessage = await ensureConnectorOutboxJob(job({ sourceMessageId: "message-b", sourceEventId: "event-b",
      metadata: { runtimeGeneration: generation, ...runtimeOutputMetadata(otherItem) } }), env);
    const otherChat = await ensureConnectorOutboxJob(job({ chatId: "chat-b" }), env);
    assert.equal(new Set([first.job.id, otherMessage.job.id, otherChat.job.id]).size, 3);
  });
}
