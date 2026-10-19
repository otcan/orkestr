import assert from 'node:assert/strict';
import {actionBoundary} from './readiness.mjs';
import {reloadOwner} from './ui.mjs';

export function nearestRankP95(samples) {
  assert(Array.isArray(samples) && samples.length > 0 && samples.length <= 20);
  assert(samples.every(value => Number.isFinite(value) && value >= 0));
  return [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1];
}

// One existing owned page, no extra authentication or provider work. Disabling
// this page's HTTP cache does not claim cold DNS/TLS, a new browser or a server
// restart; it never clears the shared browser's cache. Timing includes two
// rendered frames and the authenticated owner/configured-conversation check.
export async function sampleProtectedReadiness({page, conversation, origin, signal, verifyLease}) {
  assert(signal && typeof verifyLease === 'function');
  const action = {signal, verify: verifyLease};
  const cold = [], warm = [];
  const sample = async output => {
    await actionBoundary(action);
    const value = await reloadOwner({page, conversation, origin});
    await actionBoundary(action);
    assert.equal(value.owner_preserved, true);
    assert(Number.isSafeInteger(value.render_ms) && value.render_ms >= 0);
    output.push(value.render_ms);
  };
  await actionBoundary(action);
  try {
    await page.setCacheEnabled(false);
    await sample(cold);
  } finally {
    // Restore only our page, including failure/abort, before owned-context close.
    await page.setCacheEnabled(true);
  }
  for (let index = 0; index < 10; index++) await sample(warm);
  return {
    metric: 'navigation_to_authenticated_composer_and_scope_ready',
    normal_protected_route: true, provider_execution: false, navigations: 11,
    cache_disabled: {mode: 'page_http_cache_disabled', n: cold.length, samples_ms: cold,
      percentile: 'not_reported_for_single_sample', new_connection_claimed: false},
    warm: {mode: 'normal_browser_cache', n: warm.length, samples_ms: warm,
      p95_ms: nearestRankP95(warm), percentile_method: 'nearest_rank'},
  };
}
