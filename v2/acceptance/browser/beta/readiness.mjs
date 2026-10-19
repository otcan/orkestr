import {failure} from './diagnostics.mjs';

const ACTIONS = new Set(['First-time setup', 'Continue', 'Send', 'Stop',
  'Accept completion', 'Assistant', 'History', 'Projects', 'Host resources',
  'Reconnect', 'Reconnect and reload history', 'Sign out']);

// The enabled-label wait precedes the original one-shot action. It does not
// retry submissions, authenticate a caller or grant a desktop capability.
export async function clickReady(page, label) {
  if (!ACTIONS.has(label)) throw failure('invalid_action');
  await page.waitForFunction(expected => [...document.querySelectorAll('button')]
    .some(button => button.textContent.trim() === expected && !button.disabled),
  {timeout: 10_000}, label);
  await page.evaluate(expected => {
    const button = [...document.querySelectorAll('button')]
      .find(item => item.textContent.trim() === expected);
    if (!button || button.disabled) throw Error('readiness_unavailable');
    button.click();
  }, label);
}

export async function composerReady(page) {
  await page.waitForSelector('#composer', {visible: true, timeout: 10_000});
  await page.evaluate(() => new Promise(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

export async function setDraft(page, text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > 4096) {
    throw failure('invalid_action');
  }
  await composerReady(page);
  await page.$eval('#composer', (node, value) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(node, value);
    node.dispatchEvent(new Event('input', {bubbles: true}));
  }, text);
}

export const draft = page => page.$eval('#composer', node => node.value);

export async function timedNavigation(page, url, ready = composerReady) {
  const target = new URL(url);
  if (target.username || target.password || target.hash || target.search ||
      !(target.protocol === 'https:' || (target.protocol === 'http:' && target.hostname === '127.0.0.1'))) {
    throw failure('invalid_action');
  }
  const started = performance.now();
  await page.goto(target.href, {waitUntil: 'domcontentloaded', timeout: 15_000});
  await ready(page);
  return {render_ms: Math.round(performance.now() - started)};
}
