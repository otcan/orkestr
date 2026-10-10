// WhatsApp group messages as Agent Job triggers (owner decision 2026-10-10):
// configured group only, allowlisted senders only, message id as run_key,
// message + quoted context passed as input, rejections audited. Offline.
import assert from "node:assert/strict";
import test from "node:test";
import { dispatchWhatsAppJobTriggers } from "../packages/connectors/src/whatsapp-job-triggers.js";
import { listApprovals } from "../packages/core/src/agent-job-ledger.js";
import { driveRun } from "../packages/core/src/agent-job-runner.js";
import { getRun, listRuns, listTriggerAudit, registerJobSpec } from "../packages/core/src/agent-job-store.js";
import { makeSpec, prScript, pullRequests, tempEnv } from "./fixtures/agent-job-fixtures.js";

const GROUP = "120363000000000001@g.us";
const OWNER = "+15550100001";
const trigger = { type: "whatsapp", group: GROUP, senders: [OWNER, "15550100002@s.whatsapp.net"] };

async function setup(extra = {}) {
  const env = await tempEnv();
  await registerJobSpec(makeSpec({ name: "wa-job", triggers: [trigger], ...extra }), {}, env);
  return env;
}

function message(overrides = {}) {
  return { eventId: "wamid-0001", chatId: GROUP, accountId: "example-account", from: "15550100001@c.us", text: "/fix the flaky test", ...overrides };
}

test("an allowlisted sender in the configured group starts one run with the message and its quoted context", async () => {
  const env = await setup();
  const quoted = { messageId: "wamid-0000", from: "15550100009@c.us", text: "CI is red on main" };
  const first = await dispatchWhatsAppJobTriggers(message({ quoted }), env);
  assert.equal(first.admitted.length, 1);
  const again = await dispatchWhatsAppJobTriggers(message({ quoted, text: "edited" }), env);
  assert.equal(again.admitted[0].runId, first.admitted[0].runId);
  assert.equal(again.admitted[0].deduplicated, true);
  const run = await getRun(first.admitted[0].runId, env);
  assert.equal(run.trigger.type, "whatsapp");
  assert.equal(run.trigger.dedupeKey, "wamid-0001");
  assert.equal(run.trigger.event.text, "/fix the flaky test");
  assert.deepEqual(run.trigger.event.quoted, { messageId: "wamid-0000", sender: "15550100009@c.us", text: "CI is red on main" });
  assert.equal((await listRuns({ job: "wa-job" }, env)).length, 1);
  const audit = await listTriggerAudit({ type: "whatsapp" }, env);
  assert.deepEqual(audit.map((entry) => entry.outcome), ["accepted"]);
});

test("unknown senders, DMs and own messages never start a run; rejections are audited without text", async () => {
  const env = await setup();
  const stranger = await dispatchWhatsAppJobTriggers(message({ eventId: "wamid-0002", from: "15550100099@c.us" }), env);
  assert.deepEqual(stranger.rejected, [{ job: "wa-job", reason: "sender_not_allowed" }]);
  const dm = await dispatchWhatsAppJobTriggers(message({ eventId: "wamid-0003", chatId: "15550100001@c.us" }), env);
  assert.equal(dm.skipped, "not_a_group");
  const own = await dispatchWhatsAppJobTriggers(message({ eventId: "wamid-0004", fromMe: true }), env);
  assert.equal(own.skipped, "from_me");
  const elsewhere = await dispatchWhatsAppJobTriggers(message({ eventId: "wamid-0005", chatId: "120363000000000002@g.us" }), env);
  assert.equal(elsewhere.skipped, "group_not_configured");
  assert.equal((await listRuns({ job: "wa-job" }, env)).length, 0);
  const audit = await listTriggerAudit({ type: "whatsapp" }, env);
  assert.deepEqual(audit.map((entry) => entry.reason).sort(), ["dm_not_accepted", "sender_not_allowed"]);
  assert.ok(!JSON.stringify(audit).includes("flaky"), "the audit must not store message text");
});

test("the optional match pattern filters messages", async () => {
  const env = await tempEnv();
  await registerJobSpec(makeSpec({ name: "wa-job", triggers: [{ ...trigger, match: "^/fix\\b" }] }), {}, env);
  const chatter = await dispatchWhatsAppJobTriggers(message({ eventId: "wamid-0010", text: "lunch?" }), env);
  assert.deepEqual(chatter.admitted, []);
  const command = await dispatchWhatsAppJobTriggers(message({ eventId: "wamid-0011" }), env);
  assert.equal(command.admitted.length, 1);
});

test("allowlisted senders can approve in the group; others cannot", async () => {
  const env = await setup({ script: prScript });
  const { admitted } = await dispatchWhatsAppJobTriggers(message(), env);
  const parked = await driveRun(admitted[0].runId, {}, env);
  assert.equal(parked.state, "awaiting_approval");
  const denied = await dispatchWhatsAppJobTriggers(message({ eventId: "wamid-0020", from: "15550100099@c.us", text: `approve ${parked.approvalId}` }), env);
  assert.equal(denied.decided, false);
  const approved = await dispatchWhatsAppJobTriggers(message({ eventId: "wamid-0021", from: "15550100002@s.whatsapp.net", text: `approve ${parked.approvalId}` }), env);
  assert.equal(approved.decided, true);
  assert.equal((await listApprovals({ runId: admitted[0].runId }, env))[0].decidedBy, "whatsapp:phone:15550100002");
  assert.equal((await driveRun(admitted[0].runId, {}, env)).state, "succeeded");
  assert.equal((await pullRequests(env))[0].merges, 1);
  assert.equal((await listRuns({ job: "wa-job" }, env)).length, 1, "approval replies are not triggers");
});

test("a WhatsApp trigger for a provider that is not connected is rejected and audited", async () => {
  const env = await setup({ provider: "codex" });
  const result = await dispatchWhatsAppJobTriggers(message(), env);
  assert.deepEqual(result.rejected, [{ job: "wa-job", reason: "provider_not_connected" }]);
  assert.equal((await listRuns({}, env)).length, 0);
  const audit = await listTriggerAudit({ type: "whatsapp" }, env);
  assert.deepEqual(audit.map((entry) => entry.reason), ["provider_not_connected:provider_not_connected"], "audited exactly once");
});

test("the existing WhatsApp inbound router hands group messages to job triggers", async () => {
  const env = await setup();
  const { routeWhatsAppInbound } = await import("../packages/connectors/src/whatsapp.js");
  // deferApiAgentAutoRun and an isolated home: nothing is ever sent to WhatsApp.
  await routeWhatsAppInbound({ ...message({ eventId: "wamid-0030" }), deferApiAgentAutoRun: true }, env).catch(() => null);
  const runs = await listRuns({ job: "wa-job" }, env);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].trigger.dedupeKey, "wamid-0030");
});
