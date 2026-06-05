import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  claimConnectorOutboxJob,
  connectorOutboxTerminalState,
  ensureConnectorOutboxJob,
  markConnectorOutboxJob,
  readConnectorOutbox,
} from "../packages/connectors/src/connector-outbox.js";

function env(home, extra = {}) {
  return {
    ORKESTR_HOME: home,
    ORKESTR_CONNECTOR_OUTBOX_CLAIM_TTL_MS: "5000",
    ...extra,
  };
}

function whatsappJob(input = {}) {
  return {
    connector: "whatsapp",
    accountId: "responder",
    chatId: "shared-chat",
    threadId: "thread-1",
    sourceEventId: "message-1",
    sourceMessageId: "message-1",
    sourceRevision: "1",
    deliveryType: "final",
    payload: { text: "same outbound body" },
    ...input,
  };
}

test("connector outbox idempotency is tenant scoped and terminal states block duplicate claims", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-connector-outbox-"));
  const runtimeEnv = env(home);
  const first = await ensureConnectorOutboxJob(whatsappJob({ tenantId: "tenant-a" }), runtimeEnv);
  const duplicate = await ensureConnectorOutboxJob(whatsappJob({ tenantId: "tenant-a" }), runtimeEnv);
  const otherTenant = await ensureConnectorOutboxJob(whatsappJob({ tenantId: "tenant-b" }), runtimeEnv);
  const store = await readConnectorOutbox(runtimeEnv);

  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(otherTenant.created, true);
  assert.equal(store.jobs.length, 2);
  assert.notEqual(first.job.idempotencyKey, otherTenant.job.idempotencyKey);

  const claim = await claimConnectorOutboxJob(first.job.id, { claimant: "worker-a" }, runtimeEnv);
  const duplicateClaim = await claimConnectorOutboxJob(first.job.id, { claimant: "worker-b" }, runtimeEnv);
  assert.equal(claim.acquired, true);
  assert.equal(duplicateClaim.acquired, false);
  assert.equal(duplicateClaim.reason, "connector_outbox_claim_active");

  const delivered = await markConnectorOutboxJob(first.job.id, { state: "delivered", deliveredAt: new Date().toISOString() }, runtimeEnv);
  const terminalClaim = await claimConnectorOutboxJob(first.job.id, { claimant: "worker-c" }, runtimeEnv);
  assert.equal(connectorOutboxTerminalState(delivered.state), true);
  assert.equal(terminalClaim.acquired, false);
  assert.equal(terminalClaim.reason, "connector_outbox_delivered");
});

test("connector outbox expired claims are retryable after broker downtime", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-connector-outbox-expired-"));
  const runtimeEnv = env(home);
  const old = new Date(Date.now() - 60_000).toISOString();
  const { job } = await ensureConnectorOutboxJob(whatsappJob({
    tenantId: "tenant-a",
    state: "claimed",
    claimedBy: "old-worker",
    claimedAt: old,
    claimExpiresAt: old,
    attemptCount: 1,
  }), runtimeEnv);

  const claim = await claimConnectorOutboxJob(job.id, { claimant: "new-worker" }, runtimeEnv);

  assert.equal(claim.acquired, true);
  assert.equal(claim.job.claimedBy, "new-worker");
  assert.equal(claim.job.attemptCount, 2);
});
