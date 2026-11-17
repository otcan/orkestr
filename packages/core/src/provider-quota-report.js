// Explicit, per-window report of the provider quota snapshot that already
// drives the WhatsApp footer, GET /api/quota/providers and the V2 resource bar
// (provider-quota-snapshot.js). Pure: it reads nothing and contacts no
// provider. A value is reported as current only when its own telemetry
// observation time is known and within the freshness limit; older readings
// move to `lastObserved`, and absent or reset windows are explicit, never zero.
import { providerQuotaWindowDetails, quotaEpochMs } from "./provider-quota-snapshot.js";

export const PROVIDER_QUOTA_REPORT_FORMAT = "orkestr-provider-quotas-v1";
export const providerQuotaReportProviders = Object.freeze(["codex", "claude"]);

const DEFAULT_STALE_MS = 6 * 60 * 60 * 1000;
const UNIT = "percent_of_window_allowance";
const names = { codex: "OpenAI / Codex", claude: "Claude" };
const windowSpecs = [["fiveHour", "five_hour", 300, "5-hour"], ["weekly", "weekly", 10080, "weekly"]];
const statuses = new Set(["allowed", "allowed_warning", "rejected"]);

const NOTES = Object.freeze([
  "Subscription allowance only: percentages of each usage window's allowance as the provider reports them. Providers report no token, message or credit counts for these windows.",
  "Readings are passive: recorded from the provider's own rate-limit events during ordinary runs. Orkestr never queries the provider for this report, and nothing is derived from active or queued runs.",
  "A value is as of its observedAt; usage may have grown since. Stale, reset (expired), unreported and unavailable windows carry no current percentage.",
  "API-credit or billing balances are not collected and are not the same as these subscription windows.",
]);

const iso = (ms) => Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
const seconds = (ms) => Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : null;
const percent = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value) : null;

// The owner's IANA zone when valid, else UTC (as in the WhatsApp footer).
// `unavailable`: the profile could not be read, so UTC is not the owner's choice.
export function quotaReportTimezone(value, { unavailable = false } = {}) {
  if (unavailable) return { name: "UTC", source: "unavailable" };
  try {
    if (typeof value === "string" && value.trim()) {
      return { name: new Intl.DateTimeFormat("en-GB", { timeZone: value.trim() }).resolvedOptions().timeZone, source: "owner_profile" };
    }
  } catch { /* An invalid stored zone falls back to UTC explicitly. */ }
  return { name: "UTC", source: "default" };
}

// Broker and server clocks may differ slightly (the projection loader allows
// the same minute); a later observation time is no known age at all.
const CLOCK_SKEW_MS = 60_000;

// ISO 8601 wall time with the zone's UTC offset, e.g. 2026-11-22T14:00:00+01:00.
export function localIsoTime(ms, zone = "UTC") {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "longOffset",
  }).formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  const offset = /^GMT[+-]\d{2}:\d{2}$/.test(parts.timeZoneName) ? parts.timeZoneName.slice(3) : "+00:00";
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${offset}`;
}

// account_projection: the enrolled per-account projection (V2 provider
// broker). The thread_* kinds are legacy V1 thread telemetry.
function sourceKind(entry, details) {
  if (details) return "account_projection";
  if (entry?.source === "telemetry") return "thread_telemetry";
  if (entry?.source === "thread-activity") return "thread_activity_estimate";
  return null;
}

// One period as the snapshot selected it: per-window stamps for an enrolled
// account projection, the entry's aggregate observation for legacy telemetry.
function selectedReading(entry, details, period) {
  if (details) return details[period];
  const remainingPct = entry?.[`${period}RemainingPct`], resetsAt = entry?.[`${period}ResetsAt`], status = entry?.[`${period}Status`];
  if (remainingPct == null && !resetsAt && !status) return null;
  return { remainingPct, resetsAt, status, observedAt: entry.observedAt, source: entry.source };
}

function emptyWindow(key, minutes, state) {
  return { window: key, durationMinutes: minutes, state, usedPercent: null, remainingPercent: null, unit: UNIT,
    providerStatus: null, resetsAt: null, resetsAtLocal: null, resetsInSeconds: null, observedAt: null, ageSeconds: null,
    source: null, lastObserved: null };
}

function windowReport(entry, details, [period, key, minutes], { now, staleMs, zone, kind }) {
  const reading = selectedReading(entry, details, period);
  const known = (observedMs) => Boolean(observedMs) && observedMs <= now + CLOCK_SKEW_MS;
  const timing = (observedMs) => ({ observedAt: iso(observedMs), ageSeconds: known(observedMs) ? seconds(now - observedMs) : null, source: kind });
  // A reset window says only when it was read and when it ended.
  const expired = (observedMs, resetMs) => ({ ...emptyWindow(key, minutes, "expired"), ...timing(observedMs),
    lastObserved: { usedPercent: null, remainingPercent: null, providerStatus: null, observedAt: iso(observedMs),
      resetsAt: iso(resetMs), resetsAtLocal: localIsoTime(resetMs, zone), resetsInSeconds: null } });
  if (!reading) {
    const lapsed = details?.lapsed?.[period];
    return lapsed ? expired(quotaEpochMs(lapsed.observedAt), quotaEpochMs(lapsed.resetsAt)) : emptyWindow(key, minutes, "not_reported");
  }
  const observedMs = quotaEpochMs(reading.observedAt), resetMs = quotaEpochMs(reading.resetsAt);
  // The snapshot is cached; a window can reset after the cache fill.
  if (resetMs && resetMs <= now) return expired(observedMs, resetMs);
  const remaining = percent(reading.remainingPct);
  const values = { usedPercent: remaining === null ? null : 100 - remaining, remainingPercent: remaining,
    providerStatus: statuses.has(reading.status) ? reading.status : null };
  const reset = { resetsAt: iso(resetMs), resetsAtLocal: localIsoTime(resetMs, zone), resetsInSeconds: resetMs ? seconds(resetMs - now) : null };
  // Estimated (thread activity), unknown or future observation times are never current.
  const current = reading.source === "telemetry" && known(observedMs) && now - observedMs <= staleMs;
  if (current) return { ...emptyWindow(key, minutes, "current"), ...values, ...reset, ...timing(observedMs) };
  return { ...emptyWindow(key, minutes, "stale"), ...timing(observedMs), lastObserved: { ...values, observedAt: iso(observedMs), ...reset } };
}

function issue(code, window, message, extra = {}) {
  return { code, window, message, ...extra };
}

// Why a reading that has values is not current: by its own age, not its kind.
function staleIssue(report, label, { now, staleMs }) {
  if (report.ageSeconds === null) return issue("observation_age_unknown", report.window, `The ${label} reading has no known observation time; its values are not current.`);
  // Exact milliseconds, as for `current`; ageSeconds is rounded.
  if (now - quotaEpochMs(report.observedAt) > staleMs) return issue("stale_observation", report.window, `The newest ${label} reading is older than the freshness limit; its values are not current.`);
  return issue("observation_time_estimated", report.window, `The ${label} reading's time is only estimated, not stamped by telemetry; its values are not shown as current.`);
}

// `windowRejected`: a selected window reading (current or not) had status
// rejected, which is what sets `limited` for an account projection.
function providerIssues(entry, reports, { now, staleMs, windowRejected }) {
  const warnings = [], blockers = [];
  reports.forEach((report, index) => {
    const label = windowSpecs[index][3];
    if (report.state === "current" && (report.providerStatus === "rejected" || report.remainingPercent === 0)) {
      blockers.push(issue("rate_limited", report.window, `The ${label} window allows no further use until it resets.`,
        { until: report.resetsAt, evidence: report.providerStatus === "rejected" ? "provider_status_rejected" : "no_remaining_allowance" }));
    } else if (report.state === "current" && report.providerStatus === "allowed_warning") {
      warnings.push(issue("near_limit", report.window, `The provider reports the ${label} window as near its limit.`));
    } else if (report.state === "stale") {
      warnings.push(staleIssue(report, label, { now, staleMs }));
      if (report.lastObserved?.providerStatus === "rejected") {
        warnings.push(issue("last_seen_rate_limited", report.window, `The ${label} window was rate-limited when last read; that reading is not current.`, { observedAt: report.lastObserved.observedAt }));
      }
    } else if (report.state === "expired") {
      warnings.push(issue("window_expired", report.window, `The last ${label} reading belongs to a window that has since reset; current usage is unknown.`));
    }
  });
  // Otherwise `limited` comes from an account profile record (a failed turn).
  if (entry?.limited === true && !blockers.length && !windowRejected) {
    warnings.push(issue("account_marked_rate_limited", null, "An Orkestr account record marks this provider rate-limited, but no window reading confirms it; when that mark was set is not recorded."));
  }
  if (reports.every((report) => report.state === "not_reported")) warnings.push(issue("no_observation", null, "No quota reading has been observed for this provider's account."));
  return { warnings, blockers };
}

function providerState(reports) {
  for (const state of ["current", "stale", "expired"]) if (reports.some((report) => report.state === state)) return state;
  return "unknown";
}

const modelSpecificWindows = () => ({ state: "not_collected", reason: "Only account-wide windows are recorded; model-specific limits are not collected.", windows: [] });
const apiCredits = () => ({ state: "not_collected", reason: "Orkestr reads no API-credit or billing balance; the windows are subscription allowance, not API credits.", balance: null, unit: null });

export function providerQuotaEntryReport(entry, provider, { now = Date.now(), staleMs = DEFAULT_STALE_MS, zone = "UTC" } = {}) {
  const details = providerQuotaWindowDetails(entry);
  const kind = sourceKind(entry, details);
  const reports = windowSpecs.map((spec) => windowReport(entry, details, spec, { now, staleMs, zone, kind }));
  const windowRejected = windowSpecs.some(([period]) => selectedReading(entry, details, period)?.status === "rejected");
  const observed = reports.map((report) => quotaEpochMs(report.observedAt)).filter(Boolean);
  return {
    provider,
    name: names[provider],
    allowanceType: "subscription",
    state: providerState(reports),
    source: kind,
    newestObservedAt: observed.length ? iso(Math.max(...observed)) : null,
    windows: reports,
    modelSpecificWindows: modelSpecificWindows(),
    apiCredits: apiCredits(),
    ...providerIssues(entry, reports, { now, staleMs, windowRejected }),
  };
}

function reportShell(now, staleMs, timezone) {
  return {
    format: PROVIDER_QUOTA_REPORT_FORMAT,
    generatedAt: iso(now),
    timezone,
    staleAfterSeconds: seconds(staleMs),
    source: { kind: "passive_telemetry", providerContacted: false, sharedWith: ["whatsapp_footer", "web_quota_display", "GET /api/quota/providers"] },
    notes: NOTES,
  };
}

const selectedProviders = (provider) => providerQuotaReportProviders.includes(provider) ? [provider] : providerQuotaReportProviders;

// `snapshot` is providerQuotaSnapshot(...)'s value for the authorized owner.
export function providerQuotaReport(snapshot, { now = Date.now(), timezone = null, timezoneUnavailable = false, provider = "" } = {}) {
  const zone = quotaReportTimezone(timezone, { unavailable: timezoneUnavailable });
  const configured = snapshot?.staleAfterMs;
  const staleMs = Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_STALE_MS;
  return {
    ...reportShell(now, staleMs, zone),
    available: true,
    reason: null,
    snapshotGeneratedAt: iso(quotaEpochMs(snapshot?.generatedAt)),
    providers: selectedProviders(provider).map((name) => providerQuotaEntryReport(snapshot?.[name] || null, name, { now, staleMs, zone: zone.name })),
  };
}

// The snapshot could not be read: every provider is unavailable, not empty.
export function providerQuotaUnavailableReport(reason, { now = Date.now(), staleMs = DEFAULT_STALE_MS, timezone = null, timezoneUnavailable = false, provider = "" } = {}) {
  return {
    ...reportShell(now, staleMs, quotaReportTimezone(timezone, { unavailable: timezoneUnavailable })),
    available: false,
    reason,
    snapshotGeneratedAt: null,
    providers: selectedProviders(provider).map((name) => ({
      provider: name, name: names[name], allowanceType: "subscription", state: "unavailable", source: null, newestObservedAt: null,
      windows: windowSpecs.map(([, key, minutes]) => emptyWindow(key, minutes, "unavailable")),
      modelSpecificWindows: modelSpecificWindows(), apiCredits: apiCredits(),
      warnings: [issue("quota_unavailable", null, "The quota snapshot could not be read; nothing is known about this provider's quota right now.")],
      blockers: [],
    })),
  };
}
