#!/usr/bin/env node
// Orkestr V2 OSS release-candidate end-to-end acceptance (Docker quickstart path).
//
// Drives a clean Linux target over SSH exactly like a new user: clone the
// candidate ref, build/start with Compose, create the owner in the real web UI,
// sign in to Codex (device code, completed by a human), configure, then check
// Quick (Fast) and Deep answers, a German follow-up in context, Stop, and
// shutdown. The job tracker step is optional.
//
// No secrets live in this file or its output. The owner password is generated
// per run and kept in memory; the bootstrap token is read into memory only;
// provider logins happen inside the container through the official CLI.
// See README.md for usage.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values: opt } = parseArgs({ options: {
  target: { type: 'string' },              // user@host of a clean Linux x86_64 machine with Docker + Compose v2
  'ssh-key': { type: 'string' },
  ref: { type: 'string' },                 // tag, branch or commit to accept
  repo: { type: 'string', default: 'https://github.com/otcan/orkestr.git' },
  'prebuilt-image': { type: 'string' },    // optional `docker save` archive on the target instead of building
  out: { type: 'string', default: './oss-e2e-out' },
  'socks-port': { type: 'string', default: '19189' },
  'login-timeout-min': { type: 'string', default: '15' },
  'with-claude': { type: 'boolean', default: false }, // require an existing Claude login in the credentials volume
  'reset-state': { type: 'boolean', default: false }, // delete only the state volume first (new owner); provider logins are kept
  'with-tracker': { type: 'boolean', default: false },
  'stop-after-ms': { type: 'string', default: '5000' },
  'keep-running': { type: 'boolean', default: false },
  'skip-install': { type: 'boolean', default: false }, // reuse a running install of --ref from an earlier run
  'no-sandbox': { type: 'boolean', default: false },   // hosts whose AppArmor blocks Chrome's user-namespace sandbox
  wipe: { type: 'boolean', default: false }, // log providers out and delete the volumes at the end
} });
if (!opt.target || !opt.ref) {
  console.error('usage: oss_e2e.mjs --target user@host --ref <tag|branch|sha> [--ssh-key k] [--prebuilt-image path] [--reset-state] [--with-claude] [--with-tracker] [--wipe] [--out dir]');
  process.exit(2);
}
const ORIGIN = 'http://127.0.0.1:19822';
const COMPOSE = 'docker compose -f v2/packaging/oss/compose.yaml';
const DIR = '~/orkestr-e2e';
mkdirSync(opt.out, { recursive: true });
const sshBase = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', ...(opt['ssh-key'] ? ['-i', opt['ssh-key']] : [])];
const report = { ref: opt.ref, target: opt.target.replace(/^.*@/, ''), started: new Date().toISOString(), steps: [] };
const save = () => writeFileSync(join(opt.out, 'report.json'), JSON.stringify(report, null, 2));

function ssh(command, { input, check = true, timeout = 60 * 60 * 1000 } = {}) {
  const r = spawnSync('ssh', [...sshBase, opt.target, command], { input, encoding: 'utf8', timeout, maxBuffer: 64 << 20 });
  if (check && r.status !== 0) throw new Error(`remote command failed (${r.status}): ${command.slice(0, 120)}\n${(r.stderr || '').slice(-800)}`);
  return r.stdout || '';
}
async function step(name, fn, { optional = false } = {}) {
  const t0 = Date.now();
  const entry = { name, result: 'fail', ms: 0 };
  report.steps.push(entry);
  console.log(`== ${name}`);
  try {
    Object.assign(entry, await fn() || {});
    entry.result = entry.result === 'fail' ? 'pass' : entry.result;
  } catch (e) {
    entry.result = 'fail';
    entry.error = String(e.message || e).slice(0, 2000);
  }
  entry.ms = Date.now() - t0;
  console.log(`   ${entry.result} in ${(entry.ms / 1000).toFixed(1)}s${entry.error ? ' : ' + entry.error.split('\n')[0] : ''}`);
  save();
  if (entry.result === 'fail' && !optional) throw new Error(`step ${name} failed`);
  return entry;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- browser through a SOCKS tunnel, so the origin is the target's own loopback ----------
let browser, page, tunnel;
async function openBrowser() {
  tunnel = spawn('ssh', [...sshBase, '-N', '-o', 'ExitOnForwardFailure=yes', '-D', `127.0.0.1:${opt['socks-port']}`, opt.target], { stdio: 'ignore' });
  await sleep(2500);
  let puppeteer;
  try { puppeteer = (await import('puppeteer')).default; } catch { puppeteer = (await import('puppeteer-core')).default; }
  browser = await puppeteer.launch({
    headless: true, executablePath: process.env.CHROME_PATH || undefined,
    args: [...(opt['no-sandbox'] ? ['--no-sandbox'] : []), `--proxy-server=socks5://127.0.0.1:${opt['socks-port']}`, '--proxy-bypass-list=<-loopback>', '--no-first-run'],
    defaultViewport: { width: 1280, height: 860 },
  });
  page = await browser.newPage();
}
const shot = name => page.screenshot({ path: join(opt.out, `${name}.png`) });
const bodyText = () => page.evaluate(() => document.body.innerText);
async function click(text, timeout = 30000) {
  await page.waitForFunction(t => [...document.querySelectorAll('button,a')].some(b => b.textContent.trim() === t && !b.disabled), { timeout }, text);
  await page.evaluate(t => [...document.querySelectorAll('button,a')].find(b => b.textContent.trim() === t && !b.disabled).click(), text);
}
const api = path => page.evaluate(async p => { const r = await fetch(p, { cache: 'no-store' }); return { status: r.status, body: r.status === 200 ? await r.json() : null }; }, path);
const bubbles = () => page.evaluate(() => [...document.querySelectorAll('*')]
  .filter(e => /^(Assistant|You)\n/.test(e.innerText || '') && e.innerText.length < 20000 && ![...e.children].some(c => /^(Assistant|You)\n/.test(c.innerText || '')))
  .map(e => e.innerText.trim()));

const owner = { username: 'e2e-owner', password: randomBytes(18).toString('base64url') };
async function signIn() {
  await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
  await sleep(2500);
  if (await page.$('#username')) {
    await page.type('#username', owner.username);
    await page.type('#password', owner.password);
    await click('Continue');
    await sleep(3000);
  }
}
async function openConversation(id) {
  await page.goto(`${ORIGIN}/#conversation/${id}`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#composer', { timeout: 60000 });
  await sleep(1500);
}

// Sends one message and records Fast and Deep phases separately (ms after Send).
async function exchange(conv, text, { stopAfterMs = 0, timeoutMs = 300000 } = {}) {
  const fast0 = (await api(`/api/v2/conversations/${conv}/fast/execution`)).body?.run_id ?? null;
  const deep0 = (await api(`/api/v2/conversations/${conv}/execution`)).body?.run_id ?? null;
  const before = (await bubbles()).length;
  await page.type('#composer', text);
  const t0 = Date.now();
  await click('Send');
  const out = { fast: {}, deep: {}, stop: null };
  let stopped = false;
  while (Date.now() - t0 < timeoutMs) {
    await sleep(500);
    const ms = Date.now() - t0;
    const f = (await api(`/api/v2/conversations/${conv}/fast/execution`)).body;
    const d = (await api(`/api/v2/conversations/${conv}/execution`)).body;
    if (f && f.run_id !== fast0 && !(f.phase in out.fast)) out.fast[f.phase] = ms;
    if (d && d.run_id !== deep0 && !(d.phase in out.deep)) out.deep[d.phase] = ms;
    if (stopAfterMs && !stopped && d?.run_id !== deep0 && d?.phase === 'running' && ms >= stopAfterMs) {
      await shot('stop-before');
      await click('Stop');
      stopped = true;
      out.stop = { clicked_ms: Date.now() - t0 };
    }
    if (stopped && !out.stop.ui_stopped_ms && /\bStopped\b/.test(await bodyText())) out.stop.ui_stopped_ms = ms;
    const deepDone = d && d.run_id !== deep0 && /^(completed|failed|cancelled)$/.test(d.phase);
    if (deepDone && (!stopped || out.stop.ui_stopped_ms)) break;
  }
  await sleep(2500);
  out.replies = (await bubbles()).slice(before).filter(b => b.startsWith('Assistant')).map(b => b.replace(/^Assistant\n+/, '').replace(/\n+↩︎ Reply.*$/s, '').slice(0, 600));
  return out;
}

async function waitForLogin(provider, minutes) {
  const status = provider === 'codex'
    ? `${COMPOSE} exec -T --user 10001:10001 -e HOME=/credentials/home -e CODEX_HOME=/credentials/codex orkestr /opt/orkestr/providers/codex login status`
    : `${COMPOSE} exec -T --user 10001:10001 -e HOME=/credentials/home -e CLAUDE_CONFIG_DIR=/credentials/claude orkestr /opt/orkestr/providers/claude auth status`;
  // The CLIs print their status on stderr. Never start a new login over an existing one:
  // the device flow replaces the stored login before the person completes it.
  const ok = () => { const r = ssh(`cd ${DIR} && ${status} 2>&1`, { check: false }); return provider === 'codex' ? /Logged in using ChatGPT/.test(r) : /"loggedIn":\s*true/.test(r); };
  if (ok()) return { reused_login: true };
  if (provider === 'claude') throw new Error('Claude is not signed in; sign in once on the target (orkestr-beta login claude) before using --with-claude');
  // Start the official device/browser login on the target; show its URL and code to the operator.
  const log = `/tmp/orkestr-e2e-login-${provider}.log`;
  ssh(`cd ${DIR} && (nohup script -qfc "${COMPOSE} exec orkestr orkestr-beta login ${provider}" /dev/null > ${log} 2>&1 &) ; sleep 8; true`);
  const shown = ssh(`grep -aE 'https://|^ +[A-Z0-9]{4}-[A-Z0-9]{4,5}' ${log} || true`);
  console.log(`\n>>> ${provider} sign-in needed. Open the link and complete it (expires in ~15 min):\n${shown}\n`);
  const deadline = Date.now() + minutes * 60000;
  while (Date.now() < deadline) { await sleep(10000); if (ok()) { ssh(`rm -f ${log}`, { check: false }); return { reused_login: false }; } }
  ssh(`rm -f ${log}`, { check: false });
  throw new Error(`${provider} login not completed within ${minutes} min`);
}

let conv;
try {
  await step('1-install', async () => {
    const prebuilt = opt['prebuilt-image'];
    if (opt['skip-install']) {
      const sha = ssh(`cd ${DIR} && git rev-parse HEAD`).trim();
      const health = ssh('curl -fsS http://127.0.0.1:19822/api/v2/health', { check: false });
      if (!health.includes(sha)) throw new Error('no healthy install of the checked-out commit to reuse');
      return { commit: sha, image: 'reused-running-install' };
    }
    if (opt['reset-state']) ssh(`cd ${DIR} 2>/dev/null && ${COMPOSE} down >/dev/null 2>&1; docker volume rm orkestr-v2-beta_state >/dev/null 2>&1; true`, { check: false });
    ssh(`set -e; rm -rf ${DIR}; git clone -q --no-checkout ${opt.repo} ${DIR}; cd ${DIR}; git fetch -q origin '${opt.ref}'; git checkout -q --detach FETCH_HEAD; ` +
      `printf 'ORKESTR_SOURCE_COMMIT=%s\\n' "$(git rev-parse HEAD)" > v2/packaging/oss/.env; ` +
      (prebuilt ? `docker load -i ${prebuilt} >/dev/null; ${COMPOSE} up -d --no-build` : `${COMPOSE} up -d --build`) + ' >/dev/null 2>&1');
    const sha = ssh(`cd ${DIR} && git rev-parse HEAD`).trim();
    let health = '';
    for (let i = 0; i < 120 && !health; i++) { health = ssh('curl -fsS http://127.0.0.1:19822/api/v2/health', { check: false }); if (!health) await sleep(2000); }
    if (!health.includes(sha)) throw new Error('health does not report the checked-out commit');
    return { commit: sha, image: prebuilt ? 'prebuilt' : 'source-build' };
  });
  await openBrowser();
  await step('2-owner-account', async () => {
    const token = ssh(`cd ${DIR} && ${COMPOSE} exec -T --user 10001:10001 orkestr cat /state/bootstrap.token`).trim();
    await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#username');
    await click('First-time setup');
    await page.waitForSelector('#bootstrap');
    await page.type('#username', owner.username);
    await page.type('#password', owner.password);
    await page.type('#bootstrap', token);
    await click('Continue');
    await page.waitForFunction(() => !document.querySelector('#bootstrap'), { timeout: 30000 });
    await sleep(3000);
    await shot('2-owner-signed-in');
    return { first_screen: (await bodyText()).slice(0, 300) };
  });
  await step('3-provider-login', async () => {
    const r = { codex: await waitForLogin('codex', Number(opt['login-timeout-min'])) };
    if (opt['with-claude']) r.claude = await waitForLogin('claude', Number(opt['login-timeout-min']));
    return r;
  });
  await step('4-connect', async () => {
    const out = ssh(`cd ${DIR} && ${COMPOSE} exec -T orkestr orkestr-beta configure 2>&1 && ${COMPOSE} restart orkestr >/dev/null 2>&1`,
      { input: `${owner.username}\n${owner.password}\n` });
    for (let i = 0; i < 60; i++) { if (ssh('curl -fsS http://127.0.0.1:19822/api/v2/health', { check: false })) break; await sleep(2000); }
    await signIn();
    const beta = await api('/api/v2/beta');
    if (beta.status !== 200) throw new Error(`beta discovery ${beta.status} after configure`);
    conv = beta.body.conversation_id;
    return { configure: out.replace(/password.*$/gim, '').trim().split('\n').slice(-2).join(' | ') };
  });
  await step('5a-chat-quick-and-deep', async () => {
    await openConversation(conv);
    const r = await exchange(conv, 'In one sentence: what can you help me with?');
    await shot('5a-first-answer');
    if (!('completed' in r.deep) || r.replies.length === 0) throw new Error('no completed Deep answer: ' + JSON.stringify(r).slice(0, 500));
    return { fast_ms: r.fast.completed ?? null, deep_ms: r.deep.completed, replies: r.replies };
  });
  await step('5b-followup-german', async () => {
    const r = await exchange(conv, 'Say that again in German.');
    await shot('5b-german');
    const german = r.replies.some(t => /\b(ich|und|kann|dir|Ihnen|helfen|zu)\b/i.test(t) && /[äöüß]|\bich\b/i.test(t));
    if (!('completed' in r.deep) || !german) throw new Error('no German answer in context: ' + JSON.stringify(r.replies).slice(0, 500));
    return { fast_ms: r.fast.completed ?? null, deep_ms: r.deep.completed, replies: r.replies };
  });
  if (opt['with-tracker']) await step('6-job-tracker', async () => {
    await click('New conversation');
    await page.waitForSelector('#conversation-name');
    await page.type('#conversation-name', 'Job search');
    await click('Create conversation');
    await page.waitForFunction(() => /#conversation\/[0-9a-f-]{36}/.test(location.hash) && document.body.innerText.includes('Job search'), { timeout: 30000 });
    await sleep(2000);
    const jobs = page.url().match(/#conversation\/([0-9a-f-]{36})/)[1];
    await page.goto(`${ORIGIN}/#conversation/${jobs}/tracker`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await click('Set up job tracker');
    await click('Find mail folders');
    await sleep(8000);
    const mail = (await page.evaluate(() => (document.querySelector('section[aria-label="Mail folder setup"]') || document.body).innerText)).match(/(No Inbox\/Sent folders were found[^\n]*|Reading local mail is not available[^\n]*)/)?.[0] || 'folders offered';
    await shot('6-mail-step');
    await openConversation(jobs);
    const r = await exchange(jobs, 'I applied for Backend Engineer at Example GmbH today via LinkedIn. Please add it to my job tracker.');
    await page.goto(`${ORIGIN}/#conversation/${jobs}/tracker`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sleep(4000);
    const all = (await bodyText()).match(/All \((\d+)\)/)?.[1];
    await shot('6-tracker');
    return { result: 'recorded', mail_step: mail, row_appeared: Number(all) > 0, deep_ms: r.deep.completed ?? null, replies: r.replies };
  }, { optional: true });
  await step('7a-stop-mid-generation', async () => {
    await openConversation(conv);
    const r = await exchange(conv, 'Write a 2000-word story about a lighthouse.', { stopAfterMs: Number(opt['stop-after-ms']), timeoutMs: 180000 });
    await shot('7a-stopped');
    if (!r.stop?.ui_stopped_ms || r.deep.cancelled === undefined) throw new Error('Stop not confirmed: ' + JSON.stringify(r).slice(0, 500));
    return { clicked_ms: r.stop.clicked_ms, deep_cancelled_ms: r.deep.cancelled, ui_stopped_ms: r.stop.ui_stopped_ms };
  });
  await step('7b-shutdown', async () => {
    if (opt['keep-running']) return { result: 'skipped' };
    ssh(`cd ${DIR} && ${COMPOSE} down`);
    const ps = ssh(`cd ${DIR} && ${COMPOSE} ps -q`).trim();
    if (ps) throw new Error('containers still running');
    return {};
  });
} catch (e) {
  report.aborted = String(e.message || e);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (opt.wipe) {
    // Revoke the test sessions held in the credentials volume, then delete the volumes.
    ssh(`cd ${DIR} && ${COMPOSE} up -d --no-build >/dev/null 2>&1; sleep 5; ` +
      `${COMPOSE} exec -T --user 10001:10001 -e HOME=/credentials/home -e CODEX_HOME=/credentials/codex orkestr /opt/orkestr/providers/codex logout; ` +
      `${COMPOSE} exec -T --user 10001:10001 -e HOME=/credentials/home -e CLAUDE_CONFIG_DIR=/credentials/claude orkestr /opt/orkestr/providers/claude auth logout; ` +
      `${COMPOSE} down -v`, { check: false });
    report.wiped = true;
  }
  if (tunnel) tunnel.kill();
  report.finished = new Date().toISOString();
  report.passed = !report.aborted && report.steps.every(s => s.result !== 'fail');
  save();
  console.log(`\n${report.passed ? 'PASS' : 'FAIL'}: report ${join(opt.out, 'report.json')}`);
  process.exitCode = report.passed ? 0 : 1;
}
