// CI-only synthetic browser acceptance. Never uses a host desktop/profile.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
import { submitLogin } from './headless-login.mjs';
import { discoveryMode } from './headless-beta.mjs';
import { verifyIntake } from './headless-intake.mjs';
import { installIntakeCapture } from './headless-receipt-capture.mjs';

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
let page;
let stage = 'startup';
const network = [];
const errors = [];
try {
  for (let attempt = 0; ; attempt++) {
    if (server.exitCode !== null) throw new Error('Synthetic server exited');
    try { if ((await fetch(`${origin}/api/v2/health`)).ok) break; } catch {}
    assert.ok(attempt < 100, 'Server readiness timeout');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  page = await browser.newPage();
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin === origin && url.pathname.startsWith('/api/v2/')) {
      network.push({ route: url.pathname.replace(/[0-9a-f-]{36}/g, ':id'), status: response.status() });
      if (network.length > 40) network.shift();
    }
  });
  stage = 'login';
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
  await submitLogin(page, origin, clickText, true);
  const checkSurface = async expected => {
    const reply = await page.evaluate(async () => {
      const response = await fetch('/api/v2/beta', { redirect: 'error', cache: 'no-store' });
      return { status: response.status, body: await response.json() };
    });
    const mode = discoveryMode(reply.status, reply.body);
    if (expected) assert.deepEqual(mode, expected, 'Discovery changed across authentication/reload');
    if (mode.kind === 'configured') await page.waitForSelector('#composer');
    else {
      await page.waitForFunction(() => document.body.textContent.includes('Models are not connected yet. Sign in to Codex inside the container'));
      assert.equal(await page.$('#composer'), null, 'Unconfigured beta exposed composer');
      assert.equal(await page.$('nav[aria-label="Main"]'), null, 'Unconfigured beta exposed scoped navigation');
    }
    return mode;
  };
  const mode = await checkSurface();
  const cookies = await browser.cookies();
  const session = cookies.find(cookie => cookie.name === 'orkestr_v2_session');
  assert.ok(session?.httpOnly);
  assert.equal(session.sameSite, 'Strict');
  if (mode.kind === 'configured') {
  stage = 'durable-intake';
  const text = 'Synthetic CI rendering message';
  const conversation = mode.conversation;
  const path = `/api/v2/conversations/${conversation}/messages`;
  // Capture a cloned page fetch body before Send; CDP may not retain it.
  await page.evaluate(installIntakeCapture, path);
  // Register before Send; transient presentation text is not durable evidence.
  const responsePending = page.waitForResponse(response =>
    response.url() === `${origin}${path}` && response.request().method() === 'POST');
  await page.type('#composer', text);
  const [response] = await Promise.all([responsePending, clickText('Send')]);
  assert.equal(response.status(), 202, 'Fresh input must be admitted');
  const input = JSON.parse(response.request().postData());
  stage = 'receipt-capture';
  await page.waitForFunction(() => ['complete','failed'].includes(globalThis.__orkestrCIReceipt?.state));
  const captured = await page.evaluate(() => globalThis.__orkestrCIReceipt);
  assert.equal(captured.state, 'complete', 'Actual Send receipt capture failed');
  assert.equal(captured.status, 202);
  const receipt = captured.body;
  stage = 'canonical-history';
  const snapshot = await page.evaluate(async conversation => {
    const response = await fetch(`/api/v2/conversations/${conversation}?after=0&limit=100`);
    if (response.status !== 200) throw new Error('Canonical history unavailable');
    return response.json();
  }, conversation);
  verifyIntake({ input, receipt, snapshot, conversation, text });
  stage = 'reload-render';
  await page.reload({ waitUntil: 'networkidle2' });
  await checkSurface(mode);
  await page.waitForFunction(() => document.querySelector('.messages')?.textContent.includes('Synthetic CI rendering message'));
  const rejected = await page.evaluate(async conversation => {
    const response = await fetch(`/api/v2/conversations/${conversation}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_message_id: 'synthetic-csrf-rejected', text: 'must not persist' }),
    });
    return response.status;
  }, conversation);
  assert.equal(rejected, 403);
  } else {
    stage = 'blocked-cookie-resume';
    await page.reload({ waitUntil: 'networkidle2' });
    await checkSurface(mode);
  }
  await clickText('Sign out');
  await page.waitForSelector('#username');
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('#username');
  // Exercise a fresh password login after server-confirmed revocation, not just resume.
  await page.type('#username', 'synthetic-admin');
  await page.type('#password', 'synthetic-password-000000');
  await submitLogin(page, origin, clickText);
  await checkSurface(mode);
  const replacement = (await browser.cookies()).find(cookie => cookie.name === 'orkestr_v2_session');
  assert.ok(replacement?.httpOnly);
  assert.notEqual(replacement.value, session.value, 'Login reused revoked session');
  assert.equal(bearerSeen, false, 'Browser sent machine authority');
  assert.deepEqual(errors, [], 'Browser rendering errors');
  console.log(mode.kind === 'configured'
    ? 'PASS: configured beta rendering, exact-scope durable intake/history, cookie resume, CSRF rejection, logout and fresh login; no provider qualification'
    : 'PASS: explicitly unconfigured beta blocked gate, cookie resume, visible logout and fresh login ONLY; durable intake/history/provider browser checks NOT EXERCISED');
} catch (error) {
  // No headers, cookies, input values, raw response bodies or server logs.
  const dom = await page?.evaluate(() => ({
    composer: Boolean(document.querySelector('#composer')),
    login: Boolean(document.querySelector('#username')),
    renderedMessages: document.querySelectorAll('.messages li').length,
    receiptCapture: globalThis.__orkestrCIReceipt?.state ?? 'not-installed',
  })).catch(() => null);
  console.error(JSON.stringify({ stage, error: error.name, network, dom, pageErrorCount: errors.length }));
  throw error;
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
