import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyConnectorOutboxJobAction,
  claimConnectorOutboxJob,
  deliveryUncertainReplayConfirmation,
  getConnectorOutboxJob,
  listConnectorOutboxJobs,
  writeConnectorOutbox,
} from "../packages/connectors/src/connector-outbox.js";
import { archiveStaleWhatsAppOutbox, parseOlderThan } from "../packages/connectors/src/whatsapp-outbox-stale-archive.js";
import { formatStaleOutboxArchive } from "../apps/cli/src/doctor-whatsapp-outbox-command.js";
import { dataPaths } from "../packages/storage/src/paths.js";

const daysAgo = (days) => new Date(Date.now() - days * 86_400_000).toISOString();

function job(id, state, ageDays, extra = {}) {
  const at = daysAgo(ageDays);
  return {
    id,
    idempotencyKey: `key-${id}`,
    connector: "whatsapp",
    accountId: "fake-account",
    chatId: "fake-chat@g.us",
    threadId: "fake-thread",
    sourceMessageId: `msg-${id}`,
    deliveryType: "final",
    state,
    payload: { text: "fake body" },
    createdAt: at,
    updatedAt: at,
    ...extra,
  };
}

async function fixture(extra = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-stale-outbox-"));
  const env = { ORKESTR_HOME: home, ...extra };
  await writeConnectorOutbox({ jobs: [
    job("old-pending", "pending", 30),
    job("old-retry", "failed_retryable", 10, { error: "whatsapp_local_bridge_not_ready" }),
    job("old-uncertain", "delivery_uncertain", 9),
    job("old-ledger", "pending", 20),
    job("old-partial", "failed_retryable", 20, { error: "whatsapp_partial_delivery" }),
    job("old-claimed", "claimed", 20),
    job("fresh-pending", "pending", 1),
    job("old-delivered", "delivered", 40),
  ] }, env);
  await fs.writeFile(dataPaths(env).whatsapp, JSON.stringify({
    outboundDeliveries: [{ connectorOutboxJobId: "old-ledger", messageId: "wa-fake-1", deliveredAt: daysAgo(20) }],
    outboundIntents: [],
  }));
  return env;
}

test("stale outbox archive dry-run reports by state and age without changing anything", async () => {
  const env = await fixture();
  const before = await listConnectorOutboxJobs({ connector: "whatsapp" }, env);
  const result = await archiveStaleWhatsAppOutbox({ olderThan: "7d" }, env);
  assert.equal(result.dryRun, true);
  assert.equal(result.sendsMessages, false);
  assert.equal(result.eligible, 3);
  assert.equal(result.archived, 0);
  assert.deepEqual(Object.fromEntries(Object.entries(result.byState).map(([state, entry]) => [state, entry.count])),
    { pending: 1, failed_retryable: 1, delivery_uncertain: 1 });
  assert.deepEqual(result.byAge, { "7-14d": 2, "30-90d": 1 });
  assert.equal(result.skipped.ledgerMatch, 1);
  assert.equal(result.skipped.partialDelivery, 1);
  assert.equal(result.skipped.recent, 1);
  const after = await listConnectorOutboxJobs({ connector: "whatsapp" }, env);
  assert.deepEqual(after.jobs.map((item) => [item.id, item.state, item.updatedAt]), before.jobs.map((item) => [item.id, item.state, item.updatedAt]));
  assert.match(formatStaleOutboxArchive(result), /dry-run \(nothing changed\)[\s\S]*would archive 3/);
});

test("stale outbox archive apply keeps rows, preserves updatedAt and blocks sends", async () => {
  const env = await fixture();
  const original = await getConnectorOutboxJob("old-uncertain", env);
  const result = await archiveStaleWhatsAppOutbox({ olderThan: "7d", apply: true, operator: "test" }, env);
  assert.equal(result.archived, 3);
  assert.equal(result.remainingAfterRun, 0);
  const archived = await listConnectorOutboxJobs({ connector: "whatsapp", state: "archived" }, env);
  assert.deepEqual(archived.jobs.map((item) => item.id).sort(), ["old-pending", "old-retry", "old-uncertain"]);
  const uncertain = await getConnectorOutboxJob("old-uncertain", env);
  assert.equal(uncertain.updatedAt, original.updatedAt);
  assert.equal(uncertain.metadata.deliveryUncertain, true);
  assert.equal(uncertain.metadata.staleArchive.fromState, "delivery_uncertain");
  assert.equal((await getConnectorOutboxJob("old-ledger", env)).state, "pending");
  assert.equal((await getConnectorOutboxJob("old-claimed", env)).state, "claimed");
  assert.equal((await getConnectorOutboxJob("fresh-pending", env)).state, "pending");

  const claim = await claimConnectorOutboxJob("old-pending", { claimant: "worker" }, env);
  assert.equal(claim.acquired, false);
  assert.equal(claim.reason, "connector_outbox_archived");
  await assert.rejects(() => applyConnectorOutboxJobAction("old-uncertain", "retry", {}, env), /delivery_uncertain_retry_requires_override/);
  const reopened = await applyConnectorOutboxJobAction("old-uncertain", "retry", {
    allowDeliveryUncertainReplay: true, deliveryUncertainReplayConfirmation, reason: "operator restore",
  }, env);
  assert.equal(reopened.job.state, "pending");

  const second = await archiveStaleWhatsAppOutbox({ olderThan: "7d" }, env);
  assert.equal(second.eligible, 0);
});

test("archived jobs are not pruned by terminal retention", async () => {
  const env = await fixture({ ORKESTR_CONNECTOR_OUTBOX_RETENTION: "1" });
  await archiveStaleWhatsAppOutbox({ olderThan: "7d", apply: true }, env);
  await writeConnectorOutbox({ jobs: [...(await listConnectorOutboxJobs({}, env)).jobs, job("new-delivered", "delivered", 0)] }, env);
  const archived = await listConnectorOutboxJobs({ connector: "whatsapp", state: "archived" }, env);
  assert.equal(archived.total, 3);
  assert.equal((await listConnectorOutboxJobs({ state: "delivered" }, env)).total, 1);
});

test("stale outbox archive respects the limit and rejects thresholds under one day", async () => {
  const env = await fixture();
  const result = await archiveStaleWhatsAppOutbox({ olderThan: "7d", apply: true, limit: 1 }, env);
  assert.equal(result.archived, 1);
  assert.equal(result.remainingAfterRun, 2);
  assert.equal((await getConnectorOutboxJob("old-pending", env)).state, "archived");
  assert.equal(parseOlderThan("36h"), 36 * 3_600_000);
  assert.throws(() => parseOlderThan("2h"), /below_minimum/);
  assert.throws(() => parseOlderThan("soon"), /older_than_invalid/);
});
