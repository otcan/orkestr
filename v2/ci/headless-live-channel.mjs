// CI-only: the real WASM bundle on the page-wide live channel against a
// synthetic server (docs/v2/live-channel.md). While the channel is healthy
// the sidebar is read only when a change is pushed; when the channel stalls
// (no heartbeat) the page marks it degraded and reads on the slow fallback
// timer instead of the old 4 s poll; when the server answers again it is live.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { A, createState, startMock } from './headless-workspace-mock.mjs';
import { createLive, pushChanged } from './headless-live-channel-mock.mjs';

assert.equal(process.env.CI, 'true', 'Run only in isolated CI');
assert.ok(process.env.UI_BUNDLE_DIR, 'UI_BUNDLE_DIR is required');
const SIDEBAR = '/api/v2/sidebar?include_hidden=true';
// Short but ordered: stall 1.5 s < sidebar legacy 4 s < fallback 6 s.
const TUNING = { stallMs: 1500, helloMs: 1500, fallbackMs: 6000, backoffScale: 0.2, graceMs: 2000 };
const state = createState();
state.live = createLive();
let name = 'Synthetic live chat';
state.sidebarEntries = (entry, now) => [entry(`v2:${A}`, name, now - 60000, { read_marker: 1 })];
const reads = [];
const { server, origin } = await startMock(process.env.UI_BUNDLE_DIR, state);
const errors = [];
let browser, page, stage = 'startup';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sidebarReads = () => state.requests.filter(r => r === 'GET /api/v2/sidebar').length;
const liveState = () => page.evaluate(() => document.documentElement.dataset.live);
try {
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  page = await browser.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.pathname === '/api/v2/sidebar') reads.push(Date.now());
  });
  await page.evaluateOnNewDocument(tuning => { globalThis.orkestrLiveTuning = tuning; }, TUNING);
  await page.setViewport({ width: 1280, height: 860 });
  stage = 'load';
  await page.goto(`${origin}/#conversation/${A}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#composer');
  await page.waitForFunction(n => document.querySelector('.conversation-sidebar')?.textContent.includes(n), { timeout: 15000 }, name);

  stage = 'live';
  // The WebSocket upgrade is refused (404), so the page uses the event stream.
  await page.waitForFunction(() => document.documentElement.dataset.live === 'live', { timeout: 10000 });
  const open = state.live.opens.at(-1);
  assert.ok(open.paths.includes(SIDEBAR), `sidebar watched: ${JSON.stringify(open.paths)}`);
  assert.ok(open.paths.some(p => p.endsWith('/intelligence')), 'conversation reads watched too');
  // Healthy and quiet: no sidebar poll for longer than two old intervals.
  const quietFrom = sidebarReads();
  await sleep(9000);
  assert.ok(sidebarReads() - quietFrom <= 1, `sidebar read ${sidebarReads() - quietFrom} times in 9 s without a change`);

  stage = 'push';
  name = 'Synthetic live chat renamed';
  const before = sidebarReads();
  const pushedAt = Date.now();
  assert.ok(pushChanged(state, SIDEBAR) >= 1, 'an open stream watches the sidebar');
  await page.waitForFunction(n => document.querySelector('.conversation-sidebar')?.textContent.includes(n), { timeout: 3000 }, name);
  assert.ok(sidebarReads() > before, 'a pushed change is read at once');
  assert.ok(Date.now() - pushedAt < 3000);

  stage = 'stall';
  state.live.stalled = true;
  const stalledAt = Date.now();
  await page.waitForFunction(() => document.documentElement.dataset.live === 'degraded', { timeout: 6000 });
  assert.ok(Date.now() - stalledAt < TUNING.stallMs + 2500, 'a missing heartbeat is noticed');
  const lastLive = reads.at(-1);
  // The sidebar is read again on the fallback timer, not the 4 s poll.
  await new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error('no fallback read')), TUNING.fallbackMs + 8000);
    const check = setInterval(() => { if (reads.at(-1) !== lastLive) { clearInterval(check); clearTimeout(deadline); resolve(); } }, 50);
  });
  const fallbackGap = reads.at(-1) - Math.max(lastLive, stalledAt);
  assert.ok(fallbackGap >= TUNING.fallbackMs - 1000, `fallback read after ${fallbackGap} ms, not the 4 s poll`);
  assert.equal(await liveState(), 'degraded');
  assert.ok(state.live.opens.length >= 2, 'the page keeps trying to reconnect');

  stage = 'recover';
  state.live.stalled = false;
  await page.waitForFunction(() => document.documentElement.dataset.live === 'live', { timeout: 15000 });
  assert.ok(state.live.opens.some(o => o.resume === '1'), 'reconnects say so');
  assert.ok(state.live.opens.some(o => o.fallback_polls >= 1), 'fallback polls are reported to the server');
  assert.equal(await page.$('.connection-bar'), null, 'no reconnect bar once live again');
  assert.deepEqual(errors, [], 'Browser rendering errors');
  console.log(`PASS: live channel (${state.live.opens.length} opens; fallback read after ${fallbackGap} ms; ${sidebarReads()} sidebar reads in total)`);
} catch (error) {
  console.error(JSON.stringify({ stage, error: error.message, requests: state.requests.slice(-30), opens: state.live.opens, pageErrors: errors,
    live: await page?.evaluate(() => document.documentElement.dataset.live).catch(() => null) }));
  throw error;
} finally {
  await browser?.close();
  server.close();
  server.closeAllConnections?.();
}
