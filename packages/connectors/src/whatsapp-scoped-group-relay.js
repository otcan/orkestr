import crypto from 'node:crypto';
import {createDeliveryRouteFence} from './whatsapp-delivery-route-fence.js';
import {DatabaseSync} from 'node:sqlite';
import {scopedGroupReplyChunks} from './whatsapp-scoped-group-formatting.js';

const key = value => crypto.createHash('sha256').update(value).digest('hex');
const progressPhases = new Set(['commentary', 'awaiting_approval']);
const progressSources = new Set(['codex-rollout', 'codex-app-server', 'codex-app-server-import', 'claude-code']);
const errorCode = error => /^[a-z_]+$/.test(error.message) ? error.message : 'operation_failed';

export function createScopedGroupRelay({config, api, send, log = () => {}, inboxDb, relayDb, formatter, env = process.env}) {
  if (config.appendDebugFooter === true && !['shouldAppendWhatsAppDebugFooter', 'stripWhatsAppDebugFooter', 'whatsappDebugFooter'].every(k => typeof formatter?.[k] === 'function'))
    throw new Error('group_footer_formatter_required');
  const progressSince = Date.parse(config.forwardProgressSince || '');
  if (config.forwardProgressUpdates === true && !Number.isFinite(progressSince))
    throw new Error('group_progress_cutoff_required');
  const eligibleProgress = message => config.forwardProgressUpdates === true
    && progressPhases.has(message.phase) && progressSources.has(message.source)
    && Number.isFinite(Date.parse(message.createdAt)) && Date.parse(message.createdAt) >= progressSince;
  const inbox = inboxDb || new DatabaseSync(config.journalPath, {readOnly: true});
  const db = relayDb || new DatabaseSync(config.relayJournalPath);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS routed(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,message_id TEXT NOT NULL,completed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS replies(id TEXT PRIMARY KEY,state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reply_payloads(id TEXT PRIMARY KEY,chunks TEXT NOT NULL);`);
  const routeFence = config.routeControl ? createDeliveryRouteFence({dbPath:config.routeControl.dbPath}) : null;
  const groups = new Map(config.groups.map(g => [g.chatId, g]));
  const errors = new Map();

  async function threadFor(group) {
    const {thread: t} = await api(`/api/threads/${encodeURIComponent(group.threadId)}`);
    const b = t?.binding;
    if (!t || t.ownerUserId !== config.ownerUserId || t.retired || t.lifecycleState === 'retired'
        || b?.chatId !== group.chatId || b.enabled !== true || b.routeEligible === false || b.retired || b.deprecated)
      throw new Error('group_binding_inactive');
    return t;
  }

  async function answersFor(group, route) {
    // Walk older pages until the parent is found, so a long-running turn cannot
    // lose its final answer merely because another turn produced many messages.
    let before = '';
    const answers = new Map();
    const context = new Map();
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const page = await api(`/api/threads/${encodeURIComponent(group.threadId)}/messages?limit=200${before ? `&before=${before}` : ''}`);
      const messages = page.messages || [];
      for (const message of messages) {
        context.set(message.id, message);
        if (message.role === 'assistant' && message.state === 'completed'
            && (['final_answer', 'final', 'need_input', 'awaiting_input', 'question', 'request_user_input'].includes(message.phase) || eligibleProgress(message))
            && message.parentMessageId === route.message_id) answers.set(message.id, message);
      }
      if (messages.some(m => m.id === route.message_id) || !page.hasMoreBefore || !messages.length) {
        const ordered = [...answers.values()].sort((a, b) => Number(a.cursor || 0) - Number(b.cursor || 0));
        const finals = ordered.filter(m => ['final_answer', 'final'].includes(m.phase));
        // A final supersedes stale progress and unanswered questions. Live progress
        // keeps the route open; durable reply IDs prevent replays on later polls.
        const updates = ordered.filter(eligibleProgress);
        const question = ordered.filter(m => !progressPhases.has(m.phase)).slice(-1);
        const pending = [...updates, ...question].sort((a, b) => Number(a.cursor || 0) - Number(b.cursor || 0));
        return {answers: finals.length ? finals : pending, messages: [...context.values()]};
      }
      if (!page.oldestCursor || page.oldestCursor === before) break;
      before = page.oldestCursor;
    }
    throw new Error('group_reply_history_incomplete');
  }

  async function routeInput(input, group) {
    if (routeFence && group.threadId === config.routeControl.threadId) {
      const active = routeFence.current();
      if (active?.route !== config.routeControl.routeId || !Number.isFinite(Date.parse(input.created_at)) || Date.parse(input.created_at) < Date.parse(active.since)) return;
    }
    let route = db.prepare('SELECT * FROM routed WHERE id=?').get(input.id);
    if (route?.completed) return;
    await threadFor(group);
    if (!route) {
      const response = await api(`/api/threads/${encodeURIComponent(group.threadId)}/input`, {method: 'POST', body: {
        text: `[WhatsApp: ${group.name}]\n\n${input.body}`, source: 'whatsapp_group_relay',
        parseCommands: false, controlAllowed: false, idempotencyKey: `group:${key(input.id)}`,
      }});
      const messageId = response.message?.id || response.messageId;
      if (!messageId) throw new Error('group_input_unacknowledged');
      db.prepare('INSERT OR IGNORE INTO routed(id,thread_id,message_id) VALUES(?,?,?)').run(input.id, group.threadId, messageId);
      route = db.prepare('SELECT * FROM routed WHERE id=?').get(input.id);
      log({event: 'input_routed', threadId: group.threadId, messageId});
    }
    const {answers, messages} = await answersFor(group, route);
    for (const answer of answers) {
      const text = String(answer.text || '').trim();
      if (text && text !== 'NO_REPLY') {
        const payloadId = key(`${input.id}:${answer.id}`);
        let saved = db.prepare('SELECT chunks FROM reply_payloads WHERE id=?').get(payloadId);
        if (!saved) {
          let thread = await threadFor(group);
          if (config.appendDebugFooter === true) {
            try {
              const {quota} = await api(`/api/quota/providers?ownerUserId=${encodeURIComponent(config.ownerUserId)}`, {timeoutMs: 1000});
              if (quota) thread = {...thread, whatsAppDebugProviderQuota: quota};
            } catch { /* Missing telemetry must not prevent an otherwise valid reply. */ }
          }
          const deliveryType = progressPhases.has(answer.phase) ? 'progress' : 'final';
          const chunks = scopedGroupReplyChunks({deliveryType, text, message: {...answer, chatId: group.chatId}, thread, messages, config, formatter, env});
          // Freeze text and chunk boundaries before the first provider attempt.
          // A retry or restart must reuse the same quota snapshot and payload.
          db.prepare('INSERT INTO reply_payloads(id,chunks) VALUES(?,?)').run(payloadId, JSON.stringify(chunks));
          saved = {chunks: JSON.stringify(chunks)};
        }
        const chunks = JSON.parse(saved.chunks);
        for (let index = 0; index < chunks.length; index++) {
          const requestId = `reply:${key(`${input.id}:${answer.id}:${index}`)}`;
          if (db.prepare("SELECT 1 FROM replies WHERE id=? AND state='sent'").get(requestId)) continue;
          await threadFor(group);
          const result = await send({chatId: input.chat_id, requestId, parentId: input.id, text: chunks[index]});
          if (result.ok !== true || !result.ids?.length) throw new Error('group_reply_unconfirmed');
          db.prepare("INSERT OR REPLACE INTO replies VALUES(?,'sent')").run(requestId);
          log({event: 'reply_delivered', threadId: group.threadId, messageId: answer.id});
        }
      }
      if (['final_answer', 'final'].includes(answer.phase)) db.prepare('UPDATE routed SET completed=1 WHERE id=?').run(input.id);
    }
  }

  return {
    close() { routeFence?.close(); if (!relayDb) db.close(); if (!inboxDb) inbox.close(); },
    async tick() {
      if (inbox.prepare("SELECT 1 FROM group_send WHERE state IN ('sending','uncertain') LIMIT 1").get())
        return {ok: false, error: 'group_delivery_requires_review'};
      const inputs = inbox.prepare('SELECT * FROM group_input ORDER BY created_at').all();
      for (const input of inputs) {
        const group = groups.get(input.chat_id);
        if (!group) continue;
        try { await routeInput(input, group); errors.delete(input.id); }
        catch (error) {
          const code = errorCode(error);
          if (errors.get(input.id) !== code) log({event: 'group_relay_error', threadId: group.threadId, code});
          errors.set(input.id, code);
        }
      }
      return {ok: errors.size === 0, groups: groups.size, received: inputs.length,
        routed: db.prepare('SELECT count(*) n FROM routed').get().n,
        completed: db.prepare('SELECT count(*) n FROM routed WHERE completed=1').get().n,
        sent: db.prepare('SELECT count(*) n FROM replies').get().n,
        errors: [...new Set(errors.values())]};
    },
  };
}
