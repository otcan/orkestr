// Read only the operator-enrolled numeric projection, never native/account data.
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const identified = value => uuid.test(value) && value !== "00000000-0000-0000-0000-000000000000";
const statuses = new Set([null, "allowed", "allowed_warning", "rejected"]);
const exact = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join("|") === [...keys].sort().join("|");
const finite = value => typeof value === "number" && Number.isFinite(value);

async function privateJson(filename, owners, limit) {
  if (typeof filename !== "string" || !path.isAbsolute(filename) || path.normalize(filename) !== filename) throw Error("quota source path");
  const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || !owners.includes(stat.uid) || (stat.mode & 0o027) || stat.size > limit) throw Error("quota source custody");
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw Error("quota source bound");
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } finally { await file.close(); }
}

export const quotaProjectionProviders = Object.freeze(["claude", "codex"]);
const sourceKeys = ["ownerUserId", "coreOwnerId", "accountRef", "producerUid", "path"];
// A source without `provider` is the original Claude enrollment.
export const quotaSourceProvider = source => exact(source, sourceKeys) ? "claude"
  : exact(source, [...sourceKeys, "provider"]) && quotaProjectionProviders.includes(source.provider) ? source.provider : null;

export function quotaProjectionWindows(value, source, now) {
  const provider = source?.provider ?? "claude";
  if (!quotaProjectionProviders.includes(provider)) return [];
  if (!exact(value, ["format", "provider", "owner_id", "account_ref", "windows"])
      || value.format !== "orkestr-provider-quota-v1" || value.provider !== provider
      || value.owner_id !== source.coreOwnerId || value.account_ref !== source.accountRef
      || !value.windows || typeof value.windows !== "object" || Array.isArray(value.windows)
      || Object.keys(value.windows).some(key => !["five_hour", "seven_day"].includes(key))) return [];
  const result = [];
  for (const [period, window] of Object.entries(value.windows)) {
    if (!exact(window, ["used_percent", "resets_at", "status", "observed_at"])
        || !(window.used_percent === null || finite(window.used_percent) && window.used_percent >= 0 && window.used_percent <= 100)
        || !(window.resets_at === null || finite(window.resets_at) && window.resets_at > 0)
        || !statuses.has(window.status) || !Number.isSafeInteger(window.observed_at)
        || window.observed_at <= 0 || window.observed_at > now + 60_000) return [];
    result.push({ provider, period: period === "five_hour" ? "fiveHour" : "weekly", observedAt: new Date(window.observed_at).toISOString(),
      record: { used_percent: window.used_percent, resets_at: window.resets_at, status: window.status } });
  }
  return result;
}

export async function loadProviderQuotaProjections(ownerUserId, env = process.env, now = Date.now()) {
  const filename = env.ORKESTR_PROVIDER_QUOTA_PROJECTION_CONFIG;
  if (!filename) return [];
  try {
    const config = await privateJson(filename, [0, process.getuid?.()].filter(Number.isInteger), 16_384);
    if (!exact(config, ["format", "sources"]) || config.format !== "orkestr-provider-quota-sources-v1"
        || !Array.isArray(config.sources) || config.sources.length > 16) return [];
    const owned = config.sources.filter(source => source?.ownerUserId === ownerUserId);
    // One enrolled account per owner and provider; never blend different
    // accounts' periods or silently choose one ambiguous operator entry.
    // An unrecognized entry for this owner makes every provider ambiguous.
    if (owned.some(source => !quotaSourceProvider(source))) return [];
    const results = [];
    for (const source of owned) {
      const provider = quotaSourceProvider(source);
      if (owned.filter(other => quotaSourceProvider(other) === provider).length !== 1
          || !identified(source.coreOwnerId) || !identified(source.accountRef)
          || !Number.isInteger(source.producerUid) || source.producerUid < 0) continue;
      try {
        const value = await privateJson(source.path, [source.producerUid], 8192);
        results.push(...quotaProjectionWindows(value, { ...source, provider }, now));
      } catch { /* Missing, changing or unavailable metadata leaves quota unknown/stale. */ }
    }
    return results;
  } catch { return []; } // This informational source never fails an owner request.
}
