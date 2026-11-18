// Read paths behind list_incoming_whatsapp_messages. Both only read what an
// existing, already-authorized component keeps; neither writes anything.
//
// orkestr (scoped_relay_journal): the scoped relay's transport journal, the
//   record of every WhatsApp input the Orkestr number admitted in a bound group.
//   Opened read-only per call. Incoming = an admitted input from a listed
//   participant (it carries an author proof); the owner's own inputs have no
//   proof and the number's own messages start with "true_".
// german (coordinator_bridge): the owner's German account through the GET-only
//   coordinator routes of its bridge (chat list, chat history). Those routes
//   never mark anything seen; send/resolve/media routes are never built here.
//
// Readers return { t, key, message } records; `message` is already public
// (opaque chat/sender refs, masked numbers, no raw WhatsApp ids, no media).
import fs from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { boundedText, chatRef, maskedName, maskedNumber, messageKey, readSourceToken, senderRef, timePair } from "./whatsapp-incoming-sources.js";

const code = (value) => Object.assign(new Error(value), { readerCode: value });
const finiteTime = (value) => { const ms = Date.parse(String(value || "")); return Number.isFinite(ms) && ms > 0 ? ms : null; };
// Newest first; equal seconds ordered by reference so pages never overlap.
export const newestFirst = (left, right) => (right.t - left.t) || (left.key < right.key ? 1 : left.key > right.key ? -1 : 0);
export const olderThan = (record, position) => !position || record.t < position.t || (record.t === position.t && record.key < position.key);

// ---- orkestr: scoped relay transport journal ---------------------------------

const JOURNAL_SCAN_LIMIT = 5000;
const SKIP_NOTE = /\[WhatsApp attachment skipped: ([^\]\n]{0,120})\]/g;

function journalType(body, mimetype) {
  let type = /^image\//.test(String(mimetype || "")) ? "image" : null;
  let rest = String(body || "");
  for (const match of rest.matchAll(SKIP_NOTE)) {
    const named = /^unsupported media type ([a-z0-9_]{1,20})$/.exec(match[1].trim().toLowerCase());
    type ||= named ? named[1] : "media";
  }
  rest = rest.replace(SKIP_NOTE, "").trim();
  return { type: type || "text", body: rest };
}

// The relay keeps its WAL journal open, so its -shm file exists while it
// records. Without it nothing is being recorded, and opening the journal would
// create -wal/-shm files next to it: report that instead of touching it.
async function openJournal(filename) {
  const stat = await fs.lstat(filename).catch(() => null);
  if (!stat || !stat.isFile()) throw code("journal_missing");
  const shm = await fs.lstat(`${filename}-shm`).catch(() => null);
  if (!shm || !shm.isFile()) throw code("journal_not_recording");
  try {
    return new DatabaseSync(filename, { readOnly: true, timeout: 1000 });
  } catch { throw code("journal_unreadable"); }
}

// Journal health without content: when it last recorded any input and how far back it goes.
export async function journalStatus(source) {
  let db;
  try {
    db = await openJournal(source.journalPath);
    const row = db.prepare("SELECT min(created_at) AS oldest, max(created_at) AS newest FROM group_input").get();
    return { available: true, oldestMs: finiteTime(row?.oldest), newestMs: finiteTime(row?.newest) };
  } catch (error) {
    return { available: false, reason: error?.readerCode || "journal_unreadable" };
  } finally { try { db?.close(); } catch { /* closed */ } }
}

// `chats`: Map(raw group id -> { threadId, name, labels }) of chats bound to
// threads the grant observes now. Anything else in the journal is never read:
// the query selects only those groups, participant inputs, and the range
// [since, cursor second], so the scan bound counts only rows that can answer.
export async function readJournalIncoming(source, { account, chats, chatRaw = null, sinceMs, before = null }) {
  let db;
  let rows;
  const scope = chatRaw ? [chatRaw] : [...chats.keys()];
  if (!scope.length) return { records: [], coveredFromMs: null };
  try {
    db = await openJournal(source.journalPath);
    rows = db.prepare(`SELECT i.id AS id, i.chat_id AS chatId, i.body AS body, i.created_at AS createdAt, a.proof AS proof, m.mimetype AS mimetype
      FROM group_input i JOIN group_input_author a ON a.id = i.id LEFT JOIN group_input_media m ON m.id = i.id
      WHERE i.id LIKE 'false\\_%' ESCAPE '\\' AND i.chat_id IN (SELECT value FROM json_each(?)) AND i.created_at >= ? AND i.created_at <= ?
      ORDER BY i.created_at DESC LIMIT ?`)
      .all(JSON.stringify(scope), new Date(sinceMs).toISOString(), before ? new Date(before.t).toISOString() : "9999", JOURNAL_SCAN_LIMIT + 1);
  } catch (error) {
    throw code(error?.readerCode || "journal_unreadable");
  } finally { try { db?.close(); } catch { /* closed */ } }
  // Past the scan bound, older rows were not read: answer only after the
  // oldest row read, so pages have no gaps.
  const scanLimited = rows.length > JOURNAL_SCAN_LIMIT;
  const coveredFromMs = scanLimited ? finiteTime(rows[JOURNAL_SCAN_LIMIT - 1].createdAt) || Date.now() : null;
  const owners = new Set(source.ownerAuthorIds || []);
  const records = [];
  for (const row of rows.slice(0, JOURNAL_SCAN_LIMIT)) {
    const chat = chats.get(row.chatId);
    if (!chat || (chatRaw && row.chatId !== chatRaw)) continue;
    const t = finiteTime(row.createdAt);
    let proof = null;
    try { proof = JSON.parse(row.proof); } catch { proof = null; }
    // The admission evidence must name this very input, chat and thread.
    if (!t || (coveredFromMs && t <= coveredFromMs) || !proof || proof.inputId !== row.id || proof.chatId !== row.chatId || proof.threadId !== chat.threadId) continue;
    const authorId = typeof proof.authorId === "string" ? proof.authorId : "";
    const phoneId = typeof proof.phoneId === "string" ? proof.phoneId : "";
    if (!authorId && !phoneId) continue;
    if (owners.has(authorId) || owners.has(phoneId)) continue;
    const { type, body } = journalType(row.body, row.mimetype);
    const ref = chatRef(source.refKey, account, row.chatId);
    const id = messageKey(source.refKey, row.id);
    const key = `${ref}:${id}`;
    if (!olderThan({ t, key }, before)) continue;
    const labels = chat.labels || {};
    const name = [labels[authorId], labels[phoneId]].find((value) => typeof value === "string" && value.trim()) || null;
    records.push({ t, key, message: {
      id,
      account,
      chat: { id: ref, name: maskedName(chat.name), kind: "group", threadId: chat.threadId },
      sender: { name: maskedName(name), number: maskedNumber(phoneId) || maskedNumber(authorId), ref: senderRef(source.refKey, account, phoneId || authorId) },
      receivedAt: timePair(t),
      type,
      ...boundedText(body),
    } });
  }
  records.sort(newestFirst);
  return { records, coveredFromMs };
}

// ---- german: coordinator bridge (GET only) -----------------------------------

const READ_CHAT = /^[A-Za-z0-9._:-]{1,80}@(?:c\.us|g\.us|lid)$/;
const PROVIDER_ID = /^[A-Za-z0-9@._:-]{1,200}$/;
const RESPONSE_LIMIT = 8 * 1024 * 1024;
export const BRIDGE_PAGE = 50;
const CHAT_LIST_SIZE = 100;
const CHAT_LIST_TTL_MS = 60_000;
const BRIDGE_CODES = new Map([
  ["coordinator_not_ready", "bridge_not_ready"], ["coordinator_account_mismatch", "identity_mismatch"],
  ["coordinator_unauthorized", "bridge_unauthorized"], ["scoped_worker_invalid_cursor", "history_cursor_lost"],
  ["scoped_worker_history_window_exceeded", "history_window_exceeded"],
]);

// The only requests this module can make. No other path, method or body.
const routes = {
  health: () => "/coordinator/health",
  chats: () => `/coordinator/chats?limit=${CHAT_LIST_SIZE}`,
  history: (chatId, before) => {
    if (!READ_CHAT.test(chatId) || (before && !PROVIDER_ID.test(before))) throw code("bridge_request_invalid");
    return `/coordinator/chats/${encodeURIComponent(chatId)}/messages?limit=${BRIDGE_PAGE}${before ? `&before=${encodeURIComponent(before)}` : ""}`;
  },
};

async function bridgeGet(source, pathname, { fetchImpl = globalThis.fetch, timeoutMs }) {
  let token;
  try { token = await readSourceToken(source); } catch { throw code("credential_unavailable"); }
  let response;
  try {
    response = await fetchImpl(new URL(pathname, source.baseUrl), {
      method: "GET", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
    });
  } catch (error) {
    throw code(error?.name === "TimeoutError" || error?.name === "AbortError" ? "bridge_timeout" : "bridge_unreachable");
  }
  let payload = null;
  try {
    const raw = await response.text();
    if (raw.length > RESPONSE_LIMIT) throw new Error("size");
    payload = JSON.parse(raw);
  } catch { payload = null; }
  if (!response.ok || !payload || payload.ok !== true) throw code(BRIDGE_CODES.get(String(payload?.error || "")) || (response.status === 401 || response.status === 403 ? "bridge_unauthorized" : "bridge_error"));
  return payload;
}

export async function coordinatorStatus(source, options = {}) {
  try {
    const health = await bridgeGet(source, routes.health(), { ...options, timeoutMs: 3000 });
    if (health.markSeen !== false) return { available: false, reason: "bridge_marks_seen" };
    if (health.identityMatches !== true) return { available: false, reason: "identity_mismatch" };
    if (health.ready !== true) return { available: false, reason: "bridge_not_ready" };
    return { available: true };
  } catch (error) {
    return { available: false, reason: error?.readerCode || "bridge_error" };
  }
}

// Chats newest first, cached briefly: listing walks every chat of the account
// (seconds). Status broadcasts and channels are not conversations.
const chatLists = new Map();
export function clearCoordinatorChatCache() { chatLists.clear(); }

export async function coordinatorChats(source, { now = Date.now, ...options } = {}) {
  const cacheKey = `${source.ownerUserId}\0${source.baseUrl}`;
  const cached = chatLists.get(cacheKey);
  if (cached && now() - cached.startedAt < CHAT_LIST_TTL_MS) return cached.promise;
  const startedAt = now();
  const promise = bridgeGet(source, routes.chats(), { ...options, timeoutMs: 25_000 }).then((page) => {
    const chats = (Array.isArray(page.chats) ? page.chats : []).flatMap((chat) => {
      const raw = typeof chat?.chatId === "string" ? chat.chatId : "";
      if (!READ_CHAT.test(raw)) return [];
      return [{ raw, name: maskedName(chat.label), isGroup: chat.isGroup === true || raw.endsWith("@g.us"), lastMs: finiteTime(chat.lastMessageAt) || 0 }];
    });
    return { observedAtMs: startedAt, chats, listFull: page.hasMore === true };
  });
  chatLists.set(cacheKey, { startedAt, promise });
  promise.catch(() => { if (chatLists.get(cacheKey)?.promise === promise) chatLists.delete(cacheKey); });
  return promise;
}

const SYSTEM_TYPES = new Set(["gp2", "e2e_notification", "notification", "notification_template", "call_log", "protocol",
  "broadcast_notification", "debug", "unknown", "newsletter_notification", "pinned_message", "keep_in_chat", "reaction"]);
const TYPE_NAMES = new Map([["chat", "text"], ["ptt", "voice"], ["multi_vcard", "contacts"], ["vcard", "contact"],
  ["poll_creation", "poll"], ["revoked", "deleted"], ["ciphertext", "undecrypted"]]);
const CAPTIONED = new Set(["text", "image", "video", "document", "poll"]);
const BLOB = /^[A-Za-z0-9+/=\s]{200,}$/;

// The coordinator's serializer always sets fromMe to a boolean; anything else
// is not known to be incoming and is left out.
function germanRecord(message, chat, { account, assistants, refKey }) {
  if (!message || message.fromMe !== false) return null;
  const rawType = typeof message.type === "string" ? message.type.toLowerCase() : "";
  if (SYSTEM_TYPES.has(rawType)) return null;
  const author = typeof message.author === "string" ? message.author : chat.isGroup ? "" : chat.raw;
  if (author && assistants.has(author)) return null;
  const t = finiteTime(message.timestamp);
  if (!t || typeof message.id !== "string") return null;
  const type = TYPE_NAMES.get(rawType) || (/^[a-z_]{1,24}$/.test(rawType) ? rawType : "other");
  const body = CAPTIONED.has(type) && typeof message.body === "string" && !BLOB.test(message.body) ? message.body : "";
  const ref = chatRef(refKey, account, chat.raw);
  const id = messageKey(refKey, message.id);
  const key = `${ref}:${id}`;
  return { t, key, message: {
    id,
    account,
    chat: { id: ref, name: chat.name, kind: chat.isGroup ? "group" : "direct" },
    sender: { name: chat.isGroup ? null : chat.name, number: maskedNumber(author), ref: author ? senderRef(refKey, account, author) : null },
    receivedAt: timePair(t),
    type,
    ...boundedText(body),
  } };
}

// Incoming messages of one chat in [since, before), newest first. Walks back
// page by page over the same window on every call (to `since`, the start of
// the chat, or `maxPages`), so the window and its coverage do not move between
// the pages of one listing. `coveredFromMs` is null when the whole range was
// read, else the oldest message time that was read.
export async function coordinatorChatIncoming(source, chat, { account, sinceMs, before = null, maxPages, deadline, ...options }) {
  const assistants = new Set(source.assistantAuthorIds || []);
  const records = [];
  let beforeId = "";
  let oldestMs = Infinity;
  for (let pages = 0; ; ) {
    const remaining = deadline - Date.now();
    if (remaining < 250) throw code("bridge_timeout");
    const page = await bridgeGet(source, routes.history(chat.raw, beforeId), { ...options, timeoutMs: Math.min(10_000, remaining) });
    pages += 1;
    const messages = Array.isArray(page.messages) ? page.messages : [];
    for (const message of messages) {
      const t = finiteTime(message?.timestamp);
      if (t) oldestMs = Math.min(oldestMs, t);
      const record = germanRecord(message, chat, { account, assistants, refKey: source.refKey });
      if (record && record.t >= sinceMs && olderThan(record, before)) records.push(record);
    }
    const exhausted = page.hasMore !== true || typeof page.nextCursor !== "string" || !page.nextCursor || !messages.length;
    if (exhausted || oldestMs < sinceMs) return { records: records.sort(newestFirst), coveredFromMs: null };
    if (pages >= maxPages) return { records: records.sort(newestFirst), coveredFromMs: oldestMs };
    beforeId = page.nextCursor;
  }
}
