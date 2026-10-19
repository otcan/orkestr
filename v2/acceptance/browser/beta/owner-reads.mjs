import assert from 'node:assert/strict';
import {decodeExact} from './window-evidence.mjs';
import {failure} from './diagnostics.mjs';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const validId = value => typeof value === 'string' && UUID.test(value) &&
  value !== '00000000-0000-0000-0000-000000000000';

export function observationPath(conversation, kind, selector) {
  assert(validId(conversation), 'exact_conversation_required');
  const base = `/api/v2/conversations/${conversation}`;
  if (kind === 'beta') { assert.equal(selector, undefined); return '/api/v2/beta'; }
  if (kind === 'execution' && selector !== undefined) {
    assert(validId(selector)); return `${base}/execution?run_id=${selector}`;
  }
  if (kind === 'payload') { assert(validId(selector)); return `${base}/payloads/${selector}`; }
  if (kind === 'steering') {
    assert(typeof selector === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(selector));
    return `${base}/steering/${selector}`;
  }
  assert.equal(selector, undefined);
  if (kind === 'accepted') return `${base}/accepted-results?after_sequence=0&limit=20`;
  if (kind === 'held') return `${base}/held-inputs?after_sequence=0&limit=100`;
  if (kind === 'execution' || kind === 'window') return `${base}/${kind}`;
  throw failure('invalid_action');
}

// Read-only cookie-authenticated observations from the owned page. No token is
// extracted, no URL/body/authority selector comes from provider output, and the
// returned raw JSON is decoded without rounding Core's integer identities.
export function ownerReads(page, conversation, signal, origin) {
  assert.equal(new URL(origin).origin, origin, 'exact_origin_required');
  let count = 0;
  return async (kind, selector) => {
    signal.throwIfAborted();
    if (++count > 240) throw failure('request_budget');
    const path = observationPath(conversation, kind, selector);
    const observed = await page.evaluate(async ({path, origin}) => {
      if (location.origin !== origin) throw Error('unexpected_origin');
      const response = await fetch(path, {method: 'GET', credentials: 'same-origin',
        cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(5000)});
      if (response.status === 204) return {status: 204};
      if (response.status !== 200) {
        await response.body?.cancel(); return {status: response.status};
      }
      if (!response.body) throw Error('readiness_unavailable');
      const reader = response.body.getReader(), chunks = [];
      let size = 0, reads = 0;
      try {
        for (;;) {
          if (++reads > 1024) throw Error('request_budget');
          const {done, value} = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > 65536) throw Error('request_budget');
          chunks.push(value);
        }
      } finally { await reader.cancel(); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return {status: 200, raw: new TextDecoder('utf-8', {fatal: true}).decode(bytes)};
    }, {path, origin});
    signal.throwIfAborted();
    if (observed.status === 204 && (kind === 'window' || kind === 'execution')) return null;
    assert.equal(observed.status, 200, 'owner_observation_unavailable');
    return decodeExact(observed.raw);
  };
}
