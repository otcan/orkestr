// Per-window provider quota report (MCP get_provider_quotas). Synthetic
// readings only; no real accounts, owners or quota values.
import assert from "node:assert/strict";
import test from "node:test";
import { localIsoTime, providerQuotaReport, providerQuotaUnavailableReport, quotaReportTimezone } from "../packages/core/src/provider-quota-report.js";
import { emptyProviderQuota, providerQuotaFromThreads, providerQuotaSnapshot, providerQuotaWindowDetails } from "../packages/core/src/provider-quota-snapshot.js";

const now = Date.parse("2099-01-10T12:00:00Z"), minute = 60_000, hour = 60 * minute, day = 24 * hour;
const at = (ms) => new Date(ms).toISOString();
const reading = (provider, period, used, { observed = now - minute, reset = now + hour, status = null } = {}) =>
  ({ provider, period, observedAt: at(observed), record: { used_percent: used, resets_at: reset === null ? null : reset / 1000, status } });

async function snapshotOf(projections, { threads = [], claudeProfiles = [], env = {} } = {}) {
  return providerQuotaSnapshot({ ownerUserId: "owner-a", now, useCache: false, loadThreads: async () => threads,
    loadClaudeProfiles: async () => claudeProfiles, loadProjections: async () => projections }, env);
}

const providerOf = (report, name) => report.providers.find((entry) => entry.provider === name);
const windowOf = (entry, name) => entry.windows.find((window) => window.window === name);

test("fresh readings are current per window with used/remaining percent, UTC and local resets, age and source", async () => {
  const snapshot = await snapshotOf([
    reading("codex", "weekly", 21, { reset: now + 5 * day }),
    reading("claude", "fiveHour", 40, { reset: now + 2 * hour, status: "allowed" }),
    reading("claude", "weekly", 12.4, { observed: now - 30 * minute, reset: now + 6 * day, status: "allowed" }),
  ]);
  const report = providerQuotaReport(snapshot, { now, timezone: "Europe/Berlin" });
  assert.equal(report.format, "orkestr-provider-quotas-v1");
  assert.equal(report.available, true);
  assert.deepEqual(report.timezone, { name: "Europe/Berlin", source: "owner_profile" });
  assert.equal(report.staleAfterSeconds, 21600);
  assert.equal(report.source.providerContacted, false);
  assert.deepEqual(report.providers.map((entry) => entry.provider), ["codex", "claude"]);

  const codex = providerOf(report, "codex");
  assert.equal(codex.state, "current");
  assert.equal(codex.source, "account_projection");
  assert.equal(codex.allowanceType, "subscription");
  const weekly = windowOf(codex, "weekly");
  assert.deepEqual({ ...weekly }, {
    window: "weekly", durationMinutes: 10080, state: "current", usedPercent: 21, remainingPercent: 79, unit: "percent_of_window_allowance",
    providerStatus: null, resetsAt: "2099-01-15T12:00:00.000Z", resetsAtLocal: "2099-01-15T13:00:00+01:00", resetsInSeconds: 5 * 86400,
    observedAt: at(now - minute), ageSeconds: 60, source: "account_projection", lastObserved: null,
  });
  assert.equal(codex.newestObservedAt, at(now - minute));
  assert.deepEqual(codex.warnings, []);
  assert.deepEqual(codex.blockers, []);

  const claude = providerOf(report, "claude");
  assert.equal(windowOf(claude, "five_hour").remainingPercent, 60);
  assert.equal(windowOf(claude, "five_hour").providerStatus, "allowed");
  assert.equal(windowOf(claude, "weekly").usedPercent, 12, "whole percents, as the snapshot rounds them");
  assert.equal(windowOf(claude, "weekly").remainingPercent, 88);
  assert.equal(windowOf(claude, "weekly").observedAt, at(now - 30 * minute), "each window keeps its own observation time");
  assert.equal(claude.newestObservedAt, at(now - minute));
});

test("a window the provider does not report is explicit, not zero, and model-specific windows and API credits are not collected", async () => {
  const report = providerQuotaReport(await snapshotOf([reading("codex", "weekly", 50)]), { now });
  const codex = providerOf(report, "codex");
  const fiveHour = windowOf(codex, "five_hour");
  assert.equal(fiveHour.state, "not_reported");
  for (const key of ["usedPercent", "remainingPercent", "resetsAt", "observedAt", "lastObserved"]) assert.equal(fiveHour[key], null, key);
  assert.equal(codex.modelSpecificWindows.state, "not_collected");
  assert.deepEqual(codex.modelSpecificWindows.windows, []);
  assert.deepEqual({ state: codex.apiCredits.state, balance: codex.apiCredits.balance, unit: codex.apiCredits.unit }, { state: "not_collected", balance: null, unit: null });
  assert.match(codex.apiCredits.reason, /not API credits/);
  const claude = providerOf(report, "claude");
  assert.equal(claude.state, "unknown");
  assert.equal(claude.source, null);
  assert.deepEqual(claude.windows.map((window) => window.state), ["not_reported", "not_reported"]);
  assert.deepEqual(claude.warnings.map((warning) => warning.code), ["no_observation"]);
  assert.equal(claude.newestObservedAt, null);
});

test("a stale reading never reads as current: its values move to lastObserved with a warning", async () => {
  const snapshot = await snapshotOf([
    reading("claude", "fiveHour", 10, { observed: now - 10 * minute, status: "allowed" }),
    reading("claude", "weekly", 30, { observed: now - 7 * hour, reset: now + 3 * day, status: "allowed" }),
  ]);
  const claude = providerOf(providerQuotaReport(snapshot, { now }), "claude");
  const weekly = windowOf(claude, "weekly");
  assert.equal(weekly.state, "stale");
  assert.equal(weekly.usedPercent, null);
  assert.equal(weekly.remainingPercent, null);
  assert.equal(weekly.resetsAt, null);
  assert.equal(weekly.observedAt, at(now - 7 * hour));
  assert.equal(weekly.ageSeconds, 7 * 3600);
  assert.deepEqual({ ...weekly.lastObserved }, { usedPercent: 30, remainingPercent: 70, providerStatus: "allowed", observedAt: at(now - 7 * hour),
    resetsAt: at(now + 3 * day), resetsAtLocal: "2099-01-13T12:00:00+00:00", resetsInSeconds: 3 * 86400 });
  assert.equal(windowOf(claude, "five_hour").state, "current", "a fresh five-hour reading stays current beside the stale weekly one");
  assert.equal(claude.state, "current");
  assert.deepEqual(claude.warnings.map((warning) => [warning.code, warning.window]), [["stale_observation", "weekly"]]);
});

test("the reason a reading is not current follows its own age and source, and future times have no known age", async () => {
  const snapshot = await snapshotOf([
    { ...reading("claude", "fiveHour", 10, { observed: now - 5 * minute }), source: "thread-activity" },
    reading("claude", "weekly", 20, { observed: now + 10 * minute, reset: now + day }),
    reading("codex", "weekly", 30, { observed: now + 30_000, reset: now + day }),
  ]);
  const report = providerQuotaReport(snapshot, { now });
  const claude = providerOf(report, "claude");
  assert.deepEqual(claude.windows.map((item) => [item.state, item.ageSeconds, item.lastObserved?.remainingPercent]), [["stale", 300, 90], ["stale", null, 80]]);
  assert.deepEqual(claude.warnings.map((warning) => [warning.code, warning.window]),
    [["observation_time_estimated", "five_hour"], ["observation_age_unknown", "weekly"]], "a fresh estimate is not 'older than the limit'");
  const codexWeekly = windowOf(providerOf(report, "codex"), "weekly");
  assert.deepEqual([codexWeekly.state, codexWeekly.ageSeconds], ["current", 0], "skew within a minute still counts");
});

test("a telemetry reading just past the limit is stale_observation, though its rounded age equals the limit", async () => {
  const snapshot = await snapshotOf([reading("codex", "weekly", 5, { observed: now - 6 * hour - 400, reset: now + day })]);
  const codex = providerOf(providerQuotaReport(snapshot, { now }), "codex");
  assert.deepEqual([windowOf(codex, "weekly").state, windowOf(codex, "weekly").ageSeconds], ["stale", 21600]);
  assert.deepEqual(codex.warnings.map((warning) => warning.code), ["stale_observation"]);
});

test("the freshness limit follows the snapshot's configured staleAfterMs", async () => {
  const snapshot = await snapshotOf([reading("codex", "weekly", 5, { observed: now - 2 * hour, reset: now + day })], { env: { ORKESTR_PROVIDER_QUOTA_STALE_MS: String(hour) } });
  const report = providerQuotaReport(snapshot, { now });
  assert.equal(report.staleAfterSeconds, 3600);
  assert.equal(windowOf(providerOf(report, "codex"), "weekly").state, "stale");
});

test("a reading whose window has reset is expired: when it was read and when it ended, never its percentage", async () => {
  const snapshot = await snapshotOf([
    reading("claude", "fiveHour", 7, { observed: now - 17 * day, reset: now - 16 * day, status: "allowed" }),
    reading("claude", "weekly", 0, { observed: now - 2 * hour, reset: now + 7 * day, status: "allowed" }),
  ]);
  const claude = providerOf(providerQuotaReport(snapshot, { now }), "claude");
  const fiveHour = windowOf(claude, "five_hour");
  assert.equal(fiveHour.state, "expired");
  assert.equal(fiveHour.remainingPercent, null);
  assert.equal(fiveHour.observedAt, at(now - 17 * day));
  assert.deepEqual({ ...fiveHour.lastObserved, resetsAtLocal: undefined }, { usedPercent: null, remainingPercent: null, providerStatus: null,
    observedAt: at(now - 17 * day), resetsAt: at(now - 16 * day), resetsAtLocal: undefined, resetsInSeconds: null });
  assert.ok(!JSON.stringify(fiveHour).includes("93"), "the lapsed 93% remaining is not reported");
  assert.deepEqual(claude.warnings.map((warning) => warning.code), ["window_expired"]);
  assert.equal(windowOf(claude, "weekly").remainingPercent, 100);
  assert.equal(claude.state, "current");

  // A window that resets after the cached snapshot was filled is expired too.
  const cached = await snapshotOf([reading("codex", "weekly", 40, { reset: now + 10 * minute })]);
  const later = providerOf(providerQuotaReport(cached, { now: now + 11 * minute }), "codex");
  assert.equal(windowOf(later, "weekly").state, "expired");
  assert.equal(windowOf(later, "weekly").lastObserved.resetsAt, at(now + 10 * minute));
  assert.equal(later.state, "expired");
});

test("provider-reported limits are blockers until reset; near-limit and unconfirmed rate-limit marks are warnings", async () => {
  const snapshot = await snapshotOf([
    reading("claude", "fiveHour", 100, { reset: now + 40 * minute, status: "rejected" }),
    reading("claude", "weekly", 85, { reset: now + 2 * day, status: "allowed_warning" }),
    reading("codex", "weekly", 100, { reset: now + day }),
  ]);
  const report = providerQuotaReport(snapshot, { now });
  const claude = providerOf(report, "claude");
  assert.deepEqual(claude.blockers.map(({ code, window, until, evidence }) => ({ code, window, until, evidence })),
    [{ code: "rate_limited", window: "five_hour", until: at(now + 40 * minute), evidence: "provider_status_rejected" }]);
  assert.deepEqual(claude.warnings.map((warning) => [warning.code, warning.window]), [["near_limit", "weekly"]]);
  assert.deepEqual(providerOf(report, "codex").blockers.map((blocker) => blocker.evidence), ["no_remaining_allowance"]);

  // The V1 account profile mark has no time and no window evidence.
  const profiled = await snapshotOf([reading("claude", "weekly", 10)], { claudeProfiles: [{ state: "rate_limited" }] });
  const marked = providerOf(providerQuotaReport(profiled, { now }), "claude");
  assert.deepEqual(marked.blockers, []);
  assert.deepEqual(marked.warnings.map((warning) => warning.code), ["account_marked_rate_limited"]);

  // A stale rejected window explains the projection's limited flag with its own time.
  const staleRejected = await snapshotOf([reading("claude", "fiveHour", 100, { observed: now - 7 * hour, reset: now + 20 * minute, status: "rejected" })]);
  const seen = providerOf(providerQuotaReport(staleRejected, { now }), "claude");
  assert.equal(staleRejected.claude.limited, true);
  assert.deepEqual(seen.blockers, []);
  assert.deepEqual(seen.warnings.map(({ code, window, observedAt }) => [code, window, observedAt]),
    [["stale_observation", "five_hour", undefined], ["last_seen_rate_limited", "five_hour", at(now - 7 * hour)]]);
  // ...and a rejected window that reset after the cache fill is simply over.
  const lapsed = providerOf(providerQuotaReport(staleRejected, { now: now + 21 * minute }), "claude");
  assert.deepEqual(lapsed.warnings.map((warning) => warning.code), ["window_expired"]);
});

test("legacy thread telemetry: stamped readings are current, estimated or unknown observation times are not", () => {
  const limits = { primary: { used_percent: 20, window_minutes: 300, resets_at: (now + hour) / 1000 }, secondary: { used_percent: 60, window_minutes: 10080, resets_at: (now + 2 * day) / 1000 } };
  const stamped = providerQuotaFromThreads([{ id: "t1", codexRateLimits: limits, codexRateLimitsObservedAt: at(now - 5 * minute) }], { now });
  const codex = providerOf(providerQuotaReport(stamped, { now }), "codex");
  assert.equal(codex.source, "thread_telemetry");
  assert.deepEqual(codex.windows.map((window) => [window.state, window.remainingPercent]), [["current", 80], ["current", 40]]);
  assert.equal(providerQuotaWindowDetails(stamped.codex), null);

  const estimated = providerQuotaFromThreads([{ id: "t2", codexRateLimits: limits, updatedAt: at(now - 5 * minute) }], { now });
  const guessed = providerOf(providerQuotaReport(estimated, { now }), "codex");
  assert.equal(guessed.source, "thread_activity_estimate");
  assert.deepEqual(guessed.windows.map((window) => window.state), ["stale", "stale"]);
  assert.deepEqual(guessed.warnings.map((warning) => warning.code), ["observation_time_estimated", "observation_time_estimated"]);

  const unknownAge = { ...emptyProviderQuota("codex"), weeklyRemainingPct: 50, weeklyResetsAt: at(now + day), source: "thread-record" };
  const unknown = providerOf(providerQuotaReport({ codex: unknownAge, claude: emptyProviderQuota("claude") }, { now }), "codex");
  assert.equal(windowOf(unknown, "weekly").state, "stale");
  assert.equal(windowOf(unknown, "weekly").lastObserved.remainingPercent, 50);
  assert.deepEqual(unknown.warnings.map((warning) => warning.code), ["observation_age_unknown"]);
});

test("an unreadable snapshot reports every provider unavailable, never empty or zero", () => {
  const report = providerQuotaUnavailableReport("quota_snapshot_timeout", { now, timezone: "Not/AZone" });
  assert.equal(report.available, false);
  assert.equal(report.reason, "quota_snapshot_timeout");
  assert.deepEqual(report.timezone, { name: "UTC", source: "default" });
  for (const entry of report.providers) {
    assert.equal(entry.state, "unavailable");
    assert.deepEqual(entry.windows.map((window) => [window.state, window.remainingPercent]), [["unavailable", null], ["unavailable", null]]);
    assert.deepEqual(entry.warnings.map((warning) => warning.code), ["quota_unavailable"]);
    assert.equal(entry.apiCredits.state, "not_collected");
  }
});

test("a provider filter returns only that provider", async () => {
  const snapshot = await snapshotOf([reading("codex", "weekly", 1)]);
  assert.deepEqual(providerQuotaReport(snapshot, { now, provider: "claude" }).providers.map((entry) => entry.provider), ["claude"]);
  assert.deepEqual(providerQuotaUnavailableReport("quota_snapshot_unavailable", { now, provider: "codex" }).providers.map((entry) => entry.provider), ["codex"]);
});

test("timezones: invalid zones fall back to UTC; local times carry the zone offset", () => {
  assert.deepEqual(quotaReportTimezone(""), { name: "UTC", source: "default" });
  assert.deepEqual(quotaReportTimezone("Mars/Base"), { name: "UTC", source: "default" });
  assert.deepEqual(quotaReportTimezone(null, { unavailable: true }), { name: "UTC", source: "unavailable" });
  assert.equal(localIsoTime(Date.parse("2099-07-01T12:00:00Z"), "Europe/Berlin"), "2099-07-01T14:00:00+02:00");
  assert.equal(localIsoTime(Date.parse("2099-07-01T12:00:00Z"), "Asia/Kathmandu"), "2099-07-01T17:45:00+05:45");
  assert.equal(localIsoTime(Date.parse("2099-07-01T12:00:00Z"), "UTC"), "2099-07-01T12:00:00+00:00");
  assert.equal(localIsoTime(null, "UTC"), null);
});
