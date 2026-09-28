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
  const keys = ["ORKESTR_HOME", "ORKESTR_AUTH_REQUIRED", "ORKESTR_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED", "ORKESTR_WHATSAPP_AUTOSTART", "WHATSAPP_LOCAL_AUTOSTART"];
  const prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    ORKESTR_HOME: home,
    ORKESTR_AUTH_REQUIRED: "0",
    ORKESTR_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED: "1",
    ORKESTR_WHATSAPP_AUTOSTART: "0",
    WHATSAPP_LOCAL_AUTOSTART: "0",
  });
  let server;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetProviderQuotaCacheForTest();
    await fs.rm(home, { recursive: true, force: true });
  });
  resetProviderQuotaCacheForTest();
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
  assert.equal(payload.quota.claude.fiveHourRemainingPct, null);
  assert.equal(payload.quota.claude.weeklyRemainingPct, null);
  assert.equal(JSON.stringify(payload).includes("used_percent"), false);
});
