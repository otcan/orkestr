// Exercise both real chat renderers; suppression must leave retained API data intact.
import assert from 'node:assert/strict';

export async function silentReplies({ page, state, origin, conversation, returnConversation, worker, screenshot, label }) {
  const messages = state.messages[conversation];
  state.silentReplies = true;
  state.messages[conversation] = [...messages, {
    message_id: '00000000-0000-4000-8000-000000009029', sequence: 29, actor_kind: 'owner', text: 'NO_REPLY',
  }];
  try {
    await page.goto(`${origin}/#conversation/${conversation}`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const replies = [...document.querySelectorAll('.chat-messages .accepted-output')];
      return replies.length === 27 && replies.some(n => n.textContent.trim() === 'Why does NO_REPLY appear?');
    }, { timeout: 20000 });
    const native = await page.evaluate(() => ({
      replies: [...document.querySelectorAll('.chat-messages .assistant-message .accepted-output')].map(n => n.textContent.trim()),
      bubbles: document.querySelectorAll('.chat-messages > .assistant-message').length,
      owner: [...document.querySelectorAll('.chat-messages .user-message .rich-text')].some(n => n.textContent.trim() === 'NO_REPLY'),
    }));
    assert.equal(native.owner, true, 'owner-authored marker remains visible');
    assert.equal(native.bubbles, 27, 'suppression leaves no empty assistant bubble');
    assert.equal(native.replies.includes('NO_REPLY'), true, 'quoted marker remains visible');
    assert.equal(native.replies.at(-1), 'Why does NO_REPLY appear?');
    const retained = await page.evaluate(async id => {
      const rows = await fetch(`/api/v2/conversations/${id}/accepted-results?after_sequence=25&limit=20`).then(r => r.json());
      const silent = rows.results.find(r => r.acceptance_sequence === 26);
      const payload = await fetch(`/api/v2/conversations/${id}/payloads/${silent.payload_id}`).then(r => r.json());
      return { rows: rows.results.length, removed: silent.payload_removed, text: payload.text };
    }, conversation);
    assert.deepEqual(retained, { rows: 3, removed: false, text: '  NO_REPLY\n' }, 'audit payload and acceptance are retained');
    await screenshot(label, 'silent-native-reply');

    await page.goto(`${origin}/#v1/${worker}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelectorAll('.v1-thread .chat-messages > li').length === 5, { timeout: 20000 });
    const linked = await page.evaluate(() => ({
      assistant: [...document.querySelectorAll('.v1-thread .assistant-message .rich-text')].map(n => n.textContent.trim()),
      owner: [...document.querySelectorAll('.v1-thread .user-message .rich-text')].map(n => n.textContent.trim()),
    }));
    assert.equal(linked.assistant.includes('NO_REPLY'), false);
    assert.equal(linked.assistant.includes('Why does NO_REPLY appear?'), true);
    assert.equal(linked.owner.includes('NO_REPLY'), true);
    assert.equal(state.requests.some(r => r.startsWith('DELETE ') && r.includes('/payloads/')), false);
    await screenshot(label, 'silent-v1-reply');
  } finally {
    state.silentReplies = false;
    state.messages[conversation] = messages;
    await page.goto(`${origin}/#conversation/${returnConversation}`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
  }
}
