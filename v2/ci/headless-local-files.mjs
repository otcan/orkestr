// Real mounted WASM UI: the conversation's local folder control against the
// synthetic API. Chromium in CI cannot show a folder picker, so before the
// page loads this test replaces window.showDirectoryPicker with one returning
// a synthetic directory handle (local-files-fake-directory.mjs). That is the
// only hook, and it lives here: the UI bundle has none (checked below).
// Synthetic names and bytes only; no account, provider or real folder.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import puppeteer from 'puppeteer';
import {A, B, startMock} from './headless-workspace-mock.mjs';
import {fakeDirectory} from './local-files-fake-directory.mjs';

assert.equal(process.env.CI, 'true', 'Run only against the isolated synthetic API');
assert.ok(process.env.UI_BUNDLE_DIR, 'UI_BUNDLE_DIR is required');
const asset = await readFile(join(process.env.UI_BUNDLE_DIR, 'encrypted_upload.js'), 'utf8');
assert.ok(asset.includes('Connect folder'), 'the control ships in the release asset');
for (const marker of ['fakeDirectory', 'Synthetic folder', '__syntheticFolder']) assert.ok(!asset.includes(marker), `no test hook in the bundle: ${marker}`);

const sha = value => createHash('sha256').update(value).digest('hex');
const tree = {'a.txt': 'alpha', docs: {'plan.md': '# Plan\n'}};
const install = `(() => {
  const fakeDirectory = ${fakeDirectory.toString()};
  const root = fakeDirectory(${JSON.stringify(tree)});
  window.__syntheticFolder = root; window.__pickerCalls = [];
  // Like Chrome: the picker's readwrite mode grants view and change in that click.
  window.showDirectoryPicker = async options => {
    window.__pickerCalls.push(options);
    if (options?.mode === 'readwrite') root.fake.permissions.readwrite = 'granted';
    return root;
  };
})();`;
function untar(bytes) {
  const files = [];
  for (let at = 0; at + 512 <= bytes.length;) {
    const header = bytes.subarray(at, at + 512);
    if (header.every(b => b === 0)) break;
    const field = (o, l) => header.subarray(o, o + l).toString('utf8').replace(/\0[\s\S]*$/, '');
    const size = parseInt(field(124, 12), 8), prefix = field(345, 155), name = field(0, 100);
    files.push([prefix ? `${prefix}/${name}` : name, bytes.subarray(at + 512, at + 512 + size).toString()]);
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

const {server, state, origin} = await startMock(process.env.UI_BUNDLE_DIR);
const lf = state.localFiles;
async function served(id, label) {
  for (let i = 0; i < 400; i++) { if (lf.results.has(id)) return lf.results.get(id); await new Promise(r => setTimeout(r, 25)); }
  throw Error(`No result for ${label}`);
}
// Dioxus and the panel redraw asynchronously: a click on a node replaced in
// between is retried on the current node, never reported as passed.
async function press(page, selector) {
  for (let attempt = 0; ; attempt++) {
    try { await page.waitForSelector(selector); await page.click(selector); return; }
    catch (error) { if (attempt >= 4 || !/detached|not clickable|not an Element/i.test(error.message)) throw error; await new Promise(r => setTimeout(r, 100)); }
  }
}
const screenshots = async (page, name) => {
  if (!process.env.SCREENSHOT_DIR) return;
  await mkdir(process.env.SCREENSHOT_DIR, {recursive: true});
  await page.screenshot({path: join(process.env.SCREENSHOT_DIR, `local-files-${name}.png`)});
};
let browser;
try {
  browser = await puppeteer.launch({headless: true, args: ['--no-sandbox']});
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewport({width: 1280, height: 860});
  await page.evaluateOnNewDocument(install);
  await page.goto(`${origin}/#conversation/${A}`, {waitUntil: 'domcontentloaded'});
  await page.waitForSelector('.composer-context .local-folder-chip');
  assert.equal(lf.polls, 0, 'nothing is served before the owner connects a folder');
  // ORK-809: the composer has one folder chip (its state, and Connect in one
  // click); the full controls, in words, are in the Files panel.
  const folderView = () => page.evaluate(() => {
    const root = document.querySelector('.local-folder');
    const chips = [...document.querySelectorAll('.message-composer .composer-context .local-folder-chip')];
    return {state: root?.dataset.folderState, text: root?.querySelector('.local-folder-state')?.textContent,
      role: root?.querySelector('.local-folder-state')?.getAttribute('role'), inPanel: !!root?.closest('.files-drawer'),
      chips: chips.map(n => [n.tagName.toLowerCase(), n.textContent]), toolbar: !!document.querySelector('.conversation-toolbar')};
  });
  await page.waitForFunction(() => document.querySelector('.local-folder')?.dataset.folderState === 'none');
  assert.deepEqual(await folderView(), {state: 'none', text: 'No folder connected', role: 'status', inPanel: true, chips: [['button', 'Connect folder…']], toolbar: false});
  await screenshots(page, 'none');
  await press(page, '.composer-context .local-folder-chip');
  await page.waitForFunction(() => document.querySelector('.local-folder-live')?.textContent.includes('Synthetic folder'));
  assert.equal((await folderView()).state, 'ready');
  assert.equal((await folderView()).text, '● Folder connected: “Synthetic folder” · this chat can read and change files in it');
  await page.waitForFunction(() => document.querySelector('.composer-context a.local-folder-chip')?.textContent === '● Synthetic folder');
  assert.deepEqual((await folderView()).chips, [['a', '● Synthetic folder']], 'connected: one chip, a link to Files');
  // ORK-810: one browser prompt, at Connect, for viewing and changing the folder.
  assert.deepEqual(await page.evaluate(() => window.__pickerCalls), [{id: 'orkestr-local-folder', mode: 'readwrite'}], 'the picker asks once for read and write');
  assert.ok((await page.title()).startsWith('● '), 'the tab title shows the connection');
  assert.equal(lf.folder, 'Synthetic folder');
  await screenshots(page, 'connected');

  // The thread's requests, as the server queues them.
  const list = lf.enqueue('list', {path: ''});
  assert.deepEqual((await served(list, 'list')).listing.entries.map(e => [e.name, e.kind]), [['a.txt', 'file'], ['docs', 'directory']]);
  const read = lf.enqueue('read', {path: 'docs/plan.md'});
  const upload = await served(read, 'read');
  const prepared = state.uploads.find(u => u.upload_id === upload.upload_id);
  assert.equal(prepared?.encrypted, true, 'read through the encrypted upload path');
  assert.equal(Buffer.from(prepared.files[0].content_base64, 'base64').toString(), '# Plan\n');
  const hash = lf.enqueue('hash', {paths: ['a.txt', 'docs/plan.md']});
  assert.deepEqual((await served(hash, 'hash')).hashes.files.map(f => f.sha256), [sha('alpha'), sha('# Plan\n')]);
  const pack = lf.enqueue('package', {paths: ['a.txt', 'docs/plan.md']});
  const packaged = await served(pack, 'package');
  const archive = state.uploads.find(u => u.upload_id === packaged.upload_id);
  assert.match(archive.files[0].filename, /^selection-[0-9a-f]{12}\.tar$/);
  assert.deepEqual(untar(Buffer.from(archive.files[0].content_base64, 'base64')), [['a.txt', 'alpha'], ['docs/plan.md', '# Plan\n']]);
  const outside = lf.enqueue('read', {path: '../outside.txt'});
  assert.equal((await served(outside, 'outside')).error, 'invalid_path', 'the tab never leaves the folder, whatever the server asks');

  // ORK-810: a write applies on its own: no card, no browser prompt, logged.
  const prompts = () => page.evaluate(() => window.__syntheticFolder.fake.calls.filter(c => c[0] === 'requestPermission').length);
  const promptsBefore = await prompts();
  const write = lf.enqueue('write', {path: 'docs/plan.md', content: '# Plan v2\n'});
  assert.deepEqual((await served(write, 'write')).written, {bytes_written: 10, sha256: sha('# Plan v2\n'), created: false});
  assert.equal(await page.evaluate(() => window.__syntheticFolder.fake.text('docs/plan.md')), '# Plan v2\n');
  assert.equal(await page.$('.local-folder-confirm, .local-folder-allow'), null, 'no Allow write card');
  assert.equal(await prompts(), promptsBefore, 'no browser prompt after Connect');
  await page.waitForFunction(() => document.querySelector('.files-drawer .local-folder-activity')?.textContent.includes('write docs/plan.md (10 bytes): written'));
  assert.equal(await page.$('.composer-context .local-folder-activity'), null, 'the composer shows state, not the log');
  // The owner's test: ten small files at once. All are written, in order;
  // none is refused for the queue's size.
  const batch = [];
  for (let i = 1; i <= 10; i++) batch.push(lf.enqueue('write', {path: `docs/batch-${String(i).padStart(2, '0')}.txt`, content: `synthetic ${i}`}));
  for (const [i, id] of batch.entries()) assert.equal((await served(id, `batch ${i + 1}`)).outcome, 'done');
  const opened = await page.evaluate(() => window.__syntheticFolder.fake.calls.filter(c => c[0] === 'createWritable').map(c => c[1]).slice(-10));
  assert.deepEqual(opened, batch.map((_, i) => `batch-${String(i + 1).padStart(2, '0')}.txt`), 'in queue order');
  assert.equal(await page.evaluate(() => window.__syntheticFolder.fake.text('docs/batch-10.txt')), 'synthetic 10');
  // Rejected and expired writes stay listed: a path outside the folder, and
  // one the server expired while the tab still waited for its content.
  const outsideWrite = lf.enqueue('write', {path: '../outside.txt', content: 'x'});
  assert.equal((await served(outsideWrite, 'write outside')).error, 'invalid_path');
  const late = lf.enqueue('write', {path: 'a.txt', content: 'late'});
  lf.holdContent.add(late);
  await page.waitForFunction(() => document.querySelector('.files-drawer .local-folder-activity')?.textContent.includes('write a.txt (4 bytes): working'), {timeout: 15000});
  lf.expire(late);
  // Release the content only after the tab's polls no longer list the write.
  const pollsAtExpiry = lf.polls;
  for (let i = 0; i < 400 && lf.polls < pollsAtExpiry + 2; i++) await new Promise(r => setTimeout(r, 25));
  lf.holdContent.delete(late);
  await page.waitForFunction(() => document.querySelector('.files-drawer .local-folder-activity')?.textContent.includes('write a.txt (4 bytes): expired, nothing written'), {timeout: 15000});
  assert.equal(await page.$$eval('.files-drawer .local-folder-activity li', items => items.filter(li => li.textContent.includes('expired')).length), 1, 'recorded once');
  assert.equal(lf.results.has(late), false, 'nothing is reported for an expired write');
  assert.equal(await page.evaluate(() => window.__syntheticFolder.fake.text('a.txt')), 'alpha');
  const log = await page.$eval('.files-drawer .local-folder-activity', n => n.textContent);
  assert.match(log, /write \.\.\/outside\.txt \(1 bytes\): not written: invalid_path/);
  await page.click('#conversation-tab-files');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.files-drawer')).display !== 'none');
  await screenshots(page, 'folder-activity');
  await page.click('.files-drawer-close');

  // A hidden folder tab keeps applying writes, and no tab says "Approve write".
  const setHidden = hidden => page.evaluate(on => {
    if (on) {
      Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'hidden'});
      Object.defineProperty(document, 'hidden', {configurable: true, get: () => true});
    } else { delete document.visibilityState; delete document.hidden; }
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
  await page.waitForFunction(() => document.title === '● Orkestr', {timeout: 15000});
  const other = await browser.newPage();
  other.on('pageerror', error => errors.push(`other tab: ${error.message}`));
  await other.setViewport({width: 1280, height: 860});
  await other.goto(`${origin}/#conversation/${B}`, {waitUntil: 'domcontentloaded'});
  await other.waitForSelector('.conversation-row');
  await other.bringToFront();
  await setHidden(true);
  const hiddenWrite = lf.enqueue('write', {path: 'a.txt', content: 'hidden'});
  assert.equal((await served(hiddenWrite, 'hidden write')).outcome, 'done');
  assert.equal(await page.evaluate(() => window.__syntheticFolder.fake.text('a.txt')), 'hidden');
  assert.equal(await page.title(), '● Orkestr', 'no "Approve write" mark');
  assert.equal(await other.title(), 'Orkestr');
  assert.equal(await other.$('.write-waiting, .conversation-row[data-write-waiting]'), null, 'no waiting-write notice or row state');
  assert.equal(lf.waitingReads, 0, 'no tab reads the waiting-writes list');
  await other.close();
  await page.bringToFront();
  await setHidden(false);
  // A tab that cannot reach the server says its folder worker is offline.
  lf.failPolls = true;
  await page.waitForFunction(() => document.querySelector('.local-folder')?.dataset.folderState === 'offline', {timeout: 10000});
  assert.match((await folderView()).text, /^Folder worker offline: reconnecting “Synthetic folder”/);
  await screenshots(page, 'offline');
  lf.failPolls = false;
  await page.waitForFunction(() => document.querySelector('.local-folder')?.dataset.folderState === 'ready', {timeout: 10000});
  // The chip of a connected folder opens Files; revoking there stops serving
  // the folder at once.
  await press(page, '.composer-context a.local-folder-chip');
  await page.waitForFunction(conversation => location.hash === `#conversation/${conversation}/files`, {}, A);
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.files-drawer')).display !== 'none');
  await screenshots(page, 'files-panel-connected');
  await press(page, '.files-drawer .local-folder-disconnect');
  await page.waitForSelector('.files-drawer .local-folder-connect');
  await page.waitForFunction(() => document.querySelector('.composer-context .local-folder-chip')?.textContent === 'Connect folder…');
  assert.equal(lf.tab, null);
  assert.equal(lf.disconnects, 1);
  assert.ok(!(await page.title()).startsWith('● '), 'the indicator is gone');
  const polls = lf.polls;
  await new Promise(r => setTimeout(r, 2500));
  assert.equal(lf.polls, polls, 'no polling after disconnect');
  assert.deepEqual(errors, [], 'no unhandled browser error');
  await page.close();

  // Phone width: connect from the chip, a write applies, Files fits; a
  // browser without the API says so.
  const phone = await browser.newPage();
  await phone.setViewport({width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true});
  await phone.evaluateOnNewDocument(install);
  await phone.goto(`${origin}/#conversation/${A}`, {waitUntil: 'domcontentloaded'});
  await phone.waitForSelector('.composer-context .local-folder-chip');
  await press(phone, '.composer-context .local-folder-chip');
  await phone.waitForSelector('.local-folder-live');
  const phoneWrite = lf.enqueue('write', {path: 'a.txt', content: 'phone'});
  assert.equal((await served(phoneWrite, 'phone write')).outcome, 'done');
  await press(phone, '.composer-context a.local-folder-chip');
  await phone.waitForFunction(() => document.querySelector('.files-drawer .local-folder-activity')?.textContent.includes('write a.txt (5 bytes): written'));
  assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal scroll at phone width');
  await screenshots(phone, 'phone-files');
  await phone.close();
  const plain = await browser.newPage();
  await plain.evaluateOnNewDocument(() => { Object.defineProperty(window, 'showDirectoryPicker', {value: undefined, configurable: true}); });
  await plain.goto(`${origin}/#conversation/${A}`, {waitUntil: 'domcontentloaded'});
  await plain.waitForFunction(() => document.querySelector('.local-folder-note')?.textContent.includes('need Chrome or Edge'));
  assert.equal(await plain.$('.local-folder-connect'), null);
  assert.equal(await plain.$eval('.local-folder-chip-slot', n => n.hidden && n.children.length === 0), true, 'no folder chip in the composer');
  assert.equal(await plain.$eval('.local-folder', n => n.dataset.folderState), 'unsupported');
  assert.equal(await plain.$eval('.local-folder-state', n => n.textContent), 'Folder access unavailable in this browser');
  await plain.close();
  console.log('Local folder control: connect (read and write once), list, read, hash, package, writes applied in order without approval, rejected and expired writes logged, disconnect passed');
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
