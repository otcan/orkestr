import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
export const secret = () => crypto.randomBytes(32).toString('hex');

async function files(root, relative = '') {
  const result = [];
  for (const item of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = path.join(relative, item.name);
    assert(!item.isSymbolicLink(), 'bundle_symlink_refused');
    if (item.isDirectory()) result.push(...await files(root, name));
    else if (item.isFile()) result.push(name);
    else assert.fail('bundle_special_file_refused');
    assert(result.length <= 4096, 'bundle_file_limit');
  }
  return result.sort();
}

export async function provenance(file) {
  const value = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(value.schema_version, 1, 'provenance_schema');
  for (const artifact of [value.server, value.ui]) {
    assert(/^[a-f0-9]{40}$/.test(artifact.source_sha), 'source_pin_required');
    assert(path.isAbsolute(artifact.path), 'absolute_artifact_path_required');
  }
  assert.equal(value.server.features, 'default', 'ordinary_server_required');
  assert.equal(digest(await fs.readFile(value.server.path)), value.server.sha256, 'server_hash_mismatch');
  const actual = await files(value.ui.path);
  assert.deepEqual(actual, Object.keys(value.ui.files).sort(), 'bundle_inventory_mismatch');
  assert(actual.includes('index.html') && actual.some((p) => p.endsWith('.wasm')), 'wasm_bundle_required');
  let total = 0;
  for (const name of actual) {
    const bytes = await fs.readFile(path.join(value.ui.path, name));
    assert(bytes.length <= 8 * 1024 * 1024, 'bundle_asset_limit');
    total += bytes.length;
    assert.equal(digest(bytes), value.ui.files[name], 'bundle_hash_mismatch');
  }
  assert(total <= 64 * 1024 * 1024, 'bundle_total_limit');
  return { ...value, bundle_bytes: total };
}

export async function browserLease(file) {
  const lease = JSON.parse(await fs.readFile(file, 'utf8'));
  const endpoint = new URL(lease.browserURL);
  assert(endpoint.protocol === 'http:' && endpoint.hostname === '127.0.0.1', 'managed_loopback_cdp_required');
  assert(!endpoint.username && !endpoint.password && !endpoint.search, 'cdp_credentials_refused');
  assert(lease.desktopSlug && lease.ownerThread && lease.acquired === true, 'managed_lease_receipt_required');
  assert(Date.parse(lease.expiresAt) > Date.now() + 5 * 60_000, 'lease_too_short_or_expired');
  return lease;
}

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

export class Candidate {
  static async create(artifact, root) {
    return new Candidate(artifact, root, await freePort());
  }
  constructor(artifact, root, port) {
    this.artifact = artifact;
    this.root = root;
    this.port = port;
    this.origin = `http://127.0.0.1:${port}`;
    this.bootstrap = secret();
    this.child = null;
    this.launches = 0;
  }
  async start(namespace = 'owner-a') {
    assert(!this.child, 'candidate_already_running');
    assert(['owner-a', 'owner-b'].includes(namespace), 'synthetic_namespace_required');
    const home = path.join(this.root, namespace);
    await fs.mkdir(home, { mode: 0o700, recursive: true });
    // Deliberate allowlist: no inherited provider, connector, profile, or legacy env.
    this.child = spawn(this.artifact.server.path, [], {
      cwd: this.root,
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', ORKESTR_V2_HOME: home,
        ORKESTR_V2_BIND: `127.0.0.1:${this.port}`, ORKESTR_V2_ORIGIN: this.origin,
        ORKESTR_V2_BOOTSTRAP_TOKEN: this.bootstrap, ORKESTR_V2_UI_DIST: this.artifact.ui.path },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    this.launches += 1;
    this.exit = new Promise((resolve) => {
      this.child.once('exit', (code, signal) => resolve({ code, signal }));
      this.child.once('error', () => resolve({ code: null, signal: null, error: true }));
    });
    let launchError = false;
    this.child.once('error', () => { launchError = true; });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      this.signal?.throwIfAborted();
      assert(!launchError && this.child.exitCode === null && this.child.signalCode === null, 'candidate_start_failed');
      try {
        const response = await fetch(`${this.origin}/api/v2/health`, { signal: AbortSignal.timeout(500) });
        if (response.ok) {
          const health = await response.json();
          assert.equal(health.product, 'orkestr-v2', 'unexpected_candidate_product');
          assert.equal(health.fixture_mode, false, 'fixture_server_refused');
          return;
        }
      } catch { /* Wait for this owned child, never reuse another service. */ }
      await delay(100);
    }
    assert.fail('candidate_readiness_timeout');
  }
  async stop() {
    if (!this.child) return;
    const child = this.child;
    const ended = () => child.exitCode !== null || child.signalCode !== null;
    if (!ended()) child.kill('SIGINT');
    if (!await Promise.race([this.exit.then(() => true), delay(2500).then(() => false)])) {
      child.kill('SIGKILL');
      await this.exit;
    }
    this.child = null;
  }
  async seedHistory(credentials, conversation) {
    const login = await fetch(`${this.origin}/api/v2/machine/session`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(credentials),
    });
    assert.equal(login.status, 200, 'synthetic_seed_login_failed');
    const { token } = await login.json();
    let next = 0;
    let completed = 0;
    let failed = false;
    const started = performance.now();
    const workers = await Promise.allSettled(Array.from({ length: 4 }, async () => {
      try { while (!failed) {
        this.signal?.throwIfAborted();
        const index = next++;
        if (index >= 10_000) return;
        const response = await fetch(`${this.origin}/api/v2/conversations/${conversation}/messages`, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ client_message_id: `synthetic-browser-history-${index}`,
            text: `Synthetic browser acceptance history ${index}` }),
          signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(this.signal ? [this.signal] : [])]),
        });
        if (response.status !== 202) { failed = true; assert.fail('synthetic_history_admission_failed'); }
        await response.arrayBuffer();
        completed += 1;
        if (completed % 2500 === 0) process.stdout.write(`${JSON.stringify({ phase: 'seed_history', completed })}\n`);
      } } catch (error) { failed = true; throw error; }
    }));
    assert(workers.every((worker) => worker.status === 'fulfilled'), 'synthetic_history_admission_failed');
    assert.equal(completed, 10_000, 'history_count_incomplete');
    return { messages: completed, duration_ms: Math.round(performance.now() - started) };
  }
}

export async function click(page, label) {
  const handle = await page.evaluateHandle((text) => [...document.querySelectorAll('button')]
    .find((button) => button.textContent.trim() === text), label);
  const element = handle.asElement();
  assert(element, `button_missing_${label.replaceAll(/\W+/g, '_')}`);
  try { await element.click(); } finally { await handle.dispose(); }
}
export const text = (page, value, timeout = 10_000) => page.waitForFunction(
  (expected) => document.body.innerText.includes(expected), { timeout }, value);
export const value = (page, selector) => page.$eval(selector, (element) => element.value);
export async function waitFor(predicate, code, timeout = 10_000) {
  const started = performance.now();
  while (performance.now() - started < timeout) {
    if (await predicate()) return;
    await delay(50);
  }
  assert.fail(code);
}
export async function fill(page, selector, content) {
  await page.waitForSelector(selector, { visible: true });
  await page.click(selector, { clickCount: 3 });
  await page.keyboard.press('Backspace');
  await page.type(selector, content);
}

export async function createNetwork(page, origin) {
  const state = { execution: 'real', resources: 'real', logout: 'real', resourceSample: null,
    heldExecution: [], heldLogout: [], executionReads: 0, resourcesReads: 0,
    externalRequests: 0, interceptedFailures: 0, getAuthorityHeaders: 0, snapshots: [], requestKinds: {} };
  await page.setRequestInterception(true);
  page.on('request', (request) => { void (async () => {
    const url = new URL(request.url());
    if (url.origin !== origin) {
      if (['data:', 'about:'].includes(url.protocol)) return request.continue();
      state.externalRequests += 1;
      return request.abort();
    }
    const name = `${request.method()} ${url.pathname.replace(/[a-f0-9-]{36}/g, ':id')}`;
    state.requestKinds[name] = (state.requestKinds[name] || 0) + 1;
    if (request.method() === 'GET' && (request.headers().authorization || request.headers()['x-orkestr-csrf'])) state.getAuthorityHeaders += 1;
    if (url.pathname.endsWith('/execution')) {
      state.executionReads += 1;
      if (state.execution === 'hold') { state.heldExecution.push(request); return; }
    }
    if (url.pathname === '/api/v2/browser/session' && request.method() === 'DELETE' && state.logout === 'hold') {
      state.heldLogout.push(request); return;
    }
    if (url.pathname === '/api/v2/resources') {
      state.resourcesReads += 1;
      if (state.resources === 'cached') return request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(state.resourceSample) });
      if (state.resources === 'unavailable' || state.resources === 'unauthorized') return request.respond({
        status: state.resources === 'unauthorized' ? 401 : 503,
        contentType: 'application/json', body: '{"error":"synthetic_resource_fault"}',
      });
    }
    await request.continue();
  })().catch(() => { state.interceptedFailures += 1; }); });
  page.on('response', (response) => { void (async () => {
    const url = new URL(response.url());
    if (url.origin !== origin) return;
    if (url.pathname === '/api/v2/resources' && state.resources === 'real' && response.status() === 200) {
      state.resourceSample = await response.json();
    }
    if (/^\/api\/v2\/conversations\/[^/]+$/.test(url.pathname) && response.status() === 200) {
      const body = await response.buffer();
      state.snapshots.push({ bytes: body.length, messages: JSON.parse(body).messages.length });
      if (state.snapshots.length > 2000) state.snapshots.shift();
    }
  })().catch(() => {}); });
  state.release = async (kind) => {
    const held = state[kind].splice(0);
    for (const request of held) {
      try { await request.continue(); } catch { state.interceptedFailures += 1; }
    }
  };
  return state;
}
