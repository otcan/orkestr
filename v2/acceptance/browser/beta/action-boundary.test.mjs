import {test} from 'node:test';
import assert from 'node:assert/strict';
import {clickReady, setDraft} from './readiness.mjs';

test('cancel or revoked lease during readiness prevents every delayed one-shot control', async () => {
  for (const label of ['Send', 'Start work', 'Add to current work', 'Stop', 'Steer', 'Accept completion', 'Continue']) {
    for (const kind of ['abort', 'revoke']) {
      const abort = new AbortController(); let evaluations = 0, current = true;
      const page = {waitForFunction: async () => { if (kind === 'abort') abort.abort(); else current = false; },
        evaluate: async () => { evaluations++; }};
      await assert.rejects(clickReady(page, label, undefined, undefined,
        {signal: abort.signal, verify: async () => current}));
      assert.equal(evaluations, 0);
    }
  }
});

test('abort during a current-lease recheck cannot race the following click', async () => {
  const abort = new AbortController(); let clicks = 0;
  await assert.rejects(clickReady({waitForFunction: async () => {}, evaluate: async () => { clicks++; }},
    'Stop', undefined, undefined, {signal: abort.signal, verify: async () => { abort.abort(); return true; }}));
  assert.equal(clicks, 0);
});

test('composer readiness cannot cause a delayed input mutation after cancellation', async () => {
  const abort = new AbortController(); let writes = 0;
  const page = {waitForSelector: async () => {}, evaluate: async () => { abort.abort(); },
    $eval: async () => { writes++; }};
  await assert.rejects(setDraft(page, 'fixed input', undefined, {signal: abort.signal, verify: async () => true}));
  assert.equal(writes, 0);
});
