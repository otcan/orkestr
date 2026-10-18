import assert from 'node:assert/strict';
import { deadline } from './worker-fixture.mjs';

export const TASKS = 'section[aria-label="Worker tasks"]';
export const CHILD = `${TASKS} section[aria-label="Execution and resources"]`;
export const DRAFT = 'Synthetic unsent conversation draft retained during Worker activity.';
export const instructions = name => `TASK ${name}: independently inspect only synthetic section ${name}.\nReturn its count.`;
export async function wait(check, code, signal, milliseconds = 10000) {
  const start = performance.now();
  while (performance.now() - start < milliseconds) {
    signal.throwIfAborted();
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw Error(code);
}
export const enabled = (page, label, scope = 'body') => page.evaluate(({ label, scope }) =>
  [...(document.querySelector(scope)?.querySelectorAll('button') || [])]
    .some(button => button.textContent.trim() === label && !button.disabled), { label, scope });
export const click = (page, label, scope = 'body') => page.evaluate(({ label, scope }) => {
  const button = [...(document.querySelector(scope)?.querySelectorAll('button') || [])]
    .find(node => node.textContent.trim() === label);
  if (!button || button.disabled) throw Error('browser_button_unavailable');
  button.click();
}, { label, scope });
export const fill = (page, selector, value) => page.$eval(selector, (node, value) => {
  const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, value);
  node.dispatchEvent(new Event('input', { bubbles: true }));
}, value);
export const value = (page, selector) => page.$eval(selector, node => node.value);
export const read = (page, path) => page.evaluate(async path => {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  return { status: response.status, body: response.status === 200 ? await response.json() : null };
}, path);
export async function taskButton(page, title, label) {
  await page.waitForFunction(({ title, label, scope }) => {
    const row = [...document.querySelectorAll(`${scope} ol > li`)]
      .find(row => row.querySelector('h4')?.textContent === title);
    return [...(row?.querySelectorAll('button') || [])]
      .some(button => button.textContent.trim() === label && !button.disabled);
  }, {}, { title, label, scope: TASKS });
  await page.evaluate(({ title, label, scope }) => {
    const row = [...document.querySelectorAll(`${scope} ol > li`)]
      .find(row => row.querySelector('h4')?.textContent === title);
    const button = [...(row?.querySelectorAll('button') || [])]
      .find(button => button.textContent.trim() === label && !button.disabled);
    if (!button) throw Error('task_action_unavailable');
    button.click();
  }, { title, label, scope: TASKS });
}

// Hold/drop only a real response from this exact loopback origin. No status body
// is fabricated. The caller retains the original request/receipt in memory.
export async function responseFault(page, origin, pathname, method, action) {
  const cdp = await page.createCDPSession();
  let resolve, reject, held, capturedOnce = false;
  const captured = new Promise((done, fail) => { resolve = done; reject = fail; });
  const bounded = deadline(captured, 12000, 'response_fault_deadline');
  bounded.catch(() => {}); // An earlier caller failure still owns final cleanup.
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: `${origin}${pathname}*`, requestStage: 'Response' }] });
  cdp.on('Fetch.requestPaused', event => { void (async () => {
    const url = new URL(event.request.url);
    if (capturedOnce || url.origin !== origin || url.pathname !== pathname || event.request.method !== method) {
      await cdp.send('Fetch.continueRequest', { requestId: event.requestId }); return;
    }
    capturedOnce = true; held = event;
    const raw = await cdp.send('Fetch.getResponseBody', { requestId: event.requestId });
    const text = raw.base64Encoded ? Buffer.from(raw.body, 'base64').toString() : raw.body;
    resolve({ status: event.responseStatusCode, body: text ? JSON.parse(text) : null,
      request: event.request.postData ? JSON.parse(event.request.postData) : null });
  })().catch(reject); });
  try {
    return await action({ captured: bounded,
      release: async failed => {
        assert(held, 'response_not_held');
        await cdp.send(failed ? 'Fetch.failRequest' : 'Fetch.continueRequest',
          { requestId: held.requestId, ...(failed ? { errorReason: 'Failed' } : {}) });
        held = null;
      } });
  } finally {
    reject(Error('response_fault_closed'));
    if (held) await cdp.send('Fetch.continueRequest', { requestId: held.requestId }).catch(() => {});
    await cdp.send('Fetch.disable').catch(() => {});
    await cdp.detach();
  }
}
