import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { mock } from "node:test";
import { appendThreadMessage, createThread } from "../packages/core/src/threads.js";
import { readConnectorOutbox } from "../packages/connectors/src/connector-outbox.js";
import { deliverWhatsAppReplies } from "../packages/connectors/src/whatsapp.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";
import { readJson } from "../packages/storage/src/store.js";
import { dataPaths } from "../packages/storage/src/paths.js";
import { acquireOutboundDeliveryClaim } from "../packages/connectors/src/whatsapp-delivery-ledger.js";

// A retryable bridge failure must be retried when its backoff expires even if
// nothing else changes in the thread. Synthetic chat/account IDs; mocked bridge.

const BACKOFF_MS = 60_000;
const T0 = Date.parse("2026-10-12T16:05:00.000Z");

function response(payload, ok = true, status = 200) {
  return { ok, status, async json() { return payload; } };
}

async function fixture(t, name) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), `orkestr-wa-retry-due-${name}-`));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1",
    ORKESTR_WHATSAPP_DEBUG_FOOTER: "0",
    ORKESTR_WHATSAPP_API_AGENT_AUTORUN: "0",
    ORKESTR_CONNECTOR_OUTBOX_RETRY_BACKOFF_MS: String(BACKOFF_MS),
    // Production store; the scan-skip cache only applies with its fingerprints.
    ORKESTR_THREAD_STORE: "sqlite",
  };
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.example.test" }, env);
  const threadId = `thread-wa-retry-due-${name}`;
  await createThread({
    id: threadId,
    ownerUserId: "tenant-a",
    name: "WA retry due scan",
    binding: { connector: "whatsapp", chatId: "synthetic-chat", responderAccountId: "responder", outboundAccountId: "responder", mirrorToWhatsApp: true },
  }, env);
  const parent = await appendThreadMessage(threadId, {
    role: "user", source: "whatsapp_inbound", state: "completed", connector: "whatsapp", chatId: "synthetic-chat", accountId: "responder", text: "summary?",
  }, env);
  const reply = await appendThreadMessage(threadId, {
    role: "assistant", source: "codex-app-server", phase: "final_answer", state: "completed",
    parentMessageId: parent.id, chatId: "synthetic-chat", accountId: "responder", text: "Synthetic summary.",
  }, env);
  return { env, reply };
}

function bridge() {
  const sends = [];
  let mode = "not_ready";
  const fetchImpl = async (url) => {
    if (url.pathname === "/send-text") {
      sends.push(new Date(Date.now()).toISOString());
      if (mode === "not_ready") throw new Error("whatsapp_local_bridge_not_ready");
      if (mode === "unknown_account") throw new Error("unknown_whatsapp_account");
      return response({ ok: true, ids: [`synthetic-ack-${sends.length}`] });
    }
    return response({ ok: true, ready: true });
  };
  return { fetchImpl, sends, set: (next) => { mode = next; } };
}

async function job(env, reply) {
  return (await readConnectorOutbox(env)).jobs.find((item) => item.sourceMessageId === reply.id);
}

test("an unchanged thread is retried once its backoff expires, not before, and only once", async (t) => {
  mock.timers.enable({ apis: ["Date"], now: T0 });
  t.after(() => mock.timers.reset());
  const { env, reply } = await fixture(t, "due");
  const wa = bridge();

  await deliverWhatsAppReplies(env, wa.fetchImpl);
  assert.equal(wa.sends.length, 1);
  assert.equal((await job(env, reply)).state, "failed_retryable");

  // Before the retry time: passes over the unchanged thread send nothing.
  for (const offset of [1_000, 30_000, BACKOFF_MS - 1_000]) {
    mock.timers.setTime(T0 + offset);
    await deliverWhatsAppReplies(env, wa.fetchImpl);
  }
  assert.equal(wa.sends.length, 1, "no premature retry");

  // Retry due; the thread itself has not changed and the bridge recovered.
  wa.set("ok");
  mock.timers.setTime(T0 + BACKOFF_MS + 1_000);
  const due = await deliverWhatsAppReplies(env, wa.fetchImpl);
  assert.equal(wa.sends.length, 2, "the due retry was attempted");
  assert.equal(due.delivered.length, 1);
  assert.equal((await job(env, reply)).state, "delivered");

  // Later passes do not send it again.
  for (const offset of [BACKOFF_MS + 2_000, 5 * 60_000]) {
    mock.timers.setTime(T0 + offset);
    await deliverWhatsAppReplies(env, wa.fetchImpl);
  }
  assert.equal(wa.sends.length, 2, "no duplicate send");
});

test("a retry that fails again backs off again before the next attempt", async (t) => {
  mock.timers.enable({ apis: ["Date"], now: T0 });
  t.after(() => mock.timers.reset());
  const { env, reply } = await fixture(t, "again");
  const wa = bridge();

  await deliverWhatsAppReplies(env, wa.fetchImpl);
  mock.timers.setTime(T0 + 1_000);
  await deliverWhatsAppReplies(env, wa.fetchImpl);
  mock.timers.setTime(T0 + BACKOFF_MS + 1_000);
  await deliverWhatsAppReplies(env, wa.fetchImpl);
  assert.equal(wa.sends.length, 2, "first due retry attempted");
  const second = await job(env, reply);
  assert.equal(second.state, "failed_retryable");
  const nextAt = Date.parse(second.claimExpiresAt);
  assert.ok(nextAt > T0 + BACKOFF_MS + 1_000, "a new, later retry time");

  mock.timers.setTime(nextAt - 1_000);
  await deliverWhatsAppReplies(env, wa.fetchImpl);
  assert.equal(wa.sends.length, 2, "no attempt inside the new backoff");

  wa.set("ok");
  mock.timers.setTime(nextAt + 1_000);
  await deliverWhatsAppReplies(env, wa.fetchImpl);
  assert.equal(wa.sends.length, 3);
  assert.equal((await job(env, reply)).state, "delivered");
});

test("a retry first seen after the stale window stays suppressed", async (t) => {
  mock.timers.enable({ apis: ["Date"], now: T0 });
  t.after(() => mock.timers.reset());
  const { env, reply } = await fixture(t, "stale");
  const wa = bridge();

  await deliverWhatsAppReplies(env, wa.fetchImpl);
  mock.timers.setTime(T0 + 1_000);
  await deliverWhatsAppReplies(env, wa.fetchImpl);
  wa.set("ok");
  mock.timers.setTime(T0 + 16 * 60_000);
  await deliverWhatsAppReplies(env, wa.fetchImpl);
  assert.equal(wa.sends.length, 1, "stale item not sent");
  const stale = await job(env, reply);
  assert.notEqual(stale.state, "delivered");
  assert.notEqual(stale.state, "failed_retryable", "the stale policy suppressed it when the due retry was revisited");
});

test("a dead-lettered item is never revisited for sending", async (t) => {
  mock.timers.enable({ apis: ["Date"], now: T0 });
  t.after(() => mock.timers.reset());
  const { env, reply } = await fixture(t, "dead");
  const wa = bridge();
  wa.set("unknown_account");

  await deliverWhatsAppReplies(env, wa.fetchImpl);
  assert.equal((await job(env, reply)).state, "dead_letter");
  wa.set("ok");
  for (const offset of [BACKOFF_MS + 1_000, 10 * 60_000, 2 * 3_600_000]) {
    mock.timers.setTime(T0 + offset);
    await deliverWhatsAppReplies(env, wa.fetchImpl);
  }
  assert.equal(wa.sends.length, 1);
  assert.equal((await job(env, reply)).state, "dead_letter");
});

// Another scanner holds the per-message delivery claim (lease) when the retry
// becomes due. The due scan is claim-blocked; once the lease ends the retry
// must still be revisited, exactly once, with the claim still respected.
async function holdDeliveryClaim(env, reply) {
  const state = await readJson(dataPaths(env).whatsapp, {});
  const prior = (state.outboundDeliveryClaims || []).find((claim) => claim.messageId === reply.id);
  assert.ok(prior?.textKey, "the first attempt recorded a delivery claim");
  const held = await acquireOutboundDeliveryClaim({
    state: {}, kind: prior.kind, deliveryType: prior.deliveryType, agentId: prior.agentId, threadId: prior.threadId,
    messageId: prior.messageId, sourceMessageId: prior.sourceMessageId, chatId: prior.chatId, accountId: prior.accountId, textKey: prior.textKey,
  }, env);
  assert.equal(held.acquired, true, "competing lease taken");
  return held;
}

test("a due retry blocked by an active delivery claim is revisited when the claim expires", async (t) => {
  mock.timers.enable({ apis: ["Date"], now: T0 });
  t.after(() => mock.timers.reset());
  const { env, reply } = await fixture(t, "claim-expiry");
  const wa = bridge();

  await deliverWhatsAppReplies(env, wa.fetchImpl);
  mock.timers.setTime(T0 + 1_000);
  await deliverWhatsAppReplies(env, wa.fetchImpl);
  mock.timers.setTime(T0 + 59_000);
  const held = await holdDeliveryClaim(env, reply);
  const leaseEndsMs = Date.parse(held.claim.expiresAt);

  wa.set("ok");
  mock.timers.setTime(T0 + BACKOFF_MS + 1_000);
  await deliverWhatsAppReplies(env, wa.fetchImpl);
  assert.equal(wa.sends.length, 1, "claim respected while held");

  mock.timers.setTime(leaseEndsMs - 1_000);
  await deliverWhatsAppReplies(env, wa.fetchImpl);
  assert.equal(wa.sends.length, 1, "no send before the lease ends");

  mock.timers.setTime(leaseEndsMs + 6_000);
  const after = await deliverWhatsAppReplies(env, wa.fetchImpl);
  assert.equal(wa.sends.length, 2, "revisited once the lease ended");
  assert.equal(after.delivered.length, 1);
  assert.equal((await job(env, reply)).state, "delivered");

  mock.timers.setTime(leaseEndsMs + 60_000);
  await deliverWhatsAppReplies(env, wa.fetchImpl);
  assert.equal(wa.sends.length, 2, "no duplicate");
});

test("a due retry blocked by a delivery claim still goes out if the lease is removed early", async (t) => {
  mock.timers.enable({ apis: ["Date"], now: T0 });
  t.after(() => mock.timers.reset());
  const { env, reply } = await fixture(t, "claim-removed");
  const wa = bridge();

  await deliverWhatsAppReplies(env, wa.fetchImpl);
  mock.timers.setTime(T0 + 1_000);
  await deliverWhatsAppReplies(env, wa.fetchImpl);
  mock.timers.setTime(T0 + 59_000);
  const held = await holdDeliveryClaim(env, reply);
  const leaseEndsMs = Date.parse(held.claim.expiresAt);
  wa.set("ok");
  mock.timers.setTime(T0 + BACKOFF_MS + 1_000);
  await deliverWhatsAppReplies(env, wa.fetchImpl);
  assert.equal(wa.sends.length, 1);

  await fs.rm(held.filePath, { force: true });
  // Revisited no later than when the removed lease would have ended.
  mock.timers.setTime(leaseEndsMs + 6_000);
  await deliverWhatsAppReplies(env, wa.fetchImpl);
  assert.equal(wa.sends.length, 2);
  assert.equal((await job(env, reply)).state, "delivered");
});

test("at exactly the retry time, concurrent scanners send the due retry once", async (t) => {
  mock.timers.enable({ apis: ["Date"], now: T0 });
  t.after(() => mock.timers.reset());
  const { env, reply } = await fixture(t, "boundary");
  const wa = bridge();

  await deliverWhatsAppReplies(env, wa.fetchImpl);
  mock.timers.setTime(T0 + 1_000);
  await deliverWhatsAppReplies(env, wa.fetchImpl);
  const retryAtMs = Date.parse((await job(env, reply)).claimExpiresAt);
  wa.set("ok");
  mock.timers.setTime(retryAtMs);
  await Promise.all(Array.from({ length: 12 }, () => deliverWhatsAppReplies(env, wa.fetchImpl)));
  assert.equal(wa.sends.length, 2, "exactly one retry send");
  const jobs = (await readConnectorOutbox(env)).jobs.filter((item) => item.sourceMessageId === reply.id);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].state, "delivered");
});
