// ORK-786 application shell against the synthetic API, in the real WASM
// bundle: the compact global header, Chat / Work / Files with the rest under
// More, global Virtual desks, host and Orkestr settings views (ORK-789), quota
// and host states, and the collapsible, resizable conversation list. Five
// widths plus 200% zoom (1280 x 860 at 2x = 640 x 430 CSS px). Synthetic data
// only; no provider.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer';
import { A, V1_GROUP, createState, startMock } from './headless-workspace-mock.mjs';

assert.equal(process.env.CI, 'true', 'Run only in isolated CI');
assert.ok(process.env.UI_BUNDLE_DIR, 'UI_BUNDLE_DIR is required');
const { server, state, origin } = await startMock(process.env.UI_BUNDLE_DIR);
const errors = [];
let browser, page, stage = 'startup';
const failing = new Set();

const MORE = ['History', 'Projects', 'Timers', 'Job tracker', 'Memory', 'Live map', 'Chat settings'];
const SLUGS = { Chat: '', Work: '/work', Files: '/files', History: '/history', Projects: '/projects', Timers: '/timers',
  'Job tracker': '/tracker', Memory: '/memory', 'Live map': '/live-map', 'Chat settings': '/settings' };
// Account and server-wide panels: only in Orkestr settings, never under a chat (ORK-789).
const OWNER_PANELS = '.owner-password, .vault, .provider-sign-in, [aria-label="Account settings"], [aria-label="About Orkestr"]';
const VIEWPORTS = [
  ['1280', { width: 1280, height: 860 }],
  ['1440', { width: 1440, height: 900 }],
  ['1920', { width: 1920, height: 1080 }],
  ['768', { width: 768, height: 1024, isMobile: true, hasTouch: true }],
  ['390', { width: 390, height: 844, isMobile: true, hasTouch: true }],
  ['zoom200', { width: 640, height: 430 }],
];

const screenshot = async (label, name) => {
  const dir = process.env.SCREENSHOT_DIR;
  if (!dir) return;
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/shell-${label}-${name}.png` });
};
const count = what => state.requests.filter(r => r === what).length;
const hash = () => page.evaluate(() => location.hash);
const waitHash = value => page.waitForFunction(v => location.hash === v, { timeout: 15000 }, value);
const noHorizontalScroll = async () => {
  const { scroll, width } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
  assert.ok(scroll <= width, `Horizontal page scroll at ${width}px (${scroll}px content)`);
};
const visibleButton = label => page.evaluate(label => {
  const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === label);
  if (!b) return null;
  const r = b.getBoundingClientRect(), style = getComputedStyle(b);
  return { shown: r.width > 0 && r.height > 0 && style.visibility !== 'hidden', left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height };
}, label);
const clickVisible = async label => {
  const box = await visibleButton(label);
  assert.ok(box?.shown, `Visible button: ${label}`);
  await page.mouse.click((box.left + box.right) / 2, (box.top + box.bottom) / 2);
};
const navState = () => page.evaluate(() => {
  const nav = document.querySelector('nav[aria-label="Conversation"]');
  if (!nav) return null;
  const shown = b => b.getClientRects().length > 0;
  return {
    primary: [...nav.querySelectorAll(':scope > .nav-tab')].filter(shown).map(b => b.textContent.trim()),
    current: [...nav.querySelectorAll('button[aria-current=page]')].map(b => b.textContent.trim()),
    more: [...nav.querySelectorAll('.more-item')].map(b => b.textContent.trim()),
    open: document.getElementById('more-tabs-toggle')?.getAttribute('aria-expanded'),
    // Visible text only (innerText), whitespace-normalized: flex items render on lines of their own.
    toggle: document.getElementById('more-tabs-toggle')?.innerText.replace(/\s+/g, ' ').replace(' :', ':').trim(),
    listShown: shown(document.getElementById('more-tabs-list')),
  };
});
// Open More (by pointer) and pick a destination.
const pickMore = async label => {
  await page.click('#more-tabs-toggle');
  await page.waitForFunction(() => document.getElementById('more-tabs-toggle')?.getAttribute('aria-expanded') === 'true');
  const target = await page.evaluateHandle(label => [...document.querySelectorAll('.more-item')].find(b => b.textContent.trim() === label), label);
  await target.asElement().click();
  await page.waitForFunction(() => document.getElementById('more-tabs-toggle')?.getAttribute('aria-expanded') === 'false');
};
const sidebarWidth = () => page.$eval('.conversation-sidebar', n => Math.round(n.getBoundingClientRect().width));

async function headerAndBadge(label, phone) {
  const view = await page.evaluate(() => {
    const h = document.querySelector('.app-heading'), r = h.getBoundingClientRect();
    const badge = h.querySelector(':scope > .build-badge').getBoundingClientRect();
    return { height: Math.round(r.height), badgeRight: badge.right, badgeTop: badge.top, width: innerWidth, text: h.innerText,
      global: [...h.querySelectorAll('nav[aria-label="Global"] button')].map(b => b.textContent.trim()),
      inConversationNav: [...document.querySelectorAll('nav[aria-label="Conversation"] button')].map(b => b.textContent.trim()) };
  });
  assert.deepEqual(view.global, ['Virtual desks', 'Settings'], 'global resources live in the header');
  for (const global of ['Virtual desks', 'Host resources', 'Settings', 'Orkestr settings']) assert.ok(!view.inConversationNav.includes(global), `${global} is not a conversation tab`);
  if (!phone) assert.ok(view.height <= 64, `${label}: one compact header row, got ${view.height}px`);
  // Settings (ORK-789) joins the header without wrapping its controls: desks,
  // Settings, build and Sign out share one row at every width.
  const rows = await page.evaluate(() => ['.global-link', '.global-settings', '.build-badge > button', '.app-heading > .sign-out']
    .map(s => { const r = document.querySelector(s).getBoundingClientRect(); return [s, Math.round(r.top + r.height / 2)]; }));
  const middles = rows.map(([, y]) => y);
  assert.ok(Math.max(...middles) - Math.min(...middles) <= 6, `${label}: header controls on one row ${JSON.stringify(rows)}`);
  assert.ok(view.badgeTop < 60 && view.badgeRight > view.width * 0.55, `${label}: build badge at the top right`);
  assert.doesNotMatch(view.text, /unavailable/i, 'no "unavailable" wording in the header');
  assert.doesNotMatch(view.text, /deployed/i, 'deployment times live in the build panel');
  assert.equal(count('GET /api/v2/health'), 0, 'the closed build badge reads nothing');
  await page.click('[aria-label="Build version details"]');
  await page.waitForFunction(() => document.querySelector('#header-build-details')?.textContent.includes('Server deployed:'), { timeout: 15000 });
  const panel = await page.$eval('#header-build-details', n => ({ role: n.getAttribute('role'), label: n.getAttribute('aria-label'), text: n.textContent, right: n.getBoundingClientRect().right }));
  assert.equal(panel.role, 'region');
  assert.match(panel.text, /Web version:.*Source:.*Web compiled:.*Web deployed:.*Server version: 9\.8\.7-test.*Server deployed:/s);
  assert.ok(panel.right <= view.width, 'the build panel stays on screen');
  await screenshot(label, 'build-panel');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('#header-build-details'));
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Build version details', 'Escape returns focus to the badge');
}

async function quotasAndHost(label) {
  await page.waitForFunction(() => document.querySelectorAll('.provider-quota-item[data-state=current]').length === 2, { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('.host-metrics-panel')?.dataset.state === 'live', { timeout: 20000 });
  const quota = await page.$$eval('.provider-quota-item summary', s => s.map(n => n.textContent));
  assert.match(quota.join(' '), /Codex quota:week 40%.*Claude quota:week available/s);
  // Keyboard popover; Escape closes it and returns to its summary.
  await page.focus('.provider-quota-item summary');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('.provider-quota-item')?.open);
  const detail = await page.$eval('.provider-quota-item[open] .quota-detail', n => { const r = n.getBoundingClientRect(); return { text: n.textContent, left: r.left, right: r.right }; });
  assert.match(detail.text, /OpenAI \/ Codex.*Passive telemetry, current\..*Observed/s);
  assert.ok(detail.left >= 0 && detail.right <= await page.evaluate(() => innerWidth), 'quota popover on screen');
  await noHorizontalScroll();
  await screenshot(label, 'quota-popover');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.provider-quota-item[open]'));
  // A failed read is "disconnected": no values, no "unavailable", never live.
  failing.add('/api/v2/provider-quotas'); failing.add('/api/v2/host-metrics');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('.provider-quota-item[data-state=disconnected]').length === 2, { timeout: 20000 });
  await page.waitForFunction(() => document.querySelector('.host-metrics-panel')?.dataset.state === 'disconnected', { timeout: 20000 });
  const offline = await page.$eval('.resource-bar', n => n.innerText);
  assert.doesNotMatch(offline, /unavailable|%|live/i);
  assert.equal((offline.match(/Disconnected/g) ?? []).length, 2, 'each provider says it once');
  assert.match(await page.$eval('.host-metrics-panel', n => n.getAttribute('aria-label')), /Disconnected: the last read failed/);
  await screenshot(label, 'resources-disconnected');
  failing.clear();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelectorAll('.provider-quota-item[data-state=current]').length === 2, { timeout: 20000 });
}

async function conversationNavigation(label, phone) {
  await page.waitForSelector('#composer');
  let nav = await navState();
  assert.deepEqual(nav.primary, ['Chat', 'Work', 'Files'], 'Chat, Work and Files are primary');
  assert.equal(nav.toggle, 'More', 'everything else is under More');
  assert.deepEqual(nav.current, ['Chat']);
  assert.deepEqual(nav.more, MORE);
  assert.deepEqual([nav.open, nav.listShown], ['false', false], 'More starts closed');
  // Keyboard: Enter opens, Tab enters the list, Escape closes and returns.
  await page.focus('#more-tabs-toggle');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('more-tabs-toggle').getAttribute('aria-expanded') === 'true');
  assert.equal((await navState()).listShown, true);
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => ({ text: document.activeElement?.textContent.trim(), outline: getComputedStyle(document.activeElement).outlineStyle }));
  assert.equal(focused.text, 'History', 'Tab moves into the More list');
  assert.notEqual(focused.outline, 'none', 'visible keyboard focus');
  const list = await page.$eval('#more-tabs-list', n => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, bottom: r.bottom }; });
  assert.ok(list.left >= 0 && list.right <= await page.evaluate(() => innerWidth), 'More list on screen');
  await screenshot(label, 'more-open');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.getElementById('more-tabs-toggle').getAttribute('aria-expanded') === 'false');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'more-tabs-toggle');
  // Outside click closes.
  await page.click('#more-tabs-toggle');
  await page.waitForFunction(() => document.getElementById('more-tabs-toggle').getAttribute('aria-expanded') === 'true');
  await page.mouse.click(5, (await page.evaluate(() => innerHeight)) - 5);
  await page.waitForFunction(() => document.getElementById('more-tabs-toggle').getAttribute('aria-expanded') === 'false');
  // Files: a primary destination with its own bookmarkable URL. It opens the
  // chat's Files panel (ORK-809) over or beside the same chat, which stays
  // mounted; the collapsed private copies are not read until opened.
  const manifests = () => state.requests.filter(r => r.startsWith('GET /api/v2/conversations/:id/attachment-manifests')).length;
  const before = manifests();
  await clickVisible('Files');
  await waitHash(`#conversation/${A}/files`);
  await page.waitForFunction(() => { const a = document.querySelector('.files-drawer'); return a && getComputedStyle(a).display !== 'none'; });
  assert.deepEqual(await page.$$eval('.files-drawer .files-section h3, .files-drawer .files-private-toggle', n => n.map(e => e.textContent.trim())),
    ['In this chat', 'Your folder', 'Private copies']);
  assert.ok(await page.$('#composer'), 'the chat stays mounted under Files');
  assert.deepEqual((await navState()).current, ['Files']);
  await new Promise(r => setTimeout(r, 2500));
  assert.equal(manifests() - before, 0, 'opening Files reads no file store until Private copies opens');
  await screenshot(label, 'files');
  await noHorizontalScroll();
  // A More destination: the toggle names it, back returns.
  await pickMore('Timers');
  await waitHash(`#conversation/${A}/timers`);
  nav = await navState();
  assert.deepEqual(nav.current.map(t => t.replace('▾', '')), ['More: Timers', 'Timers'], 'More is current and names the open view');
  assert.equal(nav.toggle, phone && label !== '768' ? 'More' : 'More: Timers');
  await page.goBack();
  await waitHash(`#conversation/${A}/files`);
  await page.waitForFunction(() => [...document.querySelectorAll('nav[aria-label="Conversation"] button[aria-current=page]')].map(b => b.textContent.trim()).join() === 'Files');
}

async function everyRouteBookmarkable() {
  for (const [name, slug] of Object.entries(SLUGS)) {
    await page.goto(`${origin}/#conversation/${A}${slug}`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(name => [...document.querySelectorAll('nav[aria-label="Conversation"] button[aria-current=page]')]
      .some(b => b.textContent.trim() === name), { timeout: 20000 }, name);
    assert.equal(await hash(), `#conversation/${A}${slug}`, `${name} keeps its URL`);
  }
  for (const [path, title] of [['/virtual-desks', 'Virtual desks'], ['/#host', 'Host resources'], ['/#host/details?range=24h', 'Host resources'], ['/#settings', 'Orkestr settings']]) {
    await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(t => document.querySelector('.conversation-heading[data-scope=global] h2')?.textContent === t, { timeout: 20000 }, title);
    assert.equal(await page.$('nav[aria-label="Conversation"]'), null, `${path}: global, no conversation tabs`);
  }
  // An old chat settings bookmark still opens that chat's settings, which
  // now hold only chat controls and point to Orkestr settings (ORK-789).
  await page.goto(`${origin}/#conversation/${A}/settings`, { waitUntil: 'domcontentloaded' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#settings-model', { timeout: 20000 });
  assert.equal(await page.$$eval(OWNER_PANELS, n => n.length), 0, 'no account or server-wide panel under the chat');
  await clickVisible('Open Orkestr settings');
  await waitHash('#settings');
  await page.waitForSelector('.orkestr-settings [aria-label="Account settings"] .owner-password');
  // An old conversation-scoped desks link opens the global view.
  await page.goto(`${origin}/#conversation/${A}/virtual-desks`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('.conversation-heading[data-scope=global] h2')?.textContent === 'Virtual desks', { timeout: 20000 });
}

async function globalViews(label) {
  await clickVisible('Virtual desks');
  await page.waitForFunction(() => location.pathname === '/virtual-desks');
  await page.waitForFunction(() => document.querySelector('.conversation-heading')?.dataset.scope === 'global');
  const view = await page.evaluate(() => ({ current: document.querySelector('.global-link').getAttribute('aria-current'),
    meta: document.querySelector('.heading-scope')?.textContent, tabs: document.querySelector('nav[aria-label="Conversation"]') }));
  assert.deepEqual(view, { current: 'page', meta: 'Global · shared by all conversations', tabs: null });
  assert.equal(await page.$('.conversation-choice[aria-current=page]'), null, 'no conversation is shown as the scope of a global view');
  await page.waitForFunction(() => document.body.textContent.includes('All desk resources'), { timeout: 15000 });
  await screenshot(label, 'virtual-desks');
  await noHorizontalScroll();
  await clickVisible('Back to chat');
  await waitHash(`#conversation/${A}`);
  await page.waitForSelector('#composer');
  assert.equal(await page.$eval('.global-link', n => n.getAttribute('aria-current')), 'false');
  await page.click('.host-metrics-panel');
  await waitHash('#host');
  await page.waitForFunction(() => document.querySelector('.host-metrics-panel')?.getAttribute('aria-current') === 'page');
  assert.equal(await page.$eval('.conversation-heading h2', n => n.textContent), 'Host resources');
  await clickVisible('Back to chat');
  await page.waitForSelector('#composer');
  await orkestrSettings(label);
}

// ORK-789: account, vault, provider sign-in and About are one global page,
// opened from the header's Settings (a gear alone on narrow phones).
async function orkestrSettings(label) {
  const settings = await page.$eval('.global-settings', n => { const r = n.getBoundingClientRect(), s = getComputedStyle(n);
    return { name: n.textContent.trim(), title: n.title, left: r.left, right: r.right, top: r.top, height: r.height, width: r.width, shown: r.width > 0 && s.visibility !== 'hidden' }; });
  assert.ok(settings.shown && settings.left >= 0 && settings.right <= await page.evaluate(() => innerWidth) + 1, `${label}: Settings reachable in the header`);
  assert.equal(settings.name, 'Settings', 'accessible name, also when only the gear shows');
  assert.match(settings.title, /^Orkestr settings/);
  await page.mouse.click((settings.left + settings.right) / 2, settings.top + settings.height / 2);
  await waitHash('#settings');
  await page.waitForSelector('.orkestr-settings [aria-label="Account settings"] .owner-password', { timeout: 15000 });
  const view = () => page.evaluate(owner => ({
    scope: document.querySelector('.conversation-heading')?.dataset.scope,
    title: document.querySelector('.conversation-heading h2')?.textContent,
    meta: document.querySelector('.heading-scope')?.textContent,
    tabs: document.querySelectorAll('nav[aria-label="Conversation"]').length,
    current: [...document.querySelectorAll('nav[aria-label="Global"] button[aria-current=page]')].map(b => b.textContent.trim()),
    row: document.querySelectorAll('.conversation-choice[aria-current=page]').length,
    chat: document.querySelectorAll('#settings-model, .chat-settings, #composer').length,
    panels: document.querySelectorAll(`.orkestr-settings :is(${owner})`).length,
  }), OWNER_PANELS);
  const expected = { scope: 'global', title: 'Orkestr settings', meta: 'Global · shared by all conversations', tabs: 0, current: ['Settings'], row: 0, chat: 0, panels: 5 };
  assert.deepEqual(await view(), expected);
  await screenshot(label, 'orkestr-settings');
  await noHorizontalScroll();
  // Reload keeps the page; back returns to the chat, forward reopens it.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.orkestr-settings [aria-label="Account settings"] .owner-password', { timeout: 20000 });
  assert.equal(await hash(), '#settings');
  assert.deepEqual(await view(), expected);
  await page.goBack();
  await waitHash(`#conversation/${A}`);
  await page.waitForSelector('#composer');
  assert.equal(await page.$$eval(OWNER_PANELS, n => n.length), 0);
  await page.goForward();
  await waitHash('#settings');
  await page.waitForSelector('.orkestr-settings .owner-password');
  await clickVisible('Back to chat');
  await waitHash(`#conversation/${A}`);
  await page.waitForSelector('#composer');
}

// From a linked read-only V1 chat, Settings opens Orkestr settings; back returns to that chat.
async function settingsFromLinkedChat(phone) {
  if (phone) {
    await page.click('.threads-toggle');
    await page.waitForFunction(() => document.querySelector('.workspace')?.dataset.sidebarOpen === 'true');
  }
  await page.evaluate(() => [...document.querySelectorAll('.conversation-choice')].find(b => b.querySelector('.conversation-name')?.textContent === 'Synthetic group').click());
  await waitHash(`#v1/${V1_GROUP}`);
  await page.waitForFunction(() => document.querySelector('.heading-meta')?.textContent === 'On V1 · coordinator attached', { timeout: 15000 });
  await page.$eval('.global-settings', b => b.click());
  await waitHash('#settings');
  await page.waitForFunction(() => document.querySelector('.conversation-heading[data-scope=global] h2')?.textContent === 'Orkestr settings', { timeout: 15000 });
  await page.waitForSelector('.orkestr-settings .owner-password');
  assert.equal(await page.$('.v1-thread'), null, 'the linked chat is closed');
  await page.goBack();
  await waitHash(`#v1/${V1_GROUP}`);
  await page.waitForFunction(() => document.querySelector('.heading-meta')?.textContent === 'On V1 · coordinator attached', { timeout: 15000 });
}

async function sidebarDesktop(label) {
  // Bounded, keyboard-resizable list, remembered per viewer.
  const handle = await page.$eval('.sidebar-resize', n => ({ role: n.getAttribute('role'), now: Number(n.getAttribute('aria-valuenow')),
    min: Number(n.getAttribute('aria-valuemin')), max: Number(n.getAttribute('aria-valuemax')), label: n.getAttribute('aria-label') }));
  assert.equal(handle.role, 'separator');
  assert.equal(handle.label, 'Resize conversation list');
  const start = await sidebarWidth();
  assert.ok(Math.abs(handle.now - start) <= 1, `valuenow ${handle.now} matches ${start}`);
  await page.focus('.sidebar-resize');
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowRight');
  await page.waitForFunction(w => Math.round(document.querySelector('.conversation-sidebar').getBoundingClientRect().width) === w, { timeout: 5000 }, start + 32);
  await page.keyboard.press('End');
  const widest = Math.min(480, Math.floor((await page.evaluate(() => innerWidth)) * 0.45));
  await page.waitForFunction(w => Math.round(document.querySelector('.conversation-sidebar').getBoundingClientRect().width) === w, { timeout: 5000 }, widest);
  // Dragging past the bound stops at it.
  const box = await (await page.$('.sidebar-resize')).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + 200);
  await page.mouse.down();
  await page.mouse.move(5, box.y + 200, { steps: 4 });
  await page.mouse.up();
  await page.waitForFunction(() => Math.round(document.querySelector('.conversation-sidebar').getBoundingClientRect().width) === 240, { timeout: 5000 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.conversation-row', { timeout: 15000 });
  await page.waitForFunction(() => Math.round(document.querySelector('.conversation-sidebar').getBoundingClientRect().width) === 240, { timeout: 10000 });
  await page.focus('.sidebar-resize');
  for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
  // Collapse and restore; the choice survives a reload.
  await page.click('.sidebar-collapse');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.conversation-sidebar')).display === 'none');
  assert.equal(await page.$eval('.sidebar-collapse', n => [n.getAttribute('aria-expanded'), n.getAttribute('aria-label')].join()), 'false,Show conversation list');
  assert.equal(await page.$('.sidebar-resize'), null, 'no resize handle while collapsed');
  await screenshot(label, 'sidebar-collapsed');
  await noHorizontalScroll();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#composer');
  await page.waitForFunction(() => document.querySelector('.workspace')?.dataset.sidebarCollapsed === 'true', { timeout: 10000 });
  await page.click('.sidebar-collapse');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.conversation-sidebar')).display !== 'none');
  await page.waitForSelector('.sidebar-resize');
}

async function sidebarRows(label, phone) {
  if (phone) {
    assert.equal(await page.$eval('.sidebar-resize', n => getComputedStyle(n).display), 'none', 'no resize handle on a drawer');
    await page.click('.threads-toggle');
    await page.waitForFunction(() => document.querySelector('.workspace')?.dataset.sidebarOpen === 'true');
  }
  await page.waitForFunction(() => document.querySelectorAll('.conversation-row').length >= 4, { timeout: 20000 });
  await page.waitForFunction(() => [...document.querySelectorAll('.conversation-row')].some(r => r.querySelector('.work-state')?.textContent === 'Queued #2'), { timeout: 20000 });
  const rows = await page.$$eval('.conversation-row', rows => rows.map(r => ({
    name: r.querySelector('.conversation-name').textContent, states: r.querySelectorAll('.work-state').length,
    previews: r.querySelectorAll('.choice-preview').length, badges: r.querySelectorAll('.source-badge, .choice-badges').length,
    channel: r.querySelector('.channel-icon')?.getAttribute('aria-label') ?? null,
    selected: r.querySelector('.conversation-choice').getAttribute('aria-current') === 'page',
    background: getComputedStyle(r.querySelector('.conversation-choice')).backgroundColor,
    height: r.querySelector('.conversation-choice').getBoundingClientRect().height })));
  for (const row of rows) {
    assert.ok(row.states <= 1 && row.previews <= 1 && row.badges === 0, `${row.name}: one state, one preview, no badge pills`);
    assert.ok(row.height >= 44, `${row.name}: row is a full touch target (${row.height}px)`);
  }
  assert.equal(rows.find(r => r.name === 'Synthetic group').channel, 'On V1 · coordinator attached');
  const selected = rows.filter(r => r.selected);
  assert.deepEqual(selected.map(r => r.name), ['Assistant']);
  assert.ok(rows.filter(r => !r.selected).every(r => r.background !== selected[0].background), 'the selected row stands out');
  await screenshot(label, 'sidebar');
  if (phone) {
    // Close by tapping the scrim beside the drawer (its centre can lie under the drawer).
    const { w, h } = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    await page.mouse.click(w - 8, Math.round(h / 2));
    await page.waitForFunction(() => document.querySelector('.workspace')?.dataset.sidebarOpen === 'false');
  }
}

async function compactLayout(label, phone) {
  await page.goto(`${origin}/#conversation/${A}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#composer');
  await page.waitForFunction(() => document.querySelectorAll('.chat-messages > li').length > 0, { timeout: 20000 });
  await new Promise(r => setTimeout(r, 600));
  const layout = await page.evaluate(() => {
    const rect = s => document.querySelector(s)?.getBoundingClientRect();
    const composer = rect('#composer'), heading = rect('.conversation-heading'), scroll = rect('.conversation-pane > .conversation-scroll');
    const hit = document.elementFromPoint(composer.left + composer.width / 2, composer.top + composer.height / 2);
    const last = [...document.querySelectorAll('.chat-messages > li')].at(-1).getBoundingClientRect();
    const targets = [...document.querySelectorAll('.app-heading button, .app-heading summary, nav[aria-label="Conversation"] > .nav-tab, #more-tabs-toggle, .threads-toggle')]
      .filter(n => n.getClientRects().length).map(n => [n.textContent.trim().slice(0, 24) || n.getAttribute('aria-label'), Math.round(n.getBoundingClientRect().height)]);
    return { composerTop: composer.top, composerBottom: composer.bottom, headingBottom: heading.bottom, viewport: innerHeight,
      composerHit: hit === document.querySelector('#composer') || document.querySelector('#composer').contains(hit),
      scrollTop: scroll.top, scrollBottom: scroll.bottom, lastTop: last.top, lastBottom: last.bottom, targets };
  });
  assert.ok(layout.composerHit, `${label}: nothing covers the composer`);
  assert.ok(layout.composerTop >= layout.headingBottom && layout.composerBottom <= layout.viewport + 1, `${label}: composer on screen below the heading`);
  if (label !== 'zoom200') {
    assert.ok(layout.lastBottom > layout.scrollTop && layout.lastTop < layout.scrollBottom, `${label}: the latest message is visible`);
  }
  if (phone) for (const [name, height] of layout.targets) assert.ok(height >= 44, `${label}: ${name} is ${height}px tall (44px touch target)`);
  // Every action stays reachable: header and conversation controls are on screen.
  for (const selector of ['.global-link', '.global-settings', '#more-tabs-toggle', '.build-badge > button', '.app-heading > .sign-out', phone ? '.threads-toggle' : '.sidebar-collapse']) {
    const box = await page.$eval(selector, n => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width }; });
    assert.ok(box.width > 0 && box.left >= 0 && box.right <= await page.evaluate(() => innerWidth) + 1, `${label}: ${selector} reachable`);
  }
  await noHorizontalScroll();
  await screenshot(label, 'chat');
}

async function noNewPolling() {
  const reads = () => ({ quotas: count('GET /api/v2/provider-quotas'), host: count('GET /api/v2/host-metrics'), sidebar: count('GET /api/v2/sidebar') });
  const started = Date.now(), before = reads();
  for (const name of ['Work', 'Files', 'Chat']) { await clickVisible(name); await page.waitForFunction(n => [...document.querySelectorAll('nav[aria-label="Conversation"] button[aria-current=page]')].some(b => b.textContent.trim() === n), {}, name); }
  await pickMore('Memory');
  await clickVisible('Chat');
  await page.waitForSelector('#composer');
  const seconds = (Date.now() - started) / 1000, after = reads();
  // Navigation adds no reads: only the existing cadences (30 s, 10 s, 4 s) apply.
  assert.ok(after.quotas - before.quotas <= Math.floor(seconds / 30) + 1, `quota reads: ${JSON.stringify([before, after, seconds])}`);
  assert.ok(after.host - before.host <= Math.floor(seconds / 10) + 1, `host reads: ${JSON.stringify([before, after, seconds])}`);
  assert.ok(after.sidebar - before.sidebar <= Math.floor(seconds / 4) + 2, `sidebar reads: ${JSON.stringify([before, after, seconds])}`);
}

try {
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  for (const [label, viewport] of VIEWPORTS) {
    const phone = viewport.width <= 832;
    Object.assign(state, createState());
    failing.clear();
    page = await browser.newPage();
    page.on('pageerror', error => errors.push(`${label}: ${error.message}`));
    await page.setRequestInterception(true);
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (failing.has(path)) return request.respond({ status: 503, contentType: 'application/json', body: '{"code":"synthetic_outage","message":"Synthetic outage"}' });
      return request.continue();
    });
    await page.setViewport(viewport);
    stage = `${label}:load`;
    await page.goto(`${origin}/#conversation/${A}`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { try { localStorage.clear(); } catch {} });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#composer');
    await page.waitForSelector('.conversation-row', { timeout: 15000 });
    stage = `${label}:header`; await headerAndBadge(label, phone);
    stage = `${label}:layout`; await compactLayout(label, phone);
    stage = `${label}:navigation`; await conversationNavigation(label, phone);
    stage = `${label}:global`; await page.goto(`${origin}/#conversation/${A}`, { waitUntil: 'domcontentloaded' }); await page.waitForSelector('#composer'); await globalViews(label);
    stage = `${label}:rows`; await sidebarRows(label, phone);
    stage = `${label}:polling`; await noNewPolling();
    if (label === '1280' || label === '390') { stage = `${label}:quotas`; await quotasAndHost(label); }
    if (!phone) { stage = `${label}:resize`; await sidebarDesktop(label); }
    if (label === '1280' || label === '390') { stage = `${label}:routes`; await everyRouteBookmarkable(); }
    if (label === '1280' || label === '390') {
      stage = `${label}:linked-settings`;
      await page.goto(`${origin}/#conversation/${A}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#composer');
      await settingsFromLinkedChat(phone);
    }
    stage = `${label}:dark`;
    await page.goto(`${origin}/#conversation/${A}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#composer');
    await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
    await new Promise(r => setTimeout(r, 400));
    await screenshot(label, 'chat-dark');
    await page.emulateMediaFeatures([]);
    await page.close();
  }
  assert.deepEqual(errors, [], 'Browser rendering errors');
  console.log(`PASS: application shell and navigation at ${VIEWPORTS.map(v => v[0]).join(', ')}; synthetic API only`);
} catch (error) {
  const view = await page?.evaluate(() => ({ hash: location.hash, path: location.pathname, heading: document.querySelector('.conversation-heading')?.innerText,
    header: document.querySelector('.app-heading')?.innerText, body: document.body.innerText.slice(-2500) })).catch(() => null);
  if (page) await screenshot('failure', stage.replace(/[^a-z0-9-]/gi, '-')).catch(() => {});
  console.error(JSON.stringify({ stage, error: error.message, requests: state.requests.slice(-25), pageErrors: errors, view }));
  throw error;
} finally {
  await browser?.close();
  server.close();
  server.closeAllConnections?.();
}
