import assert from 'node:assert/strict';
import {Cleanup} from './cleanup.mjs';
import {captureControls} from './capture.mjs';
import {ownerReads} from './owner-reads.mjs';
import {executionUi} from './execution-ui.mjs';
import {assertClosedPredecessor} from './window-evidence.mjs';
import {loginOwner, reloadOwner} from './ui.mjs';
import {failure, errorChain} from './diagnostics.mjs';
import {postWindowPurpose, priorAccepted, nextWindowHandoff} from './post-window-handoff.mjs';

// One separately budgeted input after continuity, or a separately verified clean
// service restart. The private operator owns any prior retirement/restart proof.
// This does not reuse browserChat's fresh-window-null precondition or its budget.
export async function browserPostWindow({page, context, origin, sourceSha, credentials,
  expectedConversation, message, predecessor, purpose = 'post_continuity',
  verifyServedPair, verifyLease, closeContext, signal}) {
  assert(/^[a-f0-9]{40}$/.test(sourceSha));
  assert(typeof message === 'string' && message.trim() && Buffer.byteLength(message) <= 4096);
  const abort = new AbortController(), active = AbortSignal.any([signal, abort.signal]);
  const casePurpose = postWindowPurpose(purpose);
  const report = {version: 1, source: sourceSha, scope: casePurpose.scope, purpose,
    status: 'failed', checks: [], cleanup: {}};
  const cleanup = new Cleanup(); cleanup.add('owned_context', closeContext);
  let phase = 'pair', capture, controls, settled = false;
  const work = (async () => {
    active.throwIfAborted();
    if (await verifyServedPair(active) !== true || await verifyLease(active) !== true) throw failure('identity_changed');
    phase = 'login';
    const login = await loginOwner({page, context, origin, credentials, expectedConversation, signal: active, verifyLease});
    const conversation = login.conversation, read = ownerReads(page, conversation, active, origin);
    report.conversation_id = conversation;
    report.checks.push({name: 'login', ...login.evidence});
    phase = 'closed_predecessor';
    const current = await read('window'), held = await read('held');
    const preserved = assertClosedPredecessor({conversation, expected: predecessor, current, held});
    capture = captureControls(page, origin, conversation);
    controls = executionUi({page, origin, conversation, read, capture, signal: active, verifyLease});
    for (const receipt of priorAccepted(predecessor, conversation, purpose)) await controls.completed(receipt);
    const previousRun = predecessor.accepted.at(-1).run_id;
    phase = 'explicit_new_window';
    const admission = await controls.send(message);
    assert.equal(admission.proof.fresh_budget, true);
    assert.equal(admission.window.request.predecessor_window_id, predecessor.window_id);
    const next = await controls.phase(['running', 'awaiting_acceptance']);
    assert.notEqual(next.run_id, previousRun);
    phase = 'progress_accept_reload';
    await controls.progress(next.run_id);
    const accepted = await controls.accept(next.run_id);
    await reloadOwner({page, conversation, origin});
    const rendered = await controls.completed(accepted.receipt);
    if (purpose === 'post_service_restart') {
      for (const receipt of predecessor.accepted) await controls.completed(receipt);
    }
    assertClosedPredecessor({conversation, expected: predecessor, current, held: await read('held')});
    report.checks.push({name: casePurpose.check, ...preserved, ...admission.proof,
      ...accepted.proof, ...rendered, exact_closed_predecessor: true, fresh_run: true});
    report.predecessor = nextWindowHandoff({predecessor, conversation, purpose,
      window: admission.window.receipt.status, accepted: accepted.receipt});
    if (await verifyServedPair(active) !== true || await verifyLease(active) !== true) throw failure('identity_changed');
  })().finally(() => { settled = true; });
  work.catch(() => {});
  let timer;
  try {
    await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => { abort.abort(); reject(failure('timeout')); }, 85000);
    })]);
    report.status = 'passed';
  } catch (error) { report.failure = {phase, diagnostic: errorChain(error)}; }
  finally {
    clearTimeout(timer); abort.abort(); report.cleanup.owned = await cleanup.close();
    let join;
    await Promise.race([work.catch(() => {}), new Promise(resolve => { join = setTimeout(resolve, 6000); })]);
    clearTimeout(join); report.cleanup.case_work = settled ? 'joined' : 'unknown';
    if (capture) {
      try { report.cleanup.capture = await capture.close() === true ? 'joined' : 'unknown'; }
      catch { report.cleanup.capture = 'unknown'; }
      finally { capture.discard(); }
    }
    report.actions = controls?.counts() ?? {messages: 0, stop: 0, acceptance: 0, steering: 0};
    if (!settled || !report.cleanup.owned.complete || report.cleanup.capture === 'unknown') report.status = 'failed';
    assert(report.actions.messages <= 1 && report.actions.acceptance <= 1 && report.actions.stop === 0 && report.actions.steering === 0);
  }
  return report;
}
