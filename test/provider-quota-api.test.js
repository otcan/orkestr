import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { createThread } from "../packages/core/src/threads.js";
import { resetProviderQuotaCacheForTest } from "../packages/core/src/provider-quota-snapshot.js";

test("GET /api/quota/providers returns both providers without raw telemetry", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-provider-quota-api-"));
  const keys = ["ORKESTR_HOME", "ORKESTR_AUTH_REQUIRED", "ORKESTR_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED", "ORKESTR_WHATSAPP_AUTOSTART", "WHATSAPP_LOCAL_AUTOSTART", "ORKESTR_ADMIN_USER_ID", "ORKESTR_PROVIDER_QUOTA_PROJECTION_CONFIG"];
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    ORKESTR_HOME: home,
    ORKESTR_AUTH_REQUIRED: "0",
    ORKESTR_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED: "1",
    ORKESTR_WHATSAPP_AUTOSTART: "0",
    WHATSAPP_LOCAL_AUTOSTART: "0",
    ORKESTR_ADMIN_USER_ID: "quota-owner-synthetic",
  });
  let server;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetProviderQuotaCacheForTest();
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  resetProviderQuotaCacheForTest();
  const projectedOwner="11111111-1111-4111-8111-111111111111",account="22222222-2222-4222-8222-222222222222";
  const projectionPath=path.join(home,"claude.json"),configPath=path.join(home,"quota-sources.json"),observed=Date.now();
  await fs.writeFile(projectionPath,JSON.stringify({format:"orkestr-provider-quota-v1",provider:"claude",owner_id:projectedOwner,account_ref:account,
    windows:{five_hour:{used_percent:23,resets_at:Math.floor(observed/1000)+3600,status:"allowed",observed_at:observed},
      seven_day:{used_percent:41,resets_at:Math.floor(observed/1000)+7*86400,status:"allowed",observed_at:observed}}}),{mode:0o600});
  await fs.writeFile(configPath,JSON.stringify({format:"orkestr-provider-quota-sources-v1",sources:[{ownerUserId:"quota-owner-synthetic",coreOwnerId:projectedOwner,accountRef:account,producerUid:process.getuid(),path:projectionPath}]}),{mode:0o600});
  process.env.ORKESTR_PROVIDER_QUOTA_PROJECTION_CONFIG=configPath;
  await createThread({
    id: "quota-codex-thread",
    name: "Quota Codex thread",
    codexRateLimits: {
      primary: { used_percent: 25, window_minutes: 300, resets_at: Math.floor(Date.now() / 1000) + 3600 },
      secondary: { used_percent: 50, window_minutes: 10080 },
    },
    codexRateLimitsObservedAt: new Date().toISOString(),
  }, process.env);

  server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/quota/providers`);
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.equal(payload.quota.codex.fiveHourRemainingPct, 75);
  assert.equal(payload.quota.codex.weeklyRemainingPct, 50);
  assert.equal(payload.quota.codex.stale, false);
  assert.equal(payload.quota.claude.fiveHourRemainingPct, 77);
  assert.equal(payload.quota.claude.weeklyRemainingPct, 59);
  assert.equal(payload.quota.claude.observedAt,new Date(observed).toISOString());
  assert.equal(payload.quota.claude.source,"telemetry");
  assert.equal(JSON.stringify(payload).includes(account),false);
  assert.equal(JSON.stringify(payload).includes("used_percent"), false);
});
