import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { auditWhatsAppRecovery, reportWhatsAppRecovery } from "../packages/connectors/src/whatsapp-recovery-audit.js";
import { runRecoveryAudit } from "../scripts/whatsapp-recovery-audit.mjs";
import { createThread, appendThreadMessage, listThreadMessages } from "../packages/core/src/threads.js";
import { ensureConnectorOutboxJob, readConnectorOutbox } from "../packages/connectors/src/connector-outbox.js";
import { listEvents } from "../packages/storage/src/store.js";

const scope = { ownerUserId: "owner-a", threadId: "thread-a", accountId: "account-a", chatId: "chat-a",
  runtimeGeneration: "generation-a", since: "2026-01-01T00:00:00Z", until: "2026-01-01T01:00:00Z" };
const message = { id: "message-a", role: "assistant", phase: "final_answer", state: "completed",
  ownerUserId: scope.ownerUserId, threadId: scope.threadId, codexThreadId: scope.runtimeGeneration,
  text: "Private message", attachments: [{ path: "/private/sample.csv" }] };
const job = { id: "job-a", connector: "whatsapp", ownerUserId: scope.ownerUserId, threadId: scope.threadId,
  accountId: scope.accountId, chatId: scope.chatId, sourceMessageId: message.id, sourceRevision: "revision-a",
  payloadHash: "payload-a", state: "failed_retryable", deliveryType: "final", createdAt: "2026-01-01T00:30:00Z",
  metadata: { runtimeGeneration: scope.runtimeGeneration }, error: "whatsapp_local_bridge_not_ready",
  payload: { text: message.text, attachments: message.attachments } };
const audit = (jobs = [job], messages = [message], complete = true) => auditWhatsAppRecovery({ jobs, messages, complete }, scope);

test("recovery audit offers only exact incident availability failures for manual review", () => {
  const before = JSON.stringify({ job, message });
  const result = audit();
  assert.equal(result.counts.eligible, 1);
  assert.equal(result.counts.replayed, 0);
  assert.equal(result.automaticReplay, false);
  assert.equal(result.rows[0].automaticReplay, false);
  assert.equal(JSON.stringify({ job, message }), before);
  assert.equal(JSON.stringify(result).includes(message.text), false);
  assert.equal(JSON.stringify(result).includes("/private/"), false);
  assert.equal(audit([{ ...job, state: "dead_letter" }]).counts.eligible, 1);
  assert.equal(audit([job], [message], false).counts.unresolved, 1);
});

test("pending shadows, uncertain, partial and conflicting identities never become replay candidates", () => {
  const cases = [
    { state: "pending" }, { state: "delivery_uncertain" }, { state: "claimed" }, { state: "sent_to_broker" },
    { state: "partial_delivery" }, { payloadHash: "" }, { sourceRevision: "" }, { createdAt: "unknown" },
    { metadata: { ...job.metadata, retrySuppressed: true } },
    { metadata: { ...job.metadata, nonRetryable: true } },
    { metadata: { ...job.metadata, deliveryUncertain: true } },
    { metadata: { runtimeGeneration: "different" } },
    { error: "whatsapp_partial_delivery: whatsapp_local_bridge_not_ready" },
    { error: "stale_runtime" }, { error: "whatsapp_send_media_timeout" },
    ...[401, 403, 404].map(httpStatus => ({ metadata: { ...job.metadata, httpStatus } })),
  ];
  for (const patch of cases) {
    const result = audit([{ ...job, ...patch }]);
    assert.equal(result.counts.eligible, 0, JSON.stringify(patch));
    assert.equal(result.counts.unresolved, 1, JSON.stringify(patch));
  }
  assert.equal(audit([job], [{ ...message, codexThreadId: "old" }]).counts.unresolved, 1);
  assert.equal(audit([job], [message, message]).counts.unresolved, 1);
  assert.equal(audit([{ ...job, createdAt: "2025-01-01T00:00:00Z" }]).counts.skipped, 1);
});

test("only exact scoped delivered lineage qualifies as a duplicate shadow", () => {
  const delivered = { ...job, id: "delivered", state: "delivered" };
  assert.equal(audit([job, delivered]).counts.duplicate, 1);
  for (const patch of [{ payloadHash: "changed" }, { sourceRevision: "changed" },
    { metadata: { runtimeGeneration: "old" } }]) {
    const result = audit([job, { ...delivered, ...patch }]);
    assert.equal(result.counts.duplicate, 0);
    assert.equal(result.counts.eligible, 0);
  }
  for (const patch of [{ ownerUserId: "other" }, { threadId: "other" }, { accountId: "other" }, { chatId: "other" }]) {
    const result = audit([job, { ...delivered, ...patch }]);
    assert.equal(result.rows.length, 1);
    assert.equal(result.counts.duplicate, 0);
  }
  assert.equal(audit([job, { ...job, id: "second" }]).counts.unresolved, 2);
  const canonical = { ...job.metadata, canonicalFinalProjection: true, routerTraceId: "trace-a", bodyKey: "body-a" };
  assert.equal(audit([{ ...job, metadata: canonical }, { ...delivered, sourceMessageId: "projection", metadata: canonical }]).counts.duplicate, 1);
  assert.equal(audit([job, { ...delivered, sourceMessageId: "projection" }]).counts.duplicate, 0);
});

test("recovery audit requires explicit scope and never reports unrelated data", () => {
  assert.throws(() => auditWhatsAppRecovery({ jobs: [job], messages: [message] }, { ...scope, ownerUserId: "" }), /scope/);
  assert.throws(() => auditWhatsAppRecovery({ jobs: [job], messages: [message] }, { ...scope, until: "2025-01-01" }), /scope/);
  assert.deepEqual(audit([{ ...job, ownerUserId: "other", id: "private-other-id" }]).rows, []);
  assert.throws(() => audit([null]), /inventory/);
});

test("source alias conflicts and duplicate inventory IDs cannot qualify recovery", () => {
  for (const patch of [{ executorThreadId: "other-generation" },
    { codexTurnId: "turn-a", executorTurnId: "other-turn" },
    { codexItemId: "item-a", executorItemId: "other-item" }]) {
    assert.equal(audit([job], [{ ...message, ...patch }]).counts.unresolved, 1);
  }
  assert.equal(audit([job], [message, { ...message, ownerUserId: "other" }]).counts.unresolved, 1);
});

test("a delivered sibling cannot hide uncertain, conflicting or duplicate lineage records", () => {
  const delivered = { ...job, id: "delivered", state: "delivered" };
  for (const sibling of [
    { ...job, id: "conflict", sourceRevision: "different" },
    { ...job, id: "uncertain", state: "delivery_uncertain" },
    { ...job, id: "partial", state: "partial_delivery" },
    { ...job, id: "inflight", state: "claimed" },
    { ...delivered },
  ]) {
    const result = audit([job, delivered, sibling]);
    assert.equal(result.rows.find(row => row.jobId === job.id).disposition, "unresolved");
  }
});

test("repository and CLI recovery audit preserve storage and never call a transport", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ork-recovery-audit-"));
  t.after(() => fs.rm(home, { recursive: true, force: true, maxRetries: 5 }));
  const env = { ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: scope.ownerUserId };
  await createThread({ id: scope.threadId, ownerUserId: scope.ownerUserId, name: "Synthetic audit" }, env);
  const storedMessage = await appendThreadMessage(scope.threadId, { ...message, attachments: [] }, env);
  await ensureConnectorOutboxJob({ ...job, sourceMessageId: storedMessage.id }, env);
  const before = { messages: await listThreadMessages(scope.threadId, env), outbox: await readConnectorOutbox(env),
    events: await listEvents(env, 1000) };
  let transportCalls = 0;
  t.mock.method(globalThis, "fetch", async () => { transportCalls++; throw new Error("unexpected_transport"); });
  const report = await reportWhatsAppRecovery(scope, env);
  assert.equal(report.complete, true);
  assert.equal(report.counts.eligible, 1);
  const reportPath = path.join(home, "private", "report.json");
  const args = ["--thread", scope.threadId, "--owner", scope.ownerUserId, "--account", scope.accountId,
    "--chat", scope.chatId, "--generation", scope.runtimeGeneration, "--since", scope.since, "--until", scope.until,
    "--report", reportPath];
  const consoleResult = await runRecoveryAudit(args, env);
  assert.equal(consoleResult.snapshotDigest, report.snapshotDigest);
  assert.equal(JSON.stringify(consoleResult).includes(scope.chatId), false);
  assert.equal((await fs.stat(reportPath)).mode & 0o777, 0o600);
  await assert.rejects(runRecoveryAudit([...args, "--apply", "yes"], env), /invalid_arguments/);
  await assert.rejects(reportWhatsAppRecovery({ ...scope, ownerUserId: "other" }, env), /owner_mismatch/);
  assert.equal(transportCalls, 0);
  assert.deepEqual(await listThreadMessages(scope.threadId, env), before.messages);
  assert.deepEqual(await readConnectorOutbox(env), before.outbox);
  assert.deepEqual(await listEvents(env, 1000), before.events);
});
