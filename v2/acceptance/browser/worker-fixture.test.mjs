import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorkerFixture, deadline } from './worker-fixture.mjs';

const binary = process.env.ORKESTR_BROWSER_FIXTURE_SERVER;
const ui = process.env.ORKESTR_BROWSER_FIXTURE_UI;
const source = process.env.ORKESTR_BROWSER_FIXTURE_SOURCE;
const enabled = Boolean(binary && ui && source);

async function fixtureCase(action) {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'orkestr-v2-browser-fixture-check-'));
  const fixture = new WorkerFixture({ artifact: { server: { path: binary }, ui: { path: ui } },
    source, mode: 'tasks', output });
  let result;
  try {
    fixture.info = await deadline(fixture.ready, 15000, 'fixture_startup_deadline');
    for (let i = 0; i < 100; i += 1) {
      const value = await fixture.request('summary');
      if (value.owned_native_count === 1) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const summary = await fixture.request('summary');
    assert.equal(summary.owned_native_count, 1);
    assert.equal(summary.runs.length, 0, 'startup_must_not_infer_without_input');
    result = await action(fixture);
  } finally {
    try { await fixture.stop(); }
    catch { /* Deliberately invalid request exits nonzero but must still clean. */ }
    assert(fixture.closed?.cleanup?.servers_gone);
    assert(fixture.closed.cleanup.native_identities_gone);
    assert(fixture.closed.cleanup.synthetic_state_removed);
    await fs.writeFile(path.join(output, 'receipt.json'), JSON.stringify({ result, closed: fixture.closed }, null, 2), { mode: 0o600 });
  }
}

test('ordinary fixture closes owned server and namespace native without inference', { skip: !enabled }, async () => {
  await fixtureCase(async fixture => {
    const closed = await fixture.stop();
    assert.equal(closed.result, 'closed');
    return 'normal_cleanup_passed';
  });
});

test('malformed fixture command preserves failure and still reaps owned process tree', { skip: !enabled }, async () => {
  await fixtureCase(async fixture => {
    await assert.rejects(fixture.request('not-an-operation'));
    const exit = await deadline(fixture.exit, 15000, 'failed_fixture_cleanup_deadline');
    assert.notEqual(exit.code, 0);
    assert.equal(fixture.closed?.result, 'failed');
    return 'expected_refusal_cleanup_passed';
  });
});

test('truncated command at EOF refuses without blocking owned cleanup', { skip: !enabled }, async () => {
  await fixtureCase(async fixture => {
    fixture.child.stdin.end('{"id":');
    const exit = await deadline(fixture.exit, 15000, 'truncated_fixture_cleanup_deadline');
    assert.notEqual(exit.code, 0);
    assert.equal(fixture.closed?.result, 'failed');
    return 'expected_truncation_cleanup_passed';
  });
});
