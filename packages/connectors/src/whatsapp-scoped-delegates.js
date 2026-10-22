// Scoped delegates for a scoped group transport: a recipient-scoped credential
// that lets ONE thread use the owner's account for outreach to an explicit list
// of individual chats, without the full coordinator authority.
//
//   "delegates": [{
//     "name": "swing",                       // [a-z0-9-], unique
//     "threadId": "<thread id>",             // informational / audit
//     "tokenSha256": "<sha256 hex of a dedicated bearer token>",
//     "authorizedAt": "<ISO time of the owner's authorization>",
//     "chatIds": ["905550000000@c.us", ...], // the only chats it may read or send to
//     "dailyNewRecipientCap": 20,            // distinct first-contact chats per rolling 24 h
//     "dailyFollowUpCap": 20,                // sends to already-contacted chats per rolling 24 h
//     "minGapSeconds": 120                   // minimum spacing between two sends
//   }]
//
// The delegate bearer reaches only `/delegate/*`. It can read the history of
// its own chats (never marks anything seen), list its own chats, and send text
// to them, journaled like the TR direct-chat sender: each request id is sent at
// most once, a missing receipt is confirmed by reading the chat back, and an
// uncertain send blocks that one chat until the operator resolves it with the
// coordinator bearer (`/coordinator/delegate-sends`, `/coordinator/delegate-resolve`).
// Uncertain sends count toward the caps (they may have arrived).
import crypto from 'node:crypto';
import {listAllChats, historyPage} from './whatsapp-scoped-direct-chats.js';
import {serializeMessage} from './whatsapp-scoped-coordinator.js';
import {serializeMessagesWithReactions} from './whatsapp-reaction-read.js';
import {createDelegateReactions} from './whatsapp-delegate-reactions.js';

const NAME = /^[a-z0-9-]{1,40}$/;
const DIRECT_CHAT = /^\d{6,20}@c\.us$/;
const REQUEST_ID = /^[a-zA-Z0-9:._-]{1,200}$/;
const PROVIDER_ID = /^[A-Za-z0-9@._:-]{1,200}$/;
const MAX_CHATS = 1000;
const MAX_TEXT = 3000;
const SEND_TIMEOUT_MS = 30_000;
const DAY_MS = 24 * 3600 * 1000;
const KEYS = ['name', 'threadId', 'tokenSha256', 'authorizedAt', 'chatIds', 'dailyNewRecipientCap', 'dailyFollowUpCap', 'minGapSeconds', 'allowReactions'];

const deny = (code, statusCode = 403, extra = {}) => { throw Object.assign(new Error(`delegate_${code}`), {statusCode, ...extra}); };
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Returns null when the config grants no delegates (the default).
export function validateDelegatesConfig(config = {}) {
  const list = config.delegates;
  if (list === undefined) return null;
  if (!Array.isArray(list) || !list.length) deny('configuration_invalid');
  const byName = new Map();
  const seenTokens = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !KEYS.includes(key))
        || !NAME.test(item.name || '') || byName.has(item.name)
        || typeof item.threadId !== 'string' || !item.threadId
        || !/^[a-f0-9]{64}$/.test(item.tokenSha256 || '') || seenTokens.has(item.tokenSha256)
        || !Number.isFinite(Date.parse(item.authorizedAt))
        || !Array.isArray(item.chatIds) || !item.chatIds.length || item.chatIds.length > MAX_CHATS
        || new Set(item.chatIds).size !== item.chatIds.length || item.chatIds.some(id => typeof id !== 'string' || !DIRECT_CHAT.test(id))
        || !Number.isInteger(item.dailyNewRecipientCap) || item.dailyNewRecipientCap < 1 || item.dailyNewRecipientCap > 100
        || (item.allowReactions !== undefined && typeof item.allowReactions !== 'boolean')
        || (item.dailyFollowUpCap !== undefined && (!Number.isInteger(item.dailyFollowUpCap) || item.dailyFollowUpCap < 0 || item.dailyFollowUpCap > 100))
        || (item.minGapSeconds !== undefined && (!Number.isInteger(item.minGapSeconds) || item.minGapSeconds < 0 || item.minGapSeconds > 3600)))
      deny('configuration_invalid');
    seenTokens.add(item.tokenSha256);
    byName.set(item.name, {
      name: item.name, threadId: item.threadId, tokenSha256: item.tokenSha256, authorizedAt: item.authorizedAt,
      chats: new Set(item.chatIds), dailyNewRecipientCap: item.dailyNewRecipientCap,
      allowReactions: item.allowReactions === true,
      dailyFollowUpCap: item.dailyFollowUpCap ?? 20, minGapSeconds: item.minGapSeconds ?? 120,
    });
  }
  return byName;
}

export function delegateForBearer(delegates, bearer) {
  if (!delegates || typeof bearer !== 'string' || !bearer) return null;
  const supplied = crypto.createHash('sha256').update(bearer).digest();
  let found = null;
  for (const delegate of delegates.values()) {
    // Compare against every delegate so timing does not reveal which one matched.
    if (crypto.timingSafeEqual(supplied, Buffer.from(delegate.tokenSha256, 'hex'))) found = delegate;
  }
  return found;
}

export function createDelegateAccess({config, delegates, db, serial, now = Date.now, timeoutMs = SEND_TIMEOUT_MS, lookupDelayMs = 1000}) {
  const reactions = createDelegateReactions({config, delegates, db, serial, now, timeoutMs, lookupDelayMs});
  db.exec(`CREATE TABLE IF NOT EXISTS delegate_send(id TEXT PRIMARY KEY,delegate TEXT NOT NULL,request_id TEXT NOT NULL,hash TEXT NOT NULL,
    chat_id TEXT NOT NULL,state TEXT NOT NULL,provider_id TEXT,created_at TEXT NOT NULL,resolved_at TEXT,first_contact INTEGER NOT NULL DEFAULT 0)`);
  // A send interrupted by a crash may or may not have reached WhatsApp.
  db.prepare("UPDATE delegate_send SET state='uncertain' WHERE state='sending'").run();
  const assertClient = client => {
    if (!client) deny('not_ready', 503);
    if (client?.info?.wid?._serialized !== config.ownChatId) deny('account_mismatch');
  };
  const journaled = id => Boolean(db.prepare('SELECT 1 FROM delegate_send WHERE provider_id=?').get(id));
  const iso = ms => new Date(ms).toISOString();

  // Window counters. 'not_sent' rows never count; sending/uncertain/sent do.
  function usage(delegate) {
    const since = iso(now() - DAY_MS);
    const live = "state IN ('sending','sent','uncertain')";
    const newCount = db.prepare(`SELECT COUNT(DISTINCT chat_id) AS n FROM delegate_send WHERE delegate=? AND first_contact=1 AND ${live} AND created_at>=?`).get(delegate.name, since).n;
    const followUps = db.prepare(`SELECT COUNT(*) AS n FROM delegate_send WHERE delegate=? AND first_contact=0 AND ${live} AND created_at>=?`).get(delegate.name, since).n;
    const last = db.prepare(`SELECT created_at FROM delegate_send WHERE delegate=? AND ${live} ORDER BY created_at DESC LIMIT 1`).get(delegate.name);
    const lastMs = last ? Date.parse(last.created_at) : null;
    const nextAllowedAt = lastMs === null ? null : iso(lastMs + delegate.minGapSeconds * 1000);
    return {newRecipients: newCount, newRecipientCap: delegate.dailyNewRecipientCap,
      newRecipientsRemaining: Math.max(0, delegate.dailyNewRecipientCap - newCount),
      followUps, followUpCap: delegate.dailyFollowUpCap, followUpsRemaining: Math.max(0, delegate.dailyFollowUpCap - followUps),
      minGapSeconds: delegate.minGapSeconds, lastSendAt: last?.created_at || null, nextAllowedAt};
  }

  // Same rule as the group transport: WhatsApp Web can deliver a message yet
  // return no usable model. Accept exactly one matching own text created after
  // the send started, not yet journaled, with a server ack.
  async function confirmByLookup(client, to, text, startedAt) {
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, lookupDelayMs));
      try {
        const chat = await client.getChatById(to);
        const found = (await chat.fetchMessages({limit: 20})).filter(message => {
          const id = message?.id?._serialized;
          return message?.fromMe === true && typeof id === 'string' && id && !id.startsWith('summary:')
            && message.type === 'chat' && message.body === text && Number(message.timestamp) * 1000 >= startedAt - 5000 && !journaled(id);
        });
        if (found.length > 1) return null;
        if (found.length === 1 && Number(found[0].ack) >= 1) return found[0].id._serialized;
      } catch { /* a failed lookup proves nothing; retry, then stay uncertain */ }
    }
    return null;
  }

  function send(client, delegate, body = {}, {dryRun = false} = {}) {
    const {to, text, requestId} = body;
    if (Object.keys(body).some(key => !['to', 'text', 'requestId', 'dryRun'].includes(key))
        || typeof to !== 'string' || typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT || !REQUEST_ID.test(requestId || ''))
      deny('send_invalid', 400);
    if (!delegate.chats.has(to)) deny('scope_denied');
    return serial(async () => {
      assertClient(client);
      const id = `${delegate.name}:${requestId}`;
      const material = hash([to, text]);
      const previous = db.prepare('SELECT * FROM delegate_send WHERE id=?').get(id);
      if (previous) {
        if (previous.hash !== material) deny('request_conflict', 409);
        if (previous.state === 'sent') return {ok: true, requestId, ids: [previous.provider_id], duplicate: true};
        if (previous.state === 'not_sent') deny('request_resolved_not_sent', 409);
        deny('delivery_uncertain', 409);
      }
      if (db.prepare("SELECT 1 FROM delegate_send WHERE chat_id=? AND state='uncertain' LIMIT 1").get(to)) deny('chat_delivery_uncertain', 409);
      const counters = usage(delegate);
      // First contact = this delegate has never had a live send to the chat.
      const contacted = Boolean(db.prepare("SELECT 1 FROM delegate_send WHERE delegate=? AND chat_id=? AND state IN ('sending','sent','uncertain') LIMIT 1").get(delegate.name, to));
      if (!contacted && counters.newRecipientsRemaining < 1) deny('daily_cap_reached', 429, {usage: counters});
      if (contacted && counters.followUpsRemaining < 1) deny('follow_up_cap_reached', 429, {usage: counters});
      if (counters.nextAllowedAt && Date.parse(counters.nextAllowedAt) > now()) deny('too_soon', 429, {usage: counters});
      if (dryRun || body.dryRun === true) return {ok: true, dryRun: true, wouldSend: {to, firstContact: !contacted}, usage: counters};
      db.prepare('INSERT INTO delegate_send(id,delegate,request_id,hash,chat_id,state,provider_id,created_at,first_contact) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(id, delegate.name, requestId, material, to, 'sending', null, iso(now()), contacted ? 0 : 1);
      const startedAt = now();
      let sent = null, timer;
      try {
        sent = await Promise.race([
          client.sendMessage(to, text, {sendSeen: false}),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('send_timeout')), timeoutMs); }),
        ]);
      } catch { sent = null; } finally { clearTimeout(timer); }
      let providerId = sent?.id?._serialized;
      if (typeof providerId !== 'string' || !providerId || providerId.startsWith('summary:')) providerId = await confirmByLookup(client, to, text, startedAt);
      if (!providerId) {
        db.prepare("UPDATE delegate_send SET state='uncertain' WHERE id=?").run(id);
        deny('delivery_uncertain', 409);
      }
      db.prepare("UPDATE delegate_send SET state='sent',provider_id=? WHERE id=?").run(providerId, id);
      return {ok: true, requestId, ids: [providerId]};
    });
  }

  const sendsFor = (delegateName, state) => {
    if (state && !['sending', 'sent', 'uncertain', 'not_sent'].includes(state)) deny('state_invalid', 400);
    const where = [delegateName ? 'delegate=?' : null, state ? 'state=?' : null].filter(Boolean).join(' AND ');
    const args = [delegateName, state].filter(value => value);
    return db.prepare(`SELECT delegate,request_id AS requestId,chat_id AS chatId,state,provider_id AS providerId,created_at AS createdAt,
      resolved_at AS resolvedAt,first_contact AS firstContact FROM delegate_send ${where ? `WHERE ${where}` : ''} ORDER BY created_at DESC LIMIT 200`).all(...args);
  };

  // Operator decision (coordinator bearer) after reading the chat.
  function resolve(body = {}) {
    const {delegate, requestId, outcome, providerId} = body;
    if (Object.keys(body).some(key => !['delegate', 'requestId', 'outcome', 'providerId'].includes(key)) || !delegates.has(delegate)
        || !REQUEST_ID.test(requestId || '') || !['sent', 'not_sent'].includes(outcome)
        || (outcome === 'sent') !== (typeof providerId === 'string' && PROVIDER_ID.test(providerId)))
      deny('resolve_invalid', 400);
    return serial(async () => {
      const row = db.prepare('SELECT state FROM delegate_send WHERE id=?').get(`${delegate}:${requestId}`);
      if (!row) deny('request_unknown', 404);
      if (row.state !== 'uncertain') deny('request_not_uncertain', 409);
      if (outcome === 'sent' && journaled(providerId)) deny('provider_id_journaled', 409);
      db.prepare('UPDATE delegate_send SET state=?,provider_id=?,resolved_at=? WHERE id=?')
        .run(outcome, outcome === 'sent' ? providerId : null, iso(now()), `${delegate}:${requestId}`);
      return {ok: true, delegate, requestId, state: outcome};
    });
  }

  // Only this delegate's chats are visible, so no other chat leaks through paging.
  const scopedClient = (client, delegate) => ({
    getChats: async () => (await client.getChats()).filter(chat => delegate.chats.has(chat?.id?._serialized)),
  });

  async function dispatchDelegate(req, client, delegate) {
    const parts = req.path.split('/').slice(2).map(part => decodeURIComponent(part));
    const query = req.query || {};
    if (req.method === 'GET' && parts.length === 1 && parts[0] === 'health') {
      const identityMatches = client?.info?.wid?._serialized === config.ownChatId;
      const uncertain = db.prepare("SELECT COUNT(*) AS n FROM delegate_send WHERE delegate=? AND state='uncertain'").get(delegate.name).n;
      return {ok: true, ready: Boolean(client) && identityMatches, identityMatches, delegate: delegate.name, threadId: delegate.threadId,
        scopedChats: delegate.chats.size, uncertainSends: uncertain, authorizedAt: delegate.authorizedAt, usage: usage(delegate), markSeen: false,
        reactionRead: true, reactionSend: delegate.allowReactions};
    }
    if (req.method === 'GET' && parts.length === 1 && parts[0] === 'cap') return {ok: true, usage: usage(delegate)};
    if (req.method === 'GET' && parts.length === 1 && parts[0] === 'chats') {
      assertClient(client);
      return {ok: true, ...await listAllChats(scopedClient(client, delegate), {cursor: query.cursor, limit: query.limit, unreadOnly: query.unread_only === '1',
        lastMessageSnapshots: messages => serializeMessagesWithReactions(messages, message => ({id: message?.id?._serialized || null}), {ownChatId: config.ownChatId})})};
    }
    if (req.method === 'GET' && parts.length === 3 && parts[0] === 'chats' && parts[2] === 'messages') {
      if (!delegate.chats.has(parts[1])) deny('scope_denied');
      assertClient(client);
      const chat = await client.getChatById(parts[1]);
      const page = await historyPage(chat, {before: query.before, limit: query.limit});
      return {ok: true, chatId: parts[1], name: chat?.name || null,
        messages: await serializeMessagesWithReactions(page.messages, serializeMessage, {ownChatId: config.ownChatId}), hasMore: page.hasMore, nextCursor: page.nextCursor};
    }
    if (req.method === 'GET' && parts.length === 1 && parts[0] === 'sends') return {ok: true, sends: sendsFor(delegate.name, query.state === undefined ? null : String(query.state))};
    if (req.method === 'GET' && parts.length === 1 && parts[0] === 'reactions') return {ok: true, reactions: reactions.list(delegate.name, query.state === undefined ? null : String(query.state))};
    if (req.method === 'POST' && parts.length === 1 && parts[0] === 'react') return reactions.react(client, delegate, req.body || {});
    if (req.method === 'POST' && parts.length === 1 && parts[0] === 'send') return send(client, delegate, req.body || {});
    if (req.method === 'POST' && parts.length === 1 && parts[0] === 'send-dry-run') return send(client, delegate, req.body || {}, {dryRun: true});
    return deny('route_unknown', 404);
  }

  async function dispatchOperator(req) {
    const parts = req.path.split('/').slice(2);
    const query = req.query || {};
    if (req.method === 'GET' && parts.length === 1 && parts[0] === 'delegate-sends') {
      const name = query.delegate === undefined ? null : String(query.delegate);
      if (name && !delegates.has(name)) deny('unknown', 404);
      return {ok: true, sends: sendsFor(name, query.state === undefined ? null : String(query.state))};
    }
    if (req.method === 'POST' && parts.length === 1 && parts[0] === 'delegate-resolve') return resolve(req.body || {});
    if (req.method === 'POST' && parts.length === 1 && parts[0] === 'delegate-reaction-resolve') return reactions.resolve(req.body || {});
    return null;
  }

  const fail = (res, error) => {
    const code = String(error?.message || error);
    return res.status(error?.statusCode || 500).json({ok: false, error: code.startsWith('delegate_') || code.startsWith('scoped_worker_') ? code : 'delegate_failed',
      ...(error?.usage ? {usage: error.usage} : {})});
  };

  return {
    send, resolve, usage,
    // Mounted before the coordinator handler. Handles `/delegate/*` for an
    // authorized delegate bearer and the two operator routes for the coordinator.
    handler(getClient) {
      return async (req, res, next) => {
        try {
          if (req.path.startsWith('/delegate/')) {
            const delegate = req.orkestrDelegate;
            if (!delegate) return res.status(403).json({ok: false, error: 'delegate_unauthorized'});
            return res.json(await dispatchDelegate(req, getClient(), delegate));
          }
          if (['/coordinator/delegate-sends', '/coordinator/delegate-resolve', '/coordinator/delegate-reaction-resolve'].includes(req.path)) {
            if (req.orkestrCoordinator !== true) return res.status(403).json({ok: false, error: 'coordinator_unauthorized'});
            const result = await dispatchOperator(req);
            if (result) return res.json(result);
          }
        } catch (error) {
          return fail(res, error);
        }
        return next();
      };
    },
  };
}
