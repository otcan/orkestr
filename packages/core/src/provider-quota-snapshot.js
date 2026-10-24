// Account-level remaining quota for both subscription providers (Codex and
// Claude Code). Rate limits are account-wide, so the freshest observation from
// any of the owner's threads is the best estimate for every thread. Values are
// only ever derived from observed telemetry; unknown windows stay null.
import { resourceOwnerUserId } from "./policy.js";
import { loadProviderQuotaProjections } from "./provider-quota-projection.js";

export const providerQuotaProviders = Object.freeze(["codex", "claude"]);
const defaultStaleMs = 6 * 60 * 60 * 1000;
const defaultCacheMs = 30 * 1000;
const snapshotCache = new Map();
// Internal per-period stamps; keep the established JSON/API schema unchanged.
const quotaWindowDetails = new WeakMap();

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function clean(value) {
  return String(value ?? "").trim();
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export function providerQuotaStaleMs(env = process.env) {
  return positiveNumber(env.ORKESTR_PROVIDER_QUOTA_STALE_MS, defaultStaleMs);
}

export function providerQuotaCacheMs(env = process.env) {
  return positiveNumber(env.ORKESTR_PROVIDER_QUOTA_CACHE_MS, defaultCacheMs);
}

export function quotaEpochMs(value) {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function isoOrNull(ms) {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

export function threadQuotaProvider(thread = {}) {
  const executor = objectValue(thread?.executor) || {};
  const metadata = objectValue(executor.metadata) || {};
  const runtime = objectValue(thread?.runtime) || {};
  const claude = [thread?.runtimeKind, runtime.runtimeKind, executor.type, executor.id, metadata.runtimeKind]
    .some((value) => clean(value).toLowerCase() === "claude-code");
  if (claude) return "claude";
  const kind = clean(thread?.runtimeKind || runtime.runtimeKind || metadata.runtimeKind).toLowerCase();
  return kind === "api-agent" ? "" : "codex";
}

function providerRecord(thread = {}, provider = "codex") {
  const metadata = objectValue(thread?.executor?.metadata) || {};
  if (provider === "claude") return objectValue(thread?.claudeRateLimits) || objectValue(metadata.claudeRateLimits);
  return objectValue(thread?.codexRateLimits) || objectValue(metadata.codexRateLimits) || objectValue(metadata.rateLimits);
}

function providerObservation(thread = {}, provider = "codex") {
  const metadata = objectValue(thread?.executor?.metadata) || {};
  const key = provider === "claude" ? "claudeRateLimitsObservedAt" : "codexRateLimitsObservedAt";
  const exact = quotaEpochMs(thread?.[key]) ?? quotaEpochMs(metadata[key]);
  if (exact) return { ms: exact, source: "telemetry" };
  // Legacy records carry no observation stamp. Only for the thread's active
  // provider is its last update a reasonable upper bound for the telemetry age;
  // leftovers from a previous executor get no age at all.
  if (threadQuotaProvider(thread) !== provider) return { ms: null, source: "thread-record" };
  return { ms: quotaEpochMs(thread?.updatedAt), source: "thread-activity" };
}

function windowMinutes(record) {
  const minutes = Number(record?.window_minutes);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
}

// Classify primary/secondary by their window length; fall back to position only
// when the record carries no window length.
export function quotaWindowRecord(limits = null, period = "fiveHour") {
  if (!objectValue(limits)) return null;
  const weekly = period === "weekly";
  const entries = ["primary", "secondary"].map((key) => objectValue(limits[key])).filter(Boolean);
  const byWindow = entries.find((record) => {
    const minutes = windowMinutes(record);
    return minutes ? (weekly ? minutes >= 10080 : minutes <= 360) : false;
  });
  if (byWindow) return byWindow;
  const fallback = objectValue(limits[weekly ? "secondary" : "primary"]);
  return fallback && !windowMinutes(fallback) ? fallback : null;
}

export function quotaWindowSummary(record = null, now = Date.now()) {
  if (!record) return { remainingPct: null, resetsAt: null, status: null };
  const resetMs = quotaEpochMs(record.resets_at);
  const status = clean(record.status).toLowerCase() || null;
  // A window whose reset time has passed no longer describes current usage.
  if (resetMs && resetMs <= now) return { remainingPct: null, resetsAt: null, status: null };
  const rawUsed = record.used_percent;
  const used = rawUsed === null || rawUsed === undefined || rawUsed === "" ? NaN : Number(rawUsed);
  const remainingPct = Number.isFinite(used) && used >= 0 && used <= 100
    ? Math.round(Math.max(0, Math.min(100, 100 - used)))
    : null;
  return { remainingPct, resetsAt: isoOrNull(resetMs), status };
}

export function emptyProviderQuota(provider = "codex") {
  return {
    provider,
    fiveHourRemainingPct: null,
    weeklyRemainingPct: null,
    fiveHourResetsAt: null,
    weeklyResetsAt: null,
    fiveHourStatus: null,
    weeklyStatus: null,
    observedAt: null,
    stale: false,
    limited: false,
    source: null,
  };
}

export function providerQuotaFromThread(thread = {}, provider = "codex", { now = Date.now(), staleMs = defaultStaleMs } = {}) {
  const limits = providerRecord(thread, provider);
  if (!limits) return null;
  const { ms: observedMs, source } = providerObservation(thread, provider);
  const fiveHour = quotaWindowSummary(quotaWindowRecord(limits, "fiveHour"), now);
  const weekly = quotaWindowSummary(quotaWindowRecord(limits, "weekly"), now);
  return {
    ...emptyProviderQuota(provider),
    fiveHourRemainingPct: fiveHour.remainingPct,
    weeklyRemainingPct: weekly.remainingPct,
    fiveHourResetsAt: fiveHour.resetsAt,
    weeklyResetsAt: weekly.resetsAt,
    fiveHourStatus: fiveHour.status,
    weeklyStatus: weekly.status,
    observedAt: isoOrNull(observedMs),
    // Unknown age is reported as unknown (observedAt null), not guessed stale.
    stale: Boolean(observedMs) && now - observedMs > staleMs,
    source,
  };
}

// Providers round reset times; readings within this skew are the same window.
const windowSkewMs = 5 * 60 * 1000;

function observedMs(entry) {
  return quotaEpochMs(entry?.observedAt) || 0;
}

// A later reset time for the same window period means a newer window, so a
// record from an already-rolled-over window can never beat the current one,
// whatever its (possibly estimated) observation time says.
function newerWindow(left, right) {
  for (const key of ["weeklyResetsAt", "fiveHourResetsAt"]) {
    const a = quotaEpochMs(left?.[key]);
    const b = quotaEpochMs(right?.[key]);
    if (a && b && Math.abs(a - b) > windowSkewMs) return b > a ? right : left;
  }
  return null;
}

// Newer windows win first; then fresh stamped telemetry beats legacy
// estimates; otherwise the newest observation wins.
function newer(left, right) {
  if (!left) return right;
  if (!right) return left;
  const byWindow = newerWindow(left, right);
  if (byWindow) return byWindow;
  const exact = (entry) => entry.source === "telemetry" && !entry.stale;
  if (exact(left) !== exact(right)) return exact(left) ? left : right;
  return observedMs(right) > observedMs(left) ? right : left;
}

// Pure: builds the dual snapshot from thread records and optional profile state.
export function providerQuotaFromThreads(threads = [], { now = Date.now(), staleMs = defaultStaleMs, claudeProfiles = [] } = {}) {
  const best = { codex: null, claude: null };
  for (const thread of Array.isArray(threads) ? threads : []) {
    for (const provider of providerQuotaProviders) {
      best[provider] = newer(best[provider], providerQuotaFromThread(thread, provider, { now, staleMs }));
    }
  }
  const claudeLimited = (Array.isArray(claudeProfiles) ? claudeProfiles : [])
    .some((profile) => clean(profile?.state).toLowerCase() === "rate_limited");
  const claude = best.claude || emptyProviderQuota("claude");
  return {
    codex: best.codex || emptyProviderQuota("codex"),
    claude: claudeLimited ? { ...claude, limited: true, source: claude.source || "profile" } : claude,
    generatedAt: new Date(now).toISOString(),
    staleAfterMs: staleMs,
  };
}

// Prefer the calling thread's own telemetry when it is at least as fresh as
// the cached account snapshot (it may have been written after the cache fill).
export function mergeThreadIntoProviderQuota(snapshot = null, thread = null, { now = Date.now(), staleMs = defaultStaleMs } = {}) {
  const base = snapshot || providerQuotaFromThreads([], { now, staleMs });
  if (!thread) return base;
  const result = { ...base };
  for (const provider of providerQuotaProviders) {
    const own = providerQuotaFromThread(thread, provider, { now, staleMs });
    if (!own) continue;
    const current = base[provider];
    if (provider === "claude" && current && quotaWindowDetails.has(current)) {
      result[provider] = mergeProjectedClaudeQuota(current, ["fiveHour", "weekly"].map(period => ({
        period, observedAt: own.observedAt, source: own.source,
        record: { used_percent: own[`${period}RemainingPct`] == null ? null : 100 - own[`${period}RemainingPct`],
          resets_at: own[`${period}ResetsAt`], status: own[`${period}Status`] },
      })), { now, staleMs });
      continue;
    }
    // Ties go to the calling thread: it may have been written after the cache fill.
    const pick = current?.source ? newer(own, current) : own;
    if (pick === own) result[provider] = { ...own, limited: Boolean(current?.limited) };
  }
  return result;
}

async function defaultLoadThreads(env) {
  const { listThreads } = await import("./threads.js");
  return listThreads(env);
}

async function defaultLoadClaudeProfiles(ownerUserId, env) {
  const { listLlmAccountProfiles } = await import("./llm-account-profiles.js");
  return listLlmAccountProfiles(ownerUserId, { provider: "claude-code" }, env);
}

// Pick each period independently. A fresh five-hour observation must not stamp
// an older weekly percentage fresh. The public aggregate age is conservative.
export function mergeProjectedClaudeQuota(base, observations, { now = Date.now(), staleMs = defaultStaleMs } = {}) {
  const periods = ["fiveHour", "weekly"];
  const selected = { ...(quotaWindowDetails.get(base) || {}) };
  for (const period of periods) {
    const current = { remainingPct: base[`${period}RemainingPct`], resetsAt: base[`${period}ResetsAt`],
      status: base[`${period}Status`], observedAt: base.observedAt, source: base.source };
    if (!selected[period] && (current.remainingPct != null || current.resetsAt || current.status)) selected[period] = current;
  }
  let changed = false;
  for (const entry of observations) {
    if (!periods.includes(entry.period)) continue;
    const summary = quotaWindowSummary(entry.record, now);
    if (summary.remainingPct === null && !summary.resetsAt && !summary.status) continue;
    const candidate = { ...summary, observedAt: entry.observedAt, source: entry.source === undefined ? "telemetry" : entry.source };
    const current = selected[entry.period];
    const resetA = quotaEpochMs(current?.resetsAt), resetB = quotaEpochMs(candidate.resetsAt);
    const fresh = value => value?.source === "telemetry" && observedMs(value) > 0 && now - observedMs(value) <= staleMs;
    const replace = !current || (resetA && resetB && Math.abs(resetA - resetB) > windowSkewMs
      ? resetB > resetA : fresh(current) !== fresh(candidate) ? fresh(candidate) : observedMs(candidate) >= observedMs(current));
    if (replace) { selected[entry.period] = candidate; changed = true; }
  }
  if (!changed) return base;
  const result = { ...base };
  for (const period of periods) {
    const chosen = selected[period];
    result[`${period}RemainingPct`] = chosen?.remainingPct ?? null;
    result[`${period}ResetsAt`] = chosen?.resetsAt ?? null;
    result[`${period}Status`] = chosen?.status ?? null;
  }
  const values = Object.values(selected), ages = values.map(observedMs);
  const age = ages.length && ages.every(ms => ms > 0) ? Math.min(...ages) : null;
  result.observedAt = isoOrNull(age);
  result.stale = Boolean(age) && now - age > staleMs;
  result.source = values.every(value => value.source === "telemetry") ? "telemetry" : base.source;
  result.limited = Boolean(base.limited) || values.some(value => value.status === "rejected");
  quotaWindowDetails.set(result, selected);
  return result;
}

export async function providerQuotaSnapshot({ ownerUserId = "", now = Date.now(), loadThreads = defaultLoadThreads, loadClaudeProfiles = defaultLoadClaudeProfiles, loadProjections = loadProviderQuotaProjections, useCache = true } = {}, env = process.env) {
  const owner = resourceOwnerUserId({ ownerUserId }, env);
  const staleMs = providerQuotaStaleMs(env);
  const cacheKey = `${clean(env.ORKESTR_HOME)}\u0000${owner}`;
  const cached = useCache ? snapshotCache.get(cacheKey) : null;
  if (cached && now - cached.at < providerQuotaCacheMs(env)) return cached.value;
  const threads = (await loadThreads(env).catch(() => []))
    .filter((thread) => resourceOwnerUserId(thread, env) === owner);
  const claudeProfiles = await loadClaudeProfiles(owner, env).catch(() => []);
  const value = providerQuotaFromThreads(threads, { now, staleMs, claudeProfiles });
  const projections = await loadProjections(owner, env, now).catch(() => []);
  value.claude = mergeProjectedClaudeQuota(value.claude, projections, { now, staleMs });
  if (useCache) snapshotCache.set(cacheKey, { at: now, value });
  return value;
}

export function resetProviderQuotaCacheForTest() {
  snapshotCache.clear();
}
