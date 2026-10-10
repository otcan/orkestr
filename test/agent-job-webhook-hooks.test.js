// Signed Agent Job webhooks (HMAC-SHA256, replay window, GitHub-style
// X-Hub-Signature-256) and schedule triggers as read-only timer rows, offline.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { handleAgentJobHook } from "../packages/core/src/agent-job-hooks-http.js";
import { resolveAgentJobSecret } from "../packages/core/src/agent-job-secrets.js";
import { listTriggerAudit, registerJobSpec } from "../packages/core/src/agent-job-store.js";
import { assertTimerWritable, listAgentJobScheduleTimers, listAgentJobScheduleTimersForPrincipal } from "../packages/core/src/agent-job-timer-entries.js";
import { signAgentJobWebhook, verifyAgentJobWebhookSignature } from "../packages/core/src/agent-job-webhook-signature.js";
import { adminPrincipal, userPrincipal } from "../packages/core/src/principal.js";
import { setSecureSecret } from "../packages/core/src/secure-secrets.js";
import { formatTimerTable } from "../apps/cli/src/format.js";
import { makeSpec, tempEnv } from "./fixtures/agent-job-fixtures.js";

const SECRET = "example-webhook-secret-canary-7f3a";

async function hookEnv() {
  const env = await tempEnv({ ORKESTR_ADMIN_USER_ID: "admin" });
  await setSecureSecret({ scope: "global", name: "example-webhook-secret", value: SECRET }, adminPrincipal("admin"), env);
  await registerJobSpec(makeSpec(), {}, env);
  return env;
}

function signed(body, { now = Date.now(), secret = SECRET, style = "orkestr" } = {}) {
  const rawBody = Buffer.from(JSON.stringify(body));
  if (style === "github") return { rawBody, headers: { "x-hub-signature-256": signAgentJobWebhook(secret, rawBody) } };
  const timestamp = String(Math.floor(now / 1000));
  return { rawBody, headers: { "x-orkestr-timestamp": timestamp, "x-orkestr-signature-256": signAgentJobWebhook(secret, rawBody, timestamp) } };
}

test("vault:// refs resolve through the secure secret manager", async () => {
  const env = await hookEnv();
  assert.equal(await resolveAgentJobSecret("vault://example-webhook-secret", {}, env), SECRET);
  assert.equal(await resolveAgentJobSecret("vault://missing-secret", {}, env), null);
  assert.equal(await resolveAgentJobSecret("secret://global/example-webhook-secret", {}, env), null);
});

test("signed webhooks admit one run; redelivery and replay return the first run", async () => {
  const env = await hookEnv();
  const request = signed({ delivery_id: "evt-1", action: "opened" });
  const first = await handleAgentJobHook({ name: "example-job", hook: "issue-opened", ...request }, env);
  assert.equal(first.statusCode, 202);
  // Same signed body later (redelivery), even with a forged Idempotency-Key.
  const replay = signed({ delivery_id: "evt-1", action: "opened" }, { now: Date.now() + 1000 });
  const again = await handleAgentJobHook({ name: "example-job", hook: "issue-opened", rawBody: replay.rawBody,
    headers: { ...replay.headers, "idempotency-key": "forged-new-key" } }, env);
  assert.equal(again.statusCode, 200);
  assert.equal(again.body.runId, first.body.runId);
  assert.equal(again.body.deduplicated, true);
  const github = await handleAgentJobHook({ name: "example-job", hook: "issue-opened", ...signed({ delivery_id: "evt-2" }, { style: "github" }) }, env);
  assert.equal(github.statusCode, 202);
  assert.notEqual(github.body.runId, first.body.runId);
});

test("bad, stale, missing or wrongly keyed signatures are refused with one 401 and audited", async () => {
  const env = await hookEnv();
  const body = { delivery_id: "evt-9" };
  const good = signed(body);
  const cases = {
    webhook_signature_missing: { rawBody: good.rawBody, headers: {} },
    webhook_signature_mismatch: signed(body, { secret: "wrong-secret" }),
    webhook_timestamp_outside_window: signed(body, { now: Date.now() - 10 * 60_000 }),
    webhook_raw_body_unavailable: { rawBody: null, headers: good.headers },
  };
  // Body tampered after signing.
  const tampered = { rawBody: Buffer.from(JSON.stringify({ delivery_id: "evt-10" })), headers: good.headers };
  for (const [reason, request] of [...Object.entries(cases), ["webhook_signature_mismatch", tampered]]) {
    const result = await handleAgentJobHook({ name: "example-job", hook: "issue-opened", ...request }, env);
    assert.equal(result.statusCode, 401, reason);
    assert.deepEqual(result.body, { ok: false, error: "agent_job_webhook_unauthorized" });
  }
  const unknownJob = await handleAgentJobHook({ name: "no-such-job", hook: "issue-opened", ...good }, env);
  const unknownHook = await handleAgentJobHook({ name: "example-job", hook: "no-such-hook", ...good }, env);
  assert.deepEqual([unknownJob.statusCode, unknownHook.statusCode], [401, 401]);
  const reasons = (await listTriggerAudit({ type: "webhook" }, env)).map((row) => row.reason);
  for (const reason of [...Object.keys(cases), "job_not_found", "webhook_hook_not_declared"]) assert.ok(reasons.includes(reason), reason);
  // GitHub style can be refused when a signed timestamp is required.
  const strict = { ...env, ORKESTR_AGENT_JOB_WEBHOOK_REQUIRE_TIMESTAMP: "1" };
  assert.equal((await handleAgentJobHook({ name: "example-job", hook: "issue-opened", ...signed(body, { style: "github" }) }, strict)).statusCode, 401);
  // The secret never reaches the audit table or any Agent Job file.
  for (const name of (await fs.readdir(env.ORKESTR_HOME)).filter((entry) => entry.startsWith("agent-jobs.sqlite"))) {
    assert.ok(!(await fs.readFile(path.join(env.ORKESTR_HOME, name))).includes(SECRET), name);
  }
});

test("signature verification is strict about format and secrets", () => {
  const rawBody = Buffer.from("{}");
  const now = Date.now();
  const ts = String(Math.floor(now / 1000));
  const headers = { "X-Orkestr-Timestamp": ts, "X-Orkestr-Signature-256": signAgentJobWebhook("s", rawBody, ts) };
  assert.deepEqual(verifyAgentJobWebhookSignature({ secret: "s", rawBody, headers, now }), { ok: true, style: "orkestr" });
  assert.equal(verifyAgentJobWebhookSignature({ secret: null, rawBody, headers, now }).reason, "webhook_secret_unavailable");
  assert.equal(verifyAgentJobWebhookSignature({ secret: "s", rawBody, headers: { ...headers, "X-Orkestr-Signature-256": "sha1=abc" }, now }).reason, "webhook_signature_malformed");
  assert.equal(verifyAgentJobWebhookSignature({ secret: "s", rawBody, headers: { "X-Orkestr-Signature-256": headers["X-Orkestr-Signature-256"] }, now }).reason, "webhook_timestamp_missing");
  assert.equal(verifyAgentJobWebhookSignature({ secret: "s", rawBody, headers, now: now + 301_000 }).reason, "webhook_timestamp_outside_window");
  assert.equal(verifyAgentJobWebhookSignature({ secret: "s", rawBody, headers, now: now + 301_000 }, { ORKESTR_AGENT_JOB_WEBHOOK_TOLERANCE_S: "600" }).ok, true);
});

test("schedule triggers appear as read-only rows in the timers list", async () => {
  const env = await tempEnv({ ORKESTR_ADMIN_USER_ID: "admin" });
  await registerJobSpec(makeSpec({ name: "nightly-job", triggers: [
    { type: "schedule", cadence: "daily", time: "03:30", timezone: "UTC" },
    { type: "schedule", cadence: "interval", every: "90m" },
    { type: "api" },
  ] }), {}, env);
  const rows = await listAgentJobScheduleTimers(env, new Date("2026-01-01T00:00:00Z"));
  assert.deepEqual(rows.map((row) => [row.id, row.cadence, row.time, row.every, row.readOnly, row.targetType]), [
    ["agent-job:nightly-job:schedule-0", "daily", "03:30", null, true, "agent_job"],
    ["agent-job:nightly-job:schedule-1", "interval", null, "90m", true, "agent_job"],
  ]);
  assert.equal(rows[0].nextRunAt, "2026-01-01T03:30:00.000Z");
  assert.equal((await listAgentJobScheduleTimersForPrincipal(adminPrincipal("admin"), env)).length, 2);
  assert.deepEqual(await listAgentJobScheduleTimersForPrincipal(userPrincipal({ id: "example-user" }), env), []);
  assert.deepEqual(await listAgentJobScheduleTimers({ ...env, ORKESTR_AGENT_JOBS_ENABLED: "0" }), []);
  assert.throws(() => assertTimerWritable("agent-job:nightly-job:schedule-0"), /agent_job_schedule_read_only/);
  assert.doesNotThrow(() => assertTimerWritable("timer-example"));
  assert.match(formatTimerTable(rows), /read-only/);
});
