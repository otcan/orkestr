import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createThread, appendThreadMessage, listThreadMessages } from "../packages/core/src/threads.js";
import { hydrateCodexAppServerThreadMessages } from "../packages/core/src/codex-app-server.js";
import { ensureConnectorOutboxJob, markConnectorOutboxJob, claimConnectorOutboxJob, readConnectorOutbox, writeConnectorOutbox } from "../packages/connectors/src/connector-outbox.js";
import { appendOrUpdateEventMessage } from "../packages/core/src/codex-app-server-common.js";
import { runtimeOutputMetadata } from "../packages/shared/src/runtime-output-identity.js";

async function fixture(t, backend = "sqlite") {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ork-506-"));
  t.after(() => fs.rm(home, { recursive: true, force: true, maxRetries: 5 }));
  return { ORKESTR_HOME: home, ORKESTR_CONNECTOR_OUTBOX_STORE: backend, ORKESTR_CODEX_ROLLOUT_GENERATION_MODE: "off" };
}
const output = (id, extra = {}) => ({
  tenantId: "tenant-a", ownerUserId: "tenant-a", connector: "whatsapp", accountId: "account-a",
  chatId: "chat-a", threadId: "thread-a", sourceMessageId: id, sourceEventId: "runtime-event-a",
  sourceRevision: "1", deliveryType: "final", payload: { text: "Synthetic answer" },
  metadata: { runtimeGeneration: "generation-a", runtimeTurnId: "turn-a", runtimeItemId: "item-a" }, ...extra,
});

for (const backend of ["json", "sqlite"]) for (const state of ["delivered", "partial_delivery", "delivery_uncertain"]) {
  test(`${backend}: ${state} logical output cannot be resent with a new projection ID`, async t => {
    const env = await fixture(t, backend);
    const first = await ensureConnectorOutboxJob(output("local-a"), env);
    await markConnectorOutboxJob(first.job.id, { state, brokerAck: { ids: ["synthetic-receipt"] } }, env);
    const copies = await Promise.all(Array.from({ length: 4 }, (_, i) => ensureConnectorOutboxJob(output(`copy-${i}`, {
      payload: { text: "Reformatted answer", attachments: [{ path: `/synthetic/staged-${i}` }] },
    }), env)));
    for (const copy of copies) {
      assert.equal(copy.job.id, first.job.id);
      assert.equal(copy.job.state, state);
      assert.deepEqual(copy.job.brokerAck, { ids: ["synthetic-receipt"] });
      assert.equal((await claimConnectorOutboxJob(copy.job.id, { claimant: "test" }, env)).acquired, false);
    }
    assert.equal((await readConnectorOutbox(env)).jobs.length, 1);
  });
}

test("legacy thread owner hydration does not append the same input on every scan", async t => {
  const env = await fixture(t);
  const thread = await createThread({ id: "legacy", name: "Synthetic legacy thread" }, env);
  const legacy = { ...thread, ownerUserId: undefined };
  const history = { id: "generation-a", turns: [{ id: "turn-a", items: [
    { type: "userMessage", id: "input-a", text: "Synthetic input" },
  ] }] };
  for (let i = 0; i < 3; i++) await hydrateCodexAppServerThreadMessages(legacy, history, env);
  assert.equal((await listThreadMessages(thread.id, env)).length, 1);
});

test("pre-existing ambiguous input aliases stop growing without repairing history", async t => {
  const env = await fixture(t);
  const thread = await createThread({ id: "aliases", ownerUserId: "tenant-a", name: "Synthetic aliases" }, env);
  for (let i = 0; i < 2; i++) await appendThreadMessage(thread.id, {
    role: "user", source: "codex-app-server-import", text: "Synthetic input",
    codexThreadId: "generation-a", codexTurnId: "turn-a", codexItemId: "input-a",
  }, env);
  const before = await listThreadMessages(thread.id, env);
  const history = { id: "generation-a", turns: [{ id: "turn-a", items: [{ type: "userMessage", id: "input-a", text: "Synthetic input" }] }] };
  await Promise.all(Array.from({ length: 4 }, () => hydrateCodexAppServerThreadMessages(thread, history, env)));
  assert.deepEqual(await listThreadMessages(thread.id, env), before);
});

test("native, rollout and concurrent import writes share one durable output ID", async t => {
  const env = await fixture(t);
  const thread = await createThread({ id: "converge", ownerUserId: "tenant-a", name: "Synthetic projections" }, env);
  const answer = { role: "assistant", source: "codex-app-server", phase: "final_answer", state: "completed",
    text: "Synthetic answer", codexThreadId: "generation-a", codexTurnId: "turn-a", codexItemId: "answer-a" };
  const original = await appendOrUpdateEventMessage(thread, { ...answer, eventId: "native-event", parentMessageId: "original-parent" }, env);
  const copies = await Promise.all(Array.from({ length: 8 }, (_, i) => appendThreadMessage(thread.id, {
    ...answer, source: "codex-rollout", eventId: `rollout-${i}`, parentMessageId: `copied-parent-${i}`,
  }, env)));
  assert.ok(copies.every(copy => copy.id === original.id));
  const history = { id: "generation-a", turns: [{ id: "turn-a", items: [
    { type: "agentMessage", id: "answer-a", text: "Synthetic answer", phase: "final_answer" },
  ] }] };
  await Promise.all(Array.from({ length: 4 }, () => hydrateCodexAppServerThreadMessages(thread, history, env)));
  const rows = await listThreadMessages(thread.id, env);
  assert.equal(rows.length, 1); assert.equal(rows[0].id, original.id);
  assert.equal(rows[0].parentMessageId, "original-parent");
});

for (const backend of ["json", "sqlite"]) test(`${backend}: retained legacy receipts fence new canonical keys`, async t => {
  const env = await fixture(t, backend);
  await writeConnectorOutbox({ jobs: [{ ...output("old-local"), id: "old-job", idempotencyKey: "legacy-key",
    metadata: { runtimeGeneration: "generation-a" }, state: "delivery_uncertain", brokerAck: { ids: ["receipt"] } }] }, env);
  const result = await ensureConnectorOutboxJob(output("new-local"), env);
  assert.equal(result.job.id, "old-job"); assert.equal(result.created, false);
  assert.equal(result.job.state, "delivery_uncertain");
  assert.equal((await readConnectorOutbox(env)).jobs.length, 1);
});

// Regression for the pepLab2 incident (ORK-506): some rollout jsonl event
// shapes (legacy event_msg/agent_message entries) never carry an item id,
// while the same logical answer observed via app-server history hydration
// always has one. Without this, the two paths mint distinct outbox jobs for
// one logical final answer -- the observed duplicate-send root cause.
for (const backend of ["json", "sqlite"]) test(`${backend}: rollout entry missing an item id still converges onto the app-server item-identified job`, async t => {
  const env = await fixture(t, backend);
  const fromAppServer = await ensureConnectorOutboxJob(output("app-server-local"), env);
  const { metadata: baseMetadata, ...rolloutFields } = output("rollout-local", { sourceEventId: "rollout-event-without-item" });
  const { runtimeItemId: _omitted, ...metadataWithoutItem } = baseMetadata;
  const fromRollout = await ensureConnectorOutboxJob({ ...rolloutFields, metadata: metadataWithoutItem }, env);
  assert.equal(fromRollout.job.id, fromAppServer.job.id);
  assert.equal(fromRollout.created, false);
  assert.equal((await readConnectorOutbox(env)).jobs.length, 1);
});

for (const backend of ["json", "sqlite"]) test(`${backend}: two rollout entries both missing an item id still converge on shared turn identity`, async t => {
  const env = await fixture(t, backend);
  const { metadata: baseMetadata, ...rolloutFields } = output("rollout-first", { sourceEventId: "rollout-event-a" });
  const { runtimeItemId: _omittedA, ...metadataWithoutItemA } = baseMetadata;
  const first = await ensureConnectorOutboxJob({ ...rolloutFields, metadata: metadataWithoutItemA }, env);
  const { metadata: baseMetadataB, ...rolloutFieldsB } = output("rollout-second", { sourceEventId: "rollout-event-b" });
  const { runtimeItemId: _omittedB, ...metadataWithoutItemB } = baseMetadataB;
  const second = await ensureConnectorOutboxJob({ ...rolloutFieldsB, metadata: metadataWithoutItemB }, env);
  assert.equal(second.job.id, first.job.id);
  assert.equal(second.created, false);
  assert.equal((await readConnectorOutbox(env)).jobs.length, 1);
});

test("distinct turns, tenants, destinations and explicit revisions remain independent", async t => {
  const env = await fixture(t);
  const first = await ensureConnectorOutboxJob(output("first"), env);
  await markConnectorOutboxJob(first.job.id, { state: "delivered" }, env);
  for (const patch of [{ tenantId: "tenant-b", ownerUserId: "tenant-b" }, { ownerUserId: "owner-b" },
    { accountId: "account-b" }, { chatId: "chat-b" }, { threadId: "thread-b" }, { sourceRevision: "2" },
    ...["runtimeGeneration", "runtimeTurnId", "runtimeItemId"].map(key => ({ metadata: { ...output().metadata, [key]: "different" } }))]) {
    const next = await ensureConnectorOutboxJob(output("different-local", patch), env);
    assert.notEqual(next.job.id, first.job.id); assert.equal(next.created, true);
  }
});

test("conflicting runtime aliases fail closed instead of assigning another identity", () => {
  assert.throws(() => runtimeOutputMetadata({ role: "assistant", codexThreadId: "a", executorThreadId: "b" }), /identity_conflict/);
  assert.throws(() => runtimeOutputMetadata({ role: "assistant", codexTurnId: "a", executorTurnId: "b" }), /identity_conflict/);
  assert.throws(() => runtimeOutputMetadata({ role: "assistant", codexItemId: "a", executorItemId: "b" }), /identity_conflict/);
});

for (const backend of ["json", "sqlite"]) test(`${backend}: fresh processes reuse persisted uncertain receipt and output projection`, async t => {
  const env = await fixture(t, backend);
  const thread = await createThread({ id: "restart", ownerUserId: "tenant-a", name: "Synthetic restart" }, env);
  const answer = { role: "assistant", source: "codex-app-server", phase: "final_answer", state: "completed",
    text: "Synthetic answer", codexThreadId: "generation-a", codexTurnId: "turn-a", codexItemId: "item-a" };
  const message = await appendThreadMessage(thread.id, answer, env);
  const first = await ensureConnectorOutboxJob(output(message.id), env);
  await markConnectorOutboxJob(first.job.id, { state: "delivery_uncertain", brokerAck: { ids: ["receipt-a"] } }, env);
  const code = `
    import { appendThreadMessage } from ${JSON.stringify(new URL("../packages/core/src/threads.js", import.meta.url).href)};
    import { ensureConnectorOutboxJob } from ${JSON.stringify(new URL("../packages/connectors/src/connector-outbox.js", import.meta.url).href)};
    const env = JSON.parse(process.argv[1]);
    const message = await appendThreadMessage("restart", JSON.parse(process.argv[2]), env);
    const result = await ensureConnectorOutboxJob(JSON.parse(process.argv[3]), env);
    process.stdout.write(JSON.stringify({ message: message.id, job: result.job.id, state: result.job.state, ack: result.job.brokerAck }));
  `;
  const results = await Promise.all(Array.from({ length: 3 }, (_, i) => promisify(execFile)(process.execPath,
    ["--input-type=module", "-e", code, JSON.stringify(env), JSON.stringify({ ...answer, source: "codex-rollout", eventId: `reimport-${i}` }),
      JSON.stringify(output(`reimport-${i}`))], { env: { PATH: process.env.PATH, HOME: process.env.HOME }, timeout: 20000 })));
  for (const result of results) assert.deepEqual(JSON.parse(result.stdout), {
    message: message.id, job: first.job.id, state: "delivery_uncertain", ack: { ids: ["receipt-a"] },
  });
  assert.equal((await listThreadMessages(thread.id, env)).length, 1);
  assert.equal((await readConnectorOutbox(env)).jobs.length, 1);
});
