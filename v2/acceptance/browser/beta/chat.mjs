import assert from 'node:assert/strict';
import {Cleanup} from './cleanup.mjs';
import {captureControls} from './capture.mjs';
import {ownerReads} from './owner-reads.mjs';
import {executionUi} from './execution-ui.mjs';
import {executionStatus} from './execution-evidence.mjs';
import {assertHeldInput} from './window-evidence.mjs';
import {loginOwner, reloadOwner} from './ui.mjs';
import {errorChain, failure} from './diagnostics.mjs';

// A protected reviewed entry supplies fixed no-tools prompts and a separately
// authorized synthetic or selected-Codex composition. These parameters are not
// an authorization mechanism. Importing this module has no effects.
export async function browserChat({page, context, origin, sourceSha, credentials,
  bootstrap, expectedConversation, fixture, verifyServedPair, verifyLease, closeContext, signal}) {
  assert(/^[a-f0-9]{40}$/.test(sourceSha));
  assert(['synthetic', 'selected_codex'].includes(fixture?.mode));
  assert(Array.isArray(fixture.messages) && fixture.messages.length === 4);
  assert(fixture.messages.every(text => typeof text === 'string' && text.trim() && Buffer.byteLength(text) <= 4096));
  assert.equal(new Set(fixture.messages).size, 4, 'four_distinct_fixed_inputs_required');
  assert.equal(typeof fixture.requireSteer, 'boolean');
  assert(typeof fixture.steering === 'string' && fixture.steering.trim() && Buffer.byteLength(fixture.steering) <= 1024);
  for (const callback of [verifyServedPair, verifyLease, closeContext]) assert.equal(typeof callback, 'function');
  const abort = new AbortController(), active = AbortSignal.any([signal, abort.signal]);
  const report = {version: 1, source: sourceSha, scope: 'ordinary_browser_chat', mode: fixture.mode,
    status: 'failed', checks: [], cleanup: {}, independently_required: ['native_process_cleanup', 'durable_input_run_lineage']};
  const cleanup = new Cleanup(); cleanup.add('owned_context', closeContext);
  let phase = 'pair', settled = false, capture, controls;
  const step = async (name, action) => {
    active.throwIfAborted(); phase = name;
    const start = performance.now(), proof = await action(); active.throwIfAborted();
    report.checks.push({name, elapsed_ms: Math.round(performance.now() - start), ...proof});
  };
  const work = (async () => {
    await step('pair', async () => {
      if (await verifyServedPair(active) !== true || await verifyLease(active) !== true) throw failure('identity_changed');
      return {matching_pair_verified: true, current_lease_verified: true};
    });
    let conversation;
    await step('login', async () => {
      const login = await loginOwner({page, context, origin, credentials, bootstrap, expectedConversation, signal: active, verifyLease});
      conversation = login.conversation; return login.evidence;
    });
    capture = captureControls(page, origin, conversation);
    const read = ownerReads(page, conversation, active, origin);
    controls = executionUi({page, origin, conversation, read, capture, signal: active, verifyLease});
    assert.equal(await read('window'), null, 'fresh_owner_window_required');
    let first, held, stopped, heldBefore;
    await step('initial_intake', async () => (await controls.send(fixture.messages[0])).proof);
    await step('running_progress', async () => {
      first = await controls.phase(['running']);
      return (await controls.progress(first.run_id)).proof;
    });
    await step('steering', () => controls.steer(first.run_id, fixture.steering, fixture.requireSteer));
    await step('pre_stop_intake', async () => {
      held = await controls.send(fixture.messages[1]);
      const current = executionStatus(await read('execution'), conversation, first.run_id);
      assert.equal(current.phase, 'running', 'original_run_must_still_be_running');
      return held.proof;
    });
    await step('stop', async () => { stopped = await controls.stop(first.run_id); return stopped.proof; });
    await step('held_input', async () => {
      heldBefore = await read('held');
      const proof = assertHeldInput({conversation, stoppedRun: first.run_id, admitted: held.intake.receipt,
        before: heldBefore, after: heldBefore});
      await page.waitForFunction(text => document.querySelector('section[aria-label="Held input"]')?.textContent.includes(text),
        {timeout: 10000}, fixture.messages[1]);
      return {...proof, held_preview_visible: true};
    });
    let previousRun = first.run_id;
    for (let index = 2; index < 4; index++) {
      await step(index === 2 ? 'post_stop_input' : 'accepted_continuation', async () => {
        const sent = await controls.send(fixture.messages[index]);
        const next = await controls.phase(['running', 'awaiting_acceptance']);
        assert.notEqual(next.run_id, previousRun, 'fresh_run_required');
        await controls.progress(next.run_id);
        const accepted = await controls.accept(next.run_id);
        const reloaded = await reloadOwner({page, conversation, origin});
        const after = executionStatus(await read('execution'), conversation, next.run_id);
        assert.equal(after.phase, 'completed');
        const hold = assertHeldInput({conversation, stoppedRun: first.run_id, admitted: held.intake.receipt,
          before: heldBefore, after: await read('held')});
        previousRun = next.run_id;
        return {...sent.proof, ...accepted.proof, ...hold, reload: reloaded, fresh_run_observed: true};
      });
    }
    if (await verifyServedPair(active) !== true || await verifyLease(active) !== true) throw failure('identity_changed');
  })().finally(() => { settled = true; });
  work.catch(() => {});
  let timer, interrupted;
  try {
    await Promise.race([work, new Promise((_, reject) => {
      interrupted = () => reject(failure('interrupted'));
      signal.addEventListener('abort', interrupted, {once: true});
      if (signal.aborted) interrupted();
      timer = setTimeout(() => { abort.abort(); reject(failure('timeout')); }, 85000);
    })]);
    report.status = 'passed';
  } catch (error) { report.failure = {phase, diagnostic: errorChain(error)}; }
  finally {
    clearTimeout(timer); signal.removeEventListener('abort', interrupted); abort.abort();
    report.cleanup.owned = await cleanup.close();
    let join;
    if (!settled) {
      await Promise.race([work.catch(() => {}), new Promise(resolve => { join = setTimeout(resolve, 6000); })]);
      clearTimeout(join);
    }
    report.cleanup.case_work = settled ? 'joined' : 'unknown';
    if (capture) {
      try { report.cleanup.control_capture = await capture.close() === true ? 'joined' : 'unknown'; }
      catch (error) { report.cleanup.control_capture = 'unknown'; report.cleanup.capture_error = errorChain(error); }
      finally { capture.discard(); }
    }
    if (!settled || !report.cleanup.owned.complete || report.cleanup.control_capture === 'unknown') report.status = 'failed';
    report.actions = controls?.counts() ?? {messages: 0, stop: 0, acceptance: 0, steering: 0};
  }
  return report;
}
