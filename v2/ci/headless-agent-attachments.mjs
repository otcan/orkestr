// An accepted reply that attached a workspace file (ORK-779) shows it as an
// attachment card. Synthetic manifest, payload and owner only; the real WASM
// bundle parses the marker, hides it and mounts the scoped file controls.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const OWNER = id(9701), MANIFEST = id(9702), REFERENCE = id(9703);
const BYTES = Buffer.from('PK\x03\x04synthetic October package');
// Answer 25 of the workspace mock's accepted replies carries the attachment.
const ANSWER = 25;
const NAME = 'October package.zip';
const MARKER = `[orkestr-attachment manifest=${MANIFEST} reference=${REFERENCE} name="${NAME}"]`;

const manifest = conversation => ({ schema_version: 1, manifest_id: MANIFEST, owner_id: OWNER, conversation_id: conversation,
  references: [{ reference_id: REFERENCE, message_id: null, filename: NAME, media_type: 'application/zip',
    byte_length: BYTES.length, sha256: createHash('sha256').update(BYTES).digest('hex'), state: 'available' }] });

/** The marked answer and its manifest; false leaves a request to the workspace mock. */
export function agentAttachmentApi(state, req, res, rest, { json }) {
  const conversation = state.agentAttachments;
  if (req.method !== 'GET') return false;
  const payload = /^\/payloads\/([0-9a-f-]{36})$/.exec(rest);
  if (payload && Number(payload[1].slice(-4)) - 7300 === ANSWER) {
    json(res, 200, { payload_id: payload[1], conversation_id: conversation, run_id: id(7000 + ANSWER),
      text: `Synthetic answer ${ANSWER}\n\n${MARKER}` });
    return true;
  }
  if (rest === '/attachment-manifests') {
    json(res, 200, { owner_id: OWNER, conversation_id: conversation, after_id: null, next_after_id: null, manifests: [manifest(conversation)] });
    return true;
  }
  if (rest === `/attachment-manifests/${MANIFEST}`) {
    json(res, 200, manifest(conversation));
    return true;
  }
  return false;
}

export async function agentAttachments({ page, state, origin, conversation, returnConversation, screenshot, label }) {
  state.agentAttachments = conversation;
  try {
    await page.goto(`${origin}/#conversation/${conversation}`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    const card = '.chat-messages .accepted-output .message-file-card';
    await page.waitForSelector(card, { timeout: 20000 });
    const view = await page.evaluate(() => {
      const outputs = [...document.querySelectorAll('.chat-messages .assistant-message .accepted-output')];
      const marked = outputs.find(n => n.querySelector('.message-file-card'));
      return { cards: document.querySelectorAll('.chat-messages .message-file-card').length,
        text: marked?.querySelector('.rich-text')?.textContent.trim() ?? marked?.firstElementChild?.textContent.trim(),
        page: document.querySelector('.conversation-pane').innerText };
    });
    assert.equal(view.cards, 1, 'one attachment card for the one attached file');
    assert.equal(view.text, `Synthetic answer ${ANSWER}`, 'the marker line is not shown as text');
    assert.ok(!view.page.includes('orkestr-attachment'), 'no marker text anywhere in the chat');
    await page.$eval(`${card} button`, button => button.click());
    await page.waitForFunction((selector, name) => document.querySelector(`${selector} strong`)?.textContent === name,
      { timeout: 15000 }, card, NAME);
    assert.match(await page.$eval(card, n => n.textContent), /Download/);
    await screenshot(label, 'agent-reply-attachment');
  } finally {
    state.agentAttachments = null;
    await page.goto(`${origin}/#conversation/${returnConversation}`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
  }
}
