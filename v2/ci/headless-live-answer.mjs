// One answer must stay on screen from its first update to its accepted reply.
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

export function createLiveAnswer(conversation) {
  return { conversation, run: RUN_1, phase: 'running', payload: FIRST, revision: 1, progressAt: 1000, replies: [], watermark: 1 };
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
    const after = Number(q.get('after_sequence') ?? 0);
    json(res, 200, { conversation_id: live.conversation, results: live.replies.filter(r => r.acceptance_sequence > after), next_after_sequence: null });
    return true;
  }
  const payload = /^\/payloads\/([0-9a-f-]{36})$/.exec(rest)?.[1];
  if (payload && TEXT[payload]) {
    await sleep(READ_MS);
    json(res, 200, { payload_id: payload, conversation_id: live.conversation, run_id: RUN_OF[payload], text: TEXT[payload] });
    return true;
  }
  // Several accepted replies in one read (ORK-797), as slow as one.
  if (rest === '/payloads') {
    const ids = (q.get('ids') ?? '').split(',').filter(p => TEXT[p]);
    await sleep(READ_MS);
    json(res, 200, { conversation_id: live.conversation, payloads: ids.map(p => ({ payload_id: p, conversation_id: live.conversation, run_id: RUN_OF[p], text: TEXT[p] })) });
    return true;
  }
  return false;
}

// Records every change of the answers on screen. A row covered by the live
// bubble is mounted but hidden, so it does not count as visible.
const sampler = () => {
  const read = () => JSON.stringify([...document.querySelectorAll('.live-answer .rich-text, .chat-messages .accepted-output')]
    .filter(node => node.offsetParent !== null).map(node => node.textContent.trim()));
  window.__answers = [read()];
  window.__sampling = setInterval(() => {
    const now = read();
    if (window.__answers.at(-1) !== now) window.__answers.push(now);
  }, 15);
};
const samples = async page => (await page.evaluate(() => { clearInterval(window.__sampling); return window.__answers; })).map(row => JSON.parse(row));

/** After its first text appears, some text of the answer stays visible in every frame. */
function assertContinuous(frames, texts, what) {
  const first = frames.findIndex(frame => frame.some(text => texts.includes(text)));
  assert.ok(first >= 0, `${what}: the answer never appeared`);
  const gap = frames.slice(first).find(frame => !frame.some(text => texts.includes(text)));
  assert.equal(gap, undefined, `${what}: the answer disappeared from the chat and came back. Frames: ${JSON.stringify(frames)}`);
}
const assertNoDuplicate = (frames, text, what) => assert.equal(frames.find(frame => frame.filter(t => t === text).length > 1), undefined, `${what}: the same answer was shown twice. Frames: ${JSON.stringify(frames)}`);
const wake = page => page.evaluate(() => window.dispatchEvent(new Event('orkestr-stream-retry')));
const liveShows = (page, text) => page.waitForFunction(t => document.querySelector('.live-answer .rich-text')?.textContent.includes(t), { timeout: 20000 }, text);
const settled = (page, text) => page.waitForFunction(t => !document.querySelector('.live-answer')
  && [...document.querySelectorAll('.chat-messages .accepted-output')].some(node => node.offsetParent !== null && node.textContent.includes(t)), { timeout: 20000 }, text);

export async function liveAnswer({ page, state, origin, conversation, returnConversation, screenshot, label }) {
  const open = async () => {
    await page.goto(`${origin}/#conversation/${conversation}`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
  };
  state.live = createLiveAnswer(conversation);
  try {
    await open();
    await liveShows(page, TEXT[FIRST]);
    await page.evaluate(sampler);
    // A later update of the same run replaces the text without blanking it.
    set(state, { payload: SECOND });
    await liveShows(page, TEXT[SECOND]);
    await screenshot(label, 'live-answer-updating');
    // The run finishes; its accepted reply is not readable yet.
    set(state, { phase: 'completed', payload: FINAL });
    await sleep(POLL_MS);
    state.live.replies = [reply(RUN_1, 500, FINAL)];
    state.live.watermark = 500;
    await wake(page);
    await settled(page, TEXT[FINAL]);
    await sleep(POLL_MS);
    let frames = await samples(page);
    assertContinuous(frames, [TEXT[FIRST], TEXT[SECOND], TEXT[FINAL]], 'updates and handover');
    assertNoDuplicate(frames, TEXT[FINAL], 'handover');
    assert.deepEqual(frames.at(-1), [TEXT[FINAL]], 'exactly one settled answer');

    // A run followed at once by another: status never reports it completed.
    set(state, { run: RUN_2, phase: 'running', payload: NEXT });
    await liveShows(page, TEXT[NEXT]);
    await page.evaluate(sampler);
    set(state, { run: RUN_3, phase: 'starting', payload: null });
    await sleep(POLL_MS);
    state.live.replies = [...state.live.replies, reply(RUN_2, 501, NEXT)];
    state.live.watermark = 501;
    await wake(page);
    await settled(page, TEXT[NEXT]);
    frames = await samples(page);
    assertContinuous(frames, [TEXT[NEXT]], 'next run starts before the reply arrives');
    assertNoDuplicate(frames, TEXT[NEXT], 'next run starts before the reply arrives');

    // Reopening a finished chat never flashes a live bubble for an old answer.
    set(state, { run: RUN_1, phase: 'completed', payload: FINAL });
    const seen = await page.evaluateOnNewDocument(() => {
      window.__sawLive = false;
      setInterval(() => { if (document.querySelector('.live-answer')) window.__sawLive = true; }, 15);
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settled(page, TEXT[FINAL]);
    await sleep(POLL_MS);
    assert.equal(await page.evaluate(() => window.__sawLive), false, 'a finished answer is not replayed as live after a reload');
    await page.removeScriptToEvaluateOnNewDocument(seen.identifier);

    // A suppressed reply is never shown while it is being written.
    set(state, { run: RUN_4, phase: 'running', payload: SILENT });
    await sleep(POLL_MS + READ_MS);
    assert.equal(await page.evaluate(() => document.querySelector('.live-answer')?.textContent.includes('NO_REPLY') ?? false), false, 'suppression marker stays hidden while live');
  } finally {
    state.live = null;
    await page.goto(`${origin}/#conversation/${returnConversation}`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
  }
}
