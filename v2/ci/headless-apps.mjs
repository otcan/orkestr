// The Apps page in the real WASM bundle against the synthetic API
// (headless-apps-mock.mjs and headless-sites-mock.mjs): the header's Apps
// button opens one global page with the host's links under its own headings
// (the vault first, with how to sign in there) and then the live published
// sites. Every link opens in a new tab with no opener; a disabled site is not
// linked. An empty, refused or missing list says so in plain words and the
// sites stay. Phones get one column.
import assert from 'node:assert/strict';
import { appLinksState } from './headless-apps-mock.mjs';
import { sitesState } from './headless-sites-mock.mjs';

const cards = page => page.$$eval('.apps-page .app-card', nodes => nodes.map(card => {
  const link = card.querySelector('a.app-link');
  return {
    app: card.dataset.app ?? null,
    site: card.dataset.site ?? null,
    group: card.closest('.apps-group')?.querySelector('h3')?.textContent ?? null,
    title: card.querySelector('.app-title')?.textContent,
    address: card.querySelector('.app-address')?.textContent,
    description: card.querySelector('.app-description')?.textContent ?? null,
    hint: card.querySelector('.app-hint')?.textContent ?? null,
    href: link?.href, target: link?.target, rel: link?.rel,
  };
}));
const backToChat = async (page, clickText) => {
  await clickText('Back to chat');
  await page.waitForSelector('#composer');
};
const openApps = async (page, clickText) => {
  await clickText('Apps');
  await page.waitForFunction(() => location.hash === '#apps', { timeout: 15000 });
  await page.waitForSelector('.apps-page', { timeout: 15000 });
};

export async function appsPage({ page, state, label, clickText, waitText, screenshot, noHorizontalScroll }) {
  state.appLinks = appLinksState();
  state.appLinksMissing = false;
  state.siteCatalog = sitesState();
  const reads = state.appLinksReads ?? 0;
  await openApps(page, clickText);
  await page.waitForSelector('.app-card[data-app="vault"]', { timeout: 15000 });
  await page.waitForSelector('.app-card[data-site="notes"]', { timeout: 15000 });
  assert.ok((state.appLinksReads ?? 0) > reads, 'opening the page reads the list');
  assert.equal(await page.$eval('.conversation-heading h2', n => n.textContent), 'Apps');
  assert.equal(await page.$eval('.global-apps', n => n.getAttribute('aria-current')), 'page', 'the header marks Apps');
  assert.equal(await page.$eval('.global-settings', n => n.getAttribute('aria-current')), 'false');
  assert.equal(await page.$('.heading-site-link'), null, 'a global page has no chat Site link');
  const shown = await cards(page);
  assert.deepEqual(shown.map(c => c.app ?? `site:${c.site}`), ['vault', 'ops', 'crm', 'site:notes', 'site:crm', 'site:errands'],
    "the host's links in its order, then live sites newest first; a disabled site is left out");
  assert.deepEqual(shown[0], { app: 'vault', site: null, group: 'Tools', title: 'Vault (passwords)', address: 'vault.example.com/ui',
    description: 'Passwords, tokens and API keys.', hint: 'Sign in with OIDC (your Orkestr login)',
    href: 'https://vault.example.com/ui/', target: '_blank', rel: 'noopener noreferrer' });
  assert.deepEqual(shown.map(c => c.group), ['Tools', 'Dashboards', 'Apps', 'Published sites', 'Published sites', 'Published sites']);
  assert.deepEqual({ description: shown[2].description, hint: shown[2].hint }, { description: null, hint: null });
  assert.deepEqual(shown[3], { app: null, site: 'notes', group: 'Published sites', title: 'Synthetic notes', address: 'notes.sites.example.com',
    description: 'Static site', hint: null, href: 'https://notes.sites.example.com/', target: '_blank', rel: 'noopener noreferrer' });
  assert.equal(shown[4].description, 'App');
  for (const card of shown) assert.deepEqual([card.target, card.rel], ['_blank', 'noopener noreferrer'], `${card.app ?? card.site}: new tab, no opener`);
  if (label === 'phone') {
    const columns = await page.$eval('.apps-grid', n => getComputedStyle(n).gridTemplateColumns.split(' ').length);
    assert.equal(columns, 1, 'one card per row on a phone');
  }
  await noHorizontalScroll();
  await screenshot(label, 'apps');

  // Reload keeps the page.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.app-card[data-app="vault"]', { timeout: 20000 });
  assert.equal(await page.evaluate(() => location.hash), '#apps');

  // "All sites and versions" opens the Sites page.
  await clickText('All sites and versions');
  await page.waitForFunction(() => location.hash === '#sites', { timeout: 15000 });
  await page.waitForSelector('.site-row', { timeout: 15000 });
  await backToChat(page, clickText);

  // Nothing listed yet: the page says so; the sites stay.
  state.appLinks = { configured: false, links: [] };
  await openApps(page, clickText);
  await page.waitForSelector('.apps-empty', { timeout: 15000 });
  await waitText('No tools or apps are listed on this server yet.');
  assert.equal(await page.$('.app-card[data-app]'), null);
  await page.waitForSelector('.app-card[data-site="notes"]', { timeout: 15000 });
  await noHorizontalScroll();
  await screenshot(label, 'apps-empty');
  await backToChat(page, clickText);

  // A refused file: a plain notice, never its code.
  state.appLinks = { configured: true, error: 'custody_rejected', links: [] };
  await openApps(page, clickText);
  await page.waitForSelector('.apps-notice', { timeout: 15000 });
  const notice = await page.$eval('.apps-notice', n => n.textContent);
  assert.match(notice, /not protected the way it must be/);
  assert.doesNotMatch(notice, /custody_rejected/);
  assert.equal(await page.$('.apps-empty'), null, 'a refusal is not "nothing listed"');
  await backToChat(page, clickText);

  // An older server without the list: no tools section, the sites stay.
  state.appLinksMissing = true;
  await openApps(page, clickText);
  await page.waitForSelector('.app-card[data-site="notes"]', { timeout: 15000 });
  await page.waitForFunction(() => !document.body.textContent.includes('Loading tools'), { timeout: 15000 });
  assert.deepEqual(await page.$$eval('.apps-page :is(.apps-notice, .apps-empty, .app-card[data-app])', n => n.length), 0);
  await backToChat(page, clickText);
  state.appLinksMissing = false;
  state.appLinks = appLinksState();
}
