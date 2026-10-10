// Agent Job notification dispatcher: thread, WhatsApp, email and webhook
// delivery exactly once per (run, event, channel, target) (G10), offline.
// Every transport is a fake; nothing is sent.
import assert from "node:assert/strict";
import test from "node:test";
import { dispatchAgentJobNotifications, agentJobWhatsAppText } from "../packages/connectors/src/agent-job-notification-dispatcher.js";
import { relayAgentJobNotifications } from "../packages/connectors/src/agent-job-notification-relay.js";
import { listConnectorOutboxJobs, markConnectorOutboxJob } from "../packages/connectors/src/connector-outbox.js";
import { admitRun } from "../packages/core/src/agent-job-admission.js";
import { decideApproval } from "../packages/core/src/agent-job-ledger.js";
import { driveRun } from "../packages/core/src/agent-job-runner.js";
import { makeSpec, tempEnv } from "./fixtures/agent-job-fixtures.js";

function fakeTransports() {
  const sent = { thread: [], whatsapp: [], email: [], webhook: [] };
  const threadMessages = new Map();
  return {
    sent,
    transports: {
      async thread(threadId, message) {
        if (threadId === "missing-thread") throw Object.assign(new Error("thread_not_found"), { statusCode: 404 });
        const key = `${threadId}:${message.clientMessageId}`;
        if (threadMessages.has(key)) return { ...threadMessages.get(key), duplicate: true };
        const stored = { id: `msg-${threadMessages.size + 1}`, ...message };
        threadMessages.set(key, stored);
        sent.thread.push({ threadId, ...message });
        return stored;
      },
      async whatsapp(input) {
        sent.whatsapp.push(input);
        return { ok: true, sent: [{ id: `wamid-${sent.whatsapp.length}` }] };
      },
      async email(message) {
        sent.email.push(message);
        return { ok: true, configured: true, messageId: `mail-${sent.email.length}`, provider: "fake" };
      },
      async resolveBinding(id) {
        return id === "example-binding" ? { chatId: "120363000000000001@g.us", accountId: "example-account" } : null;
      },
      async fetchImpl(url, init) {
        sent.webhook.push({ url, init });
        return { status: 204 };
      },
      async resolveSecret() {
        return null;
      },
    },
  };
}

async function parkedRun(env, notifications) {
  const { run } = await admitRun({ spec: makeSpec({ notifications }), type: "api", dedupeKey: "evt" }, env);
  const parked = await driveRun(run.id, {}, env);
  assert.equal(parked.state, "awaiting_approval");
  await relayAgentJobNotifications({}, env);
  return { run, parked };
}

const testEnv = (extra = {}) => tempEnv({ ORKESTR_CONNECTOR_OUTBOX_RETRY_BACKOFF_MS: "0", ORKESTR_CONNECTOR_OUTBOX_CLAIM_TTL_MS: "5000", ...extra });

test("delivers each channel once and carries the WhatsApp approve/deny hint", async () => {
  const env = await testEnv();
  const { run, parked } = await parkedRun(env, [
    { on: ["approval_required", "succeeded"], channel: "whatsapp", target: "binding:example-binding" },
    { on: ["approval_required"], channel: "thread", target: "example-thread" },
    { on: ["approval_required"], channel: "email", target: "owner@example.com" },
    { on: ["approval_required"], channel: "webhook", target: "https://hooks.example.com/orkestr" },
  ]);
  const { sent, transports } = fakeTransports();
  const results = await dispatchAgentJobNotifications({ transports }, env);
  assert.deepEqual(results.map((entry) => entry.state).sort(), ["delivered", "delivered", "delivered", "delivered"]);
  assert.equal(sent.whatsapp.length, 1);
  assert.equal(sent.whatsapp[0].chatId, "120363000000000001@g.us");
  assert.equal(sent.whatsapp[0].accountId, "example-account");
  assert.match(sent.whatsapp[0].text, new RegExp(`approve ${parked.approvalId}`));
  assert.match(sent.whatsapp[0].text, new RegExp(`deny ${parked.approvalId}`));
  assert.equal(sent.thread[0].threadId, "example-thread");
  assert.equal(sent.thread[0].dedupeAssistantByIdempotencyKey, true);
  assert.deepEqual(sent.email[0].to, ["owner@example.com"]);
  assert.match(sent.email[0].subject, /approval required/);
  const hook = sent.webhook[0];
  assert.equal(hook.url, "https://hooks.example.com/orkestr");
  assert.equal(hook.init.redirect, "manual");
  assert.match(hook.init.headers["idempotency-key"], /^agent-job-notify:/);
  assert.equal(JSON.parse(hook.init.body).approval_id, parked.approvalId);

  // Nothing is delivered twice, even when dispatch runs again.
  assert.deepEqual(await dispatchAgentJobNotifications({ transports }, env), []);
  await decideApproval(parked.approvalId, { decision: "approved", by: "test" }, env);
  assert.equal((await driveRun(run.id, {}, env)).state, "succeeded");
  await relayAgentJobNotifications({}, env);
  await dispatchAgentJobNotifications({ transports }, env);
  await dispatchAgentJobNotifications({ transports }, env);
  assert.equal(sent.whatsapp.length, 2);
  assert.match(sent.whatsapp[1].text, /succeeded/);
  assert.equal(sent.thread.length + sent.email.length + sent.webhook.length, 3);
  const whatsappRows = (await listConnectorOutboxJobs({ connector: "whatsapp" }, env)).jobs;
  assert.equal(whatsappRows.length, 2);
  assert.ok(whatsappRows.every((row) => row.state === "delivered" && row.deliveryType === "agent_job_notification"));
});

test("G10: a crash after the WhatsApp send never sends a second message", async () => {
  const env = await testEnv();
  await parkedRun(env, [{ on: ["approval_required"], channel: "whatsapp", target: "120363000000000002@g.us" }]);
  const { sent, transports } = fakeTransports();
  await assert.rejects(dispatchAgentJobNotifications({ transports, faults: [{ at: "whatsapp_sent" }] }, env), /injected_crash/);
  assert.equal(sent.whatsapp.length, 1);
  // Simulate the claims of the dead process expiring.
  for (const row of (await listConnectorOutboxJobs({}, env)).jobs) {
    await markConnectorOutboxJob(row.id, { claimExpiresAt: new Date(Date.now() - 1000).toISOString() }, env);
  }
  const [result] = await dispatchAgentJobNotifications({ transports }, env);
  assert.equal(result.state, "delivery_uncertain");
  assert.equal(sent.whatsapp.length, 1);
  assert.deepEqual(await dispatchAgentJobNotifications({ transports }, env), []);
});

test("G10: a crash after a thread post or a delivered mark is replayed without duplicates", async () => {
  const env = await testEnv();
  await parkedRun(env, [{ on: ["approval_required"], channel: "thread", target: "example-thread" }]);
  const { sent, transports } = fakeTransports();
  await assert.rejects(dispatchAgentJobNotifications({ transports, faults: [{ at: "notify_delivered" }] }, env), /injected_crash/);
  for (const row of (await listConnectorOutboxJobs({ connector: "agent_job" }, env)).jobs) {
    await markConnectorOutboxJob(row.id, { claimExpiresAt: new Date(Date.now() - 1000).toISOString() }, env);
  }
  const [result] = await dispatchAgentJobNotifications({ transports }, env);
  assert.equal(result.state, "delivered");
  assert.equal(sent.thread.length, 1);
});

test("G10: email is never mailed twice after a crash mid-send", async () => {
  const env = await testEnv();
  await parkedRun(env, [{ on: ["approval_required"], channel: "email", target: "owner@example.com" }]);
  const { sent, transports } = fakeTransports();
  await assert.rejects(dispatchAgentJobNotifications({ transports, faults: [{ at: "email_sent" }] }, env), /injected_crash/);
  for (const row of (await listConnectorOutboxJobs({ connector: "agent_job" }, env)).jobs) {
    await markConnectorOutboxJob(row.id, { claimExpiresAt: new Date(Date.now() - 1000).toISOString() }, env);
  }
  const [result] = await dispatchAgentJobNotifications({ transports }, env);
  assert.equal(result.state, "delivery_uncertain");
  assert.equal(sent.email.length, 1);
});

test("email failures retry; unconfigured mail is skipped", async () => {
  const env = await testEnv();
  await parkedRun(env, [{ on: ["approval_required"], channel: "email", target: "owner@example.com" }]);
  const { transports } = fakeTransports();
  let calls = 0;
  const flaky = { ...transports, async email() { calls += 1; if (calls === 1) throw new Error("smtp_connect_failed"); return { ok: true, configured: true }; } };
  assert.equal((await dispatchAgentJobNotifications({ transports: flaky }, env))[0].state, "failed_retryable");
  assert.equal((await dispatchAgentJobNotifications({ transports: flaky }, env))[0].state, "delivered");

  const other = await testEnv();
  await parkedRun(other, [{ on: ["approval_required"], channel: "email", target: "owner@example.com" }]);
  const unconfigured = { ...transports, async email() { return { ok: false, configured: false, skippedReason: "smtp_not_configured" }; } };
  const [result] = await dispatchAgentJobNotifications({ transports: unconfigured }, other);
  assert.equal(result.state, "skipped");
  assert.equal(result.error, "smtp_not_configured");
});

test("webhooks: https only, retries with backoff and a stable idempotency key, then dead-letter", async () => {
  const env = await testEnv({ ORKESTR_AGENT_JOB_NOTIFY_MAX_ATTEMPTS: "3" });
  await parkedRun(env, [
    { on: ["approval_required"], channel: "webhook", target: "https://hooks.example.com/flaky" },
    { on: ["approval_required"], channel: "webhook", target: "vault://example-hook-url" },
  ]);
  const { transports } = fakeTransports();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, key: init.headers["idempotency-key"] });
    return { status: 503 };
  };
  // The vault target resolves to plain http, which is refused without a request.
  const resolveSecret = async () => "http://hooks.example.com/insecure";
  const first = await dispatchAgentJobNotifications({ transports: { ...transports, fetchImpl, resolveSecret } }, env);
  assert.deepEqual(first.map((entry) => entry.state).sort(), ["dead_letter", "failed_retryable"]);
  assert.equal(first.find((entry) => entry.state === "dead_letter").error, "webhook_target_not_https");
  await dispatchAgentJobNotifications({ transports: { ...transports, fetchImpl, resolveSecret } }, env);
  const third = await dispatchAgentJobNotifications({ transports: { ...transports, fetchImpl, resolveSecret } }, env);
  assert.equal(third[0].state, "dead_letter");
  assert.equal(third[0].error, "webhook_http_503:max_attempts");
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.url === "https://hooks.example.com/flaky" && call.key === calls[0].key));
  assert.ok(!JSON.stringify((await listConnectorOutboxJobs({ connector: "agent_job" }, env)).jobs).includes("insecure"));
});

test("webhooks: retry waits for the backoff and permanent 4xx is not retried", async () => {
  const env = await tempEnv({ ORKESTR_CONNECTOR_OUTBOX_RETRY_BACKOFF_MS: "60000" });
  await parkedRun(env, [{ on: ["approval_required"], channel: "webhook", target: "https://hooks.example.com/slow" }]);
  const { transports } = fakeTransports();
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { status: calls === 1 ? 429 : 400 }; };
  assert.equal((await dispatchAgentJobNotifications({ transports: { ...transports, fetchImpl } }, env))[0].state, "failed_retryable");
  assert.deepEqual(await dispatchAgentJobNotifications({ transports: { ...transports, fetchImpl } }, env), []);
  const [row] = (await listConnectorOutboxJobs({ connector: "agent_job" }, env)).jobs;
  await markConnectorOutboxJob(row.id, { claimExpiresAt: new Date(Date.now() - 1000).toISOString() }, env);
  const [result] = await dispatchAgentJobNotifications({ transports: { ...transports, fetchImpl } }, env);
  assert.equal(result.state, "dead_letter");
  assert.equal(result.error, "webhook_http_400");
  assert.equal(calls, 2);
});

test("unresolvable targets are dead-lettered without sending", async () => {
  const env = await testEnv();
  await parkedRun(env, [
    { on: ["approval_required"], channel: "whatsapp", target: "binding:unknown-binding" },
    { on: ["approval_required"], channel: "thread", target: "missing-thread" },
  ]);
  const { sent, transports } = fakeTransports();
  const results = await dispatchAgentJobNotifications({ transports }, env);
  assert.deepEqual(results.map((entry) => entry.error).sort(), ["thread_not_found", "whatsapp_target_unresolved"]);
  assert.equal(sent.whatsapp.length + sent.thread.length, 0);
});

test("WhatsApp approval text always contains both reply commands", () => {
  const text = agentJobWhatsAppText({ job: "example-job", runId: "run_x", event: "approval_required", approvalId: "apr_example01", text: "Agent job example-job: approval_required" });
  assert.match(text, /approve apr_example01/);
  assert.match(text, /deny apr_example01/);
  assert.equal(agentJobWhatsAppText({ event: "succeeded", text: "done" }), "done");
});
