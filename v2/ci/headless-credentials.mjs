// ORK-826: the Credentials page in the real WASM bundle against the synthetic
// API (headless-credentials-mock.mjs). Opened from Orkestr settings; a clear
// table with chat names (never ids), last use and status; search and type
// filter; add with type-specific fields and a chat picker; edit and delete
// after a confirmation; a value goes to the server once and never shows.
import assert from 'node:assert/strict';
import { SECRET, credentialsState } from './headless-credentials-mock.mjs';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';

const rows = page => page.$$eval('.credential-row', nodes => nodes.map(row => {
  const cell = label => row.querySelector(`td[data-label="${label}"]`);
  return {
    name: row.querySelector('.credential-name strong')?.textContent,
    site: row.querySelector('.credential-site')?.textContent ?? '',
    type: cell('Type')?.textContent.trim(),
    users: [...row.querySelectorAll('.credential-user')].map(n => n.textContent),
    usersText: cell('Used by')?.innerText.trim(),
    last: cell('Last used')?.innerText.replace(/\s+/g, ' ').trim(),
    status: row.querySelector('.credential-status')?.textContent,
    detail: row.querySelector('.credential-detail')?.textContent ?? '',
  };
}));
const rowNamed = async (page, name) => (await rows(page)).find(r => r.name === name);
const clickInRow = (page, name, label) => page.evaluate((name, label) => {
  const row = [...document.querySelectorAll('.credential-row')].find(r => r.querySelector('.credential-name strong')?.textContent === name);
  const button = [...(row?.querySelectorAll('button') ?? [])].find(b => b.textContent.trim() === label && !b.disabled);
  if (!button) return false;
  button.click(); return true;
}, name, label);
const setField = async (page, scope, name, value) => {
  const selector = `${scope} [name="${name}"]`;
  await page.waitForSelector(selector);
  await page.$eval(selector, n => { n.value = ''; });
  await page.type(selector, value);
};
const tick = (page, scope, selector) => page.$eval(`${scope} ${selector}`, n => n.click());
const chatBox = (page, scope, name) => page.evaluate((scope, name) => {
  const label = [...document.querySelectorAll(`${scope} .credential-chat`)].find(l => l.textContent.trim() === name);
  label?.querySelector('input')?.click();
  return !!label;
}, scope, name);
const until = async (check, what, timeout = 15000) => {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 50));
  }
};

export async function credentialsPage({ page, state, clickText, waitText, screenshot, label, noHorizontalScroll }) {
  state.credentialStore = credentialsState();
  const store = () => state.credentialStore;
  // Orkestr settings → Credentials: a global page with its own location.
  await page.$eval('.global-settings', b => b.click());
  await page.waitForSelector('.orkestr-settings .credentials-entry');
  await clickText('Open credentials');
  await page.waitForFunction(() => location.hash === '#credentials', { timeout: 15000 });
  await page.waitForSelector('.credential-row', { timeout: 15000 });
  assert.equal(await page.$eval('.conversation-heading h2', n => n.textContent), 'Credentials');
  assert.equal(await page.$eval('.global-settings', n => n.getAttribute('aria-current')), 'page', 'Settings stays marked while its Credentials page is open');
  assert.equal(await page.$('.credential-form'), null, 'the add form is closed until asked for');

  // One clear row per credential: names of chats, never their ids.
  await page.waitForFunction(() => [...document.querySelectorAll('.credential-user')].some(n => n.textContent === 'Research notes'), { timeout: 15000 });
  const search = await rowNamed(page, 'Synthetic search API');
  assert.deepEqual({ type: search.type, users: search.users, site: search.site }, { type: 'API key', users: ['Assistant', 'Research notes'], site: 'search.example.invalid' });
  assert.match(search.last, /^5 min ago by Research notes 2 chats so far$/);
  assert.equal(search.status, 'OK');
  const portal = await rowNamed(page, 'Synthetic portal');
  assert.deepEqual({ users: portal.users, status: portal.status, detail: portal.detail }, { users: ['Your desks (automatic sign-in)'], status: 'Failed last sign-in', detail: 'the site rejected it' });
  const government = await rowNamed(page, 'Synthetic government login');
  assert.deepEqual({ users: government.users, status: government.status }, { users: ['Assistant', 'Your desks (automatic sign-in)'], status: 'Needs 2FA code' });
  const token = await rowNamed(page, 'Synthetic CI token');
  assert.deepEqual({ users: token.usersText, last: token.last, status: token.status }, { users: 'No chat yet', last: 'Not yet', status: 'Never used' });
  const visible = await page.evaluate(() => document.querySelector('.credentials-page').innerText);
  for (const id of [A, B, C]) assert.ok(!visible.includes(id), 'chat ids are never shown');
  const link = await page.evaluate(() => { const a = [...document.querySelectorAll('.credential-row')][0].querySelector('a.credential-reveal');
    return a && { href: a.href, target: a.target, rel: a.rel, text: a.textContent }; });
  assert.ok(link?.href.endsWith('creds%2Fsynthetic-ci-token') && link.target === '_blank' && link.rel.includes('noopener'), JSON.stringify(link));
  await screenshot(label, 'credentials');

  // Search (name, site, chat) and the type filter.
  await page.type('.credentials-search', 'research');
  await page.waitForFunction(() => document.querySelectorAll('.credential-row').length === 1);
  assert.equal((await rows(page))[0].name, 'Synthetic search API');
  await page.$eval('.credentials-search', n => { n.value = ''; n.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.waitForFunction(() => document.querySelectorAll('.credential-row').length === 4);
  await page.select('.credentials-filter', 'password');
  await page.waitForFunction(() => document.querySelectorAll('.credential-row').length === 2);
  await page.select('.credentials-filter', '');
  await page.waitForFunction(() => document.querySelectorAll('.credential-row').length === 4);

  // Add: an API key has a key field and no username; chats are picked by name.
  await clickText('Add credential');
  const add = 'form.credential-form[aria-label="Add credential"]';
  await page.waitForSelector(add);
  await page.evaluate(scope => [...document.querySelectorAll(`${scope} .credential-kind`)].find(l => l.textContent.trim() === 'API key').querySelector('input').click(), add);
  await page.waitForSelector(`${add} [name="api_key"]`);
  assert.equal(await page.$(`${add} [name="username"]`), null, 'an API key has no username field');
  assert.equal(await page.$eval(`${add} [name="api_key"]`, n => n.type), 'password', 'the value is masked while typed');
  assert.equal(await page.$(`${add} [name="owner_desks"]`), null, 'desk sign-in is offered for passwords only');
  await setField(page, add, 'label', 'Synthetic weather API');
  await setField(page, add, 'site', 'https://www.weather.example.invalid/docs');
  await setField(page, add, 'api_key', SECRET);
  assert.ok(await chatBox(page, add, 'Queued errands'), 'the picker lists chats by name');
  await screenshot(label, 'credentials-add');
  await clickText('Save credential');
  await waitText('Saved “Synthetic weather API”.');
  await until(() => store().posts.length === 1, 'the add request');
  assert.deepEqual(store().posts[0], { type: 'api_key', label: 'Synthetic weather API', site: 'https://www.weather.example.invalid/docs',
    allowed: [C], owner_desks: false, value: { api_key: SECRET } });
  await page.waitForFunction(() => [...document.querySelectorAll('.credential-name strong')].some(n => n.textContent === 'Synthetic weather API'));
  assert.equal(await page.$(add), null, 'the form closes after saving');
  assert.ok(!(await page.content()).includes(SECRET), 'the typed value is gone from the page');

  // Edit: rename and drop a chat; nothing is saved before the owner confirms.
  assert.ok(await clickInRow(page, 'Synthetic search API', 'Edit'));
  const edit = 'form.credential-form[aria-label="Edit “Synthetic search API”"]';
  await page.waitForSelector(edit);
  await setField(page, edit, 'label', 'Synthetic search');
  assert.ok(await chatBox(page, edit, 'Assistant'));
  await clickText('Save changes');
  await page.waitForSelector(`${edit} .credential-confirm`);
  const summary = await page.$$eval(`${edit} .credential-confirm li`, n => n.map(li => li.textContent));
  assert.deepEqual(summary, ['Name: “Synthetic search API” → “Synthetic search”', 'Remove: Assistant']);
  assert.equal(store().patches.length, 0, 'the confirmation comes first');
  await clickText('Confirm and save');
  await until(() => store().patches.length === 1, 'the edit request');
  assert.deepEqual(store().patches[0], { id: 'synthetic-search', expected_revision: '1:t1', label: 'Synthetic search', allowed: [B] });
  await page.waitForFunction(() => [...document.querySelectorAll('.credential-name strong')].some(n => n.textContent === 'Synthetic search'));

  // Replace only the password of a login: one value request with the revision it saw.
  assert.ok(await clickInRow(page, 'Synthetic portal', 'Edit'));
  const portalEdit = 'form.credential-form[aria-label="Edit “Synthetic portal”"]';
  await page.waitForSelector(portalEdit);
  await tick(page, portalEdit, '[name="replace"]');
  await setField(page, portalEdit, 'password', SECRET);
  await clickText('Save changes');
  await page.waitForSelector(`${portalEdit} .credential-confirm`);
  await clickText('Confirm and save');
  await until(() => store().puts.length === 1, 'the value request');
  assert.deepEqual(store().puts[0], { id: 'synthetic-portal', expected_revision: '2:t2', value: { password: SECRET } });
  await waitText('Saved changes to “Synthetic portal”.');
  assert.ok(!(await page.content()).includes(SECRET));

  // Delete after a confirmation that says what it does.
  assert.ok(await clickInRow(page, 'Synthetic CI token', 'Delete'));
  await page.waitForSelector('.credentials-confirm');
  assert.match(await page.$eval('.credentials-confirm', n => n.textContent), /Delete “Synthetic CI token”\? Chats and desks lose access to it at once/);
  await screenshot(label, 'credentials-delete');
  await page.evaluate(() => [...document.querySelectorAll('.credentials-confirm button')].find(b => b.textContent.trim() === 'Delete').click());
  await until(() => store().deletes.length === 1, 'the delete request');
  assert.deepEqual(store().deletes[0], { id: 'synthetic-ci-token', expected_revision: '1:t4' });
  await page.waitForFunction(() => ![...document.querySelectorAll('.credential-name strong')].some(n => n.textContent === 'Synthetic CI token'));

  // Phones: one card per credential, each value named, no sideways scroll.
  if (label === 'phone') {
    const layout = await page.evaluate(() => ({
      head: document.querySelector('.credentials-table thead').getBoundingClientRect().width,
      display: getComputedStyle(document.querySelector('.credential-row')).display,
      label: getComputedStyle(document.querySelector('.credential-row td[data-label="Status"]'), '::before').content,
    }));
    assert.deepEqual(layout, { head: 1, display: 'block', label: '"Status"' });
  }
  await noHorizontalScroll();
  await screenshot(label, 'credentials-after');
  await clickText('Back to chat');
  await page.waitForSelector('#composer');
}
