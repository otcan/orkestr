#!/usr/bin/env node
// Actual browser acceptance. Connect only; never launch or close a shared browser.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { browserLease, Candidate, createNetwork, digest, provenance } from './support.mjs';
import { scenarios } from './scenarios.mjs';

const options = {};
for (let index = 2; index < process.argv.length; index += 1) {
  const name = process.argv[index];
  assert(['--provenance', '--lease-receipt', '--puppeteer-module', '--output', '--verify-only'].includes(name), 'unknown_argument');
  assert(!(name in options), 'duplicate_argument');
  options[name] = name === '--verify-only' ? true : process.argv[++index];
  assert(options[name], 'argument_value_required');
}
assert(options['--provenance'], 'provenance_required');
const artifact = await provenance(options['--provenance']);
if (options['--verify-only']) {
  process.stdout.write(`${JSON.stringify({ status: 'verified', server_source: artifact.server.source_sha,
    ui_source: artifact.ui.source_sha, bundle_bytes: artifact.bundle_bytes })}\n`);
  process.exit(0);
}
assert(options['--lease-receipt'] && options['--output'], 'lease_and_output_required');
const lease = await browserLease(options['--lease-receipt']);
const output = path.resolve(options['--output']);
await fs.mkdir(output, { mode: 0o700 }); // A run never overwrites another receipt.
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orkestr-v2-browser-'));
await fs.chmod(root, 0o700);
const report = {
  schema_version: 1, status: 'running', started_at: new Date().toISOString(), stage: 'candidate_start',
  sources: { server: artifact.server.source_sha, ui: artifact.ui.source_sha },
  hashes: { server: artifact.server.sha256, ui: artifact.ui.files },
  scope: { synthetic_namespaces: true, real_provider_execution: false, browser_launched: false,
    existing_pages_accessed: false, existing_profiles_accessed: false },
  checks: [], page_errors: [], cleanup: {},
};
report.harness_sha256 = Object.fromEntries(await Promise.all(
  ['runner.mjs', 'support.mjs', 'scenarios.mjs'].map(async (name) =>
    [name, digest(await fs.readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), name)))]),
));
let browser;
let context;
let page;
let candidate;
const controller = new AbortController();
const interrupted = () => controller.abort(new Error('acceptance_interrupted'));
process.once('SIGINT', interrupted);
process.once('SIGTERM', interrupted);
try {
  candidate = await Candidate.create(artifact, root);
  candidate.signal = controller.signal;
  await candidate.start();
  // The ordinary server must serve exactly the reviewed asset bytes, not an old bundle.
  for (const [name, hash] of Object.entries(artifact.ui.files)) {
    controller.signal.throwIfAborted();
    const uri = name.split(path.sep).map(encodeURIComponent).join('/');
    const response = await fetch(`${candidate.origin}/${uri}`, { signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200, 'candidate_asset_unavailable');
    assert.equal(digest(Buffer.from(await response.arrayBuffer())), hash, 'served_bundle_hash_mismatch');
  }
  const module = options['--puppeteer-module']
    ? await import(pathToFileURL(path.resolve(options['--puppeteer-module'])).href)
    : await import('puppeteer');
  controller.signal.throwIfAborted();
  // CDP awaits the page-side freshness wait; its deadline must exceed the
  // longest explicit browser wait (20 seconds), including the 15-second clock.
  browser = await module.default.connect({ browserURL: lease.browserURL, protocolTimeout: 30_000 });
  controller.signal.throwIfAborted();
  report.browser_version = await browser.version();
  context = await browser.createBrowserContext();
  controller.signal.throwIfAborted();
  assert.equal((await context.cookies()).length, 0, 'isolated_context_not_empty');
  page = await context.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setCacheEnabled(false);
  await page.setBypassServiceWorker(true);
  await page.bringToFront();
  page.setDefaultTimeout(10_000);
  page.on('pageerror', (error) => {
    if (report.page_errors.length < 20) report.page_errors.push({ name: error.name, message_sha256: digest(String(error.message)) });
  });
  const network = await createNetwork(page, candidate.origin);
  await scenarios({ page, context, candidate, network, report, output, signal: controller.signal });
  assert.equal(report.page_errors.length, 0, 'browser_javascript_errors');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  const firstLine = String(error.message).split('\n')[0];
  report.failure = { name: error.name, code: /^[a-z_]+$/.test(firstLine) ? firstLine : 'acceptance_check_failed',
    detail_sha256: digest(String(error.message)) };
  if (error.cause) report.failure.cause = { name: error.cause.name,
    code: /protocolTimeout/.test(String(error.cause.message)) ? 'browser_protocol_deadline' : 'browser_wait_failed',
    detail_sha256: digest(String(error.cause.message)) };
  if (page && !page.isClosed()) {
    try { await page.screenshot({ path: `${output}/failure.png`, fullPage: true }); } catch { /* Owned page may already be gone. */ }
  }
} finally {
  process.removeListener('SIGINT', interrupted);
  process.removeListener('SIGTERM', interrupted);
  try { if (context) await context.close(); report.cleanup.owned_context_closed = true; }
  catch { report.cleanup.owned_context_closed = false; report.status = 'failed'; }
  if (browser) browser.disconnect(); // Never browser.close(): the process is managed elsewhere.
  try { if (candidate) await candidate.stop(); report.cleanup.owned_server_stopped = true; }
  catch { report.cleanup.owned_server_stopped = false; report.status = 'failed'; }
  if (report.cleanup.owned_server_stopped) {
    await fs.rm(root, { recursive: true, force: true });
    report.cleanup.synthetic_state_removed = true;
  }
  report.server_launches = candidate?.launches || 0;
  report.finished_at = new Date().toISOString();
  await fs.writeFile(`${output}/receipt.json`, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ status: report.status, stage: report.stage,
    passed: report.checks.length, failure: report.failure?.code, receipt: `${output}/receipt.json` })}\n`);
}
process.exitCode = report.status === 'passed' ? 0 : 1;
