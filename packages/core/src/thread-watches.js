// Thread watches: one thread subscribes to another thread's finished turns.
// Orkestr delivers the result itself (thread-watch-pump.js) instead of relying
// on the watched agent to remember `orkestr send`. Watches are internal only;
// they never post to a chat on their own.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { appHome } from "../../storage/src/paths.js";
import { withStorageFileLock } from "../../storage/src/storage-lock.js";
import { getThread, getThreadForPrincipal, listThreadMessageCandidates } from "./threads.js";
import { isAdminPrincipal, resourceOwnerUserId } from "./policy.js";

export const WATCH_MODES = Object.freeze(["once", "continuous"]);
export const WATCH_TRIGGERS = Object.freeze(["final", "failed"]);
export const WATCH_PAYLOADS = Object.freeze(["full", "summary", "none"]);
export const WATCH_REPLIES = Object.freeze(["chat", "internal"]);
// Worker finals that are reports rather than acknowledgements ("standing by").
export const WORKER_REPORT_MATCH = "^\\s*\\**(DONE|BLOCKED|FAILED)\\b";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CONTINUOUS_TTL_MS = 7 * DAY_MS;
const DEFAULT_ONCE_TTL_MS = 2 * DAY_MS;
const MAX_ACTIVE_PER_WATCHER = 50;

function clean(value) {
  return String(value ?? "").trim();
}

function httpError(message, statusCode, extra = {}) {
  return Object.assign(new Error(message), { statusCode, ...extra });
}

export function threadWatchesPath(env = process.env) {
  return env.ORKESTR_THREAD_WATCHES_FILE || path.join(appHome(env), "thread-watches.json");
}

export async function readThreadWatches(env = process.env) {
  const stored = await readJson(threadWatchesPath(env), { watches: [] });
  return Array.isArray(stored?.watches) ? stored.watches : [];
}

// Read-modify-write under the file lock; `mutate` returns the next list.
export async function mutateThreadWatches(mutate, env = process.env) {
  const file = threadWatchesPath(env);
  return withStorageFileLock(file, async () => {
    const watches = await readThreadWatches(env);
    const next = await mutate(watches.map((watch) => ({ ...watch })));
    await writeJson(file, { watches: next });
    return next;
  });
}

function listOption(value, allowed, fallback) {
  const raw = Array.isArray(value) ? value : clean(value).split(",");
  const picked = [...new Set(raw.map((entry) => clean(entry).toLowerCase()).filter(Boolean))];
  if (!picked.length) return fallback;
  if (picked.includes("any")) return [...allowed];
  const invalid = picked.filter((entry) => !allowed.includes(entry));
  if (invalid.length) throw httpError("thread_watch_invalid_trigger", 400, { detail: `Unknown trigger: ${invalid.join(", ")}. Use ${allowed.join(", ")} or any.` });
  return picked;
}

function enumOption(value, allowed, fallback, code) {
  const picked = clean(value).toLowerCase() || fallback;
  if (!allowed.includes(picked)) throw httpError(code, 400, { detail: `Use one of: ${allowed.join(", ")}.` });
  return picked;
}

function ttlMs(value, fallback) {
  const raw = clean(value).toLowerCase();
  if (!raw) return fallback;
  const match = /^(\d+(?:\.\d+)?)\s*(m|h|d)?$/u.exec(raw);
  if (!match) throw httpError("thread_watch_invalid_expiry", 400, { detail: "Use a duration such as 90m, 12h or 7d." });
  const unit = { m: 60_000, h: 3_600_000, d: DAY_MS }[match[2] || "h"];
  return Math.min(Number(match[1]) * unit, 90 * DAY_MS);
}

function matchOption(value) {
  const source = clean(value);
  if (!source) return "";
  try { new RegExp(source, "u"); } catch { throw httpError("thread_watch_invalid_match", 400, { detail: "match must be a valid regular expression." }); }
  return source.slice(0, 200);
}

export async function lastThreadMessageCursor(threadId, env = process.env) {
  const tail = await listThreadMessageCandidates(threadId, { tailLimit: 1 }, env).catch(() => []);
  return Math.max(0, ...tail.map((message) => Number(message?.cursor || 0) || 0));
}

export function normalizeThreadWatchInput(input = {}, now = new Date()) {
  const mode = enumOption(input.mode, WATCH_MODES, "once", "thread_watch_invalid_mode");
  const on = listOption(input.on, WATCH_TRIGGERS, ["final", "failed"]);
  const ttl = ttlMs(input.expires ?? input.expiresIn, mode === "once" ? DEFAULT_ONCE_TTL_MS : DEFAULT_CONTINUOUS_TTL_MS);
  return {
    mode,
    on,
    payload: enumOption(input.payload, WATCH_PAYLOADS, "full", "thread_watch_invalid_payload"),
    reply: enumOption(input.reply, WATCH_REPLIES, "chat", "thread_watch_invalid_reply"),
    wake: input.wake !== false && clean(input.wake).toLowerCase() !== "false",
    match: matchOption(input.match),
    expiresAt: new Date(now.getTime() + ttl).toISOString(),
  };
}

// Owner-scoped create. Both threads must belong to the same owner; admin read
// access to a foreign thread never authorizes forwarding its output.
export async function createThreadWatch(input = {}, env = process.env) {
  const { watcherThreadId, targetThreadId, principal = null, auto = "", ...options } = /** @type {Record<string, any>} */ (input);
  const load = (id) => (principal ? getThreadForPrincipal(id, principal, env) : getThread(id, env));
  const watcher = await load(clean(watcherThreadId));
  const target = await load(clean(targetThreadId));
  if (!watcher) throw httpError("thread_watch_watcher_not_found", 404);
  if (!target) throw httpError("thread_watch_target_not_found", 404);
  if (watcher.id === target.id) throw httpError("thread_watch_self", 400, { detail: "A thread cannot watch itself." });
  const ownerUserId = resourceOwnerUserId(watcher, env);
  if (resourceOwnerUserId(target, env) !== ownerUserId) throw httpError("thread_watch_owner_mismatch", 403);
  const now = new Date();
  const settings = normalizeThreadWatchInput(options, now);
  const cursor = await lastThreadMessageCursor(target.id, env);
  const watch = {
    id: `watch_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    watcherThreadId: watcher.id,
    targetThreadId: target.id,
    ...settings,
    ownerUserId,
    createdBy: clean(principal?.userId) || "system",
    auto: clean(auto) || null,
    status: "active",
    createdAt: now.toISOString(),
    cursor,
    fireCount: 0,
    firedMessageIds: [],
    lastFiredAt: null,
  };
  await mutateThreadWatches((watches) => {
    const active = watches.filter((entry) => entry.status === "active" && entry.watcherThreadId === watcher.id);
    if (active.length >= MAX_ACTIVE_PER_WATCHER) throw httpError("thread_watch_limit", 409, { detail: `At most ${MAX_ACTIVE_PER_WATCHER} active watches per thread.` });
    return [...watches, watch];
  }, env);
  await appendEvent({ type: "thread_watch_created", threadId: watcher.id, targetThreadId: target.id, watchId: watch.id, mode: watch.mode, on: watch.on, payload: watch.payload, auto: watch.auto }, env);
  return watch;
}

export async function listThreadWatches({ threadId = "", principal = null, includeClosed = false } = {}, env = process.env) {
  const id = clean(threadId);
  const owner = principal && !isAdminPrincipal(principal) ? clean(principal.userId) : "";
  return (await readThreadWatches(env)).filter((watch) =>
    (includeClosed || watch.status === "active") &&
    (!id || watch.watcherThreadId === id || watch.targetThreadId === id) &&
    (!owner || watch.ownerUserId === owner));
}

export async function cancelThreadWatch(watchId, { principal = null, reason = "cancelled" } = {}, env = process.env) {
  const id = clean(watchId);
  let found = null;
  await mutateThreadWatches((watches) => watches.map((watch) => {
    if (watch.id !== id) return watch;
    if (principal && !isAdminPrincipal(principal) && watch.ownerUserId !== clean(principal.userId)) {
      throw httpError("thread_watch_not_found", 404);
    }
    found = { ...watch, status: watch.status === "active" ? "cancelled" : watch.status, closedAt: watch.closedAt || new Date().toISOString(), closeReason: watch.closeReason || reason };
    return found;
  }), env);
  if (!found) throw httpError("thread_watch_not_found", 404);
  await appendEvent({ type: "thread_watch_cancelled", threadId: found.watcherThreadId, targetThreadId: found.targetThreadId, watchId: found.id, reason }, env);
  return found;
}

// Workers report to their parent automatically: continuous, only DONE /
// BLOCKED / FAILED finals plus failed turns, so acknowledgements stay quiet.
export async function ensureWorkerParentWatch(worker, env = process.env) {
  if (!worker?.id || !worker.parentThreadId || env.ORKESTR_WORKER_AUTO_WATCH === "0") return null;
  const existing = (await readThreadWatches(env)).find((watch) =>
    watch.status === "active" && watch.auto === "worker" && watch.targetThreadId === worker.id && watch.watcherThreadId === worker.parentThreadId);
  if (existing) return existing;
  return createThreadWatch({
    watcherThreadId: worker.parentThreadId,
    targetThreadId: worker.id,
    auto: "worker",
    mode: "continuous",
    on: ["final", "failed"],
    payload: "full",
    match: WORKER_REPORT_MATCH,
    expires: "30d",
  }, env);
}

// Server start: workers created before watches existed get their parent watch
// too. New watches start at the worker's current tail, so nothing old replays.
export async function ensureExistingWorkerWatches(env = process.env) {
  if (env.ORKESTR_WORKER_AUTO_WATCH === "0") return { created: 0 };
  const { listThreads, threadLifecycleState } = await import("./threads.js");
  const workers = (await listThreads(env)).filter((thread) =>
    thread.threadKind === "worker" && thread.parentThreadId && threadLifecycleState(thread) !== "retired");
  const before = (await readThreadWatches(env)).length;
  for (const worker of workers) {
    if (!(await getThread(worker.parentThreadId, env).catch(() => null))) continue;
    await ensureWorkerParentWatch(worker, env).catch(() => null);
  }
  return { created: (await readThreadWatches(env)).length - before };
}
