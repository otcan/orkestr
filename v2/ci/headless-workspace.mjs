// CI-only rendering of the configured beta workspace against a synthetic API.
// Exercises the real WASM bundle at desktop and phone widths; no provider runs.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { A, C, V1_INSTANCE_REF, V1_LINKS, createState, startMock } from './headless-workspace-mock.mjs';
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

const transcript = () => page.$eval('.conversation-pane > .conversation-scroll', el =>
  ({ gap: el.scrollHeight - el.scrollTop - el.clientHeight, pinned: el.dataset.pinned, scrollable: el.scrollHeight > el.clientHeight + 100 }));

export const scenarios = [
  ['scroll-pin', async () => {
    // Opening a conversation shows the newest message.
    await page.waitForFunction(() => document.querySelectorAll('.archived-messages > li').length >= 50);
    await page.waitForFunction(() => {
      const el = document.querySelector('.conversation-pane > .conversation-scroll');
      return el && el.dataset.pinned === 'true' && el.scrollHeight - el.scrollTop - el.clientHeight <= 72;
    });
    assert.ok((await transcript()).scrollable, 'Synthetic transcript must overflow');
    // Scrolling up releases the pin and offers a jump back.
    await page.$eval('.conversation-pane > .conversation-scroll', el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
    await page.waitForFunction(() => document.querySelector('.conversation-pane > .conversation-scroll').dataset.pinned === 'false');
    assert.ok(await page.$eval('.jump-latest', b => getComputedStyle(b).display !== 'none'), 'Jump to latest is offered');
    await page.click('.jump-latest');
    await page.waitForFunction(() => document.querySelector('.conversation-pane > .conversation-scroll').dataset.pinned === 'true');
    assert.ok(await page.$eval('.jump-latest', b => getComputedStyle(b).display === 'none'));
  }],
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
    assert.equal(await page.$('#composer'), null, 'Linked V1 chats have no V2 composer');
    assert.match(await text('.heading-meta'), /On V1 · coordinator attached/);
    // Owner input into the V1 thread: an unknown first outcome is retried
    // with the same key, and V1 admits the message exactly once.
    await page.waitForSelector('#v1-composer');
    await page.type('#v1-composer', 'Synthetic owner note to V1');
    await clickText('Send');
    await waitText('Retry sends the same message once.');
    await screenshot(label, 'v1-chat-retry');
    await clickText('Retry send');
    await waitText('Already delivered to V1.');
    assert.equal(state.v1Inputs.length, 1, 'Exactly one V1 input');
    assert.equal(state.v1Posts.length, 2);
    assert.equal(state.v1Posts[0].client_message_id, state.v1Posts[1].client_message_id, 'Retry reuses the key');
    assert.deepEqual({ ...state.v1Posts[0], client_message_id: 'k' },
      { thread: 'synthetic-group', client_message_id: 'k', text: 'Synthetic owner note to V1' });
    assert.equal(await page.$eval('#v1-composer', n => n.value), '', 'Accepted text leaves the composer');
    // V1 works on it (typing…), then the coordinator's reply appears live.
    await page.waitForSelector('.v1-typing');
    await screenshot(label, 'v1-chat-typing');
    await waitText('Synthetic coordinator answer', 20000);
    await page.waitForFunction(() => !document.querySelector('.v1-typing'));
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.v1-thread .chat-messages strong')].at(-1).textContent), 'Coordinator');
    await screenshot(label, 'v1-chat');
    await noHorizontalScroll();
    // Back to a native conversation.
    await openDrawer(label);
    await choose('Assistant');
    await page.waitForSelector('#composer');
    await screenshot(label, 'chat');
  }],
  ['new-whatsapp-chat', async label => {
    await openDrawer(label);
    await clickText('New WhatsApp chat');
    await page.waitForSelector('#whatsapp-chat-name');
    assert.match(await text('.new-whatsapp-chat'), /your 2 WhatsApp number/);
    await page.type('#whatsapp-chat-name', 'Synthetic WhatsApp chat');
    await page.select('#whatsapp-chat-effort', 'low');
    await page.type('#whatsapp-chat-workspace', '/srv/synthetic');
    await screenshot(label, 'new-whatsapp-chat');
    await clickText('Create WhatsApp chat');
    // The first attempt stops at the adapter; Retry continues the same request.
    await waitText('Retry continues from there');
    await screenshot(label, 'new-whatsapp-chat-stopped');
    await clickText('Retry');
    await page.waitForFunction(() => document.querySelector('.heading-title h2')?.textContent === 'Synthetic WhatsApp chat', { timeout: 20000 });
    assert.equal(state.chatPosts.length, 2);
    assert.equal(state.chatPosts[0].client_request_id, state.chatPosts[1].client_request_id, 'Retry keeps the request id');
    assert.deepEqual({ ...state.chatPosts[0], client_request_id: 'k' }, { client_request_id: 'k', name: 'Synthetic WhatsApp chat',
      provider: 'codex', model: null, reasoning_effort: 'low', workspace: '/srv/synthetic' });
    await page.waitForSelector('#composer');
    await noHorizontalScroll();
  }],
  ['chat-settings', async label => {
    await openDrawer(label);
    await choose('Assistant');
    await page.waitForSelector('#composer');
    await clickText('Settings');
    await page.waitForSelector('#settings-model');
    assert.equal(await page.$eval('#settings-model', n => n.value), 'synthetic-model');
    await page.select('#settings-effort', 'high');
    await page.$eval('#settings-prefix', n => { n.value = ''; });
    await page.type('#settings-prefix', 'synthetic-new:');
    await clickText('Save settings');
    await waitText('Saved (revision 3)');
    assert.deepEqual(state.settingsPuts.at(-1), { expected_revision: 2, provider: 'codex', model: 'synthetic-model', reasoning_effort: 'high',
      honor_no_reply: true, reply_prefix: 'synthetic-new:', reply_footer: null });
    // Desktops of the chat: binding and current lease.
    await waitText('synthetic-desk');
    assert.equal(await page.$eval('#desktop-thread', n => n.value), 'synthetic-thread');
    await page.type('#desktop-slugs', ', other-desk');
    await clickText('Save desktops');
    await waitText('Desktops saved (revision 2)');
    assert.deepEqual(state.bindingPuts.at(-1).desktop_slugs, ['synthetic-desk', 'other-desk']);
    await screenshot(label, 'chat-settings');
    await noHorizontalScroll();
    // Timers of the chat are listed; selecting one opens its controls.
    await clickText('Timers');
    await waitText('Synthetic morning brief');
    await screenshot(label, 'timers');
    await clickText('Chat');
  }],
  ['v1-manage', async label => {
    await openDrawer(label);
    await choose('Synthetic group');
    await page.waitForSelector('.v1-tabs');
    await clickText('Settings');
    await page.waitForSelector('#v1-model');
    await page.select('#v1-effort', 'high');
    await clickText('Save model and effort');
    await waitText('Saved in V1.');
    assert.deepEqual(state.v1Calls.find(c => c.area === 'settings' && c.method === 'PUT').input, { model: 'synthetic-model', effort: 'high' });
    await page.click('#v1-participants');
    await page.type('#v1-participants', '10000000001@c.us');
    await clickText('Save WhatsApp options');
    await page.waitForFunction(() => document.querySelectorAll('.settings-status').length >= 2);
    assert.deepEqual(state.v1Calls.find(c => c.area === 'whatsapp' && c.method === 'PUT').input.additional_participant_ids, ['10000000001@c.us']);
    await waitText('synthetic-desk');
    await screenshot(label, 'v1-settings');
    await noHorizontalScroll();
    await page.evaluate(() => [...document.querySelectorAll('.v1-tabs button')].find(b => b.textContent === 'Timers').click());
    await waitText('Synthetic digest');
    await clickText('Pause');
    await page.waitForFunction(() => [...document.querySelectorAll('.v1-timer .source-badge')].some(b => b.textContent === 'paused'));
    await clickText('New timer');
    await page.type('#v1-timer-label', 'Synthetic evening');
    await page.$eval('#v1-timer-time', n => { n.value = ''; });
    await page.type('#v1-timer-time', '19:30');
    await page.type('#v1-timer-prompt', 'Synthetic evening prompt');
    await clickText('Save timer');
    await waitText('Synthetic evening');
    const created = state.v1Calls.find(c => c.area === 'timers' && c.method === 'POST' && !c.timer).input;
    assert.equal(created.time, '19:30'); assert.equal(created.cadence, 'daily'); assert.ok(created.client_request_id);
    await screenshot(label, 'v1-timers');
    await noHorizontalScroll();
    await page.evaluate(() => [...document.querySelectorAll('.v1-tabs button')].find(b => b.textContent === 'Chat').click());
    await page.waitForSelector('#v1-composer');
  }],
  ['v1-deep-links', async label => {
    const open = ref => page.goto(`${origin}/instance/${V1_INSTANCE_REF}/thread/${ref}`, { waitUntil: 'domcontentloaded' });
    // A thread still on V1 opens its linked entry.
    await open(V1_LINKS.group);
    await page.waitForSelector('.v1-banner', { timeout: 20000 });
    await page.waitForFunction(() => document.querySelector('.heading-title h2')?.textContent === 'Synthetic group');
    assert.match(await page.evaluate(() => location.hash), /^#conversation\//, 'The V1 fragment is replaced');
    await screenshot(label, 'v1-link-v1');
    // A migrated thread opens its V2 conversation.
    await open(V1_LINKS.migrated);
    await page.waitForFunction(() => document.querySelector('.heading-title h2')?.textContent === 'Research notes', { timeout: 20000 });
    await page.waitForSelector('#composer');
    assert.equal(await page.$('.v1-banner'), null);
    // An unknown link explains itself and keeps the default conversation.
    await open(V1_LINKS.unknown);
    await waitText('This V1 link does not open here');
    await screenshot(label, 'v1-link-unknown');
    await noHorizontalScroll();
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
    stage = `${label}:dark`;
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await new Promise(resolve => setTimeout(resolve, 400)); // let color transitions settle
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const [r, g, b] = background.match(/\d+/g).map(Number);
    assert.ok(r + g + b < 120, `Dark mode background expected, got ${background}`);
    await screenshot(label, 'chat-dark');
    if (label === 'phone') await openDrawer(label);
    await screenshot(label, 'sidebar-dark');
    await page.emulateMediaFeatures([]);
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
