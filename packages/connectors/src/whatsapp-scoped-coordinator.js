// Owner-authorized coordinator access for a scoped group transport.
//
// The scoped group transport normally admits only replies to recorded owner
// input in allowlisted groups. An operator may add a `coordinator` block to
// the transport config when the account owner explicitly grants one operator
// agent full use of their own account:
//
//   "coordinator": {
//     "tokenSha256": "<sha256 hex of a dedicated bearer token>",
//     "authorizedAt": "<ISO time of the owner's authorization>"
//   }
//
// The coordinator bearer is separate from the transport token and reaches only
// `/coordinator/*`; the transport token never reaches those routes. It may:
//   - list every chat (paged, metadata only),
//   - read any chat's history (paged, never marks anything seen),
//   - list a group's members,
//   - originate a text to any individual or group chat.
// Sends are journaled in their own table: each request id is sent at most once,
// a missing receipt is confirmed by reading the chat back, and an uncertain send
// blocks further coordinator sends to that one chat only, never group replies.
import crypto from 'node:crypto';
import {listAllChats, historyPage} from './whatsapp-scoped-direct-chats.js';
import {SCOPED_SEND_MAX_TEXT_LENGTH} from './whatsapp-scoped-group-formatting.js';

const READ_CHAT = /^[A-Za-z0-9._:-]{1,80}@(?:c\.us|g\.us|lid|newsletter|broadcast)$/;
const SEND_CHAT = /^(?:\d{5,20}@c\.us|\d+(?:-\d+)?@g\.us)$/;
const GROUP_CHAT = /^\d+(?:-\d+)?@g\.us$/;
const REQUEST_ID = /^[a-zA-Z0-9:._-]{1,200}$/;
const PROVIDER_ID = /^[A-Za-z0-9@._:-]{1,200}$/;
const SEND_TIMEOUT_MS = 30_000;

const deny = (code, statusCode = 403) => { throw Object.assign(new Error(`coordinator_${code}`), {statusCode}); };
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Returns null when the config grants no coordinator (the default).
export function validateCoordinatorConfig(config = {}) {
  const coordinator = config.coordinator;
  if (coordinator === undefined) return null;
  if (!coordinator || typeof coordinator !== 'object' || Array.isArray(coordinator)
      || !/^[a-f0-9]{64}$/.test(coordinator.tokenSha256 || '')
      || !Number.isFinite(Date.parse(coordinator.authorizedAt))
      || Object.keys(coordinator).some(key => !['tokenSha256', 'authorizedAt'].includes(key)))
    deny('configuration_invalid');
  return {tokenSha256: coordinator.tokenSha256, authorizedAt: coordinator.authorizedAt};
}

export function coordinatorTokenMatches(coordinator, bearer) {
  if (!coordinator || typeof bearer !== 'string' || !bearer) return false;
  const supplied = crypto.createHash('sha256').update(bearer).digest();
  return crypto.timingSafeEqual(supplied, Buffer.from(coordinator.tokenSha256, 'hex'));
}

export function serializeMessage(message) {
  const seconds = Number(message?.timestamp);
  return {
    id: message?.id?._serialized || null,
    fromMe: message?.fromMe === true,
    author: message?.author || (message?.fromMe === true ? null : message?.from) || null,
    timestamp: Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null,
    type: typeof message?.type === 'string' ? message.type : null,
    body: typeof message?.body === 'string' ? message.body : '',
    hasMedia: message?.hasMedia === true,
    hasQuotedMsg: message?.hasQuotedMsg === true,
    quotedMessageId: message?.hasQuotedMsg === true && typeof message?._data?.quotedStanzaID === 'string' ? message._data.quotedStanzaID : null,
    ack: Number.isFinite(Number(message?.ack)) ? Number(message.ack) : null,
  };
}

// `db` is the transport journal; `serial` the transport's queue, so coordinator
// sends and input observation never interleave.
export function createCoordinatorAccess({config, coordinator, db, serial, now = Date.now, timeoutMs = SEND_TIMEOUT_MS, lookupDelayMs = 1000}) {
  db.exec(`CREATE TABLE IF NOT EXISTS coordinator_send(id TEXT PRIMARY KEY,hash TEXT NOT NULL,chat_id TEXT NOT NULL,state TEXT NOT NULL,
    provider_id TEXT,created_at TEXT NOT NULL,resolved_at TEXT)`);
  // A send interrupted by a crash may or may not have reached WhatsApp.
  db.prepare("UPDATE coordinator_send SET state='uncertain' WHERE state='sending'").run();
  const assertClient = client => {
    if (!client) deny('not_ready', 503);
    if (client?.info?.wid?._serialized !== config.ownChatId) deny('account_mismatch');
  };
  const journaled = id => Boolean(db.prepare('SELECT 1 FROM coordinator_send WHERE provider_id=?').get(id));

  // Same rule as the group transport (#185): WhatsApp Web can deliver a message
  // yet return no usable model. Accept exactly one matching own text created
  // after the send started, not yet journaled, with a server ack.
  async function confirmByLookup(client, to, text, startedAt) {
    for (let attempt = 0; attempt < 6; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, lookupDelayMs));
      try {
        const chat = await client.getChatById(to);
        const found = (await chat.fetchMessages({limit: 20})).filter(message => {
          const id = message?.id?._serialized;
          return message?.fromMe === true && typeof id === 'string' && id && !id.startsWith('summary:')
            && message.type === 'chat' && message.body === text && Number(message.timestamp) * 1000 >= startedAt - 5000
            && !journaled(id);
        });
        if (found.length > 1) return null;
        if (found.length === 1 && Number(found[0].ack) >= 1) return found[0].id._serialized;
      } catch { /* a failed lookup proves nothing; retry, then stay uncertain */ }
    }
    return null;
  }

  function send(client, body = {}) {
    const {to, text, requestId, replyTo} = body;
    if (Object.keys(body).some(key => !['to', 'text', 'requestId', 'replyTo'].includes(key))
        || (replyTo !== undefined && (typeof replyTo !== 'string' || !PROVIDER_ID.test(replyTo))) || typeof to !== 'string' || !SEND_CHAT.test(to)
        || typeof text !== 'string' || !text.trim() || text.length > SCOPED_SEND_MAX_TEXT_LENGTH || !REQUEST_ID.test(requestId || ''))
      deny('send_invalid', 400);
    return serial(async () => {
      assertClient(client);
      const material = replyTo === undefined ? hash([to, text]) : hash([to, text, replyTo]);
      const previous = db.prepare('SELECT * FROM coordinator_send WHERE id=?').get(requestId);
      if (previous) {
        if (previous.hash !== material) deny('request_conflict', 409);
        if (previous.state === 'sent') return {ok: true, requestId, ids: [previous.provider_id], duplicate: true};
        if (previous.state === 'not_sent') deny('request_resolved_not_sent', 409);
        deny('delivery_uncertain', 409);
      }
      if (db.prepare("SELECT 1 FROM coordinator_send WHERE chat_id=? AND state='uncertain' LIMIT 1").get(to)) deny('chat_delivery_uncertain', 409);
      db.prepare('INSERT INTO coordinator_send(id,hash,chat_id,state,provider_id,created_at) VALUES(?,?,?,?,?,?)')
        .run(requestId, material, to, 'sending', null, new Date(now()).toISOString());
      const startedAt = now();
      let sent = null, timer;
      try {
        sent = await Promise.race([
          client.sendMessage(to, text, {sendSeen: false, ...(replyTo ? {quotedMessageId: replyTo} : {})}),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('send_timeout')), timeoutMs); }),
        ]);
      } catch { sent = null; } finally { clearTimeout(timer); }
      let id = sent?.id?._serialized;
      if (typeof id !== 'string' || !id || id.startsWith('summary:')) id = await confirmByLookup(client, to, text, startedAt);
      if (!id) {
        db.prepare("UPDATE coordinator_send SET state='uncertain' WHERE id=?").run(requestId);
        deny('delivery_uncertain', 409);
      }
      db.prepare("UPDATE coordinator_send SET state='sent',provider_id=? WHERE id=?").run(id, requestId);
      return {ok: true, requestId, ids: [id]};
    });
  }

  // Operator decision after reading the chat: the uncertain request was
  // delivered (with its provider id) or was not. Unblocks that chat.
  function resolve(body = {}) {
    const {requestId, outcome, providerId} = body;
    if (Object.keys(body).some(key => !['requestId', 'outcome', 'providerId'].includes(key)) || !REQUEST_ID.test(requestId || '')
        || !['sent', 'not_sent'].includes(outcome) || (outcome === 'sent') !== (typeof providerId === 'string' && PROVIDER_ID.test(providerId)))
      deny('resolve_invalid', 400);
    return serial(async () => {
      const row = db.prepare('SELECT state FROM coordinator_send WHERE id=?').get(requestId);
      if (!row) deny('request_unknown', 404);
      if (row.state !== 'uncertain') deny('request_not_uncertain', 409);
      if (outcome === 'sent' && journaled(providerId)) deny('provider_id_journaled', 409);
      db.prepare('UPDATE coordinator_send SET state=?,provider_id=?,resolved_at=? WHERE id=?')
        .run(outcome, outcome === 'sent' ? providerId : null, new Date(now()).toISOString(), requestId);
      return {ok: true, requestId, state: outcome};
    });
  }

  async function members(client, chatId) {
    assertClient(client);
    const chat = await client.getChatById(chatId);
    if (!chat?.isGroup) deny('not_a_group', 400);
    const participants = Array.isArray(chat?.groupMetadata?.participants) ? chat.groupMetadata.participants : [];
    const rows = [];
    for (const participant of participants) {
      const id = participant?.id?._serialized || (typeof participant?.id === 'string' ? participant.id : null);
      let name = null;
      if (id && typeof client.getContactById === 'function') {
        let timer;
        name = await Promise.race([client.getContactById(id).then(c => c?.name || c?.pushname || null),
          new Promise(resolve => { timer = setTimeout(() => resolve(null), 1500); })]).catch(() => null).finally(() => clearTimeout(timer));
      }
      rows.push({id, name, isAdmin: participant?.isAdmin === true, isSuperAdmin: participant?.isSuperAdmin === true});
    }
    return {ok: true, chatId, name: chat.name || null, participants: rows};
  }

  async function dispatch(req, client) {
    const parts = req.path.split('/').slice(2).map(part => decodeURIComponent(part));
    const query = req.query || {};
    if (req.method === 'GET' && parts.length === 1 && parts[0] === 'health') {
      const identityMatches = client?.info?.wid?._serialized === config.ownChatId;
      const uncertain = db.prepare("SELECT COUNT(*) AS n FROM coordinator_send WHERE state='uncertain'").get().n;
      return {ok: true, ready: Boolean(client) && identityMatches, identityMatches, uncertainSends: uncertain,
        authorizedAt: coordinator.authorizedAt, maxTextLength: SCOPED_SEND_MAX_TEXT_LENGTH, markSeen: false};
    }
    if (req.method === 'GET' && parts.length === 1 && parts[0] === 'chats') {
      assertClient(client);
      return {ok: true, ...await listAllChats(client, {cursor: query.cursor, limit: query.limit, unreadOnly: query.unread_only === '1'})};
    }
    if (req.method === 'GET' && parts.length === 3 && parts[0] === 'chats' && parts[2] === 'messages') {
      if (!READ_CHAT.test(parts[1])) deny('chat_invalid', 400);
      assertClient(client);
      const chat = await client.getChatById(parts[1]);
      const page = await historyPage(chat, {before: query.before, limit: query.limit});
      return {ok: true, chatId: parts[1], name: chat?.name || null, messages: page.messages.map(serializeMessage),
        hasMore: page.hasMore, nextCursor: page.nextCursor};
    }
    if (req.method === 'GET' && parts.length === 3 && parts[0] === 'groups' && parts[2] === 'members') {
      if (!GROUP_CHAT.test(parts[1])) deny('group_invalid', 400);
      return members(client, parts[1]);
    }
    if (req.method === 'GET' && parts.length === 1 && parts[0] === 'sends') {
      const state = query.state === undefined ? null : String(query.state);
      if (state && !['sending', 'sent', 'uncertain', 'not_sent'].includes(state)) deny('state_invalid', 400);
      const rows = db.prepare(`SELECT id,chat_id AS chatId,state,provider_id AS providerId,created_at AS createdAt,resolved_at AS resolvedAt
        FROM coordinator_send ${state ? 'WHERE state=?' : ''} ORDER BY created_at DESC LIMIT 100`).all(...(state ? [state] : []));
      return {ok: true, sends: rows};
    }
    if (req.method === 'POST' && parts.length === 1 && parts[0] === 'send') return send(client, req.body || {});
    if (req.method === 'POST' && parts.length === 1 && parts[0] === 'resolve') return resolve(req.body || {});
    deny('route_unknown', 404);
  }

  return {
    send,
    resolve,
    dispatch,
    // Express-style handler; mounted before the bridge's own routes. Only a
    // request the transport middleware marked as coordinator-authorized passes.
    handler(getClient) {
      return async (req, res, next) => {
        if (!req.path.startsWith('/coordinator/')) return next();
        if (req.orkestrCoordinator !== true) return res.status(403).json({ok: false, error: 'coordinator_unauthorized'});
        try {
          return res.json(await dispatch(req, getClient()));
        } catch (error) {
          const code = String(error?.message || error);
          return res.status(error?.statusCode || 500).json({ok: false, error: code.startsWith('coordinator_') || code.startsWith('scoped_worker_') ? code : 'coordinator_failed'});
        }
      };
    },
  };
}
