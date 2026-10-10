// POST /api/jobs/<job>/hooks/<name> through the real server: reachable without
// a session (HMAC is the only auth), verified over the raw request bytes.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { registerJobSpec } from "../packages/core/src/agent-job-store.js";
import { signAgentJobWebhook } from "../packages/core/src/agent-job-webhook-signature.js";
import { adminPrincipal } from "../packages/core/src/principal.js";
import { authorizeHttpRequest } from "../packages/core/src/security.js";
import { setSecureSecret } from "../packages/core/src/secure-secrets.js";
import { makeSpec } from "./fixtures/agent-job-fixtures.js";

const SECRET = "example-http-webhook-secret";

test("the signed hook route is the only Agent Job route open before pairing", async () => {
  const env = { ORKESTR_HOME: await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-hook-auth-")), ORKESTR_ADMIN_USER_ID: "admin", ORKESTR_AUTH_REQUIRED: "1" };
  const hook = await authorizeHttpRequest({ method: "POST", url: "/api/jobs/example-job/hooks/issue-opened", headers: {} }, env);
  const trigger = await authorizeHttpRequest({ method: "POST", url: "/api/jobs/example-job/trigger", headers: {} }, env);
  const nested = await authorizeHttpRequest({ method: "POST", url: "/api/jobs/example-job/hooks/issue-opened/extra", headers: {} }, env);
  assert.equal(hook.ok, true);
  assert.equal(hook.anonymous, true);
  assert.equal(trigger.ok, false);
  assert.equal(nested.ok, false);
});

test("HTTP: a signed delivery is admitted once and an unsigned one is refused", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-hook-http-"));
  const before = { ...process.env };
  Object.assign(process.env, {
    ORKESTR_HOME: home, ORKESTR_ADMIN_USER_ID: "admin", ORKESTR_AUTH_REQUIRED: "0", ORKESTR_HOST_BOUNDARIES: "0",
    ORKESTR_AGENT_JOBS_ENABLED: "0",
  });
  await setSecureSecret({ scope: "global", name: "example-webhook-secret", value: SECRET }, adminPrincipal("admin"), process.env);
  await registerJobSpec(makeSpec(), {}, process.env);
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
    Object.assign(process.env, before);
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const url = `http://127.0.0.1:${server.address().port}/api/jobs/example-job/hooks/issue-opened`;
  // Whitespace matters: the signature covers the exact bytes, not re-serialized JSON.
  const raw = '{ "delivery_id": "evt-http-1",  "action": "opened" }';
  const post = (headers) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: raw });
  const signature = signAgentJobWebhook(SECRET, raw);
  const first = await post({ "x-hub-signature-256": signature });
  assert.equal(first.status, 202);
  const firstBody = await first.json();
  const again = await post({ "x-hub-signature-256": signature });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).runId, firstBody.runId);
  const unsigned = await post({});
  assert.equal(unsigned.status, 401);
  assert.deepEqual(await unsigned.json(), { ok: false, error: "agent_job_webhook_unauthorized" });
  const reserialized = signAgentJobWebhook(SECRET, JSON.stringify(JSON.parse(raw)));
  assert.equal((await post({ "x-hub-signature-256": reserialized })).status, 401);
});
