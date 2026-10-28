#!/usr/bin/env node
// Adapter for the existing group relay's wrapper contract. The native worker
// independently checks recipient, owner identity, original parent and dedupe.
// `group-notify` carries a timer-run notification: the request id doubles as the
// notification id, which the worker authorizes against its own proof store.
// `group-send` reads one JSON payload from stdin instead of argv (no argument
// size limit): {kind: 'reply'|'notify', to, requestId, parentId, text}; or {kind: 'operator', to, requestId, text}
// for an operator notice (requestId `opnotice:<id>`, no parent; needs `operatorNotifications` in the config) or the
// same with `document: {filename, mimetype, text}` for a long reply's full text, or
// `file: {path, filename, mimetype, sha256}` for a file the assistant attached to the reply.
// A text may add `quotedMessageId` (a WhatsApp input id of the same group) to send
// it as a reply-quote; the transport drops a quote that names no input of that group.
import fs from 'node:fs';
import {requestWhatsAppWorker} from '../packages/connectors/src/whatsapp-worker-client.js';
import {SCOPED_SEND_MAX_TEXT_LENGTH, validQuotedMessageId, validReplyDocument} from '../packages/connectors/src/whatsapp-scoped-group-formatting.js';
import {validReplyFileShape} from '../packages/connectors/src/whatsapp-scoped-reply-files.js';
import {operatorNoticeText} from '../packages/connectors/src/whatsapp-scoped-operator-footer.js';

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
};

// A group registered at runtime (dynamicGroups) in the transport journal. The
// modules load only then: node:sqlite warns on stderr, which carries the
// wrapper's JSON error contract.
async function registered(config, chatId) {
  if (config.dynamicGroups === undefined || typeof chatId !== 'string') return false;
  const [{DatabaseSync}, dynamic] = await Promise.all([import('node:sqlite'),
    import('../packages/connectors/src/whatsapp-scoped-dynamic-groups.js')]);
  if (!dynamic.validateDynamicGroups(config)) return false;
  const db = new DatabaseSync(config.journalPath, {readOnly: true});
  try { return dynamic.createDynamicGroupView(db).has(chatId); } finally { db.close(); }
}

try {
  const [command, ...args] = process.argv.slice(2);
  const config = JSON.parse(fs.readFileSync(process.env.ORKESTR_WA_SCOPED_GROUP_CONFIG, 'utf8'));
  let request;
  if (command === 'group-send' && !args.length) {
    let input;
    try { input = await readStdin(); } catch { throw new Error('scoped_reply_invalid'); }
    request = {notify: input?.kind === 'notify', kind: input?.kind, to: input?.to, requestId: input?.requestId, parentId: input?.parentId,
      text: input?.text, document: input?.document, file: input?.file, quotedMessageId: input?.quotedMessageId};
  } else {
      const [to, requestId, parentId, text, ...extra] = args;
      if (extra.length) throw new Error('scoped_reply_invalid');
      request = {notify: command === 'group-notify', kind: command === 'group-notify' ? 'notify' : command === 'group-reply' ? 'reply' : '', to, requestId, parentId, text};
    }
    const {to, requestId, parentId, text, document, file, quotedMessageId} = request;
    if (request.kind === 'operator') {
      if (!config.workerAccountId || typeof text !== 'string' || !text.trim() || text.length > SCOPED_SEND_MAX_TEXT_LENGTH || parentId !== undefined
          || document !== undefined || file !== undefined || !/^opnotice:[A-Za-z0-9._-]{8,150}$/.test(requestId || '') || !config.groups.some(group => group.chatId === to))
        throw new Error('scoped_reply_invalid');
      const operatorEnv = {...process.env, ORKESTR_WA_WORKER_URL: '',
        ORKESTR_WA_WORKER_TOKEN: process.env.ORKESTR_WA_WORKER_TOKEN || process.env.ORKESTR_WA_SERVICE_TOKEN
          || process.env.WHATSAPP_BRIDGE_TOKEN || process.env.WA_HTTP_TOKEN || process.env.ORKESTR_WHATSAPP_BRIDGE_TOKEN};
      // The same compact notice footer (quota + q/load) as an Operator post
      // relayed through V1, in any configured group that opted into the footer.
      const noticeText = await operatorNoticeText({text, to, config, env: process.env, maxLength: SCOPED_SEND_MAX_TEXT_LENGTH,
        formatter: config.appendDebugFooter === true
          ? await import(config.formattingModulePath || '../packages/connectors/src/whatsapp-formatting.js').catch(() => null) : null,
        fetchQuota: async owner => (await import('../apps/cli/src/api-client.js'))
          .requestJson(`/api/quota/providers?ownerUserId=${encodeURIComponent(owner)}`, {timeoutMs: 1000})});
      const sent = await requestWhatsAppWorker('/send-text', {method: 'POST', timeoutMs: 40000,
        body: {accountId: config.workerAccountId, to, requestId, text: noticeText, operatorNotice: true}}, operatorEnv);
      if (sent.ok !== true || !Array.isArray(sent.ids) || !sent.ids.length) throw new Error('scoped_reply_unconfirmed');
      process.stdout.write(JSON.stringify({ok: true, ids: sent.ids, duplicate: sent.duplicate === true}));
    } else {
    const validBody = file !== undefined
      ? text === undefined && document === undefined && request.kind === 'reply' && validReplyFileShape(file)
      : document === undefined
        ? typeof text === 'string' && text && text.length <= SCOPED_SEND_MAX_TEXT_LENGTH
        : text === undefined && validReplyDocument(document);
    if (!['reply', 'notify'].includes(request.kind) || !config.workerAccountId
        || !(config.groups.some(group => group.chatId === to) || await registered(config, to))
        || typeof requestId !== 'string' || !requestId || typeof parentId !== 'string' || !parentId || !validBody
        || (quotedMessageId !== undefined && (file !== undefined || document !== undefined || !validQuotedMessageId(quotedMessageId))))
      throw new Error('scoped_reply_invalid');
    const env = {...process.env, ORKESTR_WA_WORKER_URL: '',
      ORKESTR_WA_WORKER_TOKEN: process.env.ORKESTR_WA_WORKER_TOKEN || process.env.ORKESTR_WA_SERVICE_TOKEN
        || process.env.WHATSAPP_BRIDGE_TOKEN || process.env.WA_HTTP_TOKEN || process.env.ORKESTR_WHATSAPP_BRIDGE_TOKEN};
    const base = {accountId: config.workerAccountId, to, requestId, parentId, ...(request.notify ? {notificationId: requestId} : {})};
    const result = file !== undefined
      ? await requestWhatsAppWorker('/send-file', {method: 'POST', timeoutMs: 120000,
        body: {...base, path: file.path, filename: file.filename, mimetype: file.mimetype, sha256: file.sha256}}, env)
      : document === undefined
      ? await requestWhatsAppWorker('/send-text', {method: 'POST', timeoutMs: 40000, body: {...base, text, ...(quotedMessageId ? {quotedMessageId} : {})}}, env)
      : await requestWhatsAppWorker('/send-document', {method: 'POST', timeoutMs: 40000,
        body: {...base, filename: document.filename, mimetype: document.mimetype, text: document.text}}, env);
    if (result.ok !== true || !Array.isArray(result.ids) || !result.ids.length)
      throw new Error('scoped_reply_unconfirmed');
    process.stdout.write(JSON.stringify({ok: true, ids: result.ids, duplicate: result.duplicate === true}));
  }
} catch (error) {
  const code = /^[a-z_]+$/.test(error.message) ? error.message : 'scoped_reply_failed';
  process.stderr.write(JSON.stringify({ok: false, error: code}) + '\n');
  process.exitCode = 1;
}
