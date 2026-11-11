// ORK-780: an input the adapter re-admitted shows once in the chat.
// The synthetic API serves every row, as an older server would; the
// timeline itself keeps one message for an attempt and its retry.
import assert from 'node:assert/strict';

const FIRST = '00000000-0000-4000-8000-000000009201';
const OTHER = '00000000-0000-4000-8000-000000009202';
const RETRY = '00000000-0000-4000-8000-000000009203';
const TWICE_A = '00000000-0000-4000-8000-000000009204';
const TWICE_B = '00000000-0000-4000-8000-000000009205';

const shown = page => page.evaluate(() => [...document.querySelectorAll('article[data-message-id]')]
  .map(article => ({ id: article.dataset.messageId, text: article.querySelector('.rich-text')?.textContent.trim() ?? '' })));

const count = (rows, text) => rows.filter(row => row.text === text).length;

export async function messageRetries({ page, state, origin, conversation, returnConversation, screenshot, label }) {
  const messages = state.messages[conversation];
  state.messages[conversation] = [
    { message_id: FIRST, sequence: 1, actor_kind: 'owner', text: 'Synthetic retried request' },
    { message_id: OTHER, sequence: 2, actor_kind: 'owner', text: 'Synthetic different request' },
    { message_id: TWICE_A, sequence: 3, actor_kind: 'owner', text: 'Synthetic sent twice' },
    { message_id: TWICE_B, sequence: 4, actor_kind: 'owner', text: 'Synthetic sent twice' },
  ];
  try {
    await page.goto(`${origin}/#conversation/${conversation}`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector(`article[data-message-id="${FIRST}"]`, { timeout: 20000 });

    // The adapter retried the first input while the chat was open.
    state.messages[conversation].push({ message_id: RETRY, sequence: 5, actor_kind: 'owner',
      text: 'Synthetic retried request', retry_of: FIRST });
    await page.evaluate(() => window.dispatchEvent(new Event('orkestr-stream-retry')));
    await page.waitForSelector(`article[data-message-id="${RETRY}"]`, { timeout: 8000 });
    await page.waitForFunction(id => !document.querySelector(`article[data-message-id="${id}"]`), { timeout: 8000 }, FIRST);
    let rows = await shown(page);
    assert.equal(count(rows, 'Synthetic retried request'), 1, 'a live retry shows one message');
    assert.equal(count(rows, 'Synthetic different request'), 1, 'a different message stays');
    assert.equal(count(rows, 'Synthetic sent twice'), 2, 'a message sent twice shows twice');
    await screenshot(label, 'message-retry-live');

    // Reloaded: the attempt and its retry arrive in one page.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector(`article[data-message-id="${RETRY}"]`, { timeout: 20000 });
    rows = await shown(page);
    assert.equal(rows.some(row => row.id === FIRST), false, 'the retried attempt is not shown after a reload');
    assert.equal(count(rows, 'Synthetic retried request'), 1);
    assert.equal(count(rows, 'Synthetic sent twice'), 2);
  } finally {
    state.messages[conversation] = messages;
    await page.goto(`${origin}/#conversation/${returnConversation}`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
  }
}
