// Account-level remaining quota for both subscription providers (Codex and
// Claude Code). Rate limits are account-wide, so the freshest observation from
// any of the owner's threads is the best estimate for every thread. Values are
// only ever derived from observed telemetry; unknown windows stay null.
import { resourceOwnerUserId } from "./policy.js";

export const providerQuotaProviders = Object.freeze(["codex", "claude"]);
const defaultStaleMs = 6 * 60 * 60 * 1000;
const defaultCacheMs = 30 * 1000;
const snapshotCache = new Map();

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

function observedMs(entry) {
  return quotaEpochMs(entry?.observedAt) || 0;
}

// Fresh stamped telemetry beats legacy estimates; otherwise the newest wins.
function newer(left, right) {
  if (!left) return right;
  if (!right) return left;
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

export async function providerQuotaSnapshot({ ownerUserId = "", now = Date.now(), loadThreads = defaultLoadThreads, loadClaudeProfiles = defaultLoadClaudeProfiles, useCache = true } = {}, env = process.env) {
  const owner = resourceOwnerUserId({ ownerUserId }, env);
  const staleMs = providerQuotaStaleMs(env);
  const cacheKey = `${clean(env.ORKESTR_HOME)}\u0000${owner}`;
  const cached = useCache ? snapshotCache.get(cacheKey) : null;
  if (cached && now - cached.at < providerQuotaCacheMs(env)) return cached.value;
  const threads = (await loadThreads(env).catch(() => []))
    .filter((thread) => resourceOwnerUserId(thread, env) === owner);
  const claudeProfiles = await loadClaudeProfiles(owner, env).catch(() => []);
  const value = providerQuotaFromThreads(threads, { now, staleMs, claudeProfiles });
  if (useCache) snapshotCache.set(cacheKey, { at: now, value });
  return value;
}

export function resetProviderQuotaCacheForTest() {
  snapshotCache.clear();
}
