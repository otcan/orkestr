// ORK-834: published sites in the real WASM bundle against the synthetic API
// (headless-sites-mock.mjs). A chat with a live site links its newest one in
// its header (new tab, no opener) and counts the rest; another chat shows no
// link. The Sites page, opened from Orkestr settings or that count, lists one
// row per site with its chat by name (never an id), kind, last publish and an
// Open link; a disabled site has none. Phones get one card per site.
import assert from 'node:assert/strict';
import { sitesState } from './headless-sites-mock.mjs';

const A = '00000000-0000-4000-8000-00000000000a';
const C = '00000000-0000-4000-8000-00000000000c';

const heading = page => page.evaluate(() => {
  const link = document.querySelector('.conversation-heading .heading-site-link');
  return {
    title: document.querySelector('.heading-title h2')?.textContent,
    link: link && { href: link.href, target: link.target, rel: link.rel, text: link.textContent.trim() },
    more: document.querySelector('.conversation-heading .heading-site-more')?.textContent ?? null,
  };
});
const openChat = async (page, openDrawer, choose, label, name) => {
  await openDrawer(label);
  await choose(name);
  await page.waitForFunction(n => document.querySelector('.heading-title h2')?.textContent === n, { timeout: 15000 }, name);
};
const rows = page => page.$$eval('.site-row', nodes => nodes.map(row => {
  const cell = label => row.querySelector(`td[data-label="${label}"]`);
  const open = row.querySelector('a.site-open-link');
  return {
    slug: row.dataset.site,
    status: row.dataset.status,
    name: row.querySelector('.site-name strong')?.textContent,
    address: row.querySelector('.site-address')?.textContent,
    chat: cell('Chat')?.textContent.trim(),
    kind: cell('Kind')?.textContent.trim(),
    when: cell('Last published')?.textContent.trim(),
    exact: cell('Last published')?.querySelector('time')?.title,
    version: cell('Version')?.textContent.trim(),
    open: open && { href: open.href, target: open.target, rel: open.rel },
    openText: cell('Open')?.textContent.trim(),
  };
}));

export async function sitesPage({ page, state, label, openDrawer, choose, clickText, waitText, screenshot, noHorizontalScroll }) {
  state.siteCatalog = sitesState();
  // The header: the chat's newest live site, and "+1" for its older one.
  await openChat(page, openDrawer, choose, label, 'Research notes');
  await openChat(page, openDrawer, choose, label, 'Assistant');
  await page.waitForSelector('.conversation-heading .heading-site-link', { timeout: 20000 });
  assert.deepEqual(await heading(page), { title: 'Assistant', more: '+1',
    link: { href: 'https://notes.sites.example.com/', target: '_blank', rel: 'noopener noreferrer', text: 'Site: Synthetic notes' } });
  await noHorizontalScroll();
  await screenshot(label, 'sites-header');
  // A chat without a site has no link; one with a single site has no count.
  await openChat(page, openDrawer, choose, label, 'Research notes');
  await page.waitForFunction(() => !document.querySelector('.heading-site-link'), { timeout: 15000 });
  assert.equal((await heading(page)).more, null);
  await openChat(page, openDrawer, choose, label, 'Queued errands');
  await page.waitForSelector('.conversation-heading .heading-site-link', { timeout: 15000 });
  const errands = await heading(page);
  assert.deepEqual([errands.link.href, errands.more], ['https://errands.sites.example.com/', null]);

  // Orkestr settings → Sites: a global page with its own location.
  await page.$eval('.global-settings', b => b.click());
  await page.waitForSelector('.orkestr-settings .sites-entry');
  await clickText('Open sites');
  await page.waitForFunction(() => location.hash === '#sites', { timeout: 15000 });
  await page.waitForSelector('.site-row', { timeout: 15000 });
  assert.equal(await page.$eval('.conversation-heading h2', n => n.textContent), 'Sites');
  assert.equal(await page.$eval('.global-settings', n => n.getAttribute('aria-current')), 'page', 'Settings stays marked while its Sites page is open');
  assert.equal(await page.$('.heading-site-link'), null, 'a global page has no chat Site link');
  // Opening the page reads the list again (the shown one may be a minute
  // old); chat names arrive with the sidebar read.
  await page.waitForFunction(() => document.querySelector('.site-row[data-site="notes"] td[data-label="Last published"]')?.textContent.trim() === '5 min ago', { timeout: 15000 });
  await page.waitForFunction(() => [...document.querySelectorAll('.site-chat')].some(n => n.textContent === 'Assistant'), { timeout: 15000 });
  const listed = await rows(page);
  assert.deepEqual(listed.map(r => r.slug), ['notes', 'crm', 'errands', 'old-notes'], 'newest publish first');
  const [notes, crm, board, old] = listed;
  assert.deepEqual({ name: notes.name, address: notes.address, chat: notes.chat, kind: notes.kind, version: notes.version, when: notes.when },
    { name: 'Synthetic notes', address: 'notes.sites.example.com', chat: 'Assistant', kind: 'Static site', version: 'v0003 · 3 versions', when: '5 min ago' });
  assert.match(notes.exact, /^\d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} UTC$/, 'the exact time is the tooltip');
  assert.deepEqual(notes.open, { href: 'https://notes.sites.example.com/', target: '_blank', rel: 'noopener noreferrer' });
  assert.deepEqual({ chat: crm.chat, kind: crm.kind, version: crm.version, when: crm.when }, { chat: 'No chat', kind: 'App', version: '—', when: '2 h ago' });
  assert.deepEqual({ chat: board.chat, version: board.version }, { chat: 'Queued errands', version: 'v0002 · 2 versions' });
  assert.deepEqual({ name: old.name, status: old.status, open: old.open, text: old.openText }, { name: 'old-notes', status: 'disabled', open: null, text: 'Disabled' });
  const visible = await page.evaluate(() => document.querySelector('.sites-page').innerText);
  for (const id of [A, C]) assert.ok(!visible.includes(id), 'chat ids are never shown');
  // Phones: one card per site, each value named, no sideways scroll.
  if (label === 'phone') {
    const layout = await page.evaluate(() => ({
      head: document.querySelector('.sites-table thead').getBoundingClientRect().width,
      display: getComputedStyle(document.querySelector('.site-row')).display,
      label: getComputedStyle(document.querySelector('.site-row td[data-label="Chat"]'), '::before').content,
    }));
    assert.deepEqual(layout, { head: 1, display: 'block', label: '"Chat"' });
  }
  await noHorizontalScroll();
  await screenshot(label, 'sites');

  // Back in the chat, "+1" opens the same page.
  await clickText('Back to chat');
  await page.waitForSelector('#composer');
  await openChat(page, openDrawer, choose, label, 'Assistant');
  await page.waitForSelector('.conversation-heading .heading-site-more', { timeout: 15000 });
  await page.$eval('.conversation-heading .heading-site-more', b => b.click());
  await page.waitForFunction(() => location.hash === '#sites', { timeout: 15000 });
  await page.waitForSelector('.site-row');

  // Nothing published yet: the page says how a chat publishes one.
  state.siteCatalog = { configured: false, sites: [] };
  await clickText('Back to chat');
  await page.waitForSelector('#composer');
  await page.$eval('.global-settings', b => b.click());
  await page.waitForSelector('.orkestr-settings .sites-entry');
  await clickText('Open sites');
  await page.waitForSelector('.sites-empty', { timeout: 15000 });
  await waitText('orkestr-site publish <folder>');
  assert.equal(await page.$('.site-row'), null);
  await screenshot(label, 'sites-empty');
  assert.equal(await page.$('.heading-site-link'), null);
  // A new publish shows the next time the page opens, and the chat links it.
  state.siteCatalog = sitesState();
  await clickText('Back to chat');
  await page.waitForSelector('#composer');
  await page.$eval('.global-settings', b => b.click());
  await page.waitForSelector('.orkestr-settings .sites-entry');
  await clickText('Open sites');
  await page.waitForFunction(() => document.querySelectorAll('.site-row').length === 4, { timeout: 15000 });
  await clickText('Back to chat');
  await page.waitForSelector('#composer');
  await page.waitForSelector('.conversation-heading .heading-site-link', { timeout: 15000 });
}
