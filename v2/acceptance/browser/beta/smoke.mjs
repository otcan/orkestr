import {Cleanup} from './cleanup.mjs';
import {errorChain, failure} from './diagnostics.mjs';
import {networkTiming} from './network-timing.mjs';
import {cpuAndRam, draftRemount, loginOwner, reloadOwner} from './ui.mjs';

// The protected operator supplies the already leased owned context and verified
// artifact adapter. This function neither provisions nor starts a service/provider.
// Short functional sessions fit the existing 120-second download-helper lifetime.
export async function browserSmoke({page, context, origin, sourceSha, credentials,
  bootstrap, verifyServedPair, verifyLease, closeContext, signal}) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha) || typeof verifyServedPair !== 'function' ||
      typeof verifyLease !== 'function' || typeof closeContext !== 'function' || !signal) {
    throw failure('invalid_action');
  }
  const abort = new AbortController(), active = AbortSignal.any([signal, abort.signal]);
  const report = {version: 1, source: sourceSha, scope: 'browser_smoke_only', status: 'failed',
    provider_execution: false, checks: [], cleanup: {}};
  const monitor = networkTiming(page, origin), cleanup = new Cleanup();
  cleanup.add('owned_context', closeContext);
  cleanup.add('network_observer', async () => monitor.close());
  let phase = 'pair', settled = false;
  const step = async (name, action) => {
    active.throwIfAborted(); phase = name;
    const started = performance.now(), evidence = await action();
    active.throwIfAborted();
    report.checks.push({name, elapsed_ms: Math.round(performance.now() - started), ...evidence});
  };
  const work = (async () => {
    await step('pair', async () => {
      if (await verifyServedPair(active) !== true || await verifyLease(active) !== true) throw failure('identity_changed');
      return {matching_pair_verified: true, current_lease_verified: true};
    });
    let conversation;
    await step('login', async () => {
      const result = await loginOwner({page, context, origin, credentials, bootstrap});
      conversation = result.conversation; return result.evidence;
    });
    for (let sample = 1; sample <= 3; sample++) {
      await step('ordinary_reload', async () => ({sample, ...await reloadOwner({page, conversation, origin})}));
    }
    await step('drafts', () => draftRemount({page, origin}));
    await step('cpu_ram', () => cpuAndRam({page, origin}));
    report.network = monitor.snapshot();
  })().finally(() => { settled = true; });
  work.catch(() => {});
  let timer, interrupted;
  try {
    await Promise.race([work, new Promise((_, reject) => {
      interrupted = () => reject(failure('interrupted'));
      signal.addEventListener('abort', interrupted, {once: true});
      if (signal.aborted) interrupted();
      timer = setTimeout(() => { abort.abort(); reject(failure('timeout')); }, 85_000);
    })]);
    report.status = 'passed';
  } catch (error) {
    report.failure = {phase, diagnostic: errorChain(error)};
  } finally {
    clearTimeout(timer); signal.removeEventListener('abort', interrupted); abort.abort();
    report.cleanup.owned = await cleanup.close();
    let joinTimer;
    if (!settled) {
      await Promise.race([work.catch(() => {}), new Promise(resolve => {
        joinTimer = setTimeout(resolve, 6000);
      })]);
      clearTimeout(joinTimer);
    }
    report.cleanup.case_work = settled ? 'joined' : 'unknown';
    if (!report.cleanup.owned.complete || !settled) report.status = 'failed';
  }
  return report;
}
