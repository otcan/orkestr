#!/usr/bin/env node
// Fresh synthetic namespaces and owned contexts on a previously leased browser.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { browserLease, digest, provenance } from './support.mjs';
import { fixtureSource } from './worker-artifacts.mjs';
import { WorkerFixture, deadline } from './worker-fixture.mjs';
import { click, fill } from './worker-support.mjs';
import { workerScenarios } from './fast-browser-scenarios.mjs';

const options = {};
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  assert(['--provenance', '--lease-receipt', '--puppeteer-module', '--output', '--cases', '--verify-only'].includes(key));
  assert(!(key in options)); options[key] = key === '--verify-only' ? true : process.argv[++index];
  assert(options[key]);
}
const artifact = await provenance(options['--provenance']);
const source = await fixtureSource(artifact);
if (options['--verify-only']) {
  console.log(JSON.stringify({ status: 'verified', source: source.source_sha,
    fixture_files: Object.keys(source.hashes).length, bundle_bytes: artifact.bundle_bytes }));
  process.exit(0);
}
const lease = await browserLease(options['--lease-receipt']);
const output = path.resolve(options['--output']);
await fs.mkdir(output, { mode: 0o700 });
const modes = options['--cases'] ? options['--cases'].split(',') : ['accept', 'stop', 'ack'];
assert(modes.length > 0 && new Set(modes).size === modes.length);
assert(modes.every(mode => ['accept', 'stop', 'ack'].includes(mode)));
const report = { schema_version: 1, status: 'running', started_at: new Date().toISOString(),
  source: source.source_sha, server_sha256: artifact.server.sha256, ui_files: artifact.ui.files,
  fixture_files: source.hashes, scope: { real_provider: false, production_access: false,
    browser_launched: false, existing_pages_accessed: false }, cases: [], cleanup: {} };
const here = path.dirname(fileURLToPath(import.meta.url));
report.harness_sha256 = Object.fromEntries(await Promise.all(
  ['worker-runner.mjs', 'worker-artifacts.mjs', 'worker-fixture.mjs', 'worker-fixture.py',
    'worker-support.mjs', 'fast-browser-scenarios.mjs', 'support.mjs'].map(async name =>
    [name, digest(await fs.readFile(path.join(here, name)))])));
const controller = new AbortController();
const interrupted = () => controller.abort(Error('browser_acceptance_interrupted'));
process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
let browser;
try {
  const module = await import(pathToFileURL(path.resolve(options['--puppeteer-module'])).href);
  browser = await module.default.connect({ browserURL: lease.browserURL, protocolTimeout: 30000 });
  report.browser_version = await browser.version();
  for (const mode of modes) {
    controller.signal.throwIfAborted();
    const folder = path.join(output, mode); await fs.mkdir(folder, { mode: 0o700 });
    const current = { mode, status: 'running', stage: 'fixture_start', checks: [], page_errors: [],
      request_counts: {}, external_requests_blocked: 0, cleanup: {} };
    report.cases.push(current);
    let fixture, context, page;
    try {
      fixture = new WorkerFixture({ artifact, source: source.path, mode, output: folder });
      fixture.info = await deadline(fixture.ready, 15000, 'fixture_readiness_deadline');
      // Case.start proved ownership of the listener before these HTTP requests.
      for (const [name, sha] of Object.entries(artifact.ui.files)) {
        const response = await fetch(`${fixture.info.origin}/${name.split(path.sep).map(encodeURIComponent).join('/')}`,
          { redirect: 'error', signal: AbortSignal.timeout(10000) });
        assert.equal(response.status, 200, 'candidate_asset_unavailable');
        assert.equal(digest(Buffer.from(await response.arrayBuffer())), sha, 'served_asset_mismatch');
      }
      context = await browser.createBrowserContext();
      assert.equal((await context.cookies()).length, 0, 'fresh_context_required');
      page = await context.newPage();
      await page.setViewport({ width: 1280, height: 900 });
      await page.setCacheEnabled(false); await page.setBypassServiceWorker(true); await page.bringToFront();
      await page.setRequestInterception(true);
      page.setDefaultTimeout(10000);
      page.on('pageerror', error => {
        if (current.page_errors.length < 20)
          current.page_errors.push({ name: error.name, detail_sha256: digest(error.message) });
      });
      page.on('request', request => {
        const url = new URL(request.url());
        if (url.origin !== fixture.info.origin) {
          if (['data:', 'about:', 'blob:'].includes(url.protocol)) void request.continue().catch(() => {});
          else { current.external_requests_blocked += 1; void request.abort().catch(() => {}); }
          return;
        }
        const route = url.pathname.replace(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/g, ':id');
        const key = `${request.method()} ${route}`;
        current.request_counts[key] = (current.request_counts[key] || 0) + 1;
        void request.continue().catch(() => {});
      });
      current.stage = 'fresh_browser_login';
      await page.goto(fixture.info.origin, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#username');
      await fill(page, '#username', 'synthetic-owner');
      await fill(page, '#password', 'synthetic-password-ordinary-http');
      await click(page, 'Continue'); await page.waitForSelector('#composer');
      const cookie = (await context.cookies()).find(cookie => cookie.name === 'orkestr_v2_session');
      assert(cookie?.httpOnly && cookie.sameSite === 'Strict', 'browser_cookie_not_protected');
      current.checks.push({ name: 'fresh_actual_browser_login', status: 'passed', actual_cookie: true });
      await workerScenarios({ page, fixture, mode, report: current, signal: controller.signal });
      assert.equal(current.page_errors.length, 0, 'browser_javascript_error');
      assert.equal(current.external_requests_blocked, 0, 'unexpected_external_browser_request');
      current.status = 'passed';
      await page.screenshot({ path: path.join(folder, 'result.png'), fullPage: true });
    } catch (error) {
      current.status = 'failed';
      await fs.writeFile(path.join(folder,'failure-detail.txt'),String(error.stack));
      current.failure = { name: error.name, code: /^[a-z_]+$/.test(error.message) ? error.message : 'browser_check_failed',
        detail_sha256: digest(String(error.message)) };
      if (page && !page.isClosed()) await page.screenshot({ path: path.join(folder, 'failure.png'), fullPage: true }).catch(() => {});
    } finally {
      try { if (context) await context.close(); current.cleanup.owned_context_closed = true; }
      catch { current.cleanup.owned_context_closed = false; current.status = 'failed'; }
      try {
        if (fixture) current.fixture = await fixture.stop();
        current.cleanup.owned_server_and_peers_closed = true;
      } catch {
        current.cleanup.owned_server_and_peers_closed = false; current.status = 'failed';
      }
      await fs.writeFile(path.join(folder, 'receipt.json'), `${JSON.stringify(current, null, 2)}\n`, { mode: 0o600 });
    }
    console.log(JSON.stringify({ mode, status: current.status, stage: current.stage, passed: current.checks.length }));
    if (!current.cleanup.owned_server_and_peers_closed) break; // Retain ownership for attended recovery.
  }
  report.status = report.cases.length === modes.length && report.cases.every(row => row.status === 'passed') ? 'passed' : 'failed';
} catch (error) {
  report.status = 'failed'; report.failure = { name: error.name, detail_sha256: digest(String(error.message)) };
} finally {
  // A second abort cannot skip the per-case cleanup already protected above.
  process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted);
  browser?.disconnect(); // Never close the shared managed browser.
  report.cleanup.shared_browser_left_running = true;
  report.finished_at = new Date().toISOString();
  await fs.writeFile(path.join(output, 'receipt.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, cases: report.cases.length, receipt: path.join(output, 'receipt.json') }));
}
process.exitCode = report.status === 'passed' ? 0 : 1;
