import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { runWhatsAppAccountLifecycle } from '../packages/connectors/src/whatsapp-account-lifecycle.js';

test('worker lifecycle uses the managed worker for reconnect, phone pairing and QR', async t => {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    calls.push({ url: req.url, body: body ? JSON.parse(body) : null });
    if (req.url.startsWith('/qr.svg')) { res.setHeader('content-type', 'image/svg+xml'); res.end('<svg>synthetic</svg>'); }
    else { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, account: { state: 'starting' } })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const env = { ORKESTR_WA_WORKER_URL: `http://127.0.0.1:${server.address().port}` };
  assert.equal((await runWhatsAppAccountLifecycle({ mode: 'worker' }, 'account-a', 'reconnect', {}, env)).state, 'starting');
  await runWhatsAppAccountLifecycle({ mode: 'worker' }, 'account-a', 'pair', { phoneNumber: '15555550100' }, env);
  assert.equal(await runWhatsAppAccountLifecycle({ mode: 'worker' }, 'account-a', 'qr', {}, env), '<svg>synthetic</svg>');
  assert.deepEqual(calls, [
    { url: '/accounts/account-a/start', body: { resetRuntime: true } },
    { url: '/accounts/account-a/start', body: { phoneNumber: '15555550100', resetRuntime: false } },
    { url: '/qr.svg?accountId=account-a', body: null },
  ]);
});

test('external bridges remain unsupported by local lifecycle operations', async () => {
  await assert.rejects(runWhatsAppAccountLifecycle({ mode: 'external' }, 'account-a', 'reconnect'), /not_supported/);
});
