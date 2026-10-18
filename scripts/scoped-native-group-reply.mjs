#!/usr/bin/env node
// Adapter for the existing group relay's wrapper contract. The native worker
// independently checks recipient, owner identity, original parent and dedupe.
import fs from 'node:fs';
import {requestWhatsAppWorker} from '../packages/connectors/src/whatsapp-worker-client.js';

try {
  const [command, to, requestId, parentId, text, ...extra] = process.argv.slice(2);
  const config = JSON.parse(fs.readFileSync(process.env.ORKESTR_WA_SCOPED_GROUP_CONFIG, 'utf8'));
  if (command !== 'group-reply' || extra.length || !config.workerAccountId
      || !config.groups.some(group => group.chatId === to)
      || !requestId || !parentId || !text || text.length > 3000)
    throw new Error('scoped_reply_invalid');
  const env = {...process.env, ORKESTR_WA_WORKER_URL: '',
    ORKESTR_WA_WORKER_TOKEN: process.env.ORKESTR_WA_WORKER_TOKEN || process.env.ORKESTR_WA_SERVICE_TOKEN
      || process.env.WHATSAPP_BRIDGE_TOKEN || process.env.WA_HTTP_TOKEN || process.env.ORKESTR_WHATSAPP_BRIDGE_TOKEN};
  const result = await requestWhatsAppWorker('/send-text', {method: 'POST', timeoutMs: 40000,
    body: {accountId: config.workerAccountId, to, requestId, parentId, text}}, env);
  if (result.ok !== true || !Array.isArray(result.ids) || !result.ids.length)
    throw new Error('scoped_reply_unconfirmed');
  process.stdout.write(JSON.stringify({ok: true, ids: result.ids, duplicate: result.duplicate === true}));
} catch (error) {
  const code = /^[a-z_]+$/.test(error.message) ? error.message : 'scoped_reply_failed';
  process.stderr.write(JSON.stringify({ok: false, error: code}) + '\n');
  process.exitCode = 1;
}
