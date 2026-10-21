// CI-only rendering of the configured beta workspace against a synthetic API.
// Exercises the real WASM bundle at desktop and phone widths; no provider runs.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { A, C, createState, startMock } from './headless-workspace-mock.mjs';
import { mkdir } from 'node:fs/promises';

assert.equal(process.env.CI, 'true', 'Run only in isolated CI');
assert.ok(process.env.UI_BUNDLE_DIR, 'UI_BUNDLE_DIR is required');
const { server, state, origin } = await startMock(process.env.UI_BUNDLE_DIR);
const errors = [];
let browser, page, stage = 'startup';
const text = selector => page.$eval(selector, node => node.textContent);
const waitText = (snippet, timeout = 15000) => page.waitForFunction(s => document.body.textContent.includes(s), { timeout }, snippet);
const clickText = async label => {
  const found = await page.evaluate(label => {
    const button = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === label && !b.disabled);
    if (!button) return false;
    button.click(); return true;
  }, label);
  assert.ok(found, `Missing button: ${label}`);
};
const openDrawer = async label => {
  if (label !== 'phone') return;
  await page.click('.threads-toggle');
  await page.waitForFunction(() => document.querySelector('.workspace')?.dataset.sidebarOpen === 'true');
};
const rowText = async (name, selector) => page.evaluate((name, selector) => {
  const row = [...document.querySelectorAll('.conversation-row')].find(r => r.querySelector('.conversation-name')?.textContent === name);
  return row?.querySelector(selector)?.textContent ?? null;
}, name, selector);
const choose = name => page.evaluate(name => [...document.querySelectorAll('.conversation-choice')]
  .find(b => b.querySelector('.conversation-name')?.textContent === name).click(), name);
const screenshot = async (label, name) => {
  const dir = process.env.SCREENSHOT_DIR;
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${label}-${name}.png` });
};
const noHorizontalScroll = async () => {
  const { scroll, width } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  assert.ok(scroll <= width, `Horizontal page scroll at ${width}px (${scroll}px content)`);
};

export const scenarios = [
  ['archived-history', async () => {
    await page.waitForSelector('.archived-history li');
    await page.waitForFunction(() => document.querySelectorAll('.archived-messages > li').length === 50);
    const order = await page.evaluate(() => {
      const archived = document.querySelector('.archived-history');
      const native = [...document.querySelectorAll('.conversation-scroll *')].find(n => n.textContent === 'Native synthetic message');
      return Boolean(archived && native && (archived.compareDocumentPosition(native) & Node.DOCUMENT_POSITION_FOLLOWING));
    });
    assert.ok(order, 'Archived history must render before native messages');
    assert.match(await text('.archived-history > summary'), /50 loaded, more available/);
    await clickText('Load more imported history');
    await page.waitForFunction(() => document.querySelectorAll('.archived-messages > li').length === 60);
    assert.match(await text('.archived-history > summary'), /60 messages/);
  }],
  ['reload-recovery', async () => {
    const draft = () => page.$eval('#composer', node => node.value);
    const typeDraft = async value => { await page.focus('#composer'); await page.keyboard.type(value); };
    // An unsent draft survives a full reload.
    await typeDraft('Draft survives reload');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelector('#composer')?.value === 'Draft survives reload');
    // Intake succeeds, admission is uncertain, and the composer stays editable while busy.
    state.windowMode = 'uncertain'; state.windowDelayMs = 1500;
    await clickText('Send');
    await page.waitForFunction(() => document.querySelector('.message-composer button[type=submit]')?.disabled);
    await typeDraft(' + edit while busy');
    assert.equal(await draft(), 'Draft survives reload + edit while busy');
    await waitText('Send not confirmed');
    const first = state.windowPosts.at(-1);
    const intakes = Object.keys(state.intake).length;
    // Reload recovers the saved receipt and the exact uncertain work request.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitText('Message saved; work has not started yet');
    assert.equal(await draft(), 'Draft survives reload + edit while busy');
    state.windowMode = 'accept'; state.windowDelayMs = 0;
    await clickText('Retry send');
    await waitText('Sent. Waiting for a reply.');
    const retry = state.windowPosts.at(-1);
    assert.deepEqual(retry, first, 'Retry after reload must resend the exact original work request');
    assert.equal(Object.keys(state.intake).length, intakes, 'Retry after reload must not create another message');
    assert.equal(await draft(), 'Draft survives reload + edit while busy', 'Edits made after Send are kept');
  }],
  ['conversation-list', async label => {
    await openDrawer(label);
    await page.waitForFunction(() => document.querySelectorAll('.conversation-status').length >= 2, { timeout: 20000 });
    const badges = await page.$$eval('.conversation-choice', rows => Object.fromEntries(rows.map(r =>
      [r.querySelector('.conversation-name')?.textContent, r.querySelector('.conversation-status')?.textContent ?? ''])));
    assert.equal(badges['Research notes'], 'Working');
    assert.equal(badges['Queued errands'], 'Queued #2');
    assert.match(await text('.slot-summary'), /2 of 2 work slots in use · 3 queued/);
    await page.evaluate(() => [...document.querySelectorAll('.conversation-choice')].find(b => b.textContent.includes('Research notes')).click());
    await page.waitForFunction(() => document.querySelector('.conversation-heading h2')?.textContent === 'Research notes');
    if (label === 'phone') assert.equal(await page.$eval('.workspace', n => n.dataset.sidebarOpen), 'false', 'Selecting closes the phone drawer');
    await page.waitForSelector('#composer');
  }],
  ['tabs', async () => {
    for (const [tab, expected] of [['Work', 'Provider'], ['Projects', 'Create project'], ['Timers', 'Saved timer ID'], ['Memory', 'Optional saved facts'], ['Chat', 'Message']]) {
      await clickText(tab);
      await waitText(expected);
    }
    await clickText('Work');
    await waitText('Codex');
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(b => /^(Stop|Stop unavailable)$/.test(b.textContent.trim())));
    await waitText('Steer running work');
    await clickText('Projects');
    await waitText('Git: not_configured');
    await clickText('Errand project');
    // A listed conversation keeps its directory name; otherwise the project name is shown.
    await page.waitForFunction(() => ['Errand project', 'Queued errands'].includes(document.querySelector('.conversation-heading h2')?.textContent));
    await page.waitForSelector('#composer');
    assert.ok(page.url().endsWith('#conversation/00000000-0000-4000-8000-00000000000c'), 'Project opens its conversation');
  }],
  ['live-map', async () => {
    await clickText('Live map');
    await waitText('Busy synthetic group');
    await waitText('Synthetic running agent');
    await waitText('Delegated to V2');
    await waitText('Research notes');
    const body = () => page.evaluate(() => document.querySelector('.live-map').textContent);
    assert.ok(!(await body()).includes('Quiet synthetic group'), 'Active only hides idle views');
    assert.ok(!(await body()).includes('Synthetic finished agent'), 'Active only hides finished agents');
    await noHorizontalScroll();
    await clickText('All');
    await waitText('Quiet synthetic group');
    await page.evaluate(() => document.querySelectorAll('.live-view details').forEach(d => { d.open = true; }));
    await waitText('Synthetic finished agent');
    await noHorizontalScroll();
    await clickText('Chat');
    await page.waitForSelector('#composer');
  }],
  ['sidebar', async label => {
    await openDrawer(label);
    await page.waitForFunction(() => document.querySelectorAll('.conversation-row').length >= 4, { timeout: 20000 });
    // Newest activity first: the V1 group carries its worker's newer activity.
    const order = await page.$$eval('.conversation-row[data-depth="0"] .conversation-name', n => n.map(x => x.textContent));
    assert.deepEqual(order, ['Synthetic group', 'Research notes', 'Assistant', 'Queued errands']);
    assert.equal(await rowText('Synthetic group', '.choice-time'), '1m');
    assert.equal(await rowText('Assistant', '.choice-time'), '1d');
    assert.match(await rowText('Synthetic group', '.choice-badges'), /On V1.*Coordinator.*1 sub-chats/);
    assert.equal(await rowText('Research notes', '.choice-activity'), 'thinking… · 1 worker');
    // Unread replies until viewed; the open conversation (from Projects) is read.
    assert.equal(await rowText('Synthetic group', '.unread-badge'), '1');
    assert.equal(await rowText('Assistant', '.unread-badge'), null, 'Viewed at load');
    assert.equal(await rowText('Queued errands', '.unread-badge'), null, 'Open conversation');
    assert.equal(await rowText('Assistant', '.choice-preview'), 'Synthetic assistant answer');
    for (const id of [A, C]) assert.ok(state.marks.some(m => m.key === `v2:${id}`), 'Opening marks read on the server');
    // Sub-chats are collapsed under the parent until expanded.
    assert.equal(await page.$$eval('.conversation-row[data-depth="1"]', n => n.length), 0);
    await page.evaluate(() => [...document.querySelectorAll('.group-toggle')][0].click());
    await page.waitForFunction(() => document.querySelector('.conversation-row[data-depth="1"] .conversation-name')?.textContent === 'Synthetic group / Worker 1');
    await screenshot(label, 'sidebar');
    // The header shows live activity of the open conversation.
    await choose('Research notes');
    await page.waitForFunction(() => document.querySelector('.heading-activity')?.textContent === 'thinking… · 1 worker');
    // A linked V1 chat opens read-only with its recent history and badge.
    await openDrawer(label);
    await choose('Synthetic group');
    await page.waitForSelector('.v1-banner');
    await page.waitForFunction(() => document.querySelectorAll('.v1-thread .chat-messages > li').length === 3);
    assert.match(await text('.v1-thread .chat-messages'), /Synthetic member note/);
    assert.equal(await page.$('#composer'), null, 'Linked V1 chats are read-only');
    assert.match(await text('.heading-meta'), /On V1 · coordinator attached/);
    await screenshot(label, 'v1-chat');
    await noHorizontalScroll();
    // Back to a native conversation.
    await openDrawer(label);
    await choose('Assistant');
    await page.waitForSelector('#composer');
    await screenshot(label, 'chat');
  }],
];

try {
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  for (const [label, viewport] of [['desktop', { width: 1280, height: 860 }], ['phone', { width: 390, height: 844, isMobile: true, hasTouch: true }]]) {
    Object.assign(state, createState());
    page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewport(viewport);
    stage = `${label}:load`;
    await page.goto(`${origin}/#conversation/${A}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#composer');
    for (const [name, run] of scenarios) {
      stage = `${label}:${name}`;
      await run(label);
    }
    stage = `${label}:layout`;
    await noHorizontalScroll();
    await page.close();
  }
  assert.deepEqual(errors, [], 'Browser rendering errors');
  console.log(`PASS: configured workspace rendering (${scenarios.map(s => s[0]).join(', ')}) at desktop and phone widths; synthetic API only, no provider qualification`);
} catch (error) {
  console.error(JSON.stringify({ stage, error: error.message, requests: state.requests.slice(-25), pageErrors: errors }));
  throw error;
} finally {
  await browser?.close();
  server.close();
  server.closeAllConnections?.();
}
