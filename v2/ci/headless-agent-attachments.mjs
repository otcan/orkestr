// An accepted reply that attached a workspace file (ORK-779) shows it as an
// attachment card. Synthetic manifest, payload and owner only; the real WASM
// bundle parses the marker, hides it and mounts the scoped file controls.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

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

/** The marked answer's payload while this scenario runs, or null. */
export function markedPayload(state, conversation, payload) {
  if (state.agentAttachments !== conversation || Number(payload.slice(-4)) - 7300 !== ANSWER) return null;
  return { payload_id: payload, conversation_id: conversation, run_id: id(7000 + ANSWER), text: `Synthetic answer ${ANSWER}\n\n${MARKER}` };
}

// The server gzips JSON of 1 KiB and more for a browser that accepts it
// (response_shaping.rs); the file store is served the same way here, so the
// attachment client meets the representation the owner's browser gets (ORK-809).
function zipped(state, req, res, body, json) {
  if (!/\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) return json(res, 200, body);
  state.gzippedManifestReads = (state.gzippedManifestReads ?? 0) + 1;
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-encoding': 'gzip', vary: 'accept-encoding' });
  res.end(gzipSync(JSON.stringify(body)));
}

/** The marked answer and its manifest; false leaves a request to the workspace mock. */
export function agentAttachmentApi(state, req, res, rest, { json }) {
  const conversation = state.agentAttachments;
  if (req.method !== 'GET') return false;
  const payload = /^\/payloads\/([0-9a-f-]{36})$/.exec(rest);
  const marked = payload && markedPayload(state, conversation, payload[1]);
  if (marked) {
    json(res, 200, marked);
    return true;
  }
  if (rest === '/attachment-manifests') {
    zipped(state, req, res, { owner_id: OWNER, conversation_id: conversation, after_id: null, next_after_id: null, manifests: [manifest(conversation)] }, json);
    return true;
  }
  if (rest === `/attachment-manifests/${MANIFEST}`) {
    zipped(state, req, res, manifest(conversation), json);
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
    // ORK-786: the card names its file before any request; opening verifies it.
    assert.equal(await page.$eval(`${card} strong`, n => n.textContent), NAME);
    assert.equal(await page.$eval(card, n => n.getAttribute('data-verified')), 'false');
    await page.$eval(`${card} button`, button => button.click());
    await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('data-verified') === 'true', { timeout: 15000 }, card);
    await page.waitForFunction((selector, name) => document.querySelector(`${selector} strong`)?.textContent === name,
      { timeout: 15000 }, card, NAME);
    assert.match(await page.$eval(card, n => n.textContent), /Download/);
    assert.ok(state.gzippedManifestReads > 0, 'the file store was read gzip-encoded, as the server sends it');
    await screenshot(label, 'agent-reply-attachment');
    // ORK-809: Files lists the assistant's file under "In this chat", and the
    // collapsed private copies read the same gzip store without an error.
    await page.click('#conversation-tab-files');
    const listed = '.files-drawer .chat-files .message-file-card';
    await page.waitForSelector(listed, { timeout: 15000 });
    assert.deepEqual(await page.$eval(listed, n => [n.querySelector('.message-file-from')?.textContent, n.querySelector('strong')?.textContent]), ['Assistant', NAME]);
    await page.$eval(`${listed} button`, button => button.click());
    await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('data-verified') === 'true', { timeout: 15000 }, listed);
    await page.click('.files-private-toggle');
    await page.waitForFunction(name => [...document.querySelectorAll('.files-drawer [aria-label="Thread files"] button')]
      .some(b => b.textContent === `Open saved copy: ${name}`), { timeout: 15000 }, NAME);
    assert.ok(!(await page.$eval('.files-drawer [aria-label="Thread files"]', n => n.textContent)).includes('Unexpected file representation'));
    await screenshot(label, 'files-panel-agent-file');
  } finally {
    state.agentAttachments = null;
    await page.goto(`${origin}/#conversation/${returnConversation}`, { waitUntil: 'domcontentloaded' });
    await page.reload({ waitUntil: 'domcontentloaded' });
  }
}
