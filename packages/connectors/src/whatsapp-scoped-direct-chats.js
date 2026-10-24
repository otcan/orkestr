// Owner-approved direct (1:1) chats for a scoped recovery worker.
//
// The scoped worker normally reaches only each thread's bound group. An
// operator may add `directChats` to the worker config to let named threads read
// and send text to an explicit list of individual chats:
//
//   "directChats": {
//     "journalPath": "/var/lib/.../direct.sqlite",
//     "routes": [{ "threadId": "<scoped thread>", "chatIds": ["905550000000@c.us"] }]
//   }
//
// Direct sends never touch the group journal, so an uncertain direct send can
// never block group replies. Each request id is sent at most once; an uncertain
// send blocks further sends to that one chat until an operator resolves it.
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

const DIRECT_CHAT = /^\d{6,20}@c\.us$/;
const REQUEST_ID = /^[a-zA-Z0-9:._-]{1,200}$/;
const MAX_CHATS_PER_ROUTE = 500;
const SEND_TIMEOUT_MS = 30_000;

function fail(code) {
  throw Object.assign(new Error(`scoped_worker_${code}`), {statusCode: 403});
}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

// Returns null when the config grants no direct chats (the default).
export function validateScopedDirectChats(config = {}, threads = new Set()) {
  const direct = config.directChats;
  if (direct === undefined) return null;
  if (!direct || typeof direct !== 'object' || Array.isArray(direct)
      || typeof direct.journalPath !== 'string' || !direct.journalPath
      || !Array.isArray(direct.routes) || !direct.routes.length
      || Object.keys(direct).some(key => !['journalPath', 'routes'].includes(key)))
    fail('direct_configuration_invalid');
  const chats = new Map();
  for (const route of direct.routes) {
    if (!route || typeof route !== 'object' || typeof route.threadId !== 'string' || !threads.has(route.threadId)
        || !Array.isArray(route.chatIds) || !route.chatIds.length || route.chatIds.length > MAX_CHATS_PER_ROUTE
        || (route.readAll !== undefined && route.readAll !== true)
        || Object.keys(route).some(key => !['threadId', 'chatIds', 'readAll'].includes(key)))
      fail('direct_configuration_invalid');
    for (const chatId of route.chatIds) {
      if (typeof chatId !== 'string' || !DIRECT_CHAT.test(chatId) || chats.has(chatId)) fail('direct_configuration_invalid');
      chats.set(chatId, route.threadId);
    }
  }
  // Owner-authorized read-all threads: read every chat (metadata list + history), never send beyond chatIds.
  const readAll = new Set(direct.routes.filter(route => route.readAll === true).map(route => route.threadId));
  // Read-all is an owner authorization for one thread; a second one is a configuration error.
  if (readAll.size > 1) fail('direct_configuration_invalid');
  return {chats, readAll, journalPath: direct.journalPath, contract: hash([config.ownChatId || '', direct.routes])};
}

// The fingerprint an operator migration compares before and after editing
// directChats (same role as the group contract in group_meta).
export function scopedDirectChatsContract(config = {}) {
  return hash([config.ownChatId || '', config.directChats?.routes || []]);
}

export function createScopedDirectSender({config, direct, dbPath = direct.journalPath, now = Date.now, timeoutMs = SEND_TIMEOUT_MS, lookupDelayMs = 1000}) {
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS direct_send(id TEXT PRIMARY KEY,hash TEXT NOT NULL,chat_id TEXT NOT NULL,state TEXT NOT NULL,provider_id TEXT,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS direct_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  const prior = db.prepare('SELECT value FROM direct_meta WHERE key=?').get('contract');
  if (prior && prior.value !== direct.contract) {
    db.close();
    fail('direct_configuration_changed');
  }
  db.prepare('INSERT OR IGNORE INTO direct_meta VALUES(?,?)').run('contract', direct.contract);
  // A send interrupted by a crash may or may not have reached WhatsApp.
  db.prepare("UPDATE direct_send SET state='uncertain' WHERE state='sending'").run();
  let tail = Promise.resolve();
  const serial = work => {
    const next = tail.catch(() => {}).then(work);
    tail = next;
    return next;
  };
  // Same rule as the group transport: WhatsApp Web can deliver a message yet
  // return no usable model. Accept exactly one matching own message created
  // after the send started, not yet journaled, with a server ack.
  async function confirmByLookup(client, to, text, startedAt) {
    if (typeof client?.getChatById !== 'function') return null;
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, lookupDelayMs));
      try {
        const chat = await client.getChatById(to);
        const found = (await chat.fetchMessages({limit: 20})).filter(message => {
          const id = message?.id?._serialized;
          return message?.fromMe === true && typeof id === 'string' && id && !id.startsWith('summary:')
            && message.type === 'chat' && message.body === text && Number(message.timestamp) * 1000 >= startedAt - 5000
            && !db.prepare('SELECT 1 FROM direct_send WHERE provider_id=?').get(id);
        });
        if (found.length > 1) return null;
        if (found.length === 1 && Number(found[0].ack) >= 1) return found[0].id._serialized;
      } catch { /* a failed lookup proves nothing; retry, then stay uncertain */ }
    }
    return null;
  }
  const settle = (requestId, id) => {
    db.prepare("UPDATE direct_send SET state='sent',provider_id=? WHERE id=?").run(id, requestId);
    return {ok: true, ids: [id]};
  };
  return {
    close: () => db.close(),
    sendText(client, to, text, request = {}) {
      return serial(async () => {
        if (client?.info?.wid?._serialized !== config.ownChatId) fail('account_mismatch');
        if (!direct.chats.has(to) || typeof text !== 'string' || !text.trim() || text.length > 3000
            || !REQUEST_ID.test(request.requestId || ''))
          fail('direct_scope_denied');
        const material = hash([to, text]);
        const previous = db.prepare('SELECT * FROM direct_send WHERE id=?').get(request.requestId);
        if (previous) {
          if (previous.hash !== material) fail('request_conflict');
          if (previous.state === 'sent') return {ok: true, ids: [previous.provider_id], duplicate: true};
          fail('delivery_uncertain');
        }
        if (db.prepare("SELECT 1 FROM direct_send WHERE chat_id=? AND state='uncertain' LIMIT 1").get(to)) fail('delivery_uncertain');
        db.prepare('INSERT INTO direct_send VALUES(?,?,?,?,?,?)')
          .run(request.requestId, material, to, 'sending', null, new Date(now()).toISOString());
        let timer;
        const startedAt = now();
        let sent = null;
        try {
          sent = await Promise.race([
            client.sendMessage(to, text, {sendSeen: false}),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('send_timeout')), timeoutMs); }),
          ]);
        } catch { sent = null; } finally { clearTimeout(timer); }
        const id = sent?.id?._serialized;
        if (typeof id === 'string' && id && !id.startsWith('summary:')) return settle(request.requestId, id);
        const confirmed = await confirmByLookup(client, to, text, startedAt);
        if (confirmed) return settle(request.requestId, confirmed);
        db.prepare("UPDATE direct_send SET state='uncertain' WHERE id=?").run(request.requestId);
        fail('delivery_uncertain');
      });
    },
  };
}

// ---- Owner-authorized read-all access (one route may set `readAll: true`) ----
// Metadata listing of every chat or contact with stable cursor paging, and
// chat history paging with a before-cursor. Never sends, never marks seen.
export const READ_ALL_PAGE_MAX = 100;
export const HISTORY_PAGE_MAX = 50;
export const HISTORY_WINDOW_MAX = 1000;

function pageError(code) {
  throw Object.assign(new Error(`scoped_worker_${code}`), {statusCode: 400});
}

export function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

export function decodeCursor(cursor) {
  if (cursor === undefined || cursor === null || cursor === '') return null;
  try {
    if (!/^[A-Za-z0-9_-]{1,400}$/.test(String(cursor))) throw new Error('shape');
    const value = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object' || typeof value.id !== 'string' || !Number.isFinite(value.t)) throw new Error('shape');
    return value;
  } catch {
    return pageError('invalid_cursor');
  }
}

export function pageLimit(value, max) {
  if (value === undefined || value === null || value === '') return max;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) pageError('invalid_page_size');
  return n;
}

// Items sorted newest first (t desc, id asc). The cursor names the last item
// returned; the next page starts strictly after it, so pages never overlap or
// skip when the cursor item still exists, and an unknown position still works.
export function pageByCursor(items, {cursor, limit}) {
  const sorted = [...items].sort((a, b) => (b.t - a.t) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const after = decodeCursor(cursor);
  const start = after ? sorted.findIndex(item => item.t < after.t || (item.t === after.t && item.id > after.id)) : 0;
  const from = start < 0 ? sorted.length : start;
  const page = sorted.slice(from, from + limit);
  const hasMore = from + page.length < sorted.length;
  const last = page.at(-1);
  return {page, hasMore, nextCursor: hasMore && last ? encodeCursor({t: last.t, id: last.id}) : null, total: sorted.length};
}

export async function listAllChats(client, {source = 'chats', cursor, limit, unreadOnly = false, lastMessageSnapshots} = {}) {
  const size = pageLimit(limit, READ_ALL_PAGE_MAX);
  if (source === 'contacts') {
    const contacts = await client.getContacts();
    const items = contacts.filter(c => typeof c?.id?._serialized === 'string' && !c.isMe)
      .map(c => ({t: 0, id: c.id._serialized, label: String(c.name || c.pushname || '').slice(0, 80), isMyContact: c.isMyContact === true, isGroup: c.isGroup === true}));
    const {page, hasMore, nextCursor, total} = pageByCursor(items, {cursor, limit: size});
    return {source, contacts: page.map(({t, ...rest}) => rest), hasMore, nextCursor, total};
  }
  if (source !== 'chats') pageError('invalid_source');
  const chats = await client.getChats();
  // unreadOnly filters before paging, so page, hasMore, nextCursor and total describe the unread set.
  const items = chats.filter(c => typeof c?.id?._serialized === 'string' && (!unreadOnly || Number(c.unreadCount) > 0)).map(c => {
    const last = c.lastMessage;
    const seconds = Number(c.timestamp || last?.timestamp || 0);
    return {t: Number.isFinite(seconds) ? seconds : 0, id: c.id._serialized, label: String(c.name || '').slice(0, 80), isGroup: c.isGroup === true,
      unreadCount: Math.max(0, Number(c.unreadCount) || 0), lastMessageAt: seconds > 0 ? new Date(seconds * 1000).toISOString() : null,
      lastFromThem: last ? last.fromMe !== true : null};
  });
  const {page, hasMore, nextCursor, total} = pageByCursor(items, {cursor, limit: size});
  const snapshots = lastMessageSnapshots ? await lastMessageSnapshots(page.map(item => chats.find(chat => chat.id._serialized === item.id)?.lastMessage)) : null;
  return {source, chats: page.map(({t, id, ...rest}, index) => ({chatId: id, ...rest,
    ...(snapshots ? {lastMessage: snapshots[index]} : {})})), hasMore, nextCursor, total};
}

// History page strictly older than `before` (a message id), newest first.
// The window grows until the cursor message is found; past the window the
// cursor is reported invalid instead of returning a silently wrong page.
export async function historyPage(chat, {before, limit} = {}) {
  const size = pageLimit(limit, HISTORY_PAGE_MAX);
  if (before !== undefined && before !== null && before !== '' && !/^[A-Za-z0-9@._:-]{1,200}$/.test(String(before))) pageError('invalid_cursor');
  let window = Math.min(HISTORY_WINDOW_MAX, before ? Math.max(size * 2, 100) : size + 1);
  for (;;) {
    const fetched = await chat.fetchMessages({limit: window});
    // fetchMessages returns provider order (oldest to newest); reverse it rather than
    // sorting by second-level timestamps, so same-second bursts keep their order and a
    // larger window only adds older messages after the cursor.
    const ordered = [...fetched].reverse();
    let older = ordered;
    if (before) {
      const index = ordered.findIndex(m => m?.id?._serialized === before);
      if (index < 0) {
        if (fetched.length < window) pageError('invalid_cursor');
        if (window >= HISTORY_WINDOW_MAX) pageError('history_window_exceeded');
        window = Math.min(HISTORY_WINDOW_MAX, window * 2);
        continue;
      }
      older = ordered.slice(index + 1);
    }
    const exhausted = fetched.length < window;
    // Not enough older messages loaded yet: widen the window before answering.
    if (older.length < size && !exhausted && window < HISTORY_WINDOW_MAX) {
      window = Math.min(HISTORY_WINDOW_MAX, window * 2);
      continue;
    }
    // At the maximum window with nothing older loaded, more history may exist
    // beyond it: say so explicitly rather than reporting the end of the chat.
    if (!older.length && !exhausted) pageError('history_window_exceeded');
    const page = older.slice(0, size);
    const hasMore = older.length > size || !exhausted;
    return {messages: page, hasMore, nextCursor: hasMore && page.length ? page.at(-1).id._serialized : null};
  }
}
