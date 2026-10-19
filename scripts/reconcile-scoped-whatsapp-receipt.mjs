#!/usr/bin/env node
// Operator maintenance, intentionally separate from automatic delivery. Reads
// fresh provider evidence; never retries, sends, changes scopes or restarts.
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync, backup} from 'node:sqlite';
import {requestWhatsAppWorker} from '../packages/connectors/src/whatsapp-worker-client.js';
import {reconcileAcceptedReceipt} from './lib/scoped-receipt-reconciliation.mjs';

const args = process.argv.slice(2);
const option = key => args.includes(key) ? args[args.indexOf(key) + 1] : null;
const configPath = option('--config'), requestId = option('--request-id'), auditRoot = option('--audit-dir');
if (!configPath || !requestId || !auditRoot) throw new Error('Required: --config --request-id --audit-dir [--apply]');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const db = new DatabaseSync(config.journalPath, {readOnly: true});
const row = db.prepare('SELECT * FROM group_send WHERE id=?').get(requestId);
if (!row || !config.groups.some(g => g.chatId === row.chat_id) || !config.routeControl?.dbPath) throw new Error('configured_request_required');
const health = await requestWhatsAppWorker('/health');
const account = health.accounts?.find(a => (a.id || a.accountId) === config.workerAccountId);
if (!account || account.ready !== true || account.authenticated !== true) throw new Error('authenticated_account_required');
const history = await requestWhatsAppWorker(`/accounts/${encodeURIComponent(config.workerAccountId)}/chats/${encodeURIComponent(row.chat_id)}/history?limit=50&mark_seen=false`, {timeoutMs:20000});
const evidence = {checkedAt:new Date().toISOString(), chatId:row.chat_id, authenticated:true, ready:true, messages:history.messages || history.history || []};
const params = {dbPath:config.journalPath, fencePath:config.routeControl.dbPath, routeId:config.routeControl.routeId, requestId, evidence};
const preview = reconcileAcceptedReceipt(params);
fs.mkdirSync(auditRoot, {recursive:true, mode:0o700});
const audit = fs.mkdtempSync(path.join(auditRoot, 'receipt-'));
fs.writeFileSync(path.join(audit, 'evidence.private.json'), JSON.stringify({row,evidence,preview}), {mode:0o600});
if (args.includes('--apply')) {
  await backup(db, path.join(audit,'transport.before.sqlite'));
  const fence = new DatabaseSync(config.routeControl.dbPath, {readOnly:true});
  try { await backup(fence,path.join(audit,'fence.before.sqlite')); } finally { fence.close(); }
}
db.close();
const result = args.includes('--apply') ? reconcileAcceptedReceipt({...params,apply:true}) : preview;
fs.writeFileSync(path.join(audit,'result.json'),JSON.stringify(result),{mode:0o600});
console.log(JSON.stringify({audit,...result}));
