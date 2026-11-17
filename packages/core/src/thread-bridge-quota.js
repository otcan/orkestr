// Provider quota readings for a connected assistant (MCP get_provider_quotas).
// Reuses the owner's existing quota snapshot, the source of the WhatsApp
// footer and GET /api/quota/providers; it adds no reader, credential or
// provider request. Quota is account-wide, so only a grant that may already
// observe all of the owner's threads may read it; no new scope is involved.
import { authorization } from "./thread-bridge.js";
import { providerQuotaSnapshot, providerQuotaStaleMs } from "./provider-quota-snapshot.js";
import { providerQuotaReport, providerQuotaUnavailableReport } from "./provider-quota-report.js";

// A quick look: the snapshot is cached for 30 s and its sources are local.
const SNAPSHOT_TIMEOUT_MS = 3000;
const TIMEZONE_TIMEOUT_MS = 250;

function fail(code, statusCode = 403) {
  throw Object.assign(new Error(code), { statusCode });
}

async function quotaGrant(principal, env) {
  const grant = await authorization(principal, env);
  if (grant.observe !== "all") fail("bridge_quota_not_granted");
  return grant;
}

async function readOwnerTimezone(ownerUserId, env) {
  const { readUserOnboardingState } = await import("./user-onboarding.js");
  return (await readUserOnboardingState(ownerUserId, env))?.profile?.timezone || null;
}

const timedOut = Symbol("timeout");
const failed = Symbol("failed");

// The read's value, `failed` if it throws, or `timedOut` after `ms`. A read
// that outlives the bound keeps running (and fills the snapshot cache).
async function bounded(read, ms) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(read).catch(() => failed),
      new Promise((resolve) => { timer = setTimeout(() => resolve(timedOut), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function bridgeProviderQuotas(principal, { provider = "" } = {}, env = process.env, options = {}) {
  const {
    loadSnapshot = providerQuotaSnapshot,
    loadTimezone = readOwnerTimezone,
    now = Date.now,
    timeoutMs = SNAPSHOT_TIMEOUT_MS,
  } = options;
  const grant = await quotaGrant(principal, env);
  const owner = grant.ownerUserId;
  const [snapshot, zone] = await Promise.all([
    bounded(() => loadSnapshot({ ownerUserId: owner }, env), Math.max(1, Math.min(SNAPSHOT_TIMEOUT_MS, Number(timeoutMs) || SNAPSHOT_TIMEOUT_MS))),
    bounded(() => loadTimezone(owner, env), TIMEZONE_TIMEOUT_MS),
  ]);
  const timezone = typeof zone === "string" ? zone : null;
  // The reads take time: a grant revoked or narrowed meanwhile gets nothing.
  await quotaGrant(principal, env);
  const time = now();
  if (!snapshot || typeof snapshot !== "object") {
    const reason = snapshot === timedOut ? "quota_snapshot_timeout" : "quota_snapshot_unavailable";
    return providerQuotaUnavailableReport(reason, { now: time, staleMs: providerQuotaStaleMs(env), timezone, provider });
  }
  return providerQuotaReport(snapshot, { now: time, timezone, provider });
}
