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
  window.showDirectoryPicker = async options => { window.__pickerCalls.push(options); return root; };
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
  await page.waitForSelector('.local-folder-connect');
  assert.equal(lf.polls, 0, 'nothing is served before the owner connects a folder');
  // ORK-786: the control sits in the composer's attach actions, not in a
  // floating toolbar, and states its state in words.
  const folderView = () => page.evaluate(() => {
    const root = document.querySelector('.local-folder');
    return {state: root?.dataset.folderState, text: root?.querySelector('.local-folder-state')?.textContent,
      role: root?.querySelector('.local-folder-state')?.getAttribute('role'), inComposer: !!root?.closest('.message-composer .composer-context'),
      toolbar: !!document.querySelector('.conversation-toolbar')};
  });
  await page.waitForFunction(() => document.querySelector('.local-folder')?.dataset.folderState === 'none');
  assert.deepEqual(await folderView(), {state: 'none', text: 'No folder connected', role: 'status', inComposer: true, toolbar: false});
  await screenshots(page, 'none');
  await press(page, '.local-folder-connect');
  await page.waitForFunction(() => document.querySelector('.local-folder-live')?.textContent.includes('Synthetic folder'));
  assert.equal((await folderView()).state, 'ready');
  assert.match((await folderView()).text, /Folder ready: “Synthetic folder” · read-only, writes ask you first/);
  assert.deepEqual(await page.evaluate(() => window.__pickerCalls), [{id: 'orkestr-local-folder', mode: 'read'}], 'the picker asks for read access only');
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

  // A write waits for the owner; Allow asks the browser for write access.
  const write = lf.enqueue('write', {path: 'docs/plan.md', content: '# Plan v2\n'});
  await page.waitForSelector('.local-folder-confirm');
  assert.match(await page.$eval('.local-folder-confirm', n => n.textContent), /Write 10 bytes to “docs\/plan\.md”[\s\S]*# Plan v2/);
  await new Promise(r => setTimeout(r, 500));
  assert.equal(lf.results.has(write), false, 'nothing is written before the owner answers');
  assert.equal(await page.evaluate(() => window.__syntheticFolder.fake.text('docs/plan.md')), '# Plan\n');
  await screenshots(page, 'confirm-write');
  await press(page, '.local-folder-allow');
  assert.deepEqual((await served(write, 'write')).written, {bytes_written: 10, sha256: sha('# Plan v2\n'), created: false});
  assert.equal(await page.evaluate(() => window.__syntheticFolder.fake.text('docs/plan.md')), '# Plan v2\n');
  assert.ok(await page.evaluate(() => window.__syntheticFolder.fake.calls.some(c => c[0] === 'requestPermission' && c[1] === 'readwrite')));
  await page.waitForFunction(() => !document.querySelector('.local-folder-confirm'));
  const refused = lf.enqueue('write', {path: 'a.txt', content: 'overwritten'});
  await page.waitForSelector('.local-folder-confirm');
  await press(page, '.local-folder-refuse');
  assert.equal((await served(refused, 'refused write')).error, 'refused_by_owner');
  assert.equal(await page.evaluate(() => window.__syntheticFolder.fake.text('a.txt')), 'alpha');

  // The activity log is inspected in the Files & context drawer.
  await page.waitForFunction(() => document.querySelector('.files-drawer .local-folder-activity')?.textContent.includes('refused_by_owner'));
  assert.equal(await page.$('.composer-context .local-folder-activity'), null, 'the composer shows state, not the log');

  // ORK-804: a write waiting for the owner while the folder tab is hidden
  // still shows: in that tab's title, and in every other tab of the app
  // (title, a notice saying where to answer, the chat's row). One that
  // expires before the owner answers is recorded once in Folder activity.
  const setHidden = hidden => page.evaluate(on => {
    if (on) {
      Object.defineProperty(document, 'visibilityState', {configurable: true, get: () => 'hidden'});
      Object.defineProperty(document, 'hidden', {configurable: true, get: () => true});
    } else { delete document.visibilityState; delete document.hidden; }
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
  await page.waitForFunction(() => document.title === '● Orkestr', {timeout: 15000});
  // A hidden page runs no animation frames: poll on a timer, not the default 'raf'.
  const hiddenWait = {timeout: 15000, polling: 250};
  const other = await browser.newPage();
  other.on('pageerror', error => errors.push(`other tab: ${error.message}`));
  await other.setViewport({width: 1280, height: 860});
  await other.goto(`${origin}/#conversation/${B}`, {waitUntil: 'domcontentloaded'});
  await other.waitForSelector('.conversation-row');
  await other.bringToFront();
  await setHidden(true);
  const late = lf.enqueue('write', {path: 'a.txt', content: 'late'});
  await page.waitForFunction(() => document.title.startsWith('Approve write · '), hiddenWait);
  assert.equal(await page.title(), 'Approve write · ● Orkestr', 'the hidden folder tab says a write waits');
  await page.waitForSelector('.local-folder-confirm');
  await other.waitForFunction(() => document.title === 'Approve write · Orkestr', {timeout: 15000});
  await other.waitForSelector('.write-waiting');
  const notice = await other.$eval('.write-waiting', n => n.textContent);
  assert.match(notice, /^Approve write/);
  assert.match(notice, /“Assistant” wants to change a file in your folder\. Allow or refuse it in the browser tab where the folder “Synthetic folder” is connected\./);
  await other.waitForFunction(() => [...document.querySelectorAll('.conversation-row[data-write-waiting=true]')]
    .some(row => row.querySelector('.work-state.status-attention')?.textContent === 'Approve write' && row.textContent.includes('Assistant')), {timeout: 15000});
  assert.equal(await other.$$eval('.conversation-row[data-write-waiting=true]', rows => rows.length), 1, 'only the waiting chat');
  assert.ok(await other.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'the notice fits');
  await screenshots(other, 'write-waiting-elsewhere');
  lf.expire(late);
  await page.waitForFunction(() => !document.querySelector('.local-folder-confirm'), hiddenWait);
  await page.waitForFunction(() => document.querySelector('.files-drawer .local-folder-activity')?.textContent.includes('write a.txt: expired, nothing written'), hiddenWait);
  assert.equal(await page.$$eval('.files-drawer .local-folder-activity li', items => items.filter(li => li.textContent.includes('expired')).length), 1, 'recorded once');
  assert.equal(lf.results.has(late), false, 'nothing is reported for an expired write');
  assert.equal(await page.evaluate(() => window.__syntheticFolder.fake.text('a.txt')), 'alpha');
  await page.waitForFunction(() => document.title === '● Orkestr', hiddenWait);
  await other.waitForFunction(() => !document.querySelector('.write-waiting') && document.title === 'Orkestr', {timeout: 15000});
  assert.ok(lf.waitingReads > 0);
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
  // Revoking stops serving the folder at once.
  await press(page, '.local-folder-disconnect');
  await page.waitForSelector('.local-folder-connect');
  assert.equal(lf.tab, null);
  assert.equal(lf.disconnects, 1);
  assert.ok(!(await page.title()).startsWith('● '), 'the indicator is gone');
  const polls = lf.polls;
  await new Promise(r => setTimeout(r, 2500));
  assert.equal(lf.polls, polls, 'no polling after disconnect');
  assert.deepEqual(errors, [], 'no unhandled browser error');
  await page.close();

  // Phone width: the confirmation fits; a browser without the API says so.
  const phone = await browser.newPage();
  await phone.setViewport({width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true});
  await phone.evaluateOnNewDocument(install);
  await phone.goto(`${origin}/#conversation/${A}`, {waitUntil: 'domcontentloaded'});
  await phone.waitForSelector('.local-folder-connect');
  await press(phone, '.local-folder-connect');
  await phone.waitForSelector('.local-folder-live');
  lf.enqueue('write', {path: 'a.txt', content: 'phone'});
  await phone.waitForSelector('.local-folder-confirm');
  assert.ok(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'no horizontal scroll at phone width');
  await screenshots(phone, 'phone-confirm');
  await phone.close();
  const plain = await browser.newPage();
  await plain.evaluateOnNewDocument(() => { Object.defineProperty(window, 'showDirectoryPicker', {value: undefined, configurable: true}); });
  await plain.goto(`${origin}/#conversation/${A}`, {waitUntil: 'domcontentloaded'});
  await plain.waitForFunction(() => document.querySelector('.local-folder-note')?.textContent.includes('need Chrome or Edge'));
  assert.equal(await plain.$('.local-folder-connect'), null);
  assert.equal(await plain.$eval('.local-folder', n => n.dataset.folderState), 'unsupported');
  assert.equal(await plain.$eval('.local-folder-state', n => n.textContent), 'Folder access unavailable in this browser');
  await plain.close();
  console.log('Local folder control: connect, list, read, hash, package, confirmed and refused writes, disconnect passed');
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
