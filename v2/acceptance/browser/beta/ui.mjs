import assert from 'node:assert/strict';
import {clickReady, composerReady, draft, setDraft, timedNavigation} from './readiness.mjs';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const DRAFT = 'Synthetic beta draft retained across navigation and reconnect.';

async function fill(page, selector, value, origin) {
  await page.waitForSelector(selector, {visible: true, timeout: 10_000});
  await page.$eval(selector, (node, {text, origin}) => {
    if (location.origin !== origin) throw Error('unexpected_origin');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(node, text);
    node.dispatchEvent(new Event('input', {bubbles: true}));
  }, {text: value, origin});
}

async function session(page) {
  return page.evaluate(async () => {
    const response = await fetch('/api/v2/browser/session', {credentials: 'same-origin',
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000)});
    if (response.status !== 200) throw Error('readiness_unavailable');
    const body = await response.json();
    // Never transport the CSRF token or cookie into an acceptance receipt.
    return {conversation: body.global_conversation_id};
  });
}

export async function loginOwner({page, context, origin, credentials, bootstrap}) {
  assert.equal(new URL(origin).origin, origin, 'exact_origin_required');
  assert(typeof credentials?.username === 'string' && credentials.username.length <= 128);
  assert(typeof credentials.password === 'string' && credentials.password.length <= 1024);
  assert.equal((await context.cookies()).length, 0, 'fresh_owned_context_required');
  const timing = await timedNavigation(page, origin, async page => {
    await page.waitForSelector('#username', {visible: true, timeout: 10_000});
  });
  if (bootstrap !== undefined) {
    assert(typeof bootstrap === 'string' && bootstrap.length <= 1024);
    await clickReady(page, 'First-time setup', origin);
    await fill(page, '#bootstrap', bootstrap, origin);
  }
  await fill(page, '#username', credentials.username, origin);
  await fill(page, '#password', credentials.password, origin);
  await clickReady(page, 'Continue', origin);
  await composerReady(page);
  const projection = await session(page);
  assert(UUID.test(projection.conversation), 'conversation_required');
  const cookie = (await context.cookies()).find(item => item.name === 'orkestr_v2_session');
  assert(cookie?.httpOnly && cookie.sameSite === 'Strict' && cookie.path === '/api/v2', 'cookie_policy');
  // The identity is used only internally to bind later checks to this one owner
  // conversation. Public report fields contain timing/booleans, not credentials.
  return {conversation: projection.conversation, evidence: {login: true, cookie_policy: true, ...timing}};
}

export async function reloadOwner({page, conversation}) {
  const started = performance.now();
  await page.reload({waitUntil: 'domcontentloaded', timeout: 15_000});
  await composerReady(page);
  assert.equal((await session(page)).conversation, conversation, 'owner_changed_on_reload');
  return {owner_preserved: true, render_ms: Math.round(performance.now() - started)};
}

export async function draftRemount({page}) {
  const previous = await draft(page);
  await setDraft(page, DRAFT);
  await clickReady(page, 'Projects');
  await page.waitForSelector('#project-name', {visible: true, timeout: 10_000});
  await clickReady(page, 'Assistant');
  await composerReady(page);
  assert.equal(await draft(page), DRAFT, 'draft_lost_after_navigation');
  const old = await page.$('#composer');
  try {
    await clickReady(page, 'Reconnect and reload history');
    await page.waitForFunction(node => !node.isConnected, {timeout: 10_000}, old);
  } finally { await old.dispose(); }
  await composerReady(page);
  assert.equal(await draft(page), DRAFT, 'draft_lost_after_reconnect');
  await setDraft(page, previous);
  return {navigation_preserved: true, reconnect_preserved: true, no_submission: true};
}

export async function cpuAndRam({page}) {
  await clickReady(page, 'Host resources');
  await page.waitForFunction(() => {
    const panel = document.querySelector('section[aria-label="Host resources"]');
    const values = [...(panel?.querySelectorAll('dd') ?? [])].map(node => node.textContent);
    return panel?.textContent.includes('Host resources current') && values.length === 2 &&
      /^\d+\.\d% busy$/.test(values[0]) && /^\d+ MiB used \/ \d+ MiB total/.test(values[1]);
  }, {timeout: 15_000});
  const observed = await page.evaluate(async () => {
    const response = await fetch('/api/v2/resources', {credentials: 'same-origin',
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000)});
    if (response.status !== 200) throw Error('readiness_unavailable');
    const reader = response.body.getReader(), chunks = [];
    let bytes = 0;
    try {
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 65536) throw Error('request_budget');
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const joined = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { joined.set(chunk, offset); offset += chunk.length; }
    const sample = JSON.parse(new TextDecoder().decode(joined));
    return {schema: sample.schema_version, scope: sample.scope, availability: sample.availability,
      observed_at_ms: sample.observed_at_ms, cpu: sample.cpu, memory: sample.memory};
  });
  assert.equal(observed.schema, 1);
  assert.equal(observed.scope, 'host');
  assert.equal(observed.availability, 'ready');
  assert(Number.isSafeInteger(observed.observed_at_ms) && observed.observed_at_ms > 0);
  assert(Number.isSafeInteger(observed.cpu?.busy_permille) && observed.cpu.busy_permille >= 0 && observed.cpu.busy_permille <= 1000);
  assert(Number.isSafeInteger(observed.cpu.interval_ms) && observed.cpu.interval_ms >= 1000 && observed.cpu.interval_ms <= 10_000);
  const memory = observed.memory;
  assert(memory && [memory.total_bytes, memory.available_bytes, memory.used_bytes].every(Number.isSafeInteger));
  assert(memory.total_bytes > 0 && memory.available_bytes >= 0 && memory.available_bytes <= memory.total_bytes);
  assert.equal(memory.used_bytes, memory.total_bytes - memory.available_bytes);
  await clickReady(page, 'Assistant');
  await composerReady(page);
  return {actual_cpu_visible: true, actual_ram_visible: true, native_sample_ready: true, scope: 'host_aggregate'};
}
