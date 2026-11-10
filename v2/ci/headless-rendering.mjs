// CI-only synthetic browser acceptance. Never uses a host desktop/profile.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';

assert.equal(process.env.CI, 'true', 'Run only in isolated CI');
const home = await mkdtemp(join(tmpdir(), 'orkestr-v2-browser-'));
const origin = 'http://127.0.0.1:47100';
const bootstrap = 'synthetic-ci-bootstrap-token-000000000000';
const server = spawn(process.env.V2_SERVER, [], { env: {
  PATH: process.env.PATH, LANG: 'C.UTF-8', ORKESTR_V2_HOME: home,
  ORKESTR_V2_BIND: '127.0.0.1:47100', ORKESTR_V2_BOOTSTRAP_TOKEN: bootstrap,
  ORKESTR_V2_UI_DIST: process.env.UI_BUNDLE_DIR,
}, stdio: ['ignore', 'ignore', 'pipe'] });
// Do not print server output, cookies, credentials or request headers.
server.stderr.resume();
let browser;
try {
  for (let attempt = 0; ; attempt++) {
    if (server.exitCode !== null) throw new Error('Synthetic server exited');
    try { if ((await fetch(`${origin}/api/v2/health`)).ok) break; } catch {}
    assert.ok(attempt < 100, 'Server readiness timeout');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const errors = [];
  let bearerSeen = false;
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.headers().authorization) bearerSeen = true; });
  await page.goto(origin, { waitUntil: 'networkidle2' });
  await page.waitForSelector('#username');
  const clickText = async text => {
    const found = await page.evaluate(text => {
      const button = [...document.querySelectorAll('button')].find(b => b.textContent === text);
      if (!button) return false;
      button.click(); return true;
    }, text);
    assert.ok(found, `Missing button: ${text}`);
  };
  await clickText('First-time setup');
  await page.type('#username', 'synthetic-admin');
  await page.type('#password', 'synthetic-password-000000');
  await page.type('#bootstrap', bootstrap);
  await clickText('Continue');
  await page.waitForSelector('#composer');
  const cookies = await browser.cookies();
  const session = cookies.find(cookie => cookie.name === 'orkestr_v2_session');
  assert.ok(session?.httpOnly);
  assert.equal(session.sameSite, 'Strict');
  await page.type('#composer', 'Synthetic CI rendering message');
  await clickText('Send');
  await page.waitForFunction(() => document.body.textContent.includes('Input durably accepted'));
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('#composer');
  await page.waitForFunction(() => document.querySelector('.messages')?.textContent.includes('Synthetic CI rendering message'));
  const rejected = await page.evaluate(async () => {
    const session = await (await fetch('/api/v2/browser/session')).json();
    const response = await fetch(`/api/v2/conversations/${session.global_conversation_id}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_message_id: 'synthetic-csrf-rejected', text: 'must not persist' }),
    });
    return response.status;
  });
  assert.equal(rejected, 403);
  await clickText('Sign out');
  await page.waitForSelector('#username');
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('#username');
  assert.equal(bearerSeen, false, 'Browser sent machine authority');
  assert.deepEqual(errors, [], 'Browser rendering errors');
  console.log('PASS: CI headless rendering, cookie resume, durable intake, CSRF rejection and logout');
} finally {
  try {
    await browser?.close();
  } finally {
    try {
      if (server.exitCode === null) {
        const exited = new Promise(resolve => server.once('exit', resolve));
        server.kill('SIGKILL');
        await exited;
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }
}
