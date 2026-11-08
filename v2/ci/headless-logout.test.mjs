import { test } from 'node:test';
import assert from 'node:assert/strict';
import { submitLogout } from './headless-logout.mjs';

function fixture(statuses, sessionStatus = 200, unknown = false) {
  const calls = [];
  const pending = [];
  let signedOut = false;
  const page = {
    waitForResponse(predicate, options) {
      assert.equal(options.timeout, 10000);
      return new Promise((resolve, reject) => pending.push({ predicate, resolve, reject }));
    },
    async waitForSelector(selector) {
      assert.equal(selector, '#username');
      calls.push('login');
      assert.ok(signedOut, 'sign-in form must not appear before confirmed revocation');
    },
    async waitForFunction(_fn, options) {
      assert.equal(options.timeout, 10000);
      calls.push('ready');
    },
    async evaluate(fn) {
      calls.push('reconcile');
      const original = globalThis.fetch;
      globalThis.fetch = async (path, options) => {
        assert.equal(path, '/api/v2/browser/session');
        assert.equal(options.cache, 'no-store');
        assert.equal(options.redirect, 'error');
        assert.ok(options.signal instanceof AbortSignal, 'reconciliation must have an abort deadline');
        assert.equal(options.signal.aborted, false);
        return { status: sessionStatus };
      };
      try { return await fn(); } finally { globalThis.fetch = original; }
    },
    async reload() { calls.push('reload'); signedOut = sessionStatus === 401; },
  };
  const click = async text => {
    assert.equal(text, 'Sign out');
    calls.push('click');
    const status = statuses.shift();
    signedOut = status === 204 || status === 401;
    const response = {
      url: () => 'http://synthetic/api/v2/browser/session',
      request: () => ({ method: () => 'DELETE' }),
      status: () => status,
    };
    for (const waiter of pending.splice(0)) {
      assert.equal(waiter.predicate({ ...response, request: () => ({ method: () => 'GET' }) }), false);
      assert.equal(waiter.predicate({ ...response, url: () => 'http://other/api/v2/browser/session' }), false);
      assert.ok(waiter.predicate(response));
      if (unknown) waiter.reject(new Error('response not observed'));
      else waiter.resolve(response);
    }
  };
  return { page, click, calls };
}

test('confirmed revocation waits for the exact DELETE and sign-in form', async () => {
  const f = fixture([204]);
  await submitLogout(f.page, 'http://synthetic', f.click);
  assert.deepEqual(f.calls, ['click', 'login']);
});

test('a known unavailable response reconciles an active session before one UI retry', async () => {
  const f = fixture([503, 204]);
  await submitLogout(f.page, 'http://synthetic', f.click);
  assert.deepEqual(f.calls, ['click', 'reconcile', 'ready', 'click', 'login']);
});

test('already revoked after unavailable response reloads without another DELETE', async () => {
  const f = fixture([503], 401);
  await submitLogout(f.page, 'http://synthetic', f.click);
  assert.deepEqual(f.calls, ['click', 'reconcile', 'reload', 'login']);
});

test('unavailable reconciliation never repeats a mutation', async () => {
  const f = fixture([503], 503);
  await assert.rejects(submitLogout(f.page, 'http://synthetic', f.click));
  assert.deepEqual(f.calls, ['click', 'reconcile']);
});

test('an unobserved response never repeats a mutation', async () => {
  const f = fixture([204], 200, true);
  await assert.rejects(submitLogout(f.page, 'http://synthetic', f.click));
  assert.deepEqual(f.calls, ['click']);
});

test('persistent refusal and forbidden responses remain failures', async () => {
  for (const statuses of [[503, 503], [403]]) {
    const f = fixture(statuses);
    await assert.rejects(submitLogout(f.page, 'http://synthetic', f.click));
    assert.ok(f.calls.filter(call => call === 'click').length <= 2);
    assert.ok(!f.calls.includes('login'));
  }
});
