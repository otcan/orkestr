// In-process lease-port handoff. No client/process/transport lifecycle operations.
// Registration is explicit: all store users must use port(), including readers
// (new store reads can initialize lock evidence). Direct constructors bypass it.
const METHODS = new Set(['init', 'readState', 'readAll', 'activeLease', 'acquire',
  'heartbeat', 'release', 'withCurrentLeaseAction']);
const fail = (code) => Object.assign(new Error(code), { code, statusCode: 503 });

export function createDesktopWriterLifecycle(initialFactory) {
  if (typeof initialFactory !== 'function') throw new TypeError('store factory required');
  let factory = initialFactory;
  let state = 'open';
  let active = 0;
  let generation = 0;
  let draining = false;
  let currentToken;
  const waiters = new Set();
  const notify = () => { for (const waiter of waiters) waiter(); };

  async function invoke(environment, method, args) {
    if (state !== 'open') throw fail('desktop_writer_paused');
    active += 1; // Synchronous admission before factory or first await.
    try {
      const store = factory(environment);
      if (typeof store?.[method] !== 'function') throw fail('desktop_store_method_missing');
      return await store[method](...args);
    } finally {
      active -= 1;
      notify();
    }
  }

  function port(environment) {
    // Retained callers resolve the current factory on every operation, rather
    // than retaining an old store across adoption. No arbitrary method fallback.
    return Object.freeze(Object.fromEntries([...METHODS].map((method) =>
      [method, (...args) => invoke(environment, method, args)])));
  }

  async function pauseAndDrain({ timeoutMs = 5000 } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) {
      throw fail('desktop_drain_timeout_invalid');
    }
    if (!['open', 'paused'].includes(state) || draining || currentToken) {
      throw fail('desktop_transition_unavailable');
    }
    state = 'paused'; // Blocks new readers/writers, never cancels admitted work.
    draining = true;
    try {
      if (active) await new Promise((resolve, reject) => {
        const done = () => {
          if (active) return;
          clearTimeout(timer);
          waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(() => {
          waiters.delete(done);
          reject(fail('desktop_drain_timeout_still_paused'));
        }, timeoutMs);
        waiters.add(done);
        done();
      });
      currentToken = Object.freeze({});
      return currentToken;
    } finally {
      draining = false;
    }
  }

  async function adopt(token, newFactory, adoptOfflineEvidence) {
    if (!currentToken || token !== currentToken || state !== 'paused' || active) {
      throw fail('desktop_transition_token_invalid');
    }
    if (typeof newFactory !== 'function' || typeof adoptOfflineEvidence !== 'function') {
      throw new TypeError('explicit factory and adoption callback required');
    }
    currentToken = undefined; // Spend before callback. No retry on uncertainty.
    state = 'adopting';
    try {
      // Operator must separately establish cross-process quiescence and evidence.
      // This callback is the only permitted initialization while dispatch paused.
      await adoptOfflineEvidence(newFactory);
      factory = newFactory;
      generation += 1;
      state = 'open';
    } catch (error) {
      state = 'poisoned'; // No old-writer rollback against possibly adopted state.
      throw error;
    }
  }

  return Object.freeze({ port, pauseAndDrain, adopt,
    status: () => Object.freeze({ state, active, generation }) });
}
