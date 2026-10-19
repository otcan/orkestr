import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {actionBoundary, clickReady, setDraft} from './readiness.mjs';
import {assertWindowAdmission} from './window-evidence.mjs';
import {freshControlResponse} from './execution-response.mjs';
import {executionStatus, assertStopRequested, assertStopped,
  assertAccepted, assertSteered} from './execution-evidence.mjs';
import {renderedProgress} from './rendered-progress.mjs';
import {failure} from './diagnostics.mjs';
import {acceptedResult, acceptedText, acceptedResultRendered} from './accepted-results.mjs';

// All mutations below are single ordinary UI actions. Polls are read-only and
// bounded; conflicts/unknown receipts never become an automatic control retry.
export function executionUi({page, origin, conversation, read, capture, signal, verifyLease}) {
  assert.equal(new URL(origin).origin, origin);
  let sends = 0, stops = 0, accepts = 0, steers = 0, steerChecks = 0;
  const action = {signal, verify: () => verifyLease(signal)};
  const guard = async () => {
    signal.throwIfAborted();
    if (await verifyLease(signal) !== true) throw failure('revoked');
    if (new URL(page.url()).origin !== origin) throw failure('unexpected_origin');
  };
  const wait = async (get, predicate, timeoutMs = 15000, timeoutCode = 'timeout') => {
    const start = performance.now();
    while (performance.now() - start < timeoutMs) {
      signal.throwIfAborted();
      const value = await get();
      if (predicate(value)) return value;
      await delay(200, undefined, {signal});
    }
    throw failure(timeoutCode);
  };
  const control = async operation => {
    const observed = await wait(() => capture.take(operation), Boolean);
    return freshControlResponse(operation, observed);
  };
  const phase = async (allowed, run, timeoutMs = 20000) => wait(() => read('execution', run), value => {
    if (!value) return false;
    executionStatus(value, conversation, run);
    if (['failed', 'blocked'].includes(value.phase)) throw failure('not_completed');
    return allowed.includes(value.phase);
  }, timeoutMs, 'phase_timeout');
  // Retirement removes the live scope used by selected-run reads. The durable
  // owner projection survives, but must still match this exact receipt's run;
  // a later run, unavailable read or control acknowledgement is not completion.
  const terminal = async (expected, run, timeoutMs = 20000) => wait(() => read('execution'), value => {
    if (!value) return false;
    executionStatus(value, conversation, run);
    if (['failed', 'blocked'].includes(value.phase)) throw failure('not_completed');
    return value.phase === expected;
  }, timeoutMs);

  return {
    async send(text) {
      await guard(); if (++sends > 4) throw failure('request_budget');
      assert(typeof text === 'string' && text.trim() && Buffer.byteLength(text) <= 4096);
      const previous = await read('window');
      assert(!previous || ['active', 'closed'].includes(previous.state), 'window_not_ready_for_input');
      await setDraft(page, text, origin, action); signal.throwIfAborted();
      await clickReady(page, 'Send', origin, 'Conversation', action);
      const intake = await control('messages'); assert.equal(intake.request.text, text);
      assert.equal(intake.receipt.status, 'accepted');
      // The focused beta deliberately requires a distinct owner action after
      // saving input. The ordinary intake receipt must not start execution.
      signal.throwIfAborted();
      await clickReady(page, previous?.state === 'active' ? 'Add to current work' : 'Start work', origin, 'Work window', action);
      const window = await control('window');
      const proof = assertWindowAdmission({conversation, intakeRequest: intake.request,
        intakeReceipt: intake.receipt, request: window.request, receipt: window.receipt, previous});
      // Input admission may precede asynchronous activation; never submit the
      // next input while the exact new window is still opening.
      await wait(() => read('window'), current => {
        assert(current && current.window_id === window.receipt.status.window_id);
        if (['retiring', 'reconciliation_required'].includes(current.state)) throw failure('not_completed');
        return current.state === 'active';
      });
      return {intake, window, proof};
    },
    phase,
    async progress(run) {
      return wait(() => renderedProgress({page, origin, conversation, run, read, signal}),
        Boolean, 20000, 'progress_timeout');
    },
    async steer(run, text, required) {
      await guard(); if (++steerChecks > 1) throw failure('request_budget');
      assert.equal(typeof required, 'boolean');
      const before = required ? await wait(() => read('execution', run), value => {
        executionStatus(value, conversation, run);
        if (value.phase !== 'running') throw failure('not_completed');
        return value.capabilities.steer;
      }) : executionStatus(await read('execution', run), conversation, run);
      if (!before.capabilities.steer) {
        const disabled = await page.evaluate(() => [...document.querySelectorAll('section[aria-label="Steer running work"] button')]
          .filter(node => node.textContent.trim() === 'Steer').every(node => node.disabled));
        assert.equal(disabled, true);
        return {advertised_at_sample: false, request_sent: false, delivery_checked: false};
      }
      assert.equal(before.phase, 'running');
      steers++;
      assert(typeof text === 'string' && text.trim() && Buffer.byteLength(text) <= 1024);
      await actionBoundary(action);
      await page.$eval('section[aria-label="Steer running work"] textarea', (node, {text, origin}) => {
        if (location.origin !== origin) throw Error('unexpected_origin');
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(node, text);
        node.dispatchEvent(new Event('input', {bubbles: true}));
      }, {text, origin});
      signal.throwIfAborted(); await clickReady(page, 'Steer', origin, 'Steer running work', action);
      const delivery = await control('steer'); assert.equal(delivery.request.text, text);
      const status = await wait(() => read('steering', delivery.receipt.request_key), value => {
        // Core records delivery_unknown before the native write. Keep observing
        // this request within the existing wait; only its acknowledgement passes.
        if (['rejected', 'queued'].includes(value.state)) throw failure('not_completed');
        return value.state === 'acknowledged';
      });
      return {advertised_at_sample: true, request_sent: true, ...assertSteered({conversation, run, ...delivery, status})};
    },
    async stop(run) {
      await guard(); if (++stops > 1) throw failure('request_budget');
      const before = await wait(() => read('execution', run), value => {
        executionStatus(value, conversation, run);
        if (value.phase !== 'running') throw failure('not_completed');
        return value.capabilities.stop;
      });
      await clickReady(page, 'Stop', origin, 'Execution and resources', action);
      const controlValue = await control('stop');
      assertStopRequested({conversation, before, ...controlValue});
      const after = await terminal('cancelled', controlValue.receipt.run_id, 30000);
      return {...controlValue, after, proof: assertStopped({conversation, receipt: controlValue.receipt, after})};
    },
    async accept(run) {
      await guard(); if (++accepts > 2) throw failure('request_budget');
      const proposal = await phase(['awaiting_acceptance'], run);
      await clickReady(page, 'Accept completion', origin, 'Execution and resources', action);
      const controlValue = await control('accept'), after = await terminal('completed', controlValue.receipt.run_id);
      return {...controlValue, after, proof: assertAccepted({conversation, proposal, ...controlValue, after})};
    },
    async completed(receipt) {
      signal.throwIfAborted();
      // Durable accepted history is deliberately readable after the supervisor
      // retires. A live exact-run projection is not a history prerequisite.
      const result = acceptedResult({conversation, receipt, page: await read('accepted')});
      const text = acceptedText({conversation, result, payload: await read('payload', result.payload_id)});
      // Only identifiers and bounded text enter this in-page predicate; neither
      // payload text nor credentials are copied into the acceptance receipt.
      const keys = Object.fromEntries(['run_id', 'completion_event_id', 'acceptance_event_id', 'payload_id']
        .map(key => [key, result[key]]));
      await page.waitForFunction(acceptedResultRendered, {timeout: 10000}, {origin, result: keys, text});
      signal.throwIfAborted();
      return {accepted_result_restored: true, durable_completion_event_bound: true,
        exact_accepted_payload_rendered: true};
    },
    counts() { return {messages: sends, stop: stops, acceptance: accepts, steering: steers}; },
  };
}
