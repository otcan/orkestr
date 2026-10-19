import assert from 'node:assert/strict';
import { TASKS, CHILD, DRAFT, instructions, wait, enabled, click, fill, value, read,
  taskButton, responseFault } from './worker-support.mjs';

const TITLE = `${TASKS} label input`;
const INSTRUCTIONS = `${TASKS} label textarea`;
const REVIEW = 'Review parent and prepare next task';

async function prepareTask(page, name, signal) {
  if (await enabled(page, REVIEW, TASKS)) await click(page, REVIEW, TASKS);
  await fill(page, TITLE, `Synthetic ${name}`);
  await fill(page, INSTRUCTIONS, instructions(name));
  await wait(() => enabled(page, 'Create worker task', TASKS), 'task_create_unavailable', signal);
}
async function createTask(page, base, name, signal) {
  await prepareTask(page, name, signal);
  const replied = page.waitForResponse(response => new URL(response.url()).pathname === `${base}/worker-tasks`
    && response.request().method() === 'POST');
  await click(page, 'Create worker task', TASKS);
  const response = await replied;
  assert.equal(response.status(), 200, 'task_create_refused');
  const receipt = await response.json();
  await wait(() => enabled(page, REVIEW, TASKS), 'task_receipt_not_applied', signal);
  return receipt;
}
async function runningTask(fixture, receipt, signal) {
  return wait(async () => {
    const summary = await fixture.request('summary');
    return summary.tasks.find(task => task.task_id === receipt.task_id && task.phase === 'running');
  }, 'worker_not_running', signal);
}
async function parent(page, fixture, signal) {
  await fill(page, '#composer', 'synthetic ordinary HTTP input');
  await click(page, 'Send');
  await wait(() => enabled(page, 'Create worker task', TASKS), 'parent_task_panel_unavailable', signal);
  const summary = await fixture.request('summary');
  const run = summary.runs.find(run => run.role === 'deep' && run.state === 'running');
  assert(run, 'parent_not_running');
  await fill(page, '#composer', DRAFT);
  return run;
}
async function status(page, base, run) {
  const response = await read(page, `${base}/execution?run_id=${run}`);
  assert.equal(response.status, 200);
  assert.equal(response.body.run_id, run);
  return response.body;
}

export async function workerScenarios({ page, fixture, mode, report, signal }) {
  const base = `/api/v2/conversations/${fixture.info.conversation}`;
  const step = async (name, action) => {
    signal.throwIfAborted(); report.stage = name;
    const started = performance.now();
    const evidence = await action();
    report.checks.push({ name, status: 'passed', duration_ms: Math.round(performance.now() - started), ...evidence });
  };
  const originalParent = await parent(page, fixture, signal);

  if (mode === 'tasks') {
    let original;
    await step('task_draft_editable_during_pending_read', async () => {
      await responseFault(page, fixture.info.origin, `${base}/worker-tasks`, 'GET', async fault => {
        await click(page, 'Refresh worker task history', TASKS);
        const held = await fault.captured;
        assert.equal(held.status, 200);
        await fill(page, TITLE, 'Synthetic alpha');
        await fill(page, INSTRUCTIONS, instructions('alpha'));
        assert.equal(await value(page, INSTRUCTIONS), instructions('alpha'));
        assert.equal(await value(page, '#composer'), DRAFT);
        await fault.release(false);
      });
      return { task_and_conversation_drafts_unchanged: true };
    });
    await step('lost_task_response_retries_exact_request_once', async () => {
      await prepareTask(page, 'alpha', signal);
      await responseFault(page, fixture.info.origin, `${base}/worker-tasks`, 'POST', async fault => {
        await click(page, 'Create worker task', TASKS);
        original = await fault.captured;
        assert.equal(original.status, 200);
        await fault.release(true);
      });
      await wait(() => enabled(page, 'Retry original task', TASKS), 'task_retry_unavailable', signal);
      await click(page, 'Workers', 'nav');
      await page.waitForSelector('section[aria-label="Workers"]');
      await click(page, 'Assistant', 'nav');
      await wait(() => enabled(page, 'Retry original task', TASKS), 'task_retry_lost_after_remount', signal);
      assert.equal(await value(page, TITLE), 'Synthetic alpha', 'uncertain_task_title_lost');
      assert.equal(await value(page, INSTRUCTIONS), instructions('alpha'), 'uncertain_task_instructions_lost');
      assert.equal(await value(page, '#composer'), DRAFT);
      await responseFault(page, fixture.info.origin, `${base}/worker-tasks`, 'POST', async fault => {
        await click(page, 'Retry original task', TASKS);
        const retried = await fault.captured;
        assert.equal(retried.status, 200);
        assert.deepEqual(retried.request, original.request);
        assert.deepEqual(retried.body, original.body);
        await fault.release(false);
      });
      await runningTask(fixture, original.body, signal);
      const summary = await fixture.request('summary');
      assert.equal(summary.tasks.length, 1);
      assert.equal(summary.trace.filter(row => row.kind === 'turn' && row.role === 'worker').length, 1);
      return { exact_request_and_receipt_replay: true, uncertain_request_survived_remount: true, worker_turns: 1 };
    });
    await step('task_history_readable_and_payload_removal_visible', async () => {
      await wait(async () => (await page.$eval(TASKS, node => node.innerText)).includes('Synthetic alpha'),
        'task_title_missing', signal);
      const shown = await page.$eval(TASKS, node => node.innerText);
      assert(!shown.includes(original.body.task_id), 'task_identifier_not_collapsed');
      assert.equal(await page.$$eval(`${TASKS} details[open]`, rows => rows.length), 0);
      await taskButton(page, 'Synthetic alpha', 'Remove task payload');
      await wait(async () => (await page.$eval(TASKS, node => node.innerText)).includes('Task payload removed'),
        'task_payload_removal_not_visible', signal);
      const summary = await fixture.request('summary');
      assert.equal(summary.tasks[0].instructions_available, false);
      assert.equal(summary.tasks[0].title, null);
      assert.equal(await value(page, '#composer'), DRAFT);
      return { human_title: true, provenance_initially_collapsed: true, real_payload_tombstone: true };
    });
    await step('task_and_conversation_drafts_survive_tab_remount', async () => {
      await prepareTask(page, 'beta', signal);
      await click(page, 'Workers', 'nav');
      await page.waitForSelector('section[aria-label="Workers"]');
      await click(page, 'Assistant', 'nav');
      await page.waitForSelector('#composer');
      assert.equal(await value(page, '#composer'), DRAFT, 'composer_draft_lost_after_navigation');
      await page.waitForSelector(TITLE);
      assert.equal(await value(page, TITLE), 'Synthetic beta', 'task_title_lost_after_navigation');
      assert.equal(await value(page, INSTRUCTIONS), instructions('beta'), 'task_instructions_lost_after_navigation');
      return { both_drafts_retained: true };
    });
    return;
  }

  if (mode === 'stop' || mode === 'ack-only') {
    const alpha = await createTask(page, base, 'alpha', signal);
    const beta = await createTask(page, base, 'beta', signal);
    const selected = await runningTask(fixture, alpha, signal);
    const other = await runningTask(fixture, beta, signal);
    let stopped;
    await step('selected_worker_has_independent_control_scope', async () => {
      await taskButton(page, 'Synthetic alpha', 'View worker activity');
      await wait(() => enabled(page, 'Stop', CHILD), 'worker_stop_unavailable', signal);
      const exact = await status(page, base, selected.run_id);
      assert.equal(exact.phase, 'running'); assert.equal(exact.capabilities.stop, true);
      const text = await page.$eval(`${CHILD} details`, node => node.textContent);
      if (exact.resources == null) assert(text.includes('CPU unavailable') && text.includes('RAM unavailable'));
      return { worker_scope: true, independent_parent: originalParent.id !== selected.run_id,
        process_resources_measured: exact.resources != null };
    });
    await step('worker_stop_unknown_receipt_replays_exact_original', async () => {
      await responseFault(page, fixture.info.origin, `${base}/stop`, 'POST', async fault => {
        await click(page, 'Stop', CHILD);
        stopped = await fault.captured;
        assert.equal(stopped.status, 200);
        assert.equal(stopped.request.run_id, selected.run_id);
        assert(Number.isSafeInteger(stopped.request.expected_control_revision));
        assert.equal(stopped.body.outcome, 'requested_unknown');
        await fault.release(true);
      });
      await wait(() => enabled(page, 'Stop', CHILD), 'worker_original_stop_retry_unavailable', signal);
      await responseFault(page, fixture.info.origin, `${base}/stop`, 'POST', async fault => {
        await click(page, 'Stop', CHILD);
        const retry = await fault.captured;
        assert.equal(retry.status, 200);
        assert.deepEqual(retry.request, stopped.request); assert.deepEqual(retry.body, stopped.body);
        await fault.release(false);
      });
      return { exact_retry: true, actual_native_terminal_expected: mode === 'stop' };
    });
    await step('worker_terminal_truth_does_not_stop_sibling_or_parent', async () => {
      const phase = mode === 'stop' ? 'cancelled' : 'cancel_requested';
      await wait(async () => (await status(page, base, selected.run_id)).phase === phase,
        'worker_terminal_truth_mismatch', signal);
      assert.equal((await status(page, base, other.run_id)).phase, 'running');
      assert.equal((await status(page, base, originalParent.id)).phase, 'running');
      const summary = await wait(async () => {
        const observed = await fixture.request('summary');
        return observed.trace.some(row => row.kind === 'interrupt') && observed;
      }, 'native_interrupt_not_observed', signal);
      assert.equal(summary.trace.filter(row => row.kind === 'interrupt').length, 1);
      assert.equal(summary.trace.find(row => row.kind === 'interrupt').role, 'worker');
      assert.equal(await value(page, '#composer'), DRAFT);
      await wait(async () => !await enabled(page, 'Stop', CHILD), 'worker_stop_did_not_close', signal);
      if (mode === 'ack-only') {
        await wait(async () => (await fixture.request('summary')).owned_native_alive === 2,
          'ack_only_worker_cleanup_not_observed', signal);
        assert.equal((await status(page, base, selected.run_id)).phase, 'cancel_requested');
      }
      return { phase, sibling_running: true, parent_running: true, native_interrupts: 1 };
    });
    return;
  }

  if (mode === 'held') {
    await step('held_input_remains_readable_after_stop_and_reload', async () => {
      await fill(page, '#composer', 'Synthetic older input held after Stop.');
      const accepted = page.waitForResponse(r => new URL(r.url()).pathname === `${base}/messages` && r.request().method() === 'POST');
      await click(page, 'Send'); assert.equal((await accepted).status(), 202);
      await fill(page, '#composer', DRAFT);
      await wait(() => enabled(page, 'Stop'), 'parent_stop_unavailable', signal);
      await click(page, 'Stop');
      await wait(async () => (await read(page, `${base}/execution`)).body?.phase === 'cancelled',
        'parent_stop_not_confirmed', signal);
      const held = 'section[aria-label="Held input"]';
      await wait(async () => (await page.$$(`${held} h4`)).length === 1, 'held_input_not_visible', signal);
      const before = (await read(page, `${base}/held-inputs`)).body;
      assert.equal(before.held.length, 1); assert.equal(before.held[0].reason, 'stop_boundary');
      const shown = await page.$eval(held, node => node.innerText);
      assert(shown.includes('Saved message held after Stop') && shown.includes('preview and saved time are unavailable'));
      assert(!shown.includes(before.held[0].message_id), 'held_provenance_not_collapsed');
      assert.equal(await enabled(page, 'Resume held input', held), false);
      assert.equal(await enabled(page, 'Cancel held input', held), false);
      assert.equal(await value(page, '#composer'), DRAFT);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#composer');
      await wait(async () => (await page.$$(`${held} h4`)).length === 1, 'held_input_lost_after_reload', signal);
      assert.deepEqual((await read(page, `${base}/held-inputs`)).body.held, before.held);
      assert.equal((await fixture.request('summary')).trace.filter(row => row.kind === 'turn').length, 1);
      return { held_count: 1, reload_persisted: true, no_replay: true, unavailable_actions_disabled: true };
    });
    return;
  }

  if (mode === 'logout') {
    const alpha = await createTask(page, base, 'alpha', signal);
    await runningTask(fixture, alpha, signal);
    await step('logout_fences_delayed_worker_task_response', async () => {
      let delivery;
      await responseFault(page, fixture.info.origin, `${base}/worker-tasks`, 'GET', async fault => {
        await click(page, 'Refresh worker task history', TASKS);
        const held = await fault.captured; assert.equal(held.status, 200);
        await click(page, 'Sign out', 'nav');
        await page.waitForSelector('#username');
        delivery = await fault.release(false, true);
      });
      assert.equal((await read(page, `${base}/worker-tasks?parent_run_id=${originalParent.id}`)).status, 401);
      assert.equal(await page.$(TASKS), null);
      assert(!(await page.$eval('body', node => node.innerText)).includes('Synthetic alpha'));
      await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForSelector('#username');
      assert.equal(await page.$(TASKS), null);
      return { real_cookie_revoked: true, late_response_not_restored: true, reload_requires_login: true,
        delayed_read_cancelled: delivery.cancelled };
    });
  }
}
