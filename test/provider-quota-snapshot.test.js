import assert from "node:assert/strict";
import test from "node:test";
import {
  mergeThreadIntoProviderQuota,
  providerQuotaFromThreads,
  providerQuotaSnapshot,
  quotaWindowSummary,
  resetProviderQuotaCacheForTest,
} from "../packages/core/src/provider-quota-snapshot.js";
import { appendWhatsAppDebugFooter, stripWhatsAppDebugFooter } from "../packages/connectors/src/whatsapp-formatting.js";
import { providerQuotaSegment, withWhatsAppProviderQuota } from "../packages/connectors/src/whatsapp-quota-footer.js";

const now = Date.parse("2099-01-10T12:00:00Z");
const hour = 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const futureSeconds = (ms) => Math.floor((now + ms) / 1000);
const footerEnv = { ORKESTR_WHATSAPP_DEBUG_FOOTER: "1", ORKESTR_SETTINGS_COMMANDS_ENABLED: "0", ORKESTR_ADMIN_USER_ID: "owner-a" };

function codexThread(overrides = {}) {
  return {
    id: "thread-codex",
    ownerUserId: "owner-a",
    runtimeKind: "codex-app-server",
    codexModel: "gpt-test",
    codexReasoningEffort: "high",
    codexRateLimits: {
      primary: { used_percent: 38, window_minutes: 300, resets_at: futureSeconds(2 * hour) },
      secondary: { used_percent: 20, window_minutes: 10080, resets_at: futureSeconds(72 * hour) },
    },
    codexRateLimitsObservedAt: iso(now - 10 * 60 * 1000),
    ...overrides,
  };
}

function claudeThread(overrides = {}) {
  return {
    id: "thread-claude",
    ownerUserId: "owner-a",
    runtimeKind: "claude-code",
    claudeModel: "sonnet",
    claudeEffort: "medium",
    executor: { type: "claude-code", metadata: {} },
    claudeRateLimits: {
      primary: { used_percent: 59, window_minutes: 300, resets_at: futureSeconds(hour) },
      secondary: { used_percent: 23, window_minutes: 10080, resets_at: futureSeconds(96 * hour) },
    },
    claudeRateLimitsObservedAt: iso(now - 5 * 60 * 1000),
    ...overrides,
  };
}

test("window summary reports remaining percent and never fabricates unknown or expired windows", () => {
  assert.deepEqual(quotaWindowSummary({ used_percent: 38, resets_at: futureSeconds(hour) }, now).remainingPct, 62);
  assert.equal(quotaWindowSummary({ used_percent: 140 }, now).remainingPct, null);
  assert.equal(quotaWindowSummary({ used_percent: -3 }, now).remainingPct, null);
  assert.equal(quotaWindowSummary({ used_percent: "" }, now).remainingPct, null);
  assert.equal(quotaWindowSummary({ used_percent: 10, resets_at: Math.floor((now - hour) / 1000) }, now).remainingPct, null);
  assert.equal(quotaWindowSummary({ status: "allowed" }, now).status, "allowed");
  assert.equal(quotaWindowSummary(null, now).remainingPct, null);
});

test("snapshot reports both providers from the freshest account-wide observation", () => {
  const olderCodex = codexThread({
    id: "older",
    codexRateLimits: { primary: { used_percent: 90, window_minutes: 300 }, secondary: null },
    codexRateLimitsObservedAt: iso(now - 2 * hour),
  });
  const snapshot = providerQuotaFromThreads([olderCodex, codexThread(), claudeThread()], { now, staleMs: 6 * hour });
  assert.equal(snapshot.codex.fiveHourRemainingPct, 62);
  assert.equal(snapshot.codex.weeklyRemainingPct, 80);
  assert.equal(snapshot.codex.stale, false);
  assert.equal(snapshot.codex.source, "telemetry");
  assert.equal(snapshot.claude.fiveHourRemainingPct, 41);
  assert.equal(snapshot.claude.weeklyRemainingPct, 77);
  assert.equal(snapshot.claude.fiveHourResetsAt, new Date(futureSeconds(hour) * 1000).toISOString());
});

test("snapshot marks old observations stale and unknown providers as null", () => {
  const snapshot = providerQuotaFromThreads([codexThread({ codexRateLimitsObservedAt: iso(now - 7 * hour) })], { now, staleMs: 6 * hour });
  assert.equal(snapshot.codex.stale, true);
  assert.equal(snapshot.codex.fiveHourRemainingPct, 62);
  assert.equal(snapshot.claude.fiveHourRemainingPct, null);
  assert.equal(snapshot.claude.weeklyRemainingPct, null);
  assert.equal(snapshot.claude.observedAt, null);
});

test("fresh stamped telemetry beats legacy thread records and leftover executor data gets no age", () => {
  const legacyClaudeLeftover = claudeThread({
    id: "was-codex",
    updatedAt: iso(now),
    claudeRateLimitsObservedAt: undefined,
    runtimeKind: "codex-app-server",
    executor: {},
  });
  const stamped = claudeThread({ claudeRateLimits: { primary: { used_percent: 10, window_minutes: 300 }, secondary: null } });
  const snapshot = providerQuotaFromThreads([legacyClaudeLeftover, stamped], { now, staleMs: 6 * hour });
  assert.equal(snapshot.claude.fiveHourRemainingPct, 90);
  assert.equal(snapshot.claude.source, "telemetry");
});

test("claude profile rate-limit state is surfaced without inventing percentages", () => {
  const snapshot = providerQuotaFromThreads([], { now, claudeProfiles: [{ state: "rate_limited" }] });
  assert.equal(snapshot.claude.limited, true);
  assert.equal(snapshot.claude.fiveHourRemainingPct, null);
  assert.match(providerQuotaSegment(snapshot.claude, "claude"), /^claude 5h:\? wk:\? \(limited\)$/);
});

test("calling thread wins ties and newer own telemetry over the cached snapshot", () => {
  const cached = providerQuotaFromThreads([claudeThread()], { now });
  const own = claudeThread({
    claudeRateLimits: { primary: { used_percent: 70, window_minutes: 300 }, secondary: null },
    claudeRateLimitsObservedAt: iso(now - 60 * 1000),
  });
  assert.equal(mergeThreadIntoProviderQuota(cached, own, { now }).claude.fiveHourRemainingPct, 30);
  const older = claudeThread({
    claudeRateLimits: { primary: { used_percent: 70, window_minutes: 300 }, secondary: null },
    claudeRateLimitsObservedAt: iso(now - hour),
  });
  assert.equal(mergeThreadIntoProviderQuota(cached, older, { now }).claude.fiveHourRemainingPct, 41);
});

test("snapshot is owner scoped and briefly cached", async () => {
  resetProviderQuotaCacheForTest();
  let loads = 0;
  const loadThreads = async () => {
    loads += 1;
    return [codexThread(), claudeThread({ ownerUserId: "owner-b" })];
  };
  const options = { ownerUserId: "owner-a", now, loadThreads, loadClaudeProfiles: async () => [] };
  const env = { ORKESTR_HOME: "/tmp/quota-fixture", ORKESTR_PROVIDER_QUOTA_CACHE_MS: "30000" };
  const first = await providerQuotaSnapshot(options, env);
  assert.equal(first.codex.fiveHourRemainingPct, 62);
  assert.equal(first.claude.fiveHourRemainingPct, null);
  await providerQuotaSnapshot({ ...options, now: now + 1000 }, env);
  assert.equal(loads, 1);
  await providerQuotaSnapshot({ ...options, now: now + 31_000 }, env);
  assert.equal(loads, 2);
  resetProviderQuotaCacheForTest();
});

test("provider quota enrichment is transient, bounded and fails open", async () => {
  const thread = codexThread();
  const enriched = await withWhatsAppProviderQuota(thread, {}, async () => ({ codex: {}, claude: {} }));
  assert.ok(enriched.whatsAppDebugProviderQuota);
  assert.equal(thread.whatsAppDebugProviderQuota, undefined);
  assert.equal((await withWhatsAppProviderQuota(thread, {}, async () => { throw new Error("offline"); })).whatsAppDebugProviderQuota, undefined);
  assert.equal((await withWhatsAppProviderQuota(thread, {}, () => new Promise(() => {}))).whatsAppDebugProviderQuota, undefined);
  assert.equal(await withWhatsAppProviderQuota(null), null);
});

test("Codex footer always shows both providers, Codex controls and a switch hint to Claude", () => {
  const thread = {
    ...codexThread({ codexRateLimitsObservedAt: undefined }),
    whatsAppDebugProviderQuota: providerQuotaFromThreads([claudeThread({ claudeRateLimitsObservedAt: iso(Date.now() - 60_000) })]),
  };
  const text = appendWhatsAppDebugFooter("Done", { env: footerEnv, message: { source: "codex-app-server" }, thread });
  assert.match(text, /\n\ndbg: m:gpt-test\/h · agent:codex · rt:api · msg:final · codex 5h:62% wk:80% 5h-reset:[^·]+ wk-reset:[^·]+ · claude 5h:41% wk:77%(?: 5h-reset:[^·]+)?(?: wk-reset:[^·]+)? · q:0 · /);
  assert.match(text, / · mode-switch:\/plan · rt-switch:\/switch-terminal · switch:\/claude$/);
  assert.equal(stripWhatsAppDebugFooter(text), "Done");
});

test("Claude footer always shows both providers, hides Codex controls and hints the switch to Codex", () => {
  const staleCodex = codexThread({ codexRateLimitsObservedAt: iso(Date.now() - 7 * hour) });
  const thread = { ...claudeThread({ claudeRateLimitsObservedAt: undefined }), whatsAppDebugProviderQuota: providerQuotaFromThreads([staleCodex]) };
  const text = appendWhatsAppDebugFooter("Done", { env: footerEnv, message: { source: "claude-code" }, thread });
  assert.match(text, /\n\ndbg: m:sonnet\/m · agent:claude · rt:claude · msg:final · codex 5h:\d+% wk:\d+%(?: 5h-reset:[^·]+)?(?: wk-reset:[^·]+)? \(stale\) · claude 5h:41% wk:77% 5h-reset:[^·]+ wk-reset:[^·]+ · q:0 · /);
  assert.match(text, / · help:\/help · switch:\/codex$/);
  assert.doesNotMatch(text, /fast:|mode-switch:|rt-switch:|model:\/model/);
});

test("footer renders unknown quota as ? for both providers without a snapshot", () => {
  const thread = { runtimeKind: "claude-code", executor: { type: "claude-code", metadata: {} } };
  const text = appendWhatsAppDebugFooter("Done", { env: footerEnv, message: { source: "claude-code" }, thread });
  assert.match(text, / · codex 5h:\? wk:\? · claude 5h:\? wk:\? · /);
});

test("a reading from an already-rolled-over window never beats the current window", () => {
  // Weekly-only records (no 5h window), as the Codex app-server reports them.
  const weekly = (used, resetsInMs) => ({ primary: { used_percent: used, window_minutes: 10080, resets_at: futureSeconds(resetsInMs) }, secondary: null });
  const current = codexThread({ id: "current", codexRateLimits: weekly(21, 6 * 24 * hour), codexRateLimitsObservedAt: undefined, updatedAt: iso(now - 30 * 60 * 1000) });
  // Legacy record from the previous window: no observation stamp and a newer
  // thread update caused by unrelated activity.
  const previous = codexThread({ id: "previous", codexRateLimits: weekly(54, 5 * 60 * 1000), codexRateLimitsObservedAt: undefined, updatedAt: iso(now - 60 * 1000) });
  for (const threads of [[current, previous], [previous, current]]) {
    const snapshot = providerQuotaFromThreads(threads, { now });
    assert.equal(snapshot.codex.weeklyRemainingPct, 79);
    assert.equal(snapshot.codex.fiveHourRemainingPct, null);
  }
  // The calling thread's own stale-window record does not override the snapshot either.
  const merged = mergeThreadIntoProviderQuota(providerQuotaFromThreads([current], { now }), previous, { now });
  assert.equal(merged.codex.weeklyRemainingPct, 79);
});

test("footer shows reset times for both providers, not only the active one", () => {
  const snapshot = providerQuotaFromThreads([codexThread(), claudeThread()], { now });
  for (const provider of ["codex", "claude"]) {
    const segment = providerQuotaSegment(snapshot[provider], provider);
    assert.match(segment, new RegExp(`^${provider} 5h:\\d+% wk:\\d+% 5h-reset:\\S+`));
  }
});
