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
        || Object.keys(route).some(key => !['threadId', 'chatIds'].includes(key)))
      fail('direct_configuration_invalid');
    for (const chatId of route.chatIds) {
      if (typeof chatId !== 'string' || !DIRECT_CHAT.test(chatId) || chats.has(chatId)) fail('direct_configuration_invalid');
      chats.set(chatId, route.threadId);
    }
  }
  return {chats, journalPath: direct.journalPath, contract: hash([config.ownChatId || '', direct.routes])};
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

// Recent-activity list for one thread's approved direct chats. Metadata only:
// no message text, no other chats, never marks anything seen (it only reads
// chat models). A chat the client cannot resolve is reported as unavailable.
export async function summarizeDirectChats(client, chatIds = []) {
  const chats = [];
  for (const chatId of chatIds) {
    try {
      const chat = await client.getChatById(chatId);
      const last = chat?.lastMessage;
      const seconds = Number(chat?.timestamp || last?.timestamp || 0);
      chats.push({
        chatId,
        label: typeof chat?.name === 'string' ? chat.name.slice(0, 80) : '',
        unreadCount: Math.max(0, Number(chat?.unreadCount) || 0),
        lastMessageAt: seconds > 0 ? new Date(seconds * 1000).toISOString() : null,
        lastFromThem: last ? last.fromMe !== true : null,
      });
    } catch {
      chats.push({chatId, unavailable: true});
    }
  }
  return chats;
}
