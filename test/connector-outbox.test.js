import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import {
  applyConnectorOutboxJobAction,
  claimConnectorOutboxJob,
  connectorOutboxRetentionLimit,
  connectorOutboxTerminalState,
  ensureConnectorOutboxJob,
  listConnectorOutboxJobs,
  mergeConnectorOutboxJobs,
  markConnectorOutboxJob,
  readConnectorOutbox,
} from "../packages/connectors/src/connector-outbox.js";
import { approvePairingChallenge, createPairingChallenge, pairBrowser, sessionCookieHeader } from "../packages/core/src/security.js";
import { dataPaths } from "../packages/storage/src/paths.js";

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

test("connector outbox idempotency is scoped by source revision and delivery type", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-connector-outbox-revision-key-"));
  const runtimeEnv = env(home);
  const first = await ensureConnectorOutboxJob(whatsappJob({
    tenantId: "tenant-a",
    payload: { text: "first body" },
  }), runtimeEnv);
  const duplicateRevision = await ensureConnectorOutboxJob(whatsappJob({
    tenantId: "tenant-a",
    sourceEventId: "event-from-retry",
    payload: { text: "same revision retry body" },
  }), runtimeEnv);
  const editedRevision = await ensureConnectorOutboxJob(whatsappJob({
    tenantId: "tenant-a",
    sourceRevision: "2",
    deliveryType: "edit_notice",
    payload: { text: "correction body" },
  }), runtimeEnv);
  const store = await readConnectorOutbox(runtimeEnv);

  assert.equal(first.created, true);
  assert.equal(duplicateRevision.created, false);
  assert.equal(editedRevision.created, true);
  assert.equal(store.jobs.length, 2);
  assert.equal(store.jobs.some((job) => job.sourceRevision === "1" && job.deliveryType === "final"), true);
  assert.equal(store.jobs.some((job) => job.sourceRevision === "2" && job.deliveryType === "edit_notice"), true);
  assert.equal(first.job.idempotencyKey, duplicateRevision.job.idempotencyKey);
  assert.notEqual(first.job.idempotencyKey, editedRevision.job.idempotencyKey);
});

test("connector outbox preserves original creation time across idempotent active merges", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-connector-outbox-created-at-"));
  const runtimeEnv = env(home);
  const createdAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const first = await ensureConnectorOutboxJob(whatsappJob({
    tenantId: "tenant-a",
    state: "pending",
    createdAt,
    updatedAt: createdAt,
    payload: { text: "old pending body" },
  }), runtimeEnv);

  const duplicate = await ensureConnectorOutboxJob(whatsappJob({
    tenantId: "tenant-a",
    state: "pending",
    payload: { text: "new scan body" },
  }), runtimeEnv);

  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.job.createdAt, createdAt);
  assert.equal(duplicate.job.payload.text, "new scan body");
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

test("connector outbox operator actions list and terminalize selected jobs", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-connector-outbox-ops-"));
  const runtimeEnv = env(home);
  const { job } = await ensureConnectorOutboxJob(whatsappJob({
    tenantId: "tenant-a",
    state: "failed_retryable",
    failedAt: new Date().toISOString(),
    error: "bridge_down",
  }), runtimeEnv);

  const listed = await listConnectorOutboxJobs({ connector: "whatsapp", state: "failed_retryable", tenantId: "tenant-a" }, runtimeEnv);
  assert.equal(listed.count, 1);
  assert.equal(listed.jobs[0].id, job.id);

  const suppressed = await applyConnectorOutboxJobAction(job.id, "suppress", { reason: "stale", operator: "tester" }, runtimeEnv);
  assert.equal(suppressed.job.state, "suppressed");
  assert.equal(suppressed.job.error, "stale");
  assert.equal(suppressed.job.claimedBy, "");

  const retry = await applyConnectorOutboxJobAction(job.id, "retry", { reason: "operator retry", operator: "tester" }, runtimeEnv);
  assert.equal(retry.job.state, "pending");
  assert.equal(retry.job.error, "");
  assert.equal(retry.job.skippedAt, "");
  assert.equal(retry.job.metadata.retryRequestedBy, "tester");

  const delivered = await applyConnectorOutboxJobAction(job.id, "mark-delivered", { reason: "confirmed elsewhere", operator: "tester" }, runtimeEnv);
  assert.equal(delivered.job.state, "delivered");
  assert.equal(delivered.job.brokerAck.operatorMarked, true);
});

test("whatsapp outbox diagnostics require an admin principal", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-connector-outbox-admin-"));
  const priorHome = process.env.ORKESTR_HOME;
  const priorAuth = process.env.ORKESTR_AUTH_REQUIRED;
  const priorRecover = process.env.ORKESTR_RECOVER_RUNNING_ON_START;
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  const runtimeEnv = env(home);
  const { job } = await ensureConnectorOutboxJob(whatsappJob({
    tenantId: "tenant-a",
    state: "failed_retryable",
    failedAt: new Date().toISOString(),
    error: "bridge_down",
  }), runtimeEnv);
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const challenge = await createPairingChallenge({ env: process.env, userId: "alice", role: "user" });
    await approvePairingChallenge(challenge.challengeId, { env: process.env });
    const paired = await pairBrowser({ challengeId: challenge.challengeId, env: process.env });
    const cookie = sessionCookieHeader(paired.token, process.env);

    const listResponse = await fetch(`${baseUrl}/api/connectors/whatsapp/outbox?threadId=thread-1`, {
      headers: { cookie },
    });
    const listPayload = await listResponse.json();
    assert.equal(listResponse.status, 403);
    assert.equal(listPayload.error, "connector_admin_required");

    const actionResponse = await fetch(`${baseUrl}/api/connectors/whatsapp/outbox/${encodeURIComponent(job.id)}/suppress`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ reason: "test" }),
    });
    const actionPayload = await actionResponse.json();
    assert.equal(actionResponse.status, 403);
    assert.equal(actionPayload.error, "connector_admin_required");
  } finally {
    await server.close();
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
    if (priorAuth === undefined) delete process.env.ORKESTR_AUTH_REQUIRED;
    else process.env.ORKESTR_AUTH_REQUIRED = priorAuth;
    if (priorRecover === undefined) delete process.env.ORKESTR_RECOVER_RUNNING_ON_START;
    else process.env.ORKESTR_RECOVER_RUNNING_ON_START = priorRecover;
  }
});

test("connector outbox retention prunes terminal history but keeps active jobs", async () => {
  const runtimeEnv = env("/tmp/unused-orkestr-connector-outbox-retention", {
    ORKESTR_CONNECTOR_OUTBOX_RETENTION: "2",
  });
  const oldActive = whatsappJob({
    tenantId: "tenant-a",
    sourceMessageId: "active-old",
    sourceEventId: "active-old",
    state: "pending",
    createdAt: "2026-06-07T10:00:00.000Z",
    updatedAt: "2026-06-07T10:00:00.000Z",
  });
  const terminalOne = whatsappJob({
    tenantId: "tenant-a",
    sourceMessageId: "terminal-1",
    sourceEventId: "terminal-1",
    state: "delivered",
    createdAt: "2026-06-07T10:01:00.000Z",
    updatedAt: "2026-06-07T10:01:00.000Z",
  });
  const terminalTwo = whatsappJob({
    tenantId: "tenant-a",
    sourceMessageId: "terminal-2",
    sourceEventId: "terminal-2",
    state: "skipped",
    createdAt: "2026-06-07T10:02:00.000Z",
    updatedAt: "2026-06-07T10:02:00.000Z",
  });
  const terminalThree = whatsappJob({
    tenantId: "tenant-a",
    sourceMessageId: "terminal-3",
    sourceEventId: "terminal-3",
    state: "suppressed",
    createdAt: "2026-06-07T10:03:00.000Z",
    updatedAt: "2026-06-07T10:03:00.000Z",
  });

  const merged = mergeConnectorOutboxJobs([oldActive, terminalOne, terminalTwo, terminalThree], [], runtimeEnv);

  assert.equal(connectorOutboxRetentionLimit(runtimeEnv), 2);
  assert.deepEqual(merged.map((job) => job.sourceMessageId), ["active-old", "terminal-2", "terminal-3"]);
  assert.equal(merged.find((job) => job.sourceMessageId === "active-old")?.state, "pending");
});

test("connector outbox migrates large JSON stores to SQLite without rewriting JSON on hot actions", async (t) => {
  try {
    await import("node:sqlite");
  } catch {
    t.skip("node:sqlite unavailable");
    return;
  }
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-connector-outbox-sqlite-"));
  const runtimeEnv = env(home, {
    ORKESTR_CONNECTOR_OUTBOX_STORE: "sqlite",
    ORKESTR_CONNECTOR_OUTBOX_RETENTION: "10000",
  });
  const paths = dataPaths(runtimeEnv);
  const jobs = [];
  for (let index = 0; index < 10000; index += 1) {
    jobs.push(whatsappJob({
      tenantId: `tenant-${index % 25}`,
      chatId: `chat-${index % 100}`,
      threadId: `thread-${index % 50}`,
      sourceEventId: `delivered-${index}`,
      sourceMessageId: `delivered-${index}`,
      state: "delivered",
      deliveredAt: new Date(Date.now() - index * 1000).toISOString(),
      createdAt: new Date(Date.now() - index * 1000).toISOString(),
      updatedAt: new Date(Date.now() - index * 1000).toISOString(),
      payload: { text: `delivered body ${index}` },
    }));
  }
  for (let index = 0; index < 5; index += 1) {
    jobs.push(whatsappJob({
      tenantId: "tenant-hot",
      chatId: "chat-hot",
      threadId: "thread-hot",
      sourceEventId: `retry-${index}`,
      sourceMessageId: `retry-${index}`,
      state: "failed_retryable",
      failedAt: new Date().toISOString(),
      error: "bridge_down",
      payload: { text: `retry body ${index}` },
    }));
  }
  await fs.writeFile(paths.connectorOutbox, `${JSON.stringify({ schemaVersion: 1, jobs }, null, 2)}\n`);
  const before = await fs.stat(paths.connectorOutbox);

  const retryable = await listConnectorOutboxJobs({
    connector: "whatsapp",
    state: "failed_retryable",
    tenantId: "tenant-hot",
  }, runtimeEnv);
  assert.equal(retryable.backend, "sqlite");
  assert.equal(retryable.total, 5);
  assert.equal(retryable.count, 5);
  assert.ok((await fs.stat(paths.connectorOutboxDb)).size > 0);

  const claimed = await claimConnectorOutboxJob(retryable.jobs[0].id, { claimant: "sqlite-worker" }, runtimeEnv);
  assert.equal(claimed.acquired, true);
  const delivered = await markConnectorOutboxJob(claimed.job.id, {
    state: "delivered",
    deliveredAt: new Date().toISOString(),
  }, runtimeEnv);
  assert.equal(delivered.state, "delivered");

  const after = await fs.stat(paths.connectorOutbox);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.size, before.size);
});
