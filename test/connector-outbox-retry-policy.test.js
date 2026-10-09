import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claimConnectorOutboxJob, getConnectorOutboxJob, writeConnectorOutbox } from "../packages/connectors/src/connector-outbox.js";
import {
  connectorOutboxRetryDelayMs,
  connectorOutboxRetryExhausted,
  connectorOutboxRetryPolicy,
  maybeSweepExhaustedWhatsAppOutbox,
  sweepExhaustedWhatsAppOutbox,
} from "../packages/connectors/src/connector-outbox-retry-policy.js";

const hoursAgo = (hours) => new Date(Date.now() - hours * 3_600_000).toISOString();

function job(id, state, ageHours, extra = {}) {
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
    createdAt: hoursAgo(ageHours),
    // Routine retry updates are recent; they must not reset the age budget.
    updatedAt: hoursAgo(0.1),
    ...extra,
  };
}

async function fixture(extra = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-retry-policy-"));
  const env = { ORKESTR_HOME: home, ...extra };
  await writeConnectorOutbox({ jobs: [
    job("orphan-pending", "pending", 30 * 24),
    job("old-retry", "failed_retryable", 48, { attemptCount: 1, claimedBy: "retry_backoff", claimExpiresAt: hoursAgo(-1) }),
    job("many-attempts", "failed_retryable", 2, { attemptCount: 20, updatedAt: hoursAgo(1.5) }),
    job("many-attempts-active", "failed_retryable", 2, { attemptCount: 20 }),
    job("fresh-retry", "failed_retryable", 2, { attemptCount: 3 }),
    job("fresh-pending", "pending", 1),
    job("operator-retried", "pending", 72, { attemptCount: 25, metadata: { retryRequestedAt: hoursAgo(1) } }),
    job("old-ledger", "pending", 72),
    job("old-partial", "failed_retryable", 72, { error: "whatsapp_partial_delivery" }),
    job("old-claimed", "claimed", 72),
    job("old-delivered", "delivered", 72),
  ] }, env);
  const state = { outboundDeliveries: [{ connectorOutboxJobId: "old-ledger", messageId: "wa-fake-1", deliveredAt: hoursAgo(70) }], outboundIntents: [] };
  return { env, state };
}

test("retry delay backs off exponentially up to the cap", () => {
  const env = { ORKESTR_CONNECTOR_OUTBOX_RETRY_BACKOFF_MS: "1000", ORKESTR_CONNECTOR_OUTBOX_RETRY_BACKOFF_MAX_MS: "10000" };
  assert.deepEqual([1, 2, 3, 4, 5, 50].map((n) => connectorOutboxRetryDelayMs(n, env)), [1000, 2000, 4000, 8000, 10000, 10000]);
  assert.equal(connectorOutboxRetryDelayMs(3, { ORKESTR_CONNECTOR_OUTBOX_RETRY_BACKOFF_MS: "0" }), 0);
});

test("retry budget uses generation age and failed attempts, not routine updates", () => {
  const policy = connectorOutboxRetryPolicy({});
  assert.equal(policy.maxAttempts, 20);
  assert.equal(policy.maxAgeMs, 24 * 3_600_000);
  assert.equal(connectorOutboxRetryExhausted(job("a", "failed_retryable", 48), policy)?.reason, "connector_outbox_retry_max_age_exceeded");
  assert.equal(connectorOutboxRetryExhausted(job("b", "failed_retryable", 1, { attemptCount: 20, updatedAt: hoursAgo(2) }), policy)?.reason, "connector_outbox_retry_attempts_exhausted");
  assert.equal(connectorOutboxRetryExhausted(job("b2", "failed_retryable", 1, { attemptCount: 20 }), policy), null);
  assert.equal(connectorOutboxRetryExhausted(job("c", "pending", 1, { attemptCount: 20 }), policy), null);
  assert.equal(connectorOutboxRetryExhausted(job("d", "delivered", 48), policy), null);
  assert.equal(connectorOutboxRetryExhausted(job("e", "pending", 48), { ...policy, maxAgeMs: 0 }), null);
});

test("dry-run sweep reports exhausted jobs without changing anything", async () => {
  const { env, state } = await fixture();
  const result = await sweepExhaustedWhatsAppOutbox({ state }, env);
  assert.equal(result.dryRun, true);
  assert.equal(result.sendsMessages, false);
  assert.equal(result.eligible, 3);
  assert.equal(result.archived, 0);
  assert.deepEqual(result.byState, { pending: 1, failed_retryable: 2 });
  assert.deepEqual(result.skipped, { withinBudget: 4, ledgerMatch: 1, partialDelivery: 1 });
  assert.equal((await getConnectorOutboxJob("orphan-pending", env)).state, "pending");
});

test("apply archives exhausted jobs terminally, keeps updatedAt, and they cannot be claimed", async () => {
  const { env, state } = await fixture();
  const before = await getConnectorOutboxJob("old-retry", env);
  const result = await sweepExhaustedWhatsAppOutbox({ state, apply: true }, env);
  assert.equal(result.archived, 3);
  for (const id of ["orphan-pending", "old-retry", "many-attempts"]) {
    const archived = await getConnectorOutboxJob(id, env);
    assert.equal(archived.state, "archived", id);
    assert.equal(archived.metadata.retryPolicyArchive.archivedBy, "retry-policy");
  }
  const archived = await getConnectorOutboxJob("old-retry", env);
  assert.equal(archived.updatedAt, before.updatedAt);
  assert.equal(archived.metadata.retryPolicyArchive.reason, "connector_outbox_retry_max_age_exceeded");
  assert.equal(archived.metadata.retryPolicyArchive.fromState, "failed_retryable");
  assert.equal((await claimConnectorOutboxJob("old-retry", { claimant: "test" }, env)).acquired, false);
  for (const id of ["many-attempts-active", "fresh-retry", "fresh-pending", "operator-retried", "old-ledger", "old-partial", "old-claimed"]) {
    assert.notEqual((await getConnectorOutboxJob(id, env)).state, "archived", id);
  }
});

test("automatic sweep is throttled and can be disabled", async () => {
  const { env, state } = await fixture();
  assert.equal(await maybeSweepExhaustedWhatsAppOutbox(state, { ...env, ORKESTR_CONNECTOR_OUTBOX_RETRY_SWEEP_INTERVAL_MS: "0" }, env.ORKESTR_HOME), null);
  assert.equal((await maybeSweepExhaustedWhatsAppOutbox(state, env, env.ORKESTR_HOME)).archived, 3);
  assert.equal(await maybeSweepExhaustedWhatsAppOutbox(state, env, env.ORKESTR_HOME), null);
});
