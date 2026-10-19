import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {failure} from './diagnostics.mjs';

// A genuine Stopped observation can precede original native reap and window
// retirement. This GET-only barrier cannot issue work or supply native proof.
export async function waitStoppedWindow({read, conversation, opening, signal, timeoutMs = 10000}) {
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 10000);
  assert.equal(opening?.conversation_id, conversation);
  assert.equal(opening.state, 'opening');
  const {state: _state, ...identity} = structuredClone(opening);
  const abort = new AbortController(), active = AbortSignal.any([signal, abort.signal]);
  const deadline = performance.now() + timeoutMs;
  let timer, interrupted, previous = 0;
  const work = (async () => {
    for (;;) {
      active.throwIfAborted();
      if (performance.now() >= deadline) throw failure('timeout');
      const current = await read('window');
      active.throwIfAborted();
      if (performance.now() >= deadline) throw failure('timeout');
      assert(current, 'stopped_window_unavailable');
      const {state, ...observed} = current;
      assert.deepEqual(observed, identity, 'stopped_window_identity_or_budget_changed');
      const next = ['active', 'retiring', 'closed'].indexOf(state);
      if (next < previous) throw failure('not_completed');
      previous = next;
      if (state === 'closed') return;
      await delay(Math.min(200, deadline - performance.now()), undefined, {signal: active});
    }
  })();
  work.catch(() => {});
  try {
    await Promise.race([work, new Promise((_, reject) => {
      interrupted = () => reject(signal.reason ?? failure('interrupted'));
      signal.addEventListener('abort', interrupted, {once: true});
      if (signal.aborted) interrupted();
      timer = setTimeout(() => reject(failure('timeout')), Math.max(0, deadline - performance.now()));
    })]);
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', interrupted); abort.abort();
  }
}
