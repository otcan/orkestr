import assert from "node:assert/strict";
import test from "node:test";
import {
  providerQuotaSnapshot,
  resetProviderQuotaCacheForTest,
} from "../packages/core/src/provider-quota-snapshot.js";

// The Host page derives its normal / limited / unknown states from the fields
// this snapshot returns. The quota controller delegates straight to
// providerQuotaSnapshot(...), so exercising it with injected loaders asserts
// the exact mapping the endpoint serves: stale and at-cap telemetry is
// reported truthfully, and never-observed telemetry stays null instead of a
// fabricated 0% / 100%.
const env = { ORKESTR_ADMIN_USER_ID: "owner-a", ORKESTR_HOME: "/tmp/orkestr-host-quota-states" };
const now = Date.parse("2099-01-10T12:00:00.000Z");
const futureSeconds = (ms) => Math.floor((now + ms) / 1000);

function staleCodexThread() {
  return {
    id: "codex-stale",
    ownerUserId: "owner-a",
    runtimeKind: "codex-app-server",
    codexRateLimits: {
      primary: { used_percent: 100, window_minutes: 300, resets_at: futureSeconds(60 * 60 * 1000) },
      secondary: { used_percent: 90, window_minutes: 10080, resets_at: futureSeconds(2 * 60 * 60 * 1000) },
    },
    // Observed two days ago -> past the default 6h stale window.
    codexRateLimitsObservedAt: new Date(now - 48 * 60 * 60 * 1000).toISOString(),
  };
}

test("snapshot maps at-cap, stale and unknown telemetry for the Host view", async () => {
  resetProviderQuotaCacheForTest();
  const snapshot = await providerQuotaSnapshot({
    ownerUserId: "owner-a",
    now,
    useCache: false,
    loadThreads: async () => [staleCodexThread()],
    // A rate-limited Claude account profile marks Claude at-cap even with no
    // per-window numbers (the "limited" Host state).
    loadClaudeProfiles: async () => [{ state: "rate_limited" }],
  }, env);

  // Codex: real but aged -> stale is true (Host renders "unknown"), and the
  // fully consumed 5h window is 0% remaining, not fabricated.
  assert.equal(snapshot.codex.stale, true);
  assert.equal(snapshot.codex.fiveHourRemainingPct, 0);

  // Claude: rate limited -> limited is true (Host renders "limited").
  assert.equal(snapshot.claude.limited, true);
});

test("snapshot leaves never-observed providers unknown without fabricated values", async () => {
  resetProviderQuotaCacheForTest();
  const snapshot = await providerQuotaSnapshot({
    ownerUserId: "owner-a",
    now,
    useCache: false,
    loadThreads: async () => [],
    loadClaudeProfiles: async () => [],
  }, env);

  for (const provider of ["codex", "claude"]) {
    assert.equal(snapshot[provider].fiveHourRemainingPct, null);
    assert.equal(snapshot[provider].weeklyRemainingPct, null);
    assert.equal(snapshot[provider].observedAt, null);
    assert.equal(snapshot[provider].stale, false);
    assert.equal(snapshot[provider].limited, false);
  }
});
