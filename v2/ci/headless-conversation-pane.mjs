// ORK-786 conversation pane checks, run inside headless-workspace.mjs against
// its synthetic API: the readable column the transcript and composer share at
// 1280/1440/1920/768 (and 640, i.e. 1280 at 200% zoom) and 390 CSS px, and the
// single run state next to the composer. Synthetic data only.
import assert from 'node:assert/strict';

const settle = () => new Promise(resolve => setTimeout(resolve, 250));

// Geometry of the pane at the current width.
const measure = page => page.evaluate(() => {
  const pane = document.querySelector('.conversation-pane.native-conversation');
  const scroll = pane.querySelector(':scope > .conversation-scroll');
  const box = node => { const r = node.getBoundingClientRect(); return {left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width}; };
  const transcript = box(pane.querySelector('.chat-transcript'));
  const composer = box(pane.querySelector('.message-composer'));
  const runState = box(pane.querySelector('.run-state'));
  const rows = [...pane.querySelectorAll('.chat-messages > li')].filter(li => !li.hidden && li.getBoundingClientRect().height > 0);
  const last = rows.length ? box(rows.at(-1)) : null;
  const area = box(scroll);
  const input = document.querySelector('#composer').getBoundingClientRect();
  const hit = document.elementFromPoint(input.left + input.width / 2, input.top + input.height / 2);
  const actions = ['#composer', '.message-composer > button[type=submit]', '.message-composer .tool-button', '.local-folder', '.files-drawer-toggle']
    .map(selector => [selector, box(document.querySelector(selector))]);
  return {pane: box(pane), transcript, composer, runState, last, area, pinned: scroll.dataset.pinned,
    composerCovered: hit !== document.querySelector('#composer'),
    actions, page: {scroll: document.documentElement.scrollWidth, width: window.innerWidth},
    paneOverflow: scroll.scrollWidth > scroll.clientWidth + 1};
});

function checkLayout(view, width, {wide}) {
  const where = `${width}px`;
  assert.ok(view.page.scroll <= view.page.width, `${where}: horizontal page scroll (${view.page.scroll}px)`);
  assert.equal(view.paneOverflow, false, `${where}: transcript overflows sideways`);
  // The composer and the run state share the transcript's column.
  for (const [name, part] of [['composer', view.composer], ['run state', view.runState]]) {
    assert.ok(Math.abs(part.left - view.transcript.left) <= 2, `${where}: ${name} left ${part.left} vs ${view.transcript.left}`);
    assert.ok(Math.abs(part.right - view.transcript.right) <= 2, `${where}: ${name} right ${part.right} vs ${view.transcript.right}`);
  }
  if (wide) {
    assert.ok(view.transcript.width >= 760 && view.transcript.width <= 960, `${where}: column ${view.transcript.width}px is not 760-960`);
    // Centered in the pane: the space either side is the same, not a dead zone on one side.
    const leftGap = view.transcript.left - view.pane.left, rightGap = view.pane.right - view.transcript.right;
    assert.ok(Math.abs(leftGap - rightGap) <= 20, `${where}: column off-center (${leftGap} vs ${rightGap})`);
  }
  // The latest message is in view and the composer is never covered.
  assert.ok(view.last, `${where}: no message rendered`);
  assert.ok(view.last.bottom <= view.area.bottom + 2 && view.last.bottom > view.area.top, `${where}: latest message hidden (${view.last.bottom} vs ${view.area.top}-${view.area.bottom})`);
  assert.equal(view.composerCovered, false, `${where}: something covers the composer`);
  for (const [selector, part] of view.actions) assert.ok(part.left >= 0 && part.right <= view.page.width + 1 && part.width > 0, `${where}: ${selector} unreachable`);
}

export async function readableColumn({page, label, screenshot}) {
  const base = page.viewport();
  const widths = label === 'phone' ? [base.width] : [1280, 1440, 1920, 768, 640];
  for (const width of widths) {
    if (width !== page.viewport().width) await page.setViewport({...base, width, height: base.height});
    await page.waitForSelector('#composer');
    await page.waitForFunction(() => document.querySelector('.conversation-pane > .conversation-scroll')?.dataset.pinned === 'true', {timeout: 10000});
    await settle();
    checkLayout(await measure(page), width, {wide: width >= 1280});
    await screenshot(label, `column-${width}`);
  }
  if (page.viewport().width !== base.width) await page.setViewport(base);
  await page.waitForSelector('#composer');
}

const runLine = page => page.evaluate(() => {
  const line = document.querySelector('.run-state');
  return {state: line?.dataset.runState, label: line?.querySelector('.execution-summary')?.textContent,
    detail: line?.querySelector('.execution-model')?.textContent ?? null,
    stop: [...(line?.querySelectorAll('button') ?? [])].some(b => /^(Stop|Stop unavailable|Requesting stop…)$/.test(b.textContent.trim())),
    enabledStop: [...(line?.querySelectorAll('button') ?? [])].some(b => b.textContent.trim() === 'Stop' && !b.disabled),
    steer: !!line?.querySelector('.steer-drawer'), count: document.querySelectorAll('.conversation-pane .run-state').length};
});

export async function runStates({page, state, conversation, label, screenshot}) {
  const run = '00000000-0000-4000-8000-0000000007a1';
  let revision = 10;
  const wait = async expected => {
    await page.waitForFunction(s => document.querySelector('.run-state')?.dataset.runState === s, {timeout: 15000}, expected);
    return runLine(page);
  };
  const set = (phase, extra = {}) => {
    revision += 1;
    state.execution[conversation] = {run_id: run, revision, phase, capabilities: {stop: true, steer: true}, ...extra};
  };
  try {
    // No run: idle, nothing to stop.
    let view = await wait('idle');
    assert.deepEqual(view, {state: 'idle', label: 'No work running', detail: null, stop: false, enabledStop: false, steer: false, count: 1});
    set('running');
    view = await wait('running');
    assert.equal(view.label, 'Working');
    assert.ok(view.stop && view.steer, 'a running run that supports them offers Stop and Steer');
    await screenshot(label, 'run-state-running');
    set('running', {capabilities: {stop: false, steer: false}});
    await page.waitForFunction(() => !document.querySelector('.run-state .steer-drawer'), {timeout: 15000});
    view = await runLine(page);
    assert.equal(view.stop || view.steer, false, 'no Stop or Steer for a run that does not support them');
    set('queued', {capabilities: {stop: true, steer: true}});
    view = await wait('queued');
    assert.equal(view.label, 'Queued');
    assert.ok(view.stop && !view.steer, 'queued work can be stopped, not steered');
    set('completed', {models: {actual_model: 'synthetic-model'}});
    view = await wait('completed');
    assert.deepEqual(view, {state: 'completed', label: 'Completed', detail: 'Answered with synthetic-model', stop: false, enabledStop: false, steer: false, count: 1});
    await screenshot(label, 'run-state-completed');
    set('failed', {failure: {class: 'quota'}});
    view = await wait('failed');
    assert.equal(view.label, 'Failed: provider usage limit reached');
    assert.equal(view.stop || view.steer, false);
    // Losing the status stream never implies completion.
    state.execution[conversation] = 'unavailable';
    view = await wait('disconnected');
    assert.match(view.label, /^Disconnected · last known: failed\. Reconnecting does not confirm completion\.$/);
    assert.equal(view.stop || view.steer, false);
    await screenshot(label, 'run-state-disconnected');
  } finally {
    delete state.execution[conversation];
  }
  await wait('idle');
}

