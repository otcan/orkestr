import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const files = {
  helpers: new URL("../apps/web/src/app/provider-quota.ts", import.meta.url),
  indicator: new URL("../apps/web/src/app/provider-quota-indicator.component.ts", import.meta.url),
  api: new URL("../apps/web/src/app/api.service.ts", import.meta.url),
  app: new URL("../apps/web/src/app/app.component.ts", import.meta.url),
  template: new URL("../apps/web/src/app/app.component.html", import.meta.url),
};

test("dual quota indicator shows both providers from the owner-scoped quota API", async () => {
  const [indicator, api, app, template] = await Promise.all([
    fs.readFile(files.indicator, "utf8"),
    fs.readFile(files.api, "utf8"),
    fs.readFile(files.app, "utf8"),
    fs.readFile(files.template, "utf8"),
  ]);
  assert.match(api, /this\.api\("\/quota\/providers"\)/);
  assert.match(indicator, /selector: "ork-provider-quota-indicator"/);
  assert.match(indicator, /providers: QuotaProvider\[\] = \["codex", "claude"\]/);
  assert.match(indicator, /\[title\]="tooltip\(provider\)"/);
  assert.match(indicator, /stale/);
  assert.doesNotMatch(indicator, /localStorage|sessionStorage|console\.log/);
  assert.match(app, /ProviderQuotaIndicatorComponent\]/);
  assert.match(template, /<ork-provider-quota-indicator \[activeProvider\]="activeExecutorProvider\(thread\)">/);
  assert.match(template, /class="executor-badge"[^>]*>\{\{ activeExecutorLabel\(thread\) \}\}/);
});

test("quota helpers render unknown as ?, label the executor and read Claude model settings", async () => {
  const helpers = await import(files.helpers.href);
  assert.equal(helpers.quotaPercentLabel(null), "?");
  assert.equal(helpers.quotaPercentLabel(null, "allowed"), "ok");
  assert.equal(helpers.quotaPercentLabel(41.4), "41%");
  assert.equal(helpers.quotaTone({ fiveHourRemainingPct: 8, weeklyRemainingPct: 70 }), "danger");
  assert.equal(helpers.quotaTone({ fiveHourRemainingPct: null, weeklyRemainingPct: null }), "unknown");
  assert.equal(helpers.quotaTone({ fiveHourRemainingPct: null, weeklyRemainingPct: null, limited: true }), "danger");
  assert.match(helpers.quotaTooltip("claude", null), /Claude: no quota observed yet/);
  const stale = helpers.quotaTooltip("codex", {
    fiveHourRemainingPct: 62, weeklyRemainingPct: 80, fiveHourResetsAt: null, weeklyResetsAt: null,
    observedAt: "2099-01-01T00:00:00.000Z", stale: true, source: "telemetry",
  });
  assert.match(stale, /5h: 62%/);
  assert.match(stale, /\(stale\)/);

  const claude = { runtimeKind: "claude-code", executor: { type: "claude-code", metadata: { claudeModel: "opus", claudeEffort: "high" } } };
  assert.equal(helpers.threadExecutorProvider(claude), "claude");
  assert.equal(helpers.executorLabel(helpers.threadExecutorProvider(claude)), "Claude");
  assert.equal(helpers.claudeModelName(claude), "opus");
  assert.equal(helpers.claudeEffortLabel(claude), "high");
  assert.equal(helpers.claudeModelName({ runtimeKind: "claude-code", claudeModelResolved: "claude-sonnet-x" }), "claude-sonnet-x");
  assert.equal(helpers.claudeModelName({ runtimeKind: "claude-code" }), "Claude default");
  assert.equal(helpers.threadExecutorProvider({ runtimeKind: "codex-app-server" }), "codex");
});
