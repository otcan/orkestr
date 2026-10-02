// Delivers thread-watch events. Scans each watched thread's messages after the
// watch cursor, so it works for every runtime and survives restarts: a final or
// failure that happened while the server was down is delivered afterwards.
// The input clientMessageId (watch id + message id) makes delivery idempotent.
import { appendEvent } from "../../storage/src/store.js";
import { appendThreadMessage, enqueueThreadInput, getThread, getThreadMessage, listThreadMessageCandidates, threadLifecycleState } from "./threads.js";
import { mutateThreadWatches, readThreadWatches } from "./thread-watches.js";

const FULL_TEXT_LIMIT = 12_000;
const SUMMARY_LIMIT = 600;
const FIRED_ID_MEMORY = 50;
const PENDING_HOLD_MS = 6 * 60 * 60 * 1000;
const MAX_FIRES_PER_HOUR = 20;
export const THREAD_WATCH_SOURCE = "thread_watch";

function clean(value) {
  return String(value ?? "").trim();
}

function time(value) {
  const parsed = Date.parse(clean(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function threadWatchPumpIntervalMs(env = process.env) {
  const value = Number(env.ORKESTR_THREAD_WATCH_INTERVAL_MS || 15_000);
  return Number.isFinite(value) && value >= 1000 ? value : 15_000;
}

const pendingUserStates = new Set(["queued", "running", "awaiting_ack", "delivering", "claimed"]);

// "final" | "failed" | "pending" (may still become one) | null.
export function classifyWatchedMessage(message = {}) {
  const role = clean(message.role);
  const state = clean(message.state);
  const phase = clean(message.phase);
  if (role === "assistant" && phase === "runtime_interrupted") return "failed";
  if (role === "assistant" && phase === "final_answer") {
    if (state !== "completed") return state === "failed" ? "failed" : "pending";
    const text = clean(message.text);
    return !text || text === "NO_REPLY" ? null : "final";
  }
  if (role === "user") {
    if (state === "failed") return "failed";
    if (pendingUserStates.has(state)) return "pending";
  }
  return null;
}

function threadLabel(thread, fallback) {
  return clean(thread?.bindingName || thread?.name) || fallback;
}

function attachmentLines(message = {}) {
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  return attachments.map((entry) => {
    const name = clean(entry?.name || entry?.filename || entry?.fileName);
    const where = clean(entry?.path || entry?.url);
    return name && where && !where.endsWith(name) ? `- ${name}: ${where}` : `- ${where || name}`;
  }).filter((line) => line !== "- ");
}

export function threadWatchInputText({ watch, target, message, event }) {
  const label = threadLabel(target, watch.targetThreadId);
  const error = clean(message.error || message.lastError);
  const text = event === "failed"
    ? [error && `Error: ${error}`, clean(message.text) && `${message.role === "user" ? "Input" : "Text"}: ${clean(message.text)}`].filter(Boolean).join("\n")
    : clean(message.text);
  const header = `[Orkestr watch ${watch.id}: ${label} ${event === "final" ? "final answer" : "turn failed"}]`;
  const lines = [header, `Thread: ${watch.targetThreadId}`, `Message: ${message.id}`];
  if (event === "failed") lines.push(`State: ${clean(message.state) || "failed"}${message.phase ? ` (${message.phase})` : ""}`);
  if (watch.payload === "none") {
    lines.push(`Length: ${text.length} chars`, "", `Read it with: orkestr watch read ${watch.targetThreadId} --message ${message.id}`);
  } else if (watch.payload === "summary" && text.length > SUMMARY_LIMIT) {
    lines.push("", `${text.slice(0, SUMMARY_LIMIT)}…`, "", `(${text.length} chars; full text: orkestr watch read ${watch.targetThreadId} --message ${message.id})`);
  } else {
    lines.push("", text.length > FULL_TEXT_LIMIT ? `${text.slice(0, FULL_TEXT_LIMIT)}…\n(truncated; full text: orkestr watch read ${watch.targetThreadId} --message ${message.id})` : text || "(no text)");
    const files = attachmentLines(message);
    if (files.length) lines.push("", "Attachments:", ...files);
  }
  if (watch.mode === "continuous") lines.push("", `(continuous watch; stop it with: orkestr watch cancel ${watch.id})`);
  return lines.join("\n");
}

// The watcher's reply goes where a timer's reply goes: its bound chat, unless
// the watch asked for internal handling.
function replyDefaults(thread, watch, input) {
  const binding = thread?.binding || {};
  const chatId = clean(binding.chatId);
  if (watch.reply !== "chat" || !chatId || clean(binding.connector || "whatsapp").toLowerCase() !== "whatsapp") {
    return { ...input, visibility: "internal" };
  }
  return {
    ...input,
    connector: "whatsapp",
    originSurface: THREAD_WATCH_SOURCE,
    originTransport: THREAD_WATCH_SOURCE,
    chatId,
    accountId: clean(binding.responderAccountId || binding.outboundAccountId || binding.senderAccountId || binding.inboundAccountId),
  };
}

// Loop guard: skip a target turn that the watcher itself started through a
// watch delivery (A watches B and B watches A must not ping-pong).
async function startedByWatcherWatch(watch, message, env) {
  const parentId = clean(message.parentMessageId);
  if (!parentId) return false;
  const parent = await getThreadMessage(watch.targetThreadId, parentId, env).catch(() => null);
  return clean(parent?.source) === THREAD_WATCH_SOURCE && clean(parent?.threadWatchSourceThreadId) === watch.watcherThreadId;
}

async function deliver(watch, message, event, env) {
  const [watcher, target] = await Promise.all([getThread(watch.watcherThreadId, env), getThread(watch.targetThreadId, env)]);
  if (!watcher) return { closed: "watcher_deleted" };
  const text = threadWatchInputText({ watch, target, message, event });
  const marker = {
    source: THREAD_WATCH_SOURCE,
    text,
    ownerUserId: watch.ownerUserId,
    clientMessageId: `thread-watch:${watch.id}:${message.id}`,
    threadWatchId: watch.id,
    threadWatchSourceThreadId: watch.targetThreadId,
    threadWatchSourceMessageId: message.id,
    threadWatchEvent: event,
  };
  if (!watch.wake) {
    const note = await appendThreadMessage(watcher.id, { ...marker, role: "assistant", phase: "notification", state: "completed", visibility: "internal", dedupeAssistantByIdempotencyKey: true }, env);
    return { messageId: note?.id };
  }
  const input = await enqueueThreadInput(watcher.id, replyDefaults(watcher, watch, { ...marker, codexDeliveryMode: "passive", steerActiveTurn: false }), env);
  const { requestThreadInputDelivery } = await import("./runtime-leases.js");
  requestThreadInputDelivery(watcher.id, env);
  return { messageId: input?.id };
}

function recentFires(watch, now) {
  return (watch.fireTimes || []).filter((stamp) => now - time(stamp) < 3_600_000);
}

// Scans one watch. Returns the patch to persist (or null when unchanged).
export async function processThreadWatch(watch, env = process.env, now = Date.now()) {
  if (time(watch.expiresAt) && time(watch.expiresAt) <= now) return { status: "expired", closedAt: new Date(now).toISOString(), closeReason: "expired" };
  const target = await getThread(watch.targetThreadId, env).catch(() => null);
  if (!target) return { status: "closed", closedAt: new Date(now).toISOString(), closeReason: "target_deleted" };
  if (threadLifecycleState(target) === "retired") return { status: "closed", closedAt: new Date(now).toISOString(), closeReason: "target_retired" };
  const messages = await listThreadMessageCandidates(target.id, { afterCursor: Number(watch.cursor || 0) }, env);
  const createdAt = time(watch.createdAt);
  const fired = new Set(watch.firedMessageIds || []);
  let cursor = Number(watch.cursor || 0);
  let holding = false;
  const patch = { firedMessageIds: [...fired], fireTimes: recentFires(watch, now), fireCount: Number(watch.fireCount || 0) };
  const pattern = watch.match ? new RegExp(watch.match, "u") : null;
  for (const message of messages) {
    const messageCursor = Number(message?.cursor || 0);
    const event = time(message.createdAt) >= createdAt ? classifyWatchedMessage(message) : null;
    if (event === "pending" && now - time(message.createdAt) < PENDING_HOLD_MS) holding = true;
    const wanted = (event === "final" || event === "failed") && watch.on.includes(event) && !fired.has(message.id);
    const matches = event !== "final" || !pattern || pattern.test(clean(message.text));
    if (wanted && matches && !(await startedByWatcherWatch(watch, message, env))) {
      if (patch.fireTimes.length >= MAX_FIRES_PER_HOUR) {
        await appendEvent({ type: "thread_watch_rate_limited", threadId: watch.watcherThreadId, watchId: watch.id, messageId: message.id }, env);
        break;
      }
      const result = await deliver(watch, message, event, env);
      if (result.closed) return { ...patch, status: "closed", closedAt: new Date(now).toISOString(), closeReason: result.closed };
      fired.add(message.id);
      patch.firedMessageIds = [...fired].slice(-FIRED_ID_MEMORY);
      patch.fireTimes.push(new Date(now).toISOString());
      patch.fireCount += 1;
      patch.lastFiredAt = new Date(now).toISOString();
      await appendEvent({ type: "thread_watch_fired", threadId: watch.watcherThreadId, targetThreadId: watch.targetThreadId, watchId: watch.id, messageId: message.id, event, deliveredMessageId: result.messageId || null }, env);
      if (watch.mode === "once") return { ...patch, cursor: Math.max(cursor, messageCursor), status: "fired", closedAt: new Date(now).toISOString(), closeReason: "fired_once" };
    }
    if (!holding) cursor = Math.max(cursor, messageCursor);
  }
  patch.cursor = cursor;
  const changed = cursor !== Number(watch.cursor || 0) || patch.fireCount !== Number(watch.fireCount || 0) || patch.fireTimes.length !== (watch.fireTimes || []).length;
  return changed ? patch : null;
}

let running = null;

export function runThreadWatchPump(env = process.env) {
  if (running) return running;
  running = (async () => {
    const active = (await readThreadWatches(env)).filter((watch) => watch.status === "active");
    if (!active.length) return { scanned: 0, updated: 0 };
    const patches = new Map();
    for (const watch of active) {
      try {
        const patch = await processThreadWatch(watch, env);
        if (patch) patches.set(watch.id, patch);
      } catch (error) {
        await appendEvent({ type: "thread_watch_failed", threadId: watch.watcherThreadId, watchId: watch.id, error: clean(error?.message || error) }, env).catch(() => {});
      }
    }
    if (patches.size) {
      await mutateThreadWatches((watches) => watches.map((watch) => (
        patches.has(watch.id) && watch.status === "active" ? { ...watch, ...patches.get(watch.id) } : watch
      )), env);
    }
    return { scanned: active.length, updated: patches.size };
  })().finally(() => { running = null; });
  return running;
}
