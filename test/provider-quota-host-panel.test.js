import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const files = {
  helpers: new URL("../apps/web/src/app/provider-quota.ts", import.meta.url),
  panel: new URL("../apps/web/src/app/provider-quota-panel.component.ts", import.meta.url),
  settings: new URL("../apps/web/src/app/instance-settings-page.component.ts", import.meta.url),
  settingsTemplate: new URL("../apps/web/src/app/instance-settings-page.component.html", import.meta.url),
};

const base = {
  provider: "codex",
  fiveHourRemainingPct: null,
  weeklyRemainingPct: null,
  fiveHourResetsAt: null,
  weeklyResetsAt: null,
  observedAt: null,
  stale: false,
  limited: false,
  source: null,
};

test("quota state classifies normal, limited and unknown without fabricating values", async () => {
  const helpers = await import(files.helpers.href);

  // Normal: fresh telemetry with remaining headroom.
  assert.equal(helpers.quotaState({ ...base, fiveHourRemainingPct: 62, weeklyRemainingPct: 80, observedAt: "2099-01-01T00:00:00.000Z" }), "normal");

  // Limited: explicit rate-limit flag, or a fully consumed window.
  assert.equal(helpers.quotaState({ ...base, limited: true, observedAt: "2099-01-01T00:00:00.000Z" }), "limited");
  assert.equal(helpers.quotaState({ ...base, fiveHourRemainingPct: 0, weeklyRemainingPct: 40, observedAt: "2099-01-01T00:00:00.000Z" }), "limited");

  // Unknown: no telemetry at all, or stale telemetry.
  assert.equal(helpers.quotaState(null), "unknown");
  assert.equal(helpers.quotaState({ ...base }), "unknown");
  assert.equal(helpers.quotaState({ ...base, fiveHourRemainingPct: 50, observedAt: "2099-01-01T00:00:00.000Z", stale: true }), "unknown");

  assert.equal(helpers.quotaStateLabel("normal"), "Available");
  assert.equal(helpers.quotaStateLabel("limited"), "At limit");
  assert.equal(helpers.quotaStateLabel("unknown"), "No data");
});

test("countdown and freshness labels format real timestamps and degrade to unknown", async () => {
  const helpers = await import(files.helpers.href);
  const now = Date.parse("2099-01-10T12:00:00.000Z");
  const hour = 60 * 60 * 1000;

  assert.equal(helpers.quotaCountdownLabel(new Date(now + 2 * 24 * hour + 3 * hour).toISOString(), now), "2d3h");
  assert.equal(helpers.quotaCountdownLabel(new Date(now + hour + 30 * 60 * 1000).toISOString(), now), "1h30");
  assert.equal(helpers.quotaCountdownLabel(new Date(now + 45 * 60 * 1000).toISOString(), now), "45m");
  assert.equal(helpers.quotaCountdownLabel(null, now), "");

  assert.equal(helpers.quotaFreshnessLabel(null, now), "never");
  assert.equal(helpers.quotaFreshnessLabel({ observedAt: new Date(now - 20 * 1000).toISOString() }, now), "just now");
  assert.equal(helpers.quotaFreshnessLabel({ observedAt: new Date(now - 12 * 60 * 1000).toISOString() }, now), "12m ago");
  assert.equal(helpers.quotaFreshnessLabel({ observedAt: new Date(now - 3 * hour).toISOString() }, now), "3h ago");
  assert.equal(helpers.quotaFreshnessLabel({ observedAt: new Date(now - 2 * 24 * hour).toISOString() }, now), "2d ago");
});

test("host quota panel renders the three states from the owner-scoped quota API and mounts on the Host page", async () => {
  const [panel, settings, settingsTemplate] = await Promise.all([
    fs.readFile(files.panel, "utf8"),
    fs.readFile(files.settings, "utf8"),
    fs.readFile(files.settingsTemplate, "utf8"),
  ]);

  assert.match(panel, /selector: "ork-provider-quota-panel"/);
  assert.match(panel, /this\.api\.providerQuota\(\)/);
  assert.match(panel, /providers: QuotaProvider\[\] = \["claude", "codex"\]/);
  // Distinct markup per state and the stale freshness note.
  assert.match(panel, /\[attr\.data-state\]="state\(provider\)"/);
  assert.match(panel, /state\(provider\) === "unknown"/);
  assert.match(panel, /state\(provider\) === "limited"/);
  assert.match(panel, /freshness\(provider\)/);
  // No invented numbers and no leaking storage/logging.
  assert.doesNotMatch(panel, /localStorage|sessionStorage|console\.log/);

  // Mounted on the Host page (System/Instance settings), gated like system resources (owner only).
  assert.match(settings, /ProviderQuotaPanelComponent/);
  assert.match(settingsTemplate, /@if \(showSystemResources\) \{[\s\S]*<ork-provider-quota-panel>/);
});
