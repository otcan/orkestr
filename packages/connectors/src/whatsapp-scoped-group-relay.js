import crypto from 'node:crypto';
import {createGroupParticipantPolicy, participantInputMetadata} from './whatsapp-group-participant-author.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createDeliveryRouteFence} from './whatsapp-delivery-route-fence.js';
import {scopedRouteMembership} from './whatsapp-scoped-route-membership.js';
import {DatabaseSync} from 'node:sqlite';
import {isReplyDocument, scopedGroupReplyChunks} from './whatsapp-scoped-group-formatting.js';
import {createDynamicGroupRegistry, createDynamicGroupView, eligibleGroups, validateDynamicGroups} from './whatsapp-scoped-dynamic-groups.js';

const key = value => crypto.createHash('sha256').update(value).digest('hex');
const progressPhases = new Set(['commentary', 'awaiting_approval']);
const progressSources = new Set(['codex-rollout', 'codex-app-server', 'codex-app-server-import', 'claude-code']);
// Replies posted after the turn ended (a bound api-session) and parented by V1
// to the latest relay-routed input. Delivered once, within a bounded window.
const lateSources = new Set(['api-session']);
const finalPhases = new Set(['final_answer', 'final']);
const LATE_REPLY_WINDOW_MS = 6 * 60 * 60 * 1000;
const LATE_REPLY_POLL_MS = 10_000;
// How often the relay reconciles registered groups with V1's thread registry.
const REGISTRATION_POLL_MS = 30_000;
// The binding flags of whatsapp-mirror-policy's update suppression, kept local
// so the standalone bridge's import graph stays closed.
const flagOn = value => value === true || /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
const flagOff = value => value === false || /^(0|false|no|off)$/i.test(String(value ?? '').trim());
const threadSuppressesUpdates = (thread = {}) => {
  const b = thread?.binding || {};
  return ['suppressWhatsAppUpdates', 'suppressWhatsAppUpdateMessages', 'suppressUpdateMessages', 'whatsappSuppressUpdates', 'whatsappSuppressUpdateMessages']
      .some(k => Object.hasOwn(b, k) && flagOn(b[k]))
    || ['mirrorWhatsAppUpdates', 'mirrorWhatsAppProgress', 'mirrorUpdateMessages', 'whatsappMirrorUpdates']
      .some(k => Object.hasOwn(b, k) && flagOff(b[k]));
};
const errorCode = error => /^[a-z_]+$/.test(error.message) ? error.message : 'operation_failed';
const GROUP_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const GROUP_MEDIA_MAX_BYTES = 10 * 1024 * 1024;

// Media evidence comes from the additive group_input_media side table; journals
// written by the short-lived column migration keep working through COALESCE.
function readGroupInputs(inbox) {
  const tables = new Set(inbox.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  const columns = new Set(inbox.prepare('PRAGMA table_info(group_input)').all().map(column => column.name));
  const legacy = name => columns.has(`media_${name}`) ? `i.media_${name}` : 'NULL';
  const side = name => tables.has('group_input_media') ? `m.${name}` : 'NULL';
  const join = tables.has('group_input_media') ? 'LEFT JOIN group_input_media m ON m.id=i.id' : '';
  const field = name => `COALESCE(${side(name)},${legacy(name)}) AS media_${name}`;
  const hasQuote = tables.has('group_input_quote');
  const quoteColumns = hasQuote
    ? ',q.id AS quote_row,q.quoted_id AS quote_id,q.author AS quote_author,q.sent_at AS quote_sent_at,q.body AS quote_body,q.from_me AS quote_from_me,q.resolved AS quote_resolved'
    : '';
  const quoteJoin = hasQuote ? 'LEFT JOIN group_input_quote q ON q.id=i.id' : '';
  return inbox.prepare(`SELECT i.id,i.chat_id,i.body,i.created_at,${['path','filename','mimetype','size'].map(field).join(',')}${quoteColumns}
    FROM group_input i ${join} ${quoteJoin} ORDER BY i.created_at`).all();
}

const REPLY_TEXT_MAX = 500;
const REPLY_SNIPPET_MAX = 80;
const collapse = value => String(value || '').replace(/\s+/g, ' ').trim();
const clip = (value, max) => { const text = collapse(value); return text.length > max ? `${text.slice(0, max - 1).trimEnd()}\u2026` : text; };

// The structured reply-to for an input that quoted another message, or null.
// An unresolvable quote is marked `unavailable` instead of guessed. `own` is the
// text Orkestr itself sent (from the relay's journal) when the quote is one of
// its replies. The visible line is what the model reads.
export function buildReplyTo(input, {own = null, ownChatId = '', timeZone = 'Europe/Berlin'} = {}) {
  if (!input.quote_row) return null;
  const quotedId = input.quote_id || null;
  const body = own?.text || input.quote_body || '';
  if (!Number(input.quote_resolved) && !own) {
    return {replyTo: {messageId: quotedId, author: input.quote_author || null, sentAt: input.quote_sent_at || null, text: '', isOwnReply: false, unavailable: true},
      line: '[Replying to an unavailable message]'};
  }
  const sentAt = input.quote_sent_at || own?.sentAt || null;
  const authorDigits = String(input.quote_author || '').split('@')[0];
  const ownerAuthored = !own && Boolean(authorDigits) && authorDigits === String(ownChatId).split('@')[0];
  const replyTo = {messageId: quotedId, author: own ? 'orkestr' : (input.quote_author || null), sentAt, text: clip(body, REPLY_TEXT_MAX), isOwnReply: Boolean(own)};
  let time = '';
  if (sentAt) {
    try { time = new Intl.DateTimeFormat('en-GB', {hour: '2-digit', minute: '2-digit', hour12: false, timeZone}).format(new Date(sentAt)); } catch { time = ''; }
  }
  const who = own ? 'Orkestr message' : (ownerAuthored ? 'your message' : 'earlier message');
  const line = `[Replying to ${who}${time ? ` from ${time}` : ''}: "${clip(body, REPLY_SNIPPET_MAX)}"]`;
  return {replyTo, line};
}

export function createScopedGroupRelay({config, api, send, log = () => {}, inboxDb, relayDb, formatter, env = process.env, readMediaFile = fs.readFile, now = Date.now,
    openRegistry = path => createDynamicGroupRegistry(path, {now, staticGroups: config.groups})}) {
  // Operator holds are exclusions, not delivery/completion receipts. Validate
  // before opening either journal and snapshot the policy for this process.
  const heldIds = config.heldInputIds === undefined ? [] : config.heldInputIds;
  if (!Array.isArray(heldIds) || heldIds.some(id => typeof id !== 'string' || !id.trim()))
    throw new Error('group_held_inputs_invalid');
  const heldInputIds = new Set(heldIds);
  const participants = createGroupParticipantPolicy(config);
  const fencedThreads = scopedRouteMembership(config);
  if (config.appendDebugFooter === true && !['shouldAppendWhatsAppDebugFooter', 'stripWhatsAppDebugFooter', 'whatsappDebugFooter'].every(k => typeof formatter?.[k] === 'function'))
    throw new Error('group_footer_formatter_required');
  const progressSince = Date.parse(config.forwardProgressSince || '');
  if (config.forwardProgressUpdates === true && !Number.isFinite(progressSince))
    throw new Error('group_progress_cutoff_required');
  // Commentary honours the thread's own update suppression; approval requests
  // still reach the owner because the turn waits on them.
  const eligibleProgress = (message, suppressUpdates = false) => config.forwardProgressUpdates === true
    && progressPhases.has(message.phase) && progressSources.has(message.source)
    && !(suppressUpdates && message.phase === 'commentary')
    && Number.isFinite(Date.parse(message.createdAt)) && Date.parse(message.createdAt) >= progressSince;
  const inbox = inboxDb || new DatabaseSync(config.journalPath, {readOnly: true});
  const db = relayDb || new DatabaseSync(config.relayJournalPath);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS routed(id TEXT PRIMARY KEY,thread_id TEXT NOT NULL,message_id TEXT NOT NULL,completed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS replies(id TEXT PRIMARY KEY,state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reply_payloads(id TEXT PRIMARY KEY,chunks TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS input_media_uploads(id TEXT PRIMARY KEY,attachments TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS input_media_upload_attempts(id TEXT PRIMARY KEY,attempts INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'retrying');
    CREATE TABLE IF NOT EXISTS reply_receipts(id TEXT PRIMARY KEY,provider_ids TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reply_sent_text(provider_id TEXT PRIMARY KEY,request_id TEXT NOT NULL,text TEXT NOT NULL,sent_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS remote_delivery_reports(id TEXT PRIMARY KEY,reported_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reply_file_attempts(id TEXT PRIMARY KEY,attempts INTEGER NOT NULL DEFAULT 0);`);
  const routeFence = config.routeControl ? createDeliveryRouteFence({dbPath:config.routeControl.dbPath}) : null;
  const staticGroups = new Map(config.groups.map(g => [g.chatId, g]));
  // With dynamicGroups, groups registered in the transport journal join live.
  const dynamic = validateDynamicGroups(config);
  const groups = dynamic ? createDynamicGroupView(inbox, {static: staticGroups, now}) : staticGroups;
  const fencedGroup = group => Boolean(group) && (fencedThreads?.has(group.threadId) || (Boolean(routeFence) && group.dynamic === true));
  const errors = new Map();

  // Registrar: keep each journal's registered groups equal to V1's eligible
  // delegated owner group threads (created after `since`). Registration and
  // removal are idempotent; a failing journal or V1 read changes nothing.
  const registries = new Map();
  let lastRegistration = 0;
  async function reconcileRegistrations() {
    if (!dynamic || now() - lastRegistration < REGISTRATION_POLL_MS) return;
    lastRegistration = now();
    let wanted;
    try {
      const summary = await api('/api/threads/summary?includeRetired=1');
      if (!Array.isArray(summary?.threads)) throw new Error('group_registry_unavailable');
      wanted = eligibleGroups(summary.threads, {ownerUserId: config.ownerUserId, since: dynamic.since});
    } catch (error) {
      const code = errorCode(error);
      if (errors.get('registration') !== code) log({event: 'group_registration_error', code});
      errors.set('registration', code);
      return;
    }
    errors.delete('registration');
    for (const path of [config.journalPath, ...dynamic.journals]) {
      try {
        if (!registries.has(path)) registries.set(path, openRegistry(path));
        const registry = registries.get(path);
        const active = new Map(registry.active().map(g => [g.chatId, g]));
        for (const [chatId, group] of wanted) {
          if (staticGroups.has(chatId)) continue;
          const result = registry.register(group);
          if (result.registered) log({event: 'group_registered', threadId: group.threadId, journal: path === config.journalPath ? 'primary' : 'mirror'});
        }
        for (const [chatId, group] of active) {
          if (wanted.get(chatId)?.threadId === group.threadId) continue;
          if (registry.remove(chatId, 'thread_not_eligible').removed)
            log({event: 'group_registration_removed', threadId: group.threadId, journal: path === config.journalPath ? 'primary' : 'mirror'});
        }
        errors.delete(`registration:${path}`);
      } catch (error) {
        const code = errorCode(error);
        if (errors.get(`registration:${path}`) !== code) log({event: 'group_registration_error', code});
        errors.set(`registration:${path}`, code);
      }
    }
    groups.refresh?.();
  }

  async function removeStagedFile(mediaPath, realRoot = '') {
    if (!mediaPath) return;
    const realPath = await fs.realpath(path.resolve(String(mediaPath))).catch(() => '');
    if (!realPath) return;
    const root = realRoot || await fs.realpath(path.resolve(config.mediaDir || (config.journalPath ? `${config.journalPath}.media` : '.'))).catch(() => '');
    const relative = root ? path.relative(root, realPath) : '..';
    if (root && relative && !relative.startsWith('..') && !path.isAbsolute(relative))
      await fs.rm(realPath, {force: true}).catch(() => {});
  }

  function rememberUploadFailure(id, attempts) {
    db.prepare(`INSERT INTO input_media_upload_attempts(id,attempts,state) VALUES(?,?,'retrying')
      ON CONFLICT(id) DO UPDATE SET attempts=excluded.attempts,state=excluded.state`).run(id, attempts);
  }

  async function threadFor(group) {
    const {thread: t} = await api(`/api/threads/${encodeURIComponent(group.threadId)}`);
    const b = t?.binding;
    if (!t || t.ownerUserId !== config.ownerUserId || t.retired || t.lifecycleState === 'retired'
        || b?.chatId !== group.chatId || b.enabled !== true || b.routeEligible === false || b.retired || b.deprecated)
      throw new Error('group_binding_inactive');
    return t;
  }

  async function inputThread(input, group) {
    const thread = await threadFor(group);
    const hasAuthors = inbox.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='group_input_author'").get();
    if (participants.count && !hasAuthors) throw new Error('group_participant_journal_required');
    const author = hasAuthors ? inbox.prepare('SELECT proof FROM group_input_author WHERE id=?').get(input.id) : null;
    const metadata = author ? participantInputMetadata({proof: JSON.parse(author.proof), input, group, thread, policy: participants}) : {};
    if (author) {
      const check = await api(`/api/threads/${encodeURIComponent(group.threadId)}/whatsapp-participant-check`, {method: 'POST', body: {...metadata, text: input.body}});
      if (check.allowed !== true) throw new Error('group_participant_security_denied');
    }
    return {thread, metadata};
  }

  async function answersFor(group, route, suppressUpdates = false) {
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
            && (['final_answer', 'final', 'need_input', 'awaiting_input', 'question', 'request_user_input'].includes(message.phase) || eligibleProgress(message, suppressUpdates))
            && message.parentMessageId === route.message_id) answers.set(message.id, message);
      }
      if (messages.some(m => m.id === route.message_id) || !page.hasMoreBefore || !messages.length) {
        const ordered = [...answers.values()].sort((a, b) => Number(a.cursor || 0) - Number(b.cursor || 0));
        const finals = ordered.filter(m => ['final_answer', 'final'].includes(m.phase));
        // A final supersedes stale progress and unanswered questions. Live progress
        // keeps the route open; durable reply IDs prevent replays on later polls.
        const updates = ordered.filter(message => eligibleProgress(message, suppressUpdates));
        const question = ordered.filter(m => !progressPhases.has(m.phase)).slice(-1);
        const pending = [...updates, ...question].sort((a, b) => Number(a.cursor || 0) - Number(b.cursor || 0));
        return {answers: finals.length ? finals : pending, messages: [...context.values()]};
      }
      if (!page.oldestCursor || page.oldestCursor === before) break;
      before = page.oldestCursor;
    }
    throw new Error('group_reply_history_incomplete');
  }

  async function deliverAnswer(input, group, answer, messages) {
    const text = String(answer.text || '').trim();
    if (!text || text === 'NO_REPLY') return;
    const payloadId = key(`${input.id}:${answer.id}`);
    let saved = db.prepare('SELECT chunks FROM reply_payloads WHERE id=?').get(payloadId);
    if (!saved) {
      let {thread} = await inputThread(input, group);
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
      await inputThread(input, group);
      // An entry is a text or, for a reply over the budget, its full-text document.
      const entry = chunks[index];
      const result = await send({chatId: input.chat_id, requestId, parentId: input.id,
        ...(isReplyDocument(entry) ? {document: entry.document} : {text: entry})});
      if (result.ok !== true || !result.ids?.length) throw new Error('group_reply_unconfirmed');
      db.prepare("INSERT OR REPLACE INTO replies VALUES(?,'sent')").run(requestId);
      db.prepare('INSERT OR REPLACE INTO reply_receipts VALUES(?,?)').run(requestId, JSON.stringify(result.ids.map(String)));
      // The full text Orkestr sent under each provider id, so a later WhatsApp
      // reply-quote of it can be resolved to what was actually said.
      const sentText = isReplyDocument(entry) ? String(entry.document?.text || '') : String(entry || '');
      for (const providerId of result.ids.map(String))
        db.prepare('INSERT OR IGNORE INTO reply_sent_text VALUES(?,?,?,?)').run(providerId, requestId, sentText, new Date().toISOString());
      log({event: 'reply_delivered', threadId: group.threadId, messageId: answer.id});
    }
    await deliverAnswerFiles(input, group, answer);
    // A mirrored remote-runtime reply: report the confirmed send so V1 can
    // acknowledge it to the runtime. A failed report retries on the next
    // poll without resending (every chunk above is already 'sent').
    if (answer.remoteMessageId && !db.prepare('SELECT 1 FROM remote_delivery_reports WHERE id=?').get(payloadId)) {
      const requestIds = chunks.map((_, index) => `reply:${key(`${input.id}:${answer.id}:${index}`)}`);
      const connectorMessageIds = requestIds.flatMap(id => JSON.parse(db.prepare('SELECT provider_ids FROM reply_receipts WHERE id=?').get(id)?.provider_ids || '[]'));
      await api(`/api/threads/${encodeURIComponent(group.threadId)}/messages/${encodeURIComponent(answer.id)}/scoped-relay-delivery`,
        {method: 'POST', body: {requestIds, connectorMessageIds, deliveredAt: new Date().toISOString()}});
      db.prepare('INSERT OR IGNORE INTO remote_delivery_reports VALUES(?,?)').run(payloadId, new Date().toISOString());
      log({event: 'remote_delivery_reported', threadId: group.threadId, messageId: answer.id});
    }
  }

  // Files the assistant attached to a reply, after its text (`replyMediaRoot`).
  // V1 resolves each to its plaintext snapshot; the worker re-checks the bytes.
  // A file V1 cannot resolve is skipped; a failing send is retried on later
  // polls and skipped after three attempts so it cannot block the group.
  async function deliverAnswerFiles(input, group, answer) {
    const attachments = Array.isArray(answer.attachments) ? answer.attachments : [];
    if (!config.replyMediaRoot || !attachments.length) return;
    let files = null;
    for (const attachment of attachments) {
      const fileKey = String(attachment?.id || '');
      if (!fileKey) continue;
      const requestId = `reply:${key(`${input.id}:${answer.id}:file:${fileKey}`)}`;
      if (db.prepare("SELECT 1 FROM replies WHERE id=? AND state IN ('sent','skipped')").get(requestId)) continue;
      files ||= (await api(`/api/threads/${encodeURIComponent(group.threadId)}/messages/${encodeURIComponent(answer.id)}/scoped-relay-files`)).files || [];
      const file = files.find(candidate => candidate?.id === fileKey);
      const skip = reason => {
        db.prepare("INSERT OR REPLACE INTO replies VALUES(?,'skipped')").run(requestId);
        log({event: 'reply_file_skipped', threadId: group.threadId, messageId: answer.id, attachmentId: fileKey, reason});
      };
      if (!file) { skip('no_snapshot'); continue; }
      await inputThread(input, group);
      let result;
      try {
        result = await send({chatId: input.chat_id, requestId, parentId: input.id,
          file: {path: file.path, filename: file.filename, mimetype: file.mimetype, sha256: file.sha256}});
        if (result?.ok !== true || !result.ids?.length) throw new Error('group_reply_unconfirmed');
      } catch (error) {
        db.prepare('INSERT INTO reply_file_attempts(id,attempts) VALUES(?,1) ON CONFLICT(id) DO UPDATE SET attempts=attempts+1').run(requestId);
        if (db.prepare('SELECT attempts FROM reply_file_attempts WHERE id=?').get(requestId).attempts >= 3) { skip('send_failed'); continue; }
        throw error;
      }
      db.prepare("INSERT OR REPLACE INTO replies VALUES(?,'sent')").run(requestId);
      db.prepare('INSERT OR REPLACE INTO reply_receipts VALUES(?,?)').run(requestId, JSON.stringify(result.ids.map(String)));
      log({event: 'reply_file_delivered', threadId: group.threadId, messageId: answer.id, attachmentId: fileKey});
    }
  }

  // The text Orkestr sent that a reply-quote points at, or null when the quoted
  // message is not one of our recorded replies. The quote id is the serialized
  // provider id when WhatsApp resolved it, else the bare stanza id.
  function ownReplyFor(quotedId) {
    const id = String(quotedId || '');
    if (!id) return null;
    const suffix = id.includes('_') ? null : `_${id}`;
    const exact = db.prepare('SELECT text,sent_at FROM reply_sent_text WHERE provider_id=?').get(id)
      || (suffix && db.prepare('SELECT text,sent_at FROM reply_sent_text WHERE substr(provider_id,-?)=?').get(suffix.length, suffix));
    if (exact) return {text: exact.text, sentAt: exact.sent_at};
    // Replies sent before the text journal existed: the receipt still proves it is ours.
    const receipts = db.prepare('SELECT provider_ids FROM reply_receipts').all();
    return receipts.some(row => JSON.parse(row.provider_ids || '[]').some(p => p === id || (suffix && String(p).endsWith(suffix)))) ? {text: ''} : null;
  }

  async function routeInput(input, group) {
    if (routeFence && fencedGroup(group)) {
      const active = routeFence.current();
      if (active?.route !== config.routeControl.routeId || !Number.isFinite(Date.parse(input.created_at)) || Date.parse(input.created_at) < Date.parse(active.since)) return;
    }
    let route = db.prepare('SELECT * FROM routed WHERE id=?').get(input.id);
    if (route?.completed) return;
    const {metadata, thread: routeThread} = await inputThread(input, group);
    if (!route) {
      let attachments = [];
      let inputBody = String(input.body || '').trim();
      if (input.media_path) {
        const priorUpload = db.prepare('SELECT attachments FROM input_media_uploads WHERE id=?').get(input.id);
        const priorAttempt = db.prepare('SELECT attempts,state FROM input_media_upload_attempts WHERE id=?').get(input.id);
        if (priorUpload) {
          attachments = JSON.parse(priorUpload.attachments);
          await removeStagedFile(input.media_path);
        } else if (priorAttempt?.state === 'skipped') {
          inputBody = [inputBody, '[WhatsApp attachment skipped: upload failed after 3 attempts]'].filter(Boolean).join('\n\n');
          await removeStagedFile(input.media_path);
        } else {
          const mediaRoot = path.resolve(config.mediaDir || (config.journalPath ? `${config.journalPath}.media` : '.'));
          const mediaPath = path.resolve(String(input.media_path));
          const relative = path.relative(mediaRoot, mediaPath);
          if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
            inputBody = [inputBody, '[WhatsApp attachment skipped: media unavailable]'].filter(Boolean).join('\n\n');
          } else {
            const realRoot = await fs.realpath(mediaRoot).catch(() => '');
            const realPath = await fs.realpath(mediaPath).catch(() => '');
            const realRelative = realRoot && realPath ? path.relative(realRoot, realPath) : '..';
            const stat = realPath ? await fs.stat(realPath).catch(() => null) : null;
            const mimetype = String(input.media_mimetype || '').trim().toLowerCase();
            if (!realRoot || !realPath || !stat?.isFile() || realRelative.startsWith('..') || path.isAbsolute(realRelative)
                || !GROUP_IMAGE_MIMES.has(mimetype) || stat.size > GROUP_MEDIA_MAX_BYTES) {
              inputBody = [inputBody, '[WhatsApp attachment skipped: media unavailable or outside supported limits]'].filter(Boolean).join('\n\n');
              if (realPath && realRoot && !realRelative.startsWith('..') && !path.isAbsolute(realRelative))
                await removeStagedFile(realPath, realRoot);
            } else {
              let bytes;
              try {
                bytes = await readMediaFile(realPath);
              } catch {
                inputBody = [inputBody, '[WhatsApp attachment skipped: staged media could not be read]'].filter(Boolean).join('\n\n');
                await removeStagedFile(realPath, realRoot);
              }
              if (bytes) {
                const form = new FormData();
                form.append('files', new Blob([bytes], {type: mimetype}), String(input.media_filename || 'image'));
                form.append('metadata', JSON.stringify([{
                  filename: String(input.media_filename || 'image'), name: String(input.media_filename || 'image'),
                  mimetype, type: mimetype, kind: 'image', size: bytes.length,
                  sourceEventId: String(input.id), chatId: String(input.chat_id), accountId: String(config.accountId || 'main'),
                }]));
                form.append('eventId', String(input.id));
                form.append('chatId', String(input.chat_id));
                form.append('accountId', String(config.accountId || 'main'));
                try {
                  const uploaded = await api('/api/connectors/whatsapp/inbound-media', {method: 'POST', body: form});
                  attachments = Array.isArray(uploaded?.attachments) ? uploaded.attachments : [];
                  if (attachments.length !== 1) throw new Error('group_attachment_upload_unconfirmed');
                  db.prepare('INSERT OR IGNORE INTO input_media_uploads(id,attachments,created_at) VALUES(?,?,?)')
                    .run(input.id, JSON.stringify(attachments), new Date().toISOString());
                  db.prepare("INSERT INTO input_media_upload_attempts(id,attempts,state) VALUES(?,0,'uploaded') ON CONFLICT(id) DO UPDATE SET state='uploaded'")
                    .run(input.id);
                  await removeStagedFile(realPath, realRoot);
                } catch {
                  attachments = [];
                  const attempts = Number(priorAttempt?.attempts || 0) + 1;
                  if (attempts >= 3) {
                    db.prepare(`INSERT INTO input_media_upload_attempts(id,attempts,state) VALUES(?,?,'skipped')
                      ON CONFLICT(id) DO UPDATE SET attempts=excluded.attempts,state=excluded.state`).run(input.id, attempts);
                    inputBody = [inputBody, '[WhatsApp attachment skipped: upload failed after 3 attempts]'].filter(Boolean).join('\n\n');
                    await removeStagedFile(realPath, realRoot);
                  } else {
                    rememberUploadFailure(input.id, attempts);
                    throw new Error('group_attachment_upload_retry');
                  }
                }
              }
            }
          }
        }
      }
      if (!inputBody) inputBody = attachments.length
        ? `[Image attached: ${String(input.media_filename || 'image')}]`
        : '[WhatsApp attachment received]';
      const own = input.quote_row ? ownReplyFor(input.quote_id) : null;
      const quoted = buildReplyTo(input, {own: own ? {text: own.text || input.quote_body || '', sentAt: own.sentAt || null} : null,
        ownChatId: config.ownChatId, timeZone: config.timeZone || env.ORKESTR_TIMEZONE || 'Europe/Berlin'});
      const response = await api(`/api/threads/${encodeURIComponent(group.threadId)}/input`, {method: 'POST', body: {
        ...metadata, text: `[WhatsApp: ${group.name}]\n\n${quoted ? `${quoted.line}\n\n` : ''}${inputBody}`,
        ...(quoted ? {replyTo: quoted.replyTo} : {}), ...(attachments.length ? {attachments} : {}), source: 'whatsapp_group_relay',
        parseCommands: false, controlAllowed: false, idempotencyKey: `group:${key(input.id)}`,
      }});
      const messageId = response.message?.id || response.messageId;
      if (!messageId) throw new Error('group_input_unacknowledged');
      db.prepare('INSERT OR IGNORE INTO routed(id,thread_id,message_id) VALUES(?,?,?)').run(input.id, group.threadId, messageId);
      route = db.prepare('SELECT * FROM routed WHERE id=?').get(input.id);
      log({event: 'input_routed', threadId: group.threadId, messageId});
    }
    const suppressUpdates = threadSuppressesUpdates(routeThread);
    const {answers, messages} = await answersFor(group, route, suppressUpdates);
    for (const answer of answers) {
      await deliverAnswer(input, group, answer, messages);
      if (['final_answer', 'final'].includes(answer.phase)) db.prepare('UPDATE routed SET completed=1 WHERE id=?').run(input.id);
    }
  }

  // A reply posted after the turn completed (a bound api-session answer, which V1
  // parents to the latest relay-routed input) is delivered once through the same
  // durable payload/receipt journal. Only each group's newest completed input
  // inside the window is watched, polled at most every LATE_REPLY_POLL_MS.
  const lastLatePoll = new Map();
  async function deliverLateReplies(inputs) {
    const latest = new Map();
    for (const input of inputs) if (!heldInputIds.has(input.id) && groups.has(input.chat_id)) latest.set(input.chat_id, input);
    for (const [chatId, input] of latest) {
      const group = groups.get(chatId);
      const at = Date.parse(input.created_at);
      if (!Number.isFinite(at) || now() - at > LATE_REPLY_WINDOW_MS) continue;
      const route = db.prepare('SELECT * FROM routed WHERE id=? AND completed=1').get(input.id);
      if (!route || now() - (lastLatePoll.get(chatId) || 0) < LATE_REPLY_POLL_MS) continue;
      if (routeFence && fencedGroup(group)) {
        const active = routeFence.current();
        if (active?.route !== config.routeControl.routeId || at < Date.parse(active.since)) continue;
      }
      lastLatePoll.set(chatId, now());
      try {
        const page = await api(`/api/threads/${encodeURIComponent(group.threadId)}/messages?limit=50`);
        const messages = page.messages || [];
        const late = messages.filter(m => m.role === 'assistant' && m.state === 'completed' && finalPhases.has(m.phase)
            && lateSources.has(m.source) && m.parentMessageId === route.message_id
            && Date.parse(m.createdAt) >= at && Date.parse(m.createdAt) - at <= LATE_REPLY_WINDOW_MS)
          .sort((a, b) => Number(a.cursor || 0) - Number(b.cursor || 0));
        for (const answer of late) await deliverAnswer(input, group, answer, messages);
        errors.delete(`late:${input.id}`);
      } catch (error) {
        const code = errorCode(error);
        if (errors.get(`late:${input.id}`) !== code) log({event: 'group_relay_error', threadId: group.threadId, code});
        errors.set(`late:${input.id}`, code);
      }
    }
  }

  return {
    close() { routeFence?.close(); for (const registry of registries.values()) registry.close?.(); if (!relayDb) db.close(); if (!inboxDb) inbox.close(); },
    async tick() {
      await reconcileRegistrations();
      if (inbox.prepare("SELECT 1 FROM group_send WHERE state IN ('sending','uncertain') LIMIT 1").get())
        return {ok: false, error: 'group_delivery_requires_review'};
      const inputs = readGroupInputs(inbox);
      let held = 0, excluded = 0;
      for (const input of inputs) {
        if (heldInputIds.has(input.id)) { held++; continue; }
        const group = groups.get(input.chat_id);
        if (!group) { excluded++; continue; }
        try { await routeInput(input, group); errors.delete(input.id); }
        catch (error) {
          const code = errorCode(error);
          if (errors.get(input.id) !== code) log({event: 'group_relay_error', threadId: group.threadId, code});
          errors.set(input.id, code);
        }
      }
      if (!inbox.prepare("SELECT 1 FROM group_send WHERE state IN ('sending','uncertain') LIMIT 1").get())
        await deliverLateReplies(inputs);
      return {ok: errors.size === 0, groups: groups.size, received: inputs.length,
        configuredHolds: heldInputIds.size, held, excluded,
        routed: db.prepare('SELECT count(*) n FROM routed').get().n,
        completed: db.prepare('SELECT count(*) n FROM routed WHERE completed=1').get().n,
        sent: db.prepare('SELECT count(*) n FROM replies').get().n,
        errors: [...new Set(errors.values())]};
    },
  };
}
