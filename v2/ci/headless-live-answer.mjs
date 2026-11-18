// Every interim update of a run stays visible as its own message, in order,
// marked Update; the run's answer is its own message marked Final, shown once
// (owner decision 2026-11-18). Nothing is replaced in place. While the run
// works, a line under the last update says more is coming.
// Synthetic run, payloads and replies only; the real WASM bundle does the rest.
import assert from 'node:assert/strict';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const RUN_1 = id(8001), RUN_2 = id(8002), RUN_3 = id(8003), RUN_4 = id(8004);
const FIRST = id(8101), SECOND = id(8102), FINAL = id(8103), NEXT = id(8104), SILENT = id(8105);
const TEXT = {
  [FIRST]: 'First synthetic update',
  [SECOND]: 'Second synthetic update',
  [FINAL]: 'Final synthetic answer',
  [NEXT]: 'Next run synthetic answer',
  [SILENT]: 'NO_REPLY',
};
const RUN_OF = { [FIRST]: RUN_1, [SECOND]: RUN_1, [FINAL]: RUN_1, [NEXT]: RUN_2, [SILENT]: RUN_4 };
// Reply reads as slow as the server's own slow requests in production.
const READ_MS = 700;
const POLL_MS = 2600;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const reply = (run, sequence, payload) => ({ run_id: run, completion_event_id: id(sequence + 8200), acceptance_event_id: id(sequence + 8300),
  acceptance_sequence: sequence, payload_id: payload, payload_removed: false, auto_accepted: true });
const update = (payload, sequence, final_answer = false) => ({ run_id: RUN_OF[payload], payload_id: payload, sequence,
  observed_at_ms: Date.now(), payload_removed: false, final_answer });

export function createLiveAnswer(conversation) {
  return { conversation, run: RUN_1, phase: 'running', payload: FIRST, revision: 1, progressAt: 1000, replies: [], updates: [], watermark: 1 };
}

function set(state, change) {
  Object.assign(state.live, change, { revision: state.live.revision + 1, progressAt: state.live.progressAt + 1 });
}

/** Routes of the scripted conversation; false leaves a request to the workspace mock. */
export async function liveAnswerApi(state, req, res, rest, { json, q }) {
  const live = state.live;
  if (req.method !== 'GET') return false;
  if (rest === '') {
    const after = Number(q.get('after') ?? 0), rows = state.messages[live.conversation].filter(x => x.sequence > after);
    json(res, 200, { conversation_id: live.conversation, scope: { kind: 'global' }, messages: rows, last_sequence: live.watermark, next_cursor: null });
    return true;
  }
  if (rest === '/execution') {
    json(res, 200, { schema_version: 1, conversation_id: live.conversation, run_id: live.run, revision: live.revision, observed_at_ms: Date.now(), phase: live.phase,
      queue_age_ms: null, progress: live.payload ? { payload_id: live.payload, observed_at_ms: live.progressAt } : null, resources: null,
      capabilities: { stop: false, steer: false } });
    return true;
  }
  if (rest === '/accepted-results') {
    const after = Number(q.get('after_sequence') ?? 0), before = q.get('before_sequence');
    const rows = live.replies.filter(r => before === null ? r.acceptance_sequence > after : r.acceptance_sequence < Number(before));
    json(res, 200, { conversation_id: live.conversation, results: rows, next_after_sequence: null });
    return true;
  }
  if (rest === '/updates') {
    const after = Number(q.get('after_sequence') ?? 0), before = q.get('before_sequence');
    const rows = live.updates.filter(u => before === null ? u.sequence > after : u.sequence < Number(before));
    json(res, 200, { conversation_id: live.conversation, updates: rows, next_after_sequence: null });
    return true;
  }
  const payload = /^\/payloads\/([0-9a-f-]{36})$/.exec(rest)?.[1];
  if (payload && TEXT[payload]) {
    await sleep(READ_MS);
    json(res, 200, { payload_id: payload, conversation_id: live.conversation, run_id: RUN_OF[payload], text: TEXT[payload] });
    return true;
  }
  // Several texts in one read (ORK-797), as slow as one.
  if (rest === '/payloads') {
    const ids = (q.get('ids') ?? '').split(',').filter(p => TEXT[p]);
    await sleep(READ_MS);
    json(res, 200, { conversation_id: live.conversation, payloads: ids.map(p => ({ payload_id: p, conversation_id: live.conversation, run_id: RUN_OF[p], text: TEXT[p] })) });
    return true;
  }
  return false;
}

/** The assistant messages on screen, in order: [kind, text]. */
const assistantRows = page => page.evaluate(() => [...document.querySelectorAll('ol.chat-messages > li.assistant-message article')]
  .filter(article => article.offsetParent !== null)
  .map(article => [article.dataset.messageKind, article.querySelector('.update-output, .accepted-output')?.textContent.trim() ?? '']));
const working = page => page.evaluate(() => document.querySelector('.live-answer .live-working')?.textContent.trim() ?? null);
const waitRows = (page, expected) => page.waitForFunction(rows => {
  const shown = [...document.querySelectorAll('ol.chat-messages > li.assistant-message article')].filter(a => a.offsetParent !== null)
    .map(a => [a.dataset.messageKind, a.querySelector('.update-output, .accepted-output')?.textContent.trim() ?? '']);
  return JSON.stringify(shown) === JSON.stringify(rows);
}, { timeout: 20000 }, expected);
// The stream goes quiet in the mock: a new watermark and a wake make the chat read again.
const advance = async (page, state, watermark) => {
  state.live.watermark = watermark;
  await page.evaluate(() => window.dispatchEvent(new Event('orkestr-stream-retry')));
};

export async function liveAnswer({ page, state, origin, conversation, returnConversation, screenshot, label }) {
  const open = async () => {
    await page.goto(`${origin}/#conversation/${conversation}`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
  };
  state.live = createLiveAnswer(conversation);
  try {
    // The first update is its own message, and the run says it still works.
    state.live.updates = [update(FIRST, 101)];
    state.live.watermark = 101;
    await open();
    await waitRows(page, [['update', TEXT[FIRST]]]);
    await page.waitForFunction(() => document.querySelector('.live-answer .live-working')?.textContent.includes('Still working'), { timeout: 20000 });
    assert.equal(await page.$eval('ol.chat-messages > li.update-message .message-kind', n => n.textContent), 'Update');
    // A later update is a new message below it; the first stays.
    set(state, { payload: SECOND });
    state.live.updates = [...state.live.updates, update(SECOND, 102)];
    await advance(page, state, 102);
    await waitRows(page, [['update', TEXT[FIRST]], ['update', TEXT[SECOND]]]);
    assert.match(await working(page), /Still working/);
    await screenshot(label, 'live-answer-updating');
    // The run's last text arrives: while the run is not accepted it is an update too.
    set(state, { payload: FINAL });
    state.live.updates = [...state.live.updates, update(FINAL, 103)];
    await advance(page, state, 103);
    await waitRows(page, [['update', TEXT[FIRST]], ['update', TEXT[SECOND]], ['update', TEXT[FINAL]]]);
    // Accepted: the answer is the Final message, shown once; the updates stay.
    set(state, { phase: 'completed' });
    state.live.updates = state.live.updates.map(u => u.payload_id === FINAL ? { ...u, final_answer: true } : u);
    state.live.replies = [reply(RUN_1, 500, FINAL)];
    await advance(page, state, 500);
    await waitRows(page, [['update', TEXT[FIRST]], ['update', TEXT[SECOND]], ['final', TEXT[FINAL]]]);
    await page.waitForFunction(() => !document.querySelector('.live-answer'), { timeout: 20000 });
    assert.equal(await page.$eval('ol.chat-messages > li.assistant-message:last-child .message-kind', n => n.textContent), 'Final');
    await screenshot(label, 'live-answer-final');

    // A reopened chat shows the same messages and never a working line for a finished run.
    await open();
    await waitRows(page, [['update', TEXT[FIRST]], ['update', TEXT[SECOND]], ['final', TEXT[FINAL]]]);
    await sleep(POLL_MS);
    assert.equal(await page.$('.live-answer'), null, 'a finished run is not shown as working');

    // The next run: its one text is an update until it is accepted, then its Final message.
    set(state, { run: RUN_2, phase: 'running', payload: NEXT });
    state.live.updates = [...state.live.updates, update(NEXT, 501)];
    await advance(page, state, 501);
    await waitRows(page, [['update', TEXT[FIRST]], ['update', TEXT[SECOND]], ['final', TEXT[FINAL]], ['update', TEXT[NEXT]]]);
    set(state, { run: RUN_3, phase: 'starting', payload: null });
    state.live.updates = state.live.updates.map(u => u.payload_id === NEXT ? { ...u, final_answer: true } : u);
    state.live.replies = [...state.live.replies, reply(RUN_2, 502, NEXT)];
    await advance(page, state, 502);
    await waitRows(page, [['update', TEXT[FIRST]], ['update', TEXT[SECOND]], ['final', TEXT[FINAL]], ['final', TEXT[NEXT]]]);

    // A suppressed update is never shown.
    set(state, { run: RUN_4, phase: 'running', payload: SILENT });
    state.live.updates = [...state.live.updates, update(SILENT, 503)];
    await advance(page, state, 503);
    await sleep(POLL_MS + READ_MS);
    assert.equal(await page.evaluate(() => document.querySelector('ol.chat-messages')?.textContent.includes('NO_REPLY') ?? false), false,
      'a suppression marker stays hidden');
    assert.equal((await assistantRows(page)).length, 4);
  } finally {
    state.live = null;
    await page.goto(`${origin}/#conversation/${returnConversation}`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
  }
}
