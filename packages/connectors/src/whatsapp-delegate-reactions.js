import crypto from 'node:crypto';
import {readReactionSnapshots} from './whatsapp-reaction-read.js';

const deny = (code, statusCode = 409) => {throw Object.assign(new Error(`delegate_${code}`), {statusCode});};
const REQUEST = /^[a-zA-Z0-9:._-]{1,200}$/;
const iso = ms => new Date(ms).toISOString();
const idOf = value => typeof value === 'string' ? value : value?._serialized;
const DAY = 24 * 3600 * 1000;

// Separate operation table in the SAME transport journal. Reactions never
// enter delegate_send, consume a first-contact slot, or establish text contact.
export function createDelegateReactions({config, delegates, db, serial, now, timeoutMs = 30_000, lookupDelayMs = 1000}) {
  db.exec(`CREATE TABLE IF NOT EXISTS delegate_reaction(id TEXT PRIMARY KEY,delegate TEXT NOT NULL,request_id TEXT NOT NULL,
    hash TEXT NOT NULL,chat_id TEXT NOT NULL,message_id TEXT NOT NULL,emoji TEXT NOT NULL,state TEXT NOT NULL,
    provider_id TEXT,created_at TEXT NOT NULL,resolved_at TEXT);
    CREATE UNIQUE INDEX IF NOT EXISTS delegate_reaction_provider_id ON delegate_reaction(provider_id) WHERE provider_id IS NOT NULL`);
  db.prepare("UPDATE delegate_reaction SET state='uncertain' WHERE state='sending'").run();

  async function bounded(operation) {
    let timer;
    try { return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
    })]); } finally {clearTimeout(timer);}
  }

  async function target(client, to, messageId) {
    const message = await bounded(() => client.getMessageById(messageId));
    // Both the supplied and returned provider IDs must name this approved chat.
    // Unmapped LID IDs fail closed; no inferred PN/LID conversion or chat lookup.
    if (message?.id?._serialized !== messageId || idOf(message?.id?.remote) !== to || typeof message.react !== 'function')
      deny('reaction_target_unverified', 403);
    return message;
  }

  const snapshot = async message => (await readReactionSnapshots([message], {ownChatId: config.ownChatId}))[0];
  const live = "state IN ('sending','confirmed','uncertain')";
  function react(client, delegate, body = {}) {
    const {to, messageId, emoji, requestId} = body;
    if (Object.keys(body).some(key => !['to', 'messageId', 'emoji', 'requestId'].includes(key))
        || typeof to !== 'string' || typeof messageId !== 'string' || messageId.length > 200
        || typeof emoji !== 'string' || emoji.length > 64 || !/^\p{RGI_Emoji}$/v.test(emoji) || !REQUEST.test(requestId || '')) deny('reaction_invalid', 400);
    if (!delegate.allowReactions) deny('reactions_not_enabled', 403);
    if (!delegate.chats.has(to)) deny('scope_denied', 403);
    const prefix = /^(true|false)_([^_]+)_([A-Za-z0-9_-]+)$/.exec(messageId);
    if (!prefix || prefix[2] !== to) deny('reaction_target_unverified', 403);
    return serial(async () => {
      if (!client) deny('not_ready', 503);
      if (client?.info?.wid?._serialized !== config.ownChatId) deny('account_mismatch', 403);
      const id = `${delegate.name}:${requestId}`;
      const material = crypto.createHash('sha256').update(JSON.stringify([to, messageId, emoji])).digest('hex');
      const previous = db.prepare('SELECT * FROM delegate_reaction WHERE id=?').get(id);
      if (previous) {
        if (previous.hash !== material) deny('request_conflict');
        if (['confirmed', 'unchanged'].includes(previous.state))
          return {ok: true, requestId, state: previous.state, providerId: previous.provider_id, duplicate: true};
        deny(previous.state === 'not_sent' ? 'request_resolved_not_sent' : 'reaction_uncertain');
      }
      // Across delegates, one unresolved operation holds this account/message.
      if (db.prepare("SELECT 1 FROM delegate_reaction WHERE message_id=? AND state IN ('sending','uncertain')").get(messageId)) deny('reaction_uncertain');
      const message = await target(client, to, messageId);
      const before = await snapshot(message);
      if (before.reactionsStatus !== 'available') deny('reaction_snapshot_unavailable', 503);
      const unchanged = before.reactions.some(r => r.fromMe === true && r.emoji === emoji);
      if (!unchanged) {
        const used = db.prepare(`SELECT COUNT(*) AS n FROM delegate_reaction WHERE delegate=? AND ${live} AND created_at>=?`).get(delegate.name, iso(now() - DAY)).n;
        if (used >= 20) deny('reaction_cap_reached', 429);
        const last = db.prepare(`SELECT created_at FROM delegate_reaction WHERE delegate=? AND ${live} ORDER BY created_at DESC LIMIT 1`).get(delegate.name);
        if (last && now() - Date.parse(last.created_at) < 60_000) deny('reaction_too_soon', 429);
      }
      db.prepare('INSERT INTO delegate_reaction VALUES(?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, delegate.name, requestId, material, to, messageId, emoji, unchanged ? 'unchanged' : 'sending', null, iso(now()), null);
      if (unchanged) return {ok: true, requestId, state: 'unchanged', providerId: null};
      const startedAt = now();
      // The library returns no reaction receipt. Even a resolved react() does
      // not prove acceptance; independently read back a NEW own acked reaction.
      try {await bounded(() => message.react(emoji));} catch { /* may already have reached the provider */ }
      const oldIds = new Set(before.reactions.map(r => r.reactionId).filter(Boolean));
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await new Promise(resolve => setTimeout(resolve, lookupDelayMs));
        try {
          const after = await snapshot(await target(client, to, messageId));
          const found = after.reactions.filter(r => r.messageId === messageId && r.fromMe === true && r.emoji === emoji
            && r.reactionId && !oldIds.has(r.reactionId) && !db.prepare('SELECT 1 FROM delegate_reaction WHERE provider_id=?').get(r.reactionId)
            && r.ack >= 1 && r.timestamp && Date.parse(r.timestamp) >= startedAt - 5000);
          if (after.reactionsStatus === 'available' && found.length === 1) {
            db.prepare("UPDATE delegate_reaction SET state='confirmed',provider_id=? WHERE id=?").run(found[0].reactionId, id);
            return {ok: true, requestId, state: 'confirmed', providerId: found[0].reactionId, acceptance: 'provider_ack', delivered: null};
          }
        } catch { /* No new proof; never resend. */ }
      }
      db.prepare("UPDATE delegate_reaction SET state='uncertain' WHERE id=?").run(id);
      deny('reaction_uncertain');
    });
  }

  function list(delegate, state) {
    if (state && !['sending', 'confirmed', 'uncertain', 'unchanged', 'not_sent'].includes(state)) deny('state_invalid', 400);
    return db.prepare(`SELECT request_id AS requestId,chat_id AS chatId,message_id AS messageId,emoji,state,provider_id AS providerId,
      created_at AS createdAt,resolved_at AS resolvedAt FROM delegate_reaction WHERE delegate=? ${state ? 'AND state=?' : ''} ORDER BY created_at DESC LIMIT 200`)
      .all(...[delegate, state].filter(Boolean));
  }

  // Explicit operator reconciliation only, with original observations retained.
  function resolve(body = {}) {
    const {delegate, requestId, outcome, providerId} = body;
    if (Object.keys(body).some(k => !['delegate', 'requestId', 'outcome', 'providerId'].includes(k)) || !delegates.has(delegate)
        || !REQUEST.test(requestId || '') || !['confirmed', 'not_sent'].includes(outcome)
        || (outcome === 'confirmed' ? typeof providerId !== 'string' || !/^[A-Za-z0-9@._:-]{1,200}$/.test(providerId) : providerId !== undefined)) deny('resolve_invalid', 400);
    return serial(async () => {
      const id = `${delegate}:${requestId}`;
      const row = db.prepare('SELECT state FROM delegate_reaction WHERE id=?').get(id);
      if (!row) deny('request_unknown', 404);
      if (row.state !== 'uncertain') deny('request_not_uncertain');
      if (outcome === 'confirmed' && db.prepare('SELECT 1 FROM delegate_reaction WHERE provider_id=?').get(providerId)) deny('provider_id_journaled');
      db.prepare('UPDATE delegate_reaction SET state=?,provider_id=?,resolved_at=? WHERE id=?').run(outcome, providerId || null, iso(now()), id);
      return {ok: true, delegate, requestId, state: outcome};
    });
  }
  return {react, list, resolve};
}
