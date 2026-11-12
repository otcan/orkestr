// ORK-797: a chat reads its answers' texts in one batch, keeps them, and
// retries a busy server quietly. It never says "Loading this answer again…",
// and an answer's text, once shown, never disappears.
import assert from 'node:assert/strict';

const ANSWERS = 25;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Runs in every new document of the page: records the old sentence, a failure
// notice, the quiet hint, and any answer whose shown text went away.
const SAMPLER = () => {
  const seen = {};
  window.__ork797 = { sentence: false, failed: false, hint: false, lost: [] };
  setInterval(() => {
    const record = window.__ork797;
    const text = document.body?.innerText ?? '';
    if (text.includes('Loading this answer again')) record.sentence = true;
    if (text.includes('could not be loaded')) record.failed = true;
    if (document.querySelector('.chat-messages .reply-loading')) record.hint = true;
    for (const article of document.querySelectorAll('.chat-messages article[data-payload-id]')) {
      const id = article.dataset.payloadId;
      const shown = article.querySelector('.accepted-output')?.textContent.trim() ?? '';
      if (shown) seen[id] = shown;
      else if (seen[id] && !record.lost.includes(id)) record.lost.push(id);
    }
  }, 15);
};

export async function answerLoading({ page, state, origin, conversation, returnConversation, screenshot, label }) {
  // Requests since `from`: answer listings and answer-text reads (one or many).
  const count = from => {
    const rows = state.requests.slice(from);
    return {
      listing: rows.filter(r => r === 'GET /api/v2/conversations/:id/accepted-results').length,
      payloads: rows.filter(r => /^GET \/api\/v2\/conversations\/:id\/payloads(\/:id)?$/.test(r)).length,
    };
  };
  const shownAll = () => page.waitForFunction(n => [...document.querySelectorAll('.chat-messages .assistant-message .accepted-output')]
    .filter(node => node.textContent.trim()).length === n, { timeout: 30000 }, ANSWERS);
  // The other chat has no answers, only its own synthetic message.
  const otherChat = () => page.waitForFunction(() => !document.querySelector('.chat-messages .accepted-output')
    && document.querySelector('.chat-messages')?.textContent.includes('Native synthetic message'), { timeout: 15000 });
  const records = [];
  const collect = async () => records.push(await page.evaluate(() => structuredClone(window.__ork797)));
  // A full page load, not a hash change: nothing is cached yet.
  const load = async name => {
    const from = state.requests.length;
    await page.goto(`${origin}/?answers=${name}-${label}#conversation/${conversation}`, { waitUntil: 'domcontentloaded' });
    await shownAll();
    return count(from);
  };
  const sampler = await page.evaluateOnNewDocument(SAMPLER);
  try {
    // 1. One chat load: one listing per 20 answers and one batch for the texts.
    const clean = await load('clean');
    await screenshot(label, 'answers-loaded');

    // 2. No polling: an open chat never reads a shown text again, so a busy
    // server cannot blank it.
    state.payloadBusy = 1000;
    let from = state.requests.length;
    await sleep(6500);
    const quiet = count(from);
    state.payloadBusy = 0;

    // 3. Another chat and back, and a stream reconnect: texts come from the
    // page's cache, not from new reads.
    from = state.requests.length;
    await page.evaluate(id => { location.hash = `#conversation/${id}`; }, returnConversation);
    await otherChat();
    await page.evaluate(id => { location.hash = `#conversation/${id}`; }, conversation);
    await shownAll();
    await page.evaluate(() => window.dispatchEvent(new Event('orkestr-stream-retry')));
    await sleep(1500);
    const back = count(from);
    await collect();

    // 4. A busy server: the first three reads fail. The chat retries with
    // backoff, shows only a quiet hint, and every text arrives.
    state.payloadBusy = 3;
    const busy = await load('busy');
    await screenshot(label, 'answers-after-busy-server');
    await collect();

    console.log(`ORK-797 request count (${label}): a chat load with ${ANSWERS} answers took ${clean.listing} listing + ${clean.payloads} answer-text requests; `
      + `${quiet.payloads} text requests in the next 6.5 s; ${back.payloads} after switching chats and reconnecting; `
      + `${busy.payloads} text requests when the first 3 failed`);
    for (const record of records) {
      assert.equal(record.sentence, false, '"Loading this answer again" is never shown');
      assert.equal(record.failed, false, 'no answer is reported as not loadable while retries remain');
      assert.deepEqual(record.lost, [], 'an answer\'s shown text never disappears');
    }
    assert.equal(records.at(-1).hint, true, 'a slow first load shows the quiet hint');
    assert.equal(await page.$('.chat-messages .reply-loading'), null, 'the hint goes once the texts are there');
    assert.equal(clean.payloads, 1, `${ANSWERS} answers are one text request, not ${ANSWERS}`);
    assert.ok(clean.listing <= 3, `answer listing requests: ${clean.listing}`);
    assert.equal(quiet.payloads, 0, 'no text is read again while the chat is open');
    assert.equal(back.payloads, 0, 'switching chats and reconnecting reads no text again');
    assert.equal(busy.payloads, 4, 'three busy answers, then one batch');
    assert.equal(state.payloadBusy, 0);
  } finally {
    state.payloadBusy = 0;
    await page.removeScriptToEvaluateOnNewDocument(sampler.identifier);
    await page.goto(`${origin}/#conversation/${returnConversation}`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
  }
}
