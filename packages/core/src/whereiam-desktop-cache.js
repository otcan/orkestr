import { listBrowserSessions } from "../../browsers/src/browsers.js";

// whereiam only reports desktop inventory as orientation context, so it serves
// a recently expired payload immediately (refreshing in the background) and
// never waits longer than a small budget for a cold `browserctl list`, which
// takes seconds under load. Live state stays available on /api/browser-sessions.
const desktopInventoryLiveCache = new Map();

function clean(value) {
  return String(value || "").trim();
}

function durationMs(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback;
}

function freshTtlMs(env = process.env) {
  return durationMs(env.ORKESTR_DESKTOP_INVENTORY_CACHE_MS || env.ORKESTR_BROWSER_SESSIONS_CACHE_MS, 15_000);
}

function staleWindowMs(env = process.env) {
  return durationMs(env.ORKESTR_WHEREIAM_DESKTOP_STALE_MS, 300_000);
}

function coldBudgetMs(env = process.env) {
  return durationMs(env.ORKESTR_WHEREIAM_DESKTOP_BUDGET_MS, 1_500);
}

function cacheKey(env = process.env, options = {}) {
  return JSON.stringify({
    home: clean(env.ORKESTR_HOME),
    mode: clean(env.ORKESTR_BROWSER_DESKTOP_MODE),
    browserctlPath: clean(env.ORKESTR_BROWSERCTL_PATH || env.ORKESTR_BROWSERCTL),
    userId: clean(options.principal?.userId),
    role: clean(options.principal?.role),
    threadId: clean(options.threadId),
    policyRevision: Number(options.desktopPolicyRevision || 0) || 0,
  });
}

function pendingPayload(budgetMs) {
  return {
    ok: false,
    pending: true,
    sessions: [],
    error: "desktop_inventory_pending",
    message: `Live desktop inventory did not answer within ${budgetMs} ms; retry whereiam or use GET /api/browser-sessions.`,
  };
}

function refresh(key, env, options, load) {
  const cached = desktopInventoryLiveCache.get(key);
  if (cached?.inFlight) return cached.inFlight;
  const inFlight = Promise.resolve()
    .then(() => load(env, options))
    .then((payload) => {
      desktopInventoryLiveCache.set(key, { payload, fetchedAt: Date.now(), inFlight: null });
      return payload;
    })
    .catch((error) => {
      const prior = desktopInventoryLiveCache.get(key);
      if (prior?.payload) desktopInventoryLiveCache.set(key, { ...prior, inFlight: null });
      else desktopInventoryLiveCache.delete(key);
      throw error;
    });
  desktopInventoryLiveCache.set(key, { payload: cached?.payload || null, fetchedAt: cached?.fetchedAt || 0, inFlight });
  return inFlight;
}

export async function cachedWhereamiDesktopInventory(env = process.env, options = {}, load = listBrowserSessions) {
  const ttlMs = freshTtlMs(env);
  if (ttlMs <= 0) return load(env, options);
  const key = cacheKey(env, options);
  const cached = desktopInventoryLiveCache.get(key);
  const ageMs = cached?.payload ? Date.now() - cached.fetchedAt : Infinity;
  if (ageMs < ttlMs) return cached.payload;
  if (ageMs < ttlMs + staleWindowMs(env)) {
    refresh(key, env, options, load).catch(() => undefined);
    return { ...cached.payload, stale: true, ageMs: Math.round(ageMs) };
  }
  const inFlight = refresh(key, env, options, load);
  const budgetMs = coldBudgetMs(env);
  if (budgetMs <= 0) return inFlight;
  let timer = null;
  const budget = new Promise((resolve) => {
    timer = setTimeout(() => resolve(pendingPayload(budgetMs)), budgetMs);
    timer.unref?.();
  });
  inFlight.catch(() => undefined);
  try {
    return await Promise.race([inFlight, budget]);
  } finally {
    clearTimeout(timer);
  }
}

export function resetWhereamiDesktopInventoryCache() {
  desktopInventoryLiveCache.clear();
}
