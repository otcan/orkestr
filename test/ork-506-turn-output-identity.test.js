import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendThreadMessage, createThread, listThreadMessages } from "../packages/core/src/threads.js";
import { reconcileCodexFinalProjection } from "../packages/core/src/codex-final-projection.js";
import { hydrateCodexAppServerThreadMessages } from "../packages/core/src/codex-app-server.js";
import { syncActiveRuntimeRolloutMessages } from "../packages/core/src/runtime-leases.js";
import { claimConnectorOutboxJob, ensureConnectorOutboxJob, markConnectorOutboxJob, readConnectorOutbox } from "../packages/connectors/src/connector-outbox.js";
import { deliverWhatsAppReplies } from "../packages/connectors/src/whatsapp.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";
import { dataPaths, ensureDataDirs } from "../packages/storage/src/paths.js";
import { runtimeOutputMetadata, sameLogicalOutput } from "../packages/shared/src/runtime-output-identity.js";

// All identities below are synthetic fixtures.
async function fixture(t, backend = "sqlite") {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ork-506-turn-"));
  t.after(() => fs.rm(home, { recursive: true, force: true, maxRetries: 5 }));
  return { ORKESTR_HOME: home, ORKESTR_CONNECTOR_OUTBOX_STORE: backend, ORKESTR_CODEX_ROLLOUT_GENERATION_MODE: "off" };
}

const answer = (extra = {}) => ({ role: "assistant", phase: "final_answer", state: "completed", text: "Synthetic final answer",
  codexThreadId: "generation-a", codexTurnId: "turn-a", codexItemId: "item-a", ...extra });

// Mirrors the projection/sender call sites: metadata comes from the source message.
const job = (sourceMessageId, message, extra = {}) => ({
  tenantId: "tenant-a", ownerUserId: "tenant-a", connector: "whatsapp", accountId: "account-a", chatId: "chat-a",
  threadId: "thread-a", sourceMessageId, sourceEventId: message.eventId || sourceMessageId, sourceRevision: "1",
  deliveryType: "final", payload: { text: message.text }, metadata: { runtimeGeneration: "generation-a", ...runtimeOutputMetadata(message) },
  ...extra,
});

for (const backend of ["json", "sqlite"]) for (const state of ["delivered", "partial_delivery", "delivery_uncertain"]) {
  test(`${backend}: item-less re-parented copy of a ${state} final cannot create a new send`, async t => {
    const env = await fixture(t, backend);
    const native = answer({ eventId: "native-event" });
    const first = await ensureConnectorOutboxJob(job("native-local", native, { metadata: { ...job("x", native).metadata, parentMessageId: "input-a" } }), env);
    await markConnectorOutboxJob(first.job.id, { state, brokerAck: { ids: ["synthetic-receipt"] } }, env);
    // Rollout copies: no item ID, a new local ID, a shared foreign event ID,
    // a different parent alias and whitespace-only formatting differences.
    for (let i = 0; i < 3; i++) {
      const copy = answer({ codexItemId: null, eventId: "rollout-event", text: "Synthetic  final\nanswer" });
      const result = await ensureConnectorOutboxJob(job(`copy-${i}`, copy, {
        metadata: { ...job("x", copy).metadata, parentMessageId: `copied-input-${i}` },
        payload: { text: copy.text, attachments: [{ path: `/synthetic/staged-${i}` }] },
      }), env);
      assert.equal(result.job.id, first.job.id);
      assert.equal(result.created, false);
      assert.equal(result.job.state, state);
      assert.deepEqual(result.job.brokerAck, { ids: ["synthetic-receipt"] });
      assert.equal((await claimConnectorOutboxJob(result.job.id, { claimant: "test" }, env)).acquired, false);
    }
    assert.equal((await readConnectorOutbox(env)).jobs.length, 1);
  });
}

test("item-keyed final arriving after a delivered item-less copy reuses its receipt", async t => {
  const env = await fixture(t);
  const copy = answer({ codexItemId: null, eventId: "rollout-event" });
  const first = await ensureConnectorOutboxJob(job("rollout-local", copy), env);
  await markConnectorOutboxJob(first.job.id, { state: "delivered", brokerAck: { ids: ["receipt"] } }, env);
  const late = await ensureConnectorOutboxJob(job("history-local", answer({ eventId: "history-event" })), env);
  assert.equal(late.job.id, first.job.id);
  assert.equal(late.job.state, "delivered");
  assert.equal((await readConnectorOutbox(env)).jobs.length, 1);
});

test("a pending final keeps one job lineage for copies and remains retryable", async t => {
  const env = await fixture(t);
  const first = await ensureConnectorOutboxJob(job("native-local", answer({ eventId: "native-event" })), env);
  const copy = await ensureConnectorOutboxJob(job("rollout-local", answer({ codexItemId: null, eventId: "rollout-event" })), env);
  assert.equal(copy.job.id, first.job.id);
  const claim = await claimConnectorOutboxJob(first.job.id, { claimant: "worker-a" }, env);
  assert.equal(claim.acquired, true);
  await markConnectorOutboxJob(first.job.id, { state: "failed_retryable", error: "synthetic_transient", claimExpiresAt: new Date(0).toISOString() }, env);
  const retry = await ensureConnectorOutboxJob(job("native-local", answer({ eventId: "native-event" })), env);
  assert.equal(retry.job.id, first.job.id);
  assert.equal((await claimConnectorOutboxJob(first.job.id, { claimant: "worker-b" }, env)).acquired, true);
  assert.equal((await readConnectorOutbox(env)).jobs.length, 1);
});

test("genuinely distinct finals remain independently deliverable", async t => {
  const env = await fixture(t);
  const first = await ensureConnectorOutboxJob(job("native-local", answer({ eventId: "native-event" })), env);
  await markConnectorOutboxJob(first.job.id, { state: "delivered" }, env);
  const distinct = [
    job("other-text", answer({ codexItemId: null, eventId: "e1", text: "A different final answer" })),
    job("other-turn", answer({ codexItemId: null, eventId: "e2", codexTurnId: "turn-b" })),
    job("other-item", answer({ eventId: "e3", codexItemId: "item-b" })),
    job("other-generation", answer({ codexItemId: null, eventId: "e4", codexThreadId: "generation-b" }), { metadata: runtimeOutputMetadata(answer({ codexItemId: null, codexThreadId: "generation-b" })) }),
    job("other-chat", answer({ codexItemId: null, eventId: "e5" }), { chatId: "chat-b" }),
    job("other-revision", answer({ codexItemId: null, eventId: "e6" }), { sourceRevision: "2" }),
  ];
  const ids = new Set([first.job.id]);
  for (const input of distinct) {
    const result = await ensureConnectorOutboxJob(input, env);
    assert.equal(result.created, true, input.sourceMessageId);
    ids.add(result.job.id);
  }
  assert.equal(ids.size, distinct.length + 1);
});

test("turn-scoped matching never collapses by text alone or across two item IDs", () => {
  const base = job("a", answer());
  assert.equal(sameLogicalOutput(base, job("b", answer({ codexItemId: "item-b" }))), false);
  const noTurn = job("c", answer({ codexItemId: null, codexTurnId: null }));
  assert.equal(sameLogicalOutput(base, noTurn), false);
  assert.equal(sameLogicalOutput(base, job("d", answer({ codexItemId: null }))), true);
});

for (const backend of ["json", "sqlite"]) test(`${backend}: item-less rollout copy reuses the stored final regardless of parent`, async t => {
  const env = { ...(await fixture(t)), ORKESTR_THREAD_MESSAGE_STORE: backend };
  const thread = await createThread({ id: "turn-copy", ownerUserId: "tenant-a", name: "Synthetic turn copy" }, env);
  const original = await appendThreadMessage(thread.id, answer({ source: "codex-app-server", eventId: "native-event", parentMessageId: "input-a" }), env);
  const copies = await Promise.all(Array.from({ length: 4 }, (_, i) => appendThreadMessage(thread.id, answer({
    source: "codex-rollout", codexItemId: null, eventId: "rollout-event", parentMessageId: `copied-input-${i}`,
    text: "Synthetic final  answer", timestamp: new Date(Date.now() + 60_000).toISOString(),
  }), env)));
  for (const copy of copies) {
    assert.equal(copy.id, original.id);
    assert.equal(copy.duplicate, true);
    assert.equal(copy.duplicateReason, "canonical_runtime_turn_output");
  }
  const distinct = await appendThreadMessage(thread.id, answer({ source: "codex-rollout", codexItemId: null, eventId: "other", text: "Another answer" }), env);
  assert.notEqual(distinct.id, original.id);
  const rows = await listThreadMessages(thread.id, env);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].parentMessageId, "input-a");
});

test("history hydration adopts an item-less rollout final instead of importing another copy", async t => {
  const env = await fixture(t);
  const thread = await createThread({ id: "hydrate-copy", ownerUserId: "tenant-a", name: "Synthetic hydration" }, env);
  const rollout = await appendThreadMessage(thread.id, answer({ source: "codex-rollout", codexItemId: null,
    eventId: "rollout-event", parentMessageId: "input-a" }), env);
  const history = { id: "generation-a", turns: [{ id: "turn-a", items: [
    { type: "agentMessage", id: "item-a", phase: "final_answer", text: "Synthetic final answer" },
  ] }] };
  await Promise.all(Array.from({ length: 4 }, () => hydrateCodexAppServerThreadMessages(thread, history, env)));
  await hydrateCodexAppServerThreadMessages(thread, history, env);
  const rows = await listThreadMessages(thread.id, env);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, rollout.id);
  assert.equal(rows[0].parentMessageId, "input-a");
});

const response = (payload, status = 200) => ({ ok: status < 400, status, async json() { return payload; } });

test("rollout rescan after a steered input does not re-parent and resend a delivered final", async t => {
  const env = { ...(await fixture(t)), ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1", ORKESTR_WHATSAPP_DEBUG_FOOTER: "0",
    ORKESTR_WHATSAPP_API_AGENT_AUTORUN: "0", ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_LOCAL_ATTACHMENTS: "0" };
  const home = env.ORKESTR_HOME;
  await ensureDataDirs(env);
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.invalid" }, env);
  const generation = "generation-a";
  const base = Date.now() - 120_000;
  const at = seconds => new Date(base + seconds * 1000).toISOString();
  const thread = await createThread({ id: "steer", ownerUserId: "tenant-a", name: "Synthetic steer", cwd: home,
    codexThreadId: generation, executor: { type: "codex", codexThreadId: generation },
    runtime: { runtimeKind: "codex-app-server", codexThreadId: generation, runtimeGeneration: generation },
    binding: { connector: "whatsapp", chatId: "chat-a", responderAccountId: "account-a", outboundAccountId: "account-a", mirrorToWhatsApp: true } }, env);
  const inbound = (text, timestamp) => appendThreadMessage(thread.id, { role: "user", source: "whatsapp_inbound", text, timestamp,
    state: "completed", deliveryState: "delivered", connector: "whatsapp", chatId: "chat-a", accountId: "account-a",
    codexThreadId: generation, codexTurnId: "turn-a" }, env);
  const first = await inbound("Synthetic request", at(0));
  const final = await appendThreadMessage(thread.id, answer({ source: "codex-app-server", eventId: "native-event",
    parentMessageId: first.id, connector: "whatsapp", chatId: "chat-a", accountId: "account-a",
    timestamp: at(5) }), env);
  await reconcileCodexFinalProjection({ thread, message: final, runtimeGeneration: generation, env });
  const sends = [];
  const transport = async (url, options) => {
    if (url.pathname === "/health") return response({ ok: true, ready: true, accounts: [{ id: "account-a", ready: true }] });
    sends.push(JSON.parse(options.body));
    return response({ ok: true, ids: [`receipt-${sends.length}`] });
  };
  await deliverWhatsAppReplies(env, transport);
  assert.equal(sends.length, 1);
  // A steered input shares the runtime turn, so exact-turn parent selection
  // now prefers it over the original parent.
  await inbound("Synthetic steer", at(3));
  const rolloutPath = path.join(home, "rollout.jsonl");
  await fs.writeFile(rolloutPath, [
    JSON.stringify({ type: "session_meta", payload: { id: generation } }),
    JSON.stringify({ timestamp: at(40), type: "response_item", payload: {
      type: "message", role: "assistant", phase: "final_answer", turn_id: "turn-a",
      content: [{ type: "output_text", text: "Synthetic final answer" }] } }),
  ].join("\n") + "\n", "utf8");
  await fs.writeFile(dataPaths(env).runtimeLeases, JSON.stringify([{ id: "lease-a", threadId: thread.id,
    sessionName: "session-a", rolloutPath, rolloutGeneration: generation, rolloutOffset: 0, startedAt: at(-60) }]), "utf8");
  for (let i = 0; i < 3; i++) {
    await syncActiveRuntimeRolloutMessages(env);
    await deliverWhatsAppReplies(env, transport);
  }
  const finals = (await listThreadMessages(thread.id, env)).filter(row => row.role === "assistant");
  assert.equal(finals.length, 1);
  assert.equal(finals[0].parentMessageId, first.id);
  assert.equal(sends.length, 1, "the final must not be sent again");
  assert.equal((await readConnectorOutbox(env)).jobs.filter(row => row.deliveryType === "final").length, 1);
});
