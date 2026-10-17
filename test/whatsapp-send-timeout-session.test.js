import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { resetLocalWhatsAppBridgeForTest, sendLocalWhatsAppMessage, setLocalWhatsAppRuntimeForTest, setLocalWhatsAppRuntimeRecoveryHooksForTest } from '../packages/connectors/src/whatsapp-local-bridge.js';

test('a send acknowledgement timeout preserves the linked runtime and surfaces uncertainty', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'wa-timeout-preserve-'));
  const env = { ORKESTR_HOME: home, ORKESTR_WHATSAPP_ACCOUNT_IDS: 'fixture' };
  const calls = [];
  t.after(async () => { await resetLocalWhatsAppBridgeForTest(env); await fs.rm(home, { recursive: true, force: true }); });
  setLocalWhatsAppRuntimeForTest('fixture', { client: { async sendMessage() { calls.push('send'); throw new Error('whatsapp_send_message_timeout'); } } }, {}, env);
  setLocalWhatsAppRuntimeRecoveryHooksForTest({ async restartAccount() { calls.push('restart'); }, async startAccount() { calls.push('start'); } });
  await assert.rejects(sendLocalWhatsAppMessage({ accountId: 'fixture', chatId: 'fixture@g.us', text: 'Synthetic message', env }), /whatsapp_send_message_timeout/);
  assert.deepEqual(calls, ['send'], 'a slow acknowledgement is not evidence that the browser session is invalid');
});
