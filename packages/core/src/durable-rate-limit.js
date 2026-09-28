import crypto from "node:crypto";
import path from "node:path";
import { dataPaths } from "../../storage/src/paths.js";
import { readJson, writeSecretJson } from "../../storage/src/store.js";
import { withStorageFileLock } from "../../storage/src/storage-lock.js";

// File-backed sliding-window counters. Keys are hashed before they are
// persisted so source addresses and account names never land on disk in the
// clear. Counters survive process restarts because they live under the
// instance secrets directory, and every read-modify-write holds a file lock.

const MAX_KEYS_PER_BUCKET = 5_000;

function clean(value) {
  return String(value || "").trim();
}

function bucketName(bucket = "") {
  const name = clean(bucket).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!name) throw Object.assign(new Error("rate_limit_bucket_required"), { statusCode: 500 });
  return name;
}

export function durableRateLimitKey(value = "") {
  return crypto.createHash("sha256").update(clean(value)).digest("hex").slice(0, 32);
}

function bucketPath(bucket, env) {
  return path.join(dataPaths(env).secrets, "rate-limits", `${bucketName(bucket)}.json`);
}

function recentHits(hits, nowMs, windowMs) {
  return (Array.isArray(hits) ? hits : [])
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > nowMs - windowMs && value <= nowMs + windowMs);
}

function pruneBucket(entries, nowMs, windowMs) {
  const next = {};
  const live = Object.entries(entries || {})
    .map(([key, hits]) => [key, recentHits(hits, nowMs, windowMs)])
    .filter(([, hits]) => hits.length)
    .sort((a, b) => Math.max(...b[1]) - Math.max(...a[1]))
    .slice(0, MAX_KEYS_PER_BUCKET);
  for (const [key, hits] of live) next[key] = hits;
  return next;
}

/**
 * Records one hit for `key` in `bucket` unless the window is already full.
 * Returns `{ ok, count, limit, retryAfterMs }`. A full window records nothing.
 * @param {{ bucket: string; key: string; limit: number; windowMs: number; nowMs?: number }} options
 * @param {Record<string, string | undefined>} [env]
 * @returns {Promise<{ ok: boolean; count: number; limit: number; retryAfterMs: number }>}
 */
export async function consumeDurableRateLimit({ bucket, key, limit, windowMs, nowMs = Date.now() }, env = process.env) {
  const max = Math.max(1, Math.floor(Number(limit) || 1));
  const window = Math.max(1_000, Math.floor(Number(windowMs) || 60_000));
  const hashed = durableRateLimitKey(key);
  const filePath = bucketPath(bucket, env);
  return withStorageFileLock(filePath, async () => {
    const stored = await readJson(filePath, {});
    const entries = pruneBucket(stored?.entries, nowMs, window);
    const hits = entries[hashed] || [];
    if (hits.length >= max) {
      await writeSecretJson(filePath, { entries, updatedAt: new Date(nowMs).toISOString() });
      return { ok: false, count: hits.length, limit: max, retryAfterMs: Math.max(0, Math.min(...hits) + window - nowMs) };
    }
    entries[hashed] = [...hits, nowMs];
    await writeSecretJson(filePath, { entries, updatedAt: new Date(nowMs).toISOString() });
    return { ok: true, count: hits.length + 1, limit: max, retryAfterMs: 0 };
  });
}

export function positiveIntegerEnv(value, fallback, minimum = 1) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}
