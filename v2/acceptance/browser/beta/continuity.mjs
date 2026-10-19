import {setTimeout as delay} from 'node:timers/promises';
import {failure} from './diagnostics.mjs';

export const MIN_CONTINUITY_MS = 15 * 60_000;
export const MAX_CONTINUITY_MS = 20 * 60_000;
const SAMPLE_INTERVAL_MS = 15_000;
const MAX_GAP_MS = 30_000;

// This local oracle does not define an HTTP/window API. The reviewed concrete
// adapter must verify current health, the exact served build and service identity
// before returning true. An unavailable or changed observation ends the attempt.
export class ContinuityEvidence {
  #started; #last; #count = 0; #maximumGap = 0; #failure;
  constructor(startedMs) {
    if (!Number.isFinite(startedMs) || startedMs < 0) throw failure('invalid_sample');
    this.#started = startedMs; this.#last = startedMs;
  }
  sample(nowMs, verified) {
    if (this.#failure) throw this.#failure;
    try {
      if (verified !== true) throw failure('continuity_unavailable');
      if (!Number.isFinite(nowMs) || nowMs < this.#last) throw failure('invalid_sample');
      const gap = nowMs - this.#last;
      if (gap > MAX_GAP_MS) throw failure('continuity_gap');
      this.#maximumGap = Math.max(this.#maximumGap, gap);
      this.#last = nowMs; this.#count++;
      if (this.#count > 96) throw failure('request_budget');
    } catch (error) { this.#failure = error; throw error; }
  }
  finish() {
    if (this.#failure) throw this.#failure;
    const elapsed = this.#last - this.#started;
    if (elapsed < MIN_CONTINUITY_MS || elapsed > MAX_CONTINUITY_MS || this.#count < 31) {
      throw failure('not_completed');
    }
    return {elapsed_ms: Math.floor(elapsed), samples: this.#count,
      maximum_gap_ms: Math.ceil(this.#maximumGap), natural_time_required: true};
  }
}

async function bounded(work, signal) {
  signal.throwIfAborted();
  const child = new AbortController();
  const combined = AbortSignal.any([signal, child.signal]);
  let timer, interrupted;
  const pending = Promise.resolve().then(() => { combined.throwIfAborted(); return work(combined); });
  pending.catch(() => {});
  try {
    return await Promise.race([pending, new Promise((_, reject) => {
      interrupted = () => reject(failure('interrupted'));
      signal.addEventListener('abort', interrupted, {once: true});
      if (signal.aborted) interrupted();
      timer = setTimeout(() => { child.abort(); reject(failure('timeout')); }, 6000);
    })]);
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', interrupted);
  }
}

export async function observeContinuity({verify, heartbeat, signal, progress,
  durationMs = MIN_CONTINUITY_MS + SAMPLE_INTERVAL_MS}) {
  if (typeof verify !== 'function' || typeof heartbeat !== 'function' ||
      !Number.isSafeInteger(durationMs) || durationMs < MIN_CONTINUITY_MS ||
      durationMs > MAX_CONTINUITY_MS - SAMPLE_INTERVAL_MS || !signal) throw failure('invalid_action');
  const started = performance.now(), evidence = new ContinuityEvidence(started);
  let index = 0;
  for (;;) {
    signal.throwIfAborted();
    // Both callbacks are trusted adapters; deadlines are still enforced here.
    if (index % 4 === 0 && await bounded(heartbeat, signal) !== true) throw failure('revoked');
    const verified = await bounded(verify, signal);
    evidence.sample(performance.now(), verified);
    if (index % 4 === 0 && progress) {
      const output = progress({phase: 'continuity', samples: index + 1});
      if (output !== undefined) {
        if (output && typeof output.catch === 'function') output.catch(() => {});
        throw failure('invalid_action');
      }
    }
    if (performance.now() - started >= durationMs) break;
    index++;
    await delay(SAMPLE_INTERVAL_MS, undefined, {signal});
  }
  return evidence.finish();
}
