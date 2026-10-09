// Durable performance log: one JSONL line per HTTP request and one per health
// sample, in daily files under ORKESTR_HOME/observability. Entries carry only
// the normalized route template, status, timings, sizes and the auth kind —
// never query strings, bodies, headers, tokens, user ids or chat ids. Writes
// are buffered and appended off the request path; old days are pruned.
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { appHome } from "../../storage/src/paths.js";
import { routeTemplateFromUrl } from "./observability.js";

const DEFAULT_RETENTION_DAYS = 14;
const FLUSH_INTERVAL_MS = 5000;
const MAX_BUFFERED = 2000;
const FILE_PATTERN = /^(requests|health)-(\d{4}-\d{2}-\d{2})\.jsonl$/;

export function perfLogEnabled(env = process.env) {
  return String(env.ORKESTR_PERF_LOG ?? "1") !== "0";
}

export function perfLogDir(env = process.env) {
  return env.ORKESTR_PERF_LOG_DIR || path.join(appHome(env), "observability");
}

export function perfRetentionDays(env = process.env) {
  const parsed = Number(env.ORKESTR_PERF_LOG_RETENTION_DAYS || DEFAULT_RETENTION_DAYS);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.min(Math.floor(parsed), 90) : DEFAULT_RETENTION_DAYS;
}

export function perfLogFile(kind, at = new Date(), env = process.env) {
  return path.join(perfLogDir(env), `${kind}-${at.toISOString().slice(0, 10)}.jsonl`);
}

export function createPerfLogWriter(env = process.env, { now = () => new Date() } = {}) {
  const buffers = { requests: [], health: [] };
  let flushing = null;
  let timer = null;
  let lastPrunedDay = "";
  let dropped = 0;

  function append(kind, entry) {
    const buffer = buffers[kind];
    if (!buffer) return;
    if (buffer.length >= MAX_BUFFERED) {
      dropped += 1;
      return;
    }
    buffer.push(JSON.stringify(entry));
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        void flush();
      }, FLUSH_INTERVAL_MS);
      timer.unref?.();
    }
  }

  async function writeAll() {
    const at = now();
    const dir = perfLogDir(env);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    for (const kind of Object.keys(buffers)) {
      const lines = buffers[kind].splice(0);
      if (kind === "requests" && dropped) {
        lines.push(JSON.stringify({ ts: at.toISOString(), dropped }));
        dropped = 0;
      }
      if (!lines.length) continue;
      await fs.appendFile(perfLogFile(kind, at, env), `${lines.join("\n")}\n`, { mode: 0o600 });
    }
    const day = at.toISOString().slice(0, 10);
    if (day !== lastPrunedDay) {
      lastPrunedDay = day;
      await prunePerfLogs(env, at);
    }
  }

  async function flush() {
    if (flushing) await flushing.catch(() => {});
    flushing = writeAll().catch(() => {}).finally(() => {
      flushing = null;
    });
    return flushing;
  }

  async function close() {
    if (timer) clearTimeout(timer);
    timer = null;
    await flush();
  }

  return { append, flush, close };
}

export async function prunePerfLogs(env = process.env, at = new Date()) {
  const cutoff = new Date(at.getTime() - perfRetentionDays(env) * 86400000).toISOString().slice(0, 10);
  const names = await fs.readdir(perfLogDir(env)).catch(() => []);
  for (const name of names) {
    const match = FILE_PATTERN.exec(name);
    if (match && match[2] < cutoff) await fs.rm(path.join(perfLogDir(env), name), { force: true });
  }
}

// Route templates from observability.js, plus a stricter allowlist pass for
// the durable log: only segments shaped like static route words survive
// (lowercase letters, dots, hyphens, or a short word with a version digit, as
// every controller path uses). Anything else (tokens, user ids, phone numbers,
// chat ids, file names) becomes :id, and the segment after /users/ is always
// :userId unless it is a fixed sub-route.
const STATIC_SEGMENT = /^(?:\.?[a-z][a-z.-]{0,39}|[a-z]{1,12}[0-9]{1,2})$/;
const ID_PARENTS = new Map([
  ["users", ["me", "credit-usage"]],
  ["chats", []],
  ["desktop-share", []],
]);

function perfSegment(segment, previous) {
  if (segment.startsWith(":")) return segment;
  const fixed = ID_PARENTS.get(previous);
  if (fixed && !fixed.includes(segment)) return previous === "users" ? ":userId" : ":id";
  return STATIC_SEGMENT.test(segment) ? segment : ":id";
}

export function perfRouteTemplate(rawUrl = "") {
  const route = routeTemplateFromUrl(rawUrl)
    .split("/")
    .map((segment, index, parts) => (index === 0 ? segment : perfSegment(segment, parts[index - 1])))
    .join("/");
  return route.length > 160 ? `${route.slice(0, 157)}...` : route;
}

function authKind(request) {
  if (request.orkestrMachineAuth) return "machine";
  if (request.orkestrDesktopShare) return "share";
  if (request.orkestrAnonymous) return "anonymous";
  if (request.orkestrPrincipal) return "user";
  return "none";
}

// Express middleware: records every finished (or aborted) request.
export function createPerfRequestLogMiddleware(writer, { tracker = createInflightTracker() } = {}) {
  return (request, response, next) => {
    const started = performance.now();
    const startedAt = new Date();
    const inflight = tracker.start();
    let recorded = false;
    const record = (aborted) => {
      if (recorded) return;
      recorded = true;
      tracker.end();
      writer.append("requests", {
        ts: startedAt.toISOString(),
        method: String(request.method || "GET").toUpperCase().slice(0, 10),
        route: perfRouteTemplate(request.originalUrl || request.url || "/"),
        status: aborted ? 0 : response.statusCode,
        ms: Math.round((performance.now() - started) * 10) / 10,
        bytes: Number(response.getHeader("content-length") || 0) || 0,
        auth: authKind(request),
        inflight,
        ...(aborted ? { aborted: true } : {}),
      });
    };
    response.once("finish", () => record(false));
    response.once("close", () => record(!response.writableFinished));
    next();
  };
}

export function createInflightTracker() {
  let active = 0;
  return {
    start: () => ++active,
    end: () => {
      active = Math.max(0, active - 1);
    },
    current: () => active,
  };
}
