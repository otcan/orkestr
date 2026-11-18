// Recent incoming WhatsApp messages for a connected assistant (MCP tool
// list_incoming_whatsapp_messages). Read-only: it sends, reacts, marks read,
// links or logs in nothing, and creates no credential.
//
// Access needs threads:read, a grant that observes all of the owner's threads,
// and the grant's own consent for the selected account (`whatsappRead`, a list
// of account names, set on the consent screen or by the operator after the
// owner's approval). The operator enrolls which read path backs each account
// (whatsapp-incoming-sources.js); an account that is not enrolled is reported
// as not connected, never as empty. The grant and thread ownership are checked
// again after the read.
import { authorization, observableBridgeThreads } from "./thread-bridge.js";
import { WHATSAPP_INCOMING_ACCOUNTS, WHATSAPP_INCOMING_FORMAT, WHATSAPP_REPORT_ZONE, chatRef, loadWhatsAppSources } from "./whatsapp-incoming-sources.js";
import { coordinatorChatIncoming, coordinatorChats, coordinatorStatus, journalStatus, newestFirst, readJournalIncoming } from "./whatsapp-incoming-readers.js";

export const WHATSAPP_DEFAULT_LIMIT = 20;
export const WHATSAPP_MAX_LIMIT = 50;
const DEFAULT_SINCE_MS = 7 * 24 * 60 * 60 * 1000;
const STALE_MS = 24 * 60 * 60 * 1000;
const SCAN_CHATS = 25;
const SCAN_PAGES_PER_CHAT = 3;
const CHAT_PAGES = 10;
const SCAN_CONCURRENCY = 4;
const READ_DEADLINE_MS = 30_000;

const fail = (code, statusCode = 403) => { throw Object.assign(new Error(code), { statusCode }); };
const iso = (ms) => Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;

export function grantedWhatsAppAccounts(grant) {
  const value = grant?.whatsappRead;
  return Array.isArray(value) ? WHATSAPP_INCOMING_ACCOUNTS.filter((account) => value.includes(account)) : [];
}

// What the consent screen lists for a new connection: the accounts enrolled
// for this owner. Approving grants exactly these.
export async function whatsappConsentAccounts(ownerUserId, env = process.env) {
  const { accounts } = await loadWhatsAppSources(ownerUserId, env).catch(() => ({ accounts: new Map() }));
  return [...accounts.values()].map((source) => ({ account: source.account, label: source.label }));
}

async function whatsappGrant(principal, account, env) {
  const grant = await authorization(principal, env);
  if (grant.observe !== "all" || !grantedWhatsAppAccounts(grant).includes(account)) fail("bridge_whatsapp_not_granted");
  return grant;
}

// Groups bound to threads this grant observes now: raw group id -> thread.
// A chat bound to two threads belongs to neither.
async function boundGroupChats(grant, env) {
  const chats = new Map();
  const seen = new Map();
  for (const thread of await observableBridgeThreads(grant, env)) {
    const binding = thread?.binding;
    if (!binding || typeof binding !== "object" || String(binding.connector || "whatsapp").trim().toLowerCase() !== "whatsapp") continue;
    const chatId = typeof binding.chatId === "string" ? binding.chatId.trim() : "";
    if (!/^\d+(?:-\d+)?@g\.us$/.test(chatId)) continue;
    seen.set(chatId, (seen.get(chatId) || 0) + 1);
    const rawLabels = binding.additionalParticipantLabels;
    const labels = rawLabels && typeof rawLabels === "object" && !Array.isArray(rawLabels)
      ? Object.fromEntries(Object.entries(rawLabels).filter(([, value]) => typeof value === "string")) : {};
    const name = String(binding.displayName || thread.bindingName || thread.name || "").trim().slice(0, 80) || null;
    chats.set(chatId, { threadId: thread.id, name, labels });
  }
  for (const [chatId, count] of seen) if (count > 1) chats.delete(chatId);
  return chats;
}

// ---- input --------------------------------------------------------------------

const SINCE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
function parseSince(value, now) {
  if (value === undefined || value === null || value === "") return null;
  const ms = SINCE.test(String(value)) ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms) || ms > now + 60_000) fail("whatsapp_since_invalid", 400);
  return ms;
}

const CURSOR_KEY = /^wa-[0-9a-f]{20}:(?:[A-Za-z0-9]{6,64}|h[0-9a-f]{24})$/;
function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

// The cursor is a position (time, message reference) in one listing: same
// account, chat and since, plus the time the listing was complete after (w).
// It carries no raw id, so it grants nothing.
function decodeCursor(cursor, { account, chat, sinceMs }) {
  if (!cursor) return null;
  let value;
  try {
    if (!/^[A-Za-z0-9_-]{1,1024}$/.test(cursor)) throw new Error("shape");
    value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch { fail("whatsapp_cursor_invalid", 400); }
  if (!value || value.v !== 1 || !WHATSAPP_INCOMING_ACCOUNTS.includes(value.a) || !Number.isSafeInteger(value.t) || value.t <= 0
      || typeof value.k !== "string" || !CURSOR_KEY.test(value.k) || !Number.isSafeInteger(value.s) || value.s < 0
      || !Number.isSafeInteger(value.w) || value.w < value.s - 1
      || !(value.c === null || typeof value.c === "string" && /^wa-[0-9a-f]{20}$/.test(value.c))) fail("whatsapp_cursor_invalid", 400);
  if (value.a !== account || value.c !== (chat || null) || (sinceMs !== null && sinceMs !== value.s)) fail("whatsapp_cursor_mismatch", 400);
  return { t: value.t, key: value.k, sinceMs: value.s, windowMs: value.w };
}

// `windowMs`: the answer holds every incoming message after it.
function page(records, { limit, account, chat, sinceMs, windowMs }) {
  const selected = records.slice(0, limit);
  const hasMore = records.length > limit;
  const last = selected.at(-1);
  return {
    messages: selected.map((record) => record.message),
    hasMore,
    nextCursor: hasMore && last ? encodeCursor({ v: 1, a: account, c: chat || null, s: sinceMs, w: windowMs, t: last.t, k: last.key }) : null,
  };
}

// ---- accounts -----------------------------------------------------------------

const LIMITS = {
  orkestr: [
    "Messages the Orkestr number admitted in WhatsApp groups bound to your threads, from the participants you listed for each group. Your own messages and the Orkestr number's replies are not incoming and are left out.",
    "Messages from unlisted group members are dropped by the relay before anything is recorded and cannot be read here; 1:1 chats with the Orkestr number are not recorded.",
    "The record starts at recordsSince and nothing is deleted from it. Times are WhatsApp's message times (1 s precision).",
    "Media is reported by type only: nothing is downloaded and no media link is given.",
  ],
  german: [
    "Live, read-only reading of your German WhatsApp account through its bridge: it never sends, reacts or marks anything read.",
    `Without chat: the newest ${SCAN_PAGES_PER_CHAT * 50} messages of each of the ${SCAN_CHATS} most recently active chats; the answer is complete only after coverage.completeAfter. With chat: the newest ${CHAT_PAGES * 50} messages of that chat, which must be among the 100 most recently active chats.`,
    "Group senders are given as masked number and reference only (the bridge returns no group sender names); a direct chat's sender is named after the chat.",
    "Your own messages, Orkestr assistant replies and system notices (group changes, calls, encryption notices) are left out. Media is reported by type only.",
    "Every page reads the window again. If new messages moved it past the listing's start, the next page answers whatsapp_cursor_expired: start again without cursor.",
  ],
};

async function accountStatus(account, source, now, options) {
  if (!source) return { account, state: "not_connected", reason: "not_enrolled" };
  const base = { account, label: source.label };
  if (source.kind === "scoped_relay_journal") {
    const status = await journalStatus(source);
    if (!status.available) return { ...base, state: "unavailable", reason: status.reason, source: "orkestr_relay_journal" };
    const age = status.newestMs ? Math.max(0, now - status.newestMs) : null;
    return { ...base, state: "available", source: "orkestr_relay_journal", recordsSince: iso(status.oldestMs), lastRecordedAt: iso(status.newestMs),
      lastRecordedAgeSeconds: age === null ? null : Math.round(age / 1000), staleAfterSeconds: STALE_MS / 1000, stale: age === null || age > STALE_MS };
  }
  const status = await coordinatorStatus(source, options);
  return { ...base, state: status.available ? "available" : "unavailable", ...(status.available ? {} : { reason: status.reason }),
    source: "german_bridge_live", ownerApprovedAt: iso(Date.parse(source.ownerApprovedAt)) };
}

async function mapLimited(items, size, run) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]);
    }
  }));
  return results;
}

async function readOrkestr(source, grant, { account, chat, sinceMs, before }, env) {
  const chats = await boundGroupChats(grant, env);
  let chatRaw = null;
  if (chat) {
    chatRaw = [...chats.keys()].find((raw) => chatRef(source.refKey, account, raw) === chat) || null;
    if (!chatRaw) fail("whatsapp_chat_not_found", 404);
  }
  const { records, coveredFromMs } = await readJournalIncoming(source, { account, chats, chatRaw, sinceMs, before });
  return { records, windowMs: coveredFromMs || sinceMs - 1,
    coverage: { source: "orkestr_relay_journal", complete: !coveredFromMs, completeAfter: iso(coveredFromMs || sinceMs), groupsInScope: chat ? 1 : chats.size } };
}

async function readGerman(source, { account, chat, sinceMs, before }, options) {
  const list = await coordinatorChats(source, options);
  let scan;
  let unscanned = [];
  if (chat) {
    const found = list.chats.find((entry) => chatRef(source.refKey, account, entry.raw) === chat);
    if (!found) fail("whatsapp_chat_not_found", 404);
    scan = [found];
  } else {
    // A chat without a last-activity time may hold anything: read it like an active one.
    const active = list.chats.filter((entry) => !entry.lastMs || entry.lastMs >= sinceMs)
      .sort((left, right) => (right.lastMs || Infinity) - (left.lastMs || Infinity));
    scan = active.slice(0, SCAN_CHATS);
    unscanned = active.slice(SCAN_CHATS);
  }
  const deadline = Date.now() + READ_DEADLINE_MS;
  const results = await mapLimited(scan, SCAN_CONCURRENCY, (entry) => coordinatorChatIncoming(source, entry, {
    ...options, account, sinceMs, before, maxPages: chat ? CHAT_PAGES : SCAN_PAGES_PER_CHAT, deadline,
  }).catch((error) => ({ failed: error?.readerCode || "bridge_error" })));
  // Older messages of a chat not (fully) read may be missing: answer only
  // after the newest such point, so the pages have no gaps.
  const listCut = !chat && list.listFull && list.chats.length > 0 && list.chats.at(-1).lastMs >= sinceMs;
  const holes = [sinceMs - 1];
  if (unscanned.length) holes.push(unscanned[0].lastMs || Date.now());
  if (listCut) holes.push(list.chats.at(-1).lastMs);
  const truncatedChats = [];
  const failedChats = [];
  results.forEach((result, index) => {
    const entry = scan[index];
    const ref = { id: chatRef(source.refKey, account, entry.raw), name: entry.name };
    if (result.failed) {
      failedChats.push({ chat: ref, reason: result.failed });
      holes.push(entry.lastMs || Date.now());
    } else if (result.coveredFromMs) {
      truncatedChats.push({ chat: ref, coveredFrom: iso(result.coveredFromMs) });
      holes.push(result.coveredFromMs);
    }
  });
  const cutoff = Math.max(...holes);
  const seen = new Set();
  const records = results.flatMap((result) => result.records || [])
    .filter((record) => record.t > cutoff && !seen.has(record.key) && seen.add(record.key))
    .sort(newestFirst);
  const complete = cutoff < sinceMs;
  return { records, windowMs: cutoff, coverage: {
    source: "german_bridge_live",
    chatListObservedAt: iso(list.observedAtMs),
    complete,
    completeAfter: iso(complete ? sinceMs : cutoff),
    chatsScanned: scan.length - failedChats.length,
    activeChatsNotScanned: unscanned.length + (listCut ? 1 : 0),
    moreActiveChatsBeyondList: listCut,
    truncatedChats,
    failedChats,
  } };
}

export async function bridgeWhatsAppIncoming(principal, input = {}, env = process.env, options = {}) {
  const { now = Date.now, ...readerOptions } = options;
  const account = input.account;
  if (!WHATSAPP_INCOMING_ACCOUNTS.includes(account)) fail("invalid_arguments", 400);
  const grant = await whatsappGrant(principal, account, env);
  const limit = input.limit ?? WHATSAPP_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > WHATSAPP_MAX_LIMIT) fail("bridge_limit_invalid", 400);
  const chat = input.chat || null;
  if (chat && !/^wa-[0-9a-f]{20}$/.test(chat)) fail("whatsapp_chat_not_found", 404);
  const requestedSince = parseSince(input.since, now());
  const cursor = decodeCursor(input.cursor || "", { account, chat, sinceMs: requestedSince });
  const sinceMs = cursor ? cursor.sinceMs : requestedSince ?? now() - DEFAULT_SINCE_MS;
  const before = cursor ? { t: cursor.t, key: cursor.key } : null;

  const { accounts: sources } = await loadWhatsAppSources(grant.ownerUserId, env);
  const statuses = await Promise.all(grantedWhatsAppAccounts(grant).map((name) => accountStatus(name, sources.get(name), now(), readerOptions)));
  const selected = statuses.find((status) => status.account === account);
  let read = null;
  let reason = selected.state === "available" ? null : selected.reason || "unavailable";
  if (!reason) {
    try {
      read = account === "orkestr"
        ? await readOrkestr(sources.get(account), grant, { account, chat, sinceMs, before }, env)
        : await readGerman(sources.get(account), { account, chat, sinceMs, before }, readerOptions);
    } catch (error) {
      if (!error?.readerCode) throw error;
      reason = error.readerCode;
    }
  }

  // Every page re-reads its window. If it now ends later than when the listing
  // started (new messages pushed a busy chat's window, the active chats
  // changed), older messages of this listing can no longer be reached: say so
  // instead of ending the listing early.
  if (read && cursor && read.windowMs > cursor.windowMs) fail("whatsapp_cursor_expired", 409);

  // The reads take time: a grant revoked or narrowed meanwhile gets nothing,
  // and a thread that left the grant takes its group's messages with it.
  const current = await whatsappGrant(principal, account, env);
  let records = read?.records || [];
  if (account === "orkestr" && records.length) {
    const threads = new Set([...(await boundGroupChats(current, env)).values()].map((entry) => entry.threadId));
    records = records.filter((record) => threads.has(record.message.chat.threadId));
  }
  const paged = page(records, { limit, account, chat, sinceMs, windowMs: read?.windowMs ?? sinceMs - 1 });
  return {
    format: WHATSAPP_INCOMING_FORMAT,
    account,
    available: Boolean(read),
    ...(read ? {} : { reason }),
    observedAt: new Date(now()).toISOString(),
    since: new Date(sinceMs).toISOString(),
    timezone: WHATSAPP_REPORT_ZONE,
    chat,
    ...paged,
    coverage: read?.coverage || null,
    accounts: statuses,
    limits: LIMITS[account],
  };
}
