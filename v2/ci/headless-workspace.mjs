// CI-only rendering of the configured beta workspace against a synthetic API.
// Exercises the real WASM bundle at desktop and phone widths; no provider runs.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { A, startMock } from './headless-workspace-mock.mjs';

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
];

try {
  browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  for (const [label, viewport] of [['desktop', { width: 1280, height: 860 }], ['phone', { width: 390, height: 844, isMobile: true, hasTouch: true }]]) {
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
