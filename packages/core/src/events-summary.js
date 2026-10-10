// Summarizes the recent tail of the event log for `orkestr doctor events` and
// GET /api/system/events/summary: counts by event type and the top error
// codes of failing types. Only event types and short machine codes are
// reported; free-form error text, chat ids, message ids and targets never
// leave this module.
import fs from "node:fs/promises";
import { dataPaths } from "../../storage/src/paths.js";
import { parseDurationMs } from "./perf-compare.js";

const MAX_WINDOW_MS = 7 * 86400000;
const CHUNK_BYTES = 1024 * 1024;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const TYPE_LIMIT = 40;
const CODE_LIMIT = 5;
const CODE_FIELDS = ["errorCode", "code", "error", "reason"];
const FAILURE_TYPE = /(fail|error|degraded|exhausted|blocked|rejected|timeout|lost)/i;

export function resolveEventsSince(since = "1h", now = Date.now()) {
  const duration = parseDurationMs(since);
  if (duration != null) return now - Math.min(MAX_WINDOW_MS, Math.max(60000, duration));
  const parsed = Date.parse(String(since || ""));
  return Number.isFinite(parsed) ? Math.max(now - MAX_WINDOW_MS, Math.min(parsed, now)) : now - 3600000;
}

// Reduces an error/reason value to a short machine code. Values that do not
// look like a code (sentences, ids, addresses) collapse to the first
// snake_case token they contain, or to "unclassified".
export function eventErrorCode(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (text.length <= 64 && /^[a-z][a-z0-9_.:-]*$/i.test(text) && !/\d{5,}/.test(text)) return text;
  const token = text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/i);
  return token ? token[0].slice(0, 64) : "unclassified";
}

async function readTailSince(filePath, sinceMs, maxBytes) {
  const handle = await fs.open(filePath, "r").catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!handle) return { lines: [], truncated: false };
  try {
    const { size } = await handle.stat();
    let position = size;
    let carry = "";
    const lines = [];
    while (position > 0) {
      if (size - position >= maxBytes) return { lines, truncated: true };
      const length = Math.min(CHUNK_BYTES, position, maxBytes - (size - position));
      position -= length;
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      const parts = (buffer.subarray(0, bytesRead).toString("utf8") + carry).split("\n");
      carry = position > 0 ? parts.shift() : "";
      let reachedStart = false;
      for (let index = parts.length - 1; index >= 0; index -= 1) {
        const line = parts[index];
        if (!line) continue;
        lines.push(line);
        const ts = Date.parse(line.slice(0, 64).match(/"ts":"([^"]+)"/)?.[1] || "");
        // Writers append in time order, so a line older than the window
        // (with a small slack for late writers) means the rest is older too.
        if (Number.isFinite(ts) && ts < sinceMs - 60000) reachedStart = true;
      }
      if (reachedStart) return { lines, truncated: false };
    }
    if (carry) lines.push(carry);
    return { lines, truncated: false };
  } finally {
    await handle.close();
  }
}

export async function summarizeEvents(env = process.env, { since = "1h", now = Date.now(), maxBytes } = {}) {
  const sinceMs = resolveEventsSince(since, now);
  const limitBytes = Number(maxBytes || env.ORKESTR_EVENTS_SUMMARY_MAX_BYTES) || DEFAULT_MAX_BYTES;
  const { lines, truncated } = await readTailSince(dataPaths(env).events, sinceMs, limitBytes);
  const byType = new Map();
  let total = 0;
  let unparseable = 0;
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      unparseable += 1;
      continue;
    }
    const ts = Date.parse(event?.ts || "");
    if (!Number.isFinite(ts) || ts < sinceMs || ts > now) continue;
    const type = eventErrorCode(event.type) || "untyped";
    total += 1;
    const row = byType.get(type) || { type, count: 0, codes: new Map() };
    row.count += 1;
    if (FAILURE_TYPE.test(type)) {
      const field = CODE_FIELDS.find((name) => event[name] != null && event[name] !== "");
      const code = field ? `${field === "errorCode" ? "error" : field}=${eventErrorCode(event[field])}` : "none";
      row.codes.set(code, (row.codes.get(code) || 0) + 1);
    }
    byType.set(type, row);
  }
  const hours = Math.max(1 / 60, (now - sinceMs) / 3600000);
  const rows = [...byType.values()].sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  const shape = (row) => ({
    type: row.type,
    count: row.count,
    perHour: Math.round((row.count / hours) * 10) / 10,
    ...(row.codes.size ? {
      topCodes: [...row.codes.entries()].sort((a, b) => b[1] - a[1]).slice(0, CODE_LIMIT).map(([code, count]) => ({ code, count })),
    } : {}),
  });
  return {
    ok: true,
    window: { since: new Date(sinceMs).toISOString(), until: new Date(now).toISOString(), minutes: Math.round((now - sinceMs) / 60000) },
    total,
    truncated,
    unparseable,
    types: rows.slice(0, TYPE_LIMIT).map(shape),
    failures: rows.filter((row) => FAILURE_TYPE.test(row.type)).slice(0, TYPE_LIMIT).map(shape),
  };
}
