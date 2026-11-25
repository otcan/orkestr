import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeReplyEntry, encodeReplyEntry, replyEntrySendFields, scopedGroupReplyChunks, scopedGroupReplyLimit, scopedReplyDeliveryType, scopedReplyHeader, scopedReplyParts, scopedReplyPreview,
  SCOPED_ATTACHED_MARKER, SCOPED_REPLY_MAX_PARTS, SCOPED_REPLY_PART_CHARS, SCOPED_SEND_MAX_TEXT_LENGTH,
} from '../packages/connectors/src/whatsapp-scoped-group-formatting.js';
import * as formatter from '../packages/connectors/src/whatsapp-formatting.js';

const chunk = (text, config = {}, env = {}, withFormatter = false) =>
  scopedGroupReplyChunks({text, message: {id: 'm1', chatId: 'group-1', role: 'assistant', source: 'codex-app-server'},
    thread: {codexModel: 'example-model', binding: {}}, messages: [], config, formatter: withFormatter ? formatter : null, env});
const loneSurrogate = text => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
const words = n => Array.from({length: n}, (_, i) => `word${i}`).join(' ');
const marker = `\n\n${SCOPED_ATTACHED_MARKER}`;
const label = /^(?:agent: )?\((\d+)\/(\d+)\)\n/;
// The reply's text without labels and without the whitespace dropped at cuts.
const compact = text => text.replace(/\s+/g, '');

test('only real timer metadata adds a reminder heading', () => {
  assert.equal(scopedReplyHeader({timerId: '10000000-0000-4000-8000-000000000001', label: 'Daily brief'}), '⏰ Daily brief');
  assert.equal(scopedReplyHeader({label: 'Local reminder'}), '⏰ Local reminder');
  for (const timerId of ['web', 'task-update', 'post', 'fast', 'status', 'web-progress', 'task-update-progress', 'unknown-transport']) {
    for (const label of ['Update', 'Güncelleme', '更新']) {
      assert.equal(scopedReplyHeader({timerId, label}), '');
    }
  }
});

test('a V2 pseudo-timer reply is a notice, an update or a final by its source (ORK-819)', () => {
  assert.equal(scopedReplyDeliveryType({timerId: 'post', postAuthor: 'operator', label: 'Operator'}), 'router_update');
  assert.equal(scopedReplyDeliveryType({timerId: 'post', label: 'System'}), 'router_update');
  for (const timerId of ['status', 'web-progress', 'task-update-progress']) {
    assert.equal(scopedReplyDeliveryType({timerId, label: 'Update'}), 'progress', timerId);
  }
  for (const [timerId, postAuthor] of [['10000000-0000-4000-8000-000000000001'], ['post', 'coordinator'], ['post', 'assistant_question'],
    ['web'], ['task-update'], ['fast'], [''], ['unknown-transport']]) {
    assert.equal(scopedReplyDeliveryType({timerId, postAuthor, label: 'Reply'}), 'timer_reply', timerId);
  }
});

test('reply limit defaults to 40000, honours config then env, and is clamped', () => {
  assert.equal(scopedGroupReplyLimit({}, {}), 40000);
  assert.equal(scopedGroupReplyLimit({}, {ORKESTR_WHATSAPP_MAX_REPLY_CHARS: '2500'}), 2500);
  assert.equal(scopedGroupReplyLimit({maxReplyChars: 8000}, {ORKESTR_WHATSAPP_MAX_REPLY_CHARS: '2500'}), 8000);
  assert.equal(scopedGroupReplyLimit({maxReplyChars: 10}, {}), 1000);
  assert.equal(scopedGroupReplyLimit({}, {ORKESTR_WHATSAPP_MAX_REPLY_CHARS: '999999'}), 60000);
  assert.equal(scopedGroupReplyLimit({maxReplyChars: 'many'}, {ORKESTR_WHATSAPP_MAX_REPLY_CHARS: ''}), 40000);
  assert.ok(SCOPED_SEND_MAX_TEXT_LENGTH >= 60000 + marker.length + 4002);
});

test('a reply of one part is exactly one unsplit message', () => {
  const short = words(400).slice(0, 2500);
  assert.deepEqual(chunk(short), [short]);
  const atPart = 'x'.repeat(SCOPED_REPLY_PART_CHARS);
  assert.deepEqual(chunk(atPart), [atPart]);
});

test('a longer reply within the budget is numbered parts cut at paragraphs, in order', () => {
  const paragraphs = Array.from({length: 12}, (_, i) => `Paragraph ${i}: ${'lorem ipsum '.repeat(70).trim()}.`);
  const text = paragraphs.join('\n\n');
  assert.ok(text.length > 2 * SCOPED_REPLY_PART_CHARS && text.length < 40000);
  const entries = chunk(text, {replyPrefix: 'agent:'});
  assert.ok(entries.length >= 3 && entries.length <= SCOPED_REPLY_MAX_PARTS);
  entries.forEach((entry, i) => {
    assert.equal(typeof entry, 'string');
    assert.ok(entry.length <= SCOPED_REPLY_PART_CHARS, `part ${i + 1} is ${entry.length}`);
    const [head, index, count] = entry.match(label);
    assert.equal(head, `agent: (${i + 1}/${entries.length})\n`);
    assert.deepEqual([Number(index), Number(count)], [i + 1, entries.length]);
    const body = entry.slice(head.length);
    // Each part ends a paragraph and starts the next one.
    assert.match(body, /^Paragraph \d+: /);
    assert.ok(body.endsWith('ipsum.'), `part ${i + 1} ends inside a paragraph`);
  });
  assert.equal(compact(entries.map(entry => entry.replace(label, '')).join('')), compact(text));
  assert.deepEqual(chunk(text, {replyPrefix: 'agent:'}), entries, 'the same reply always splits the same way');
});

test('a whole 32 KiB reply (two-byte letters) is numbered parts, never a document', () => {
  const sentence = 'Çalışma planı güncellendi; bütçe, iş paketleri ve ölçütler şöyle sıralandı. ';
  let text = '';
  while (Buffer.byteLength(text + sentence) <= 32768) text += sentence;
  text = text.trim();
  const entries = chunk(text);
  assert.ok(entries.length >= 7 && entries.length <= SCOPED_REPLY_MAX_PARTS, `${entries.length} parts`);
  assert.ok(entries.every(entry => typeof entry === 'string' && entry.length <= SCOPED_REPLY_PART_CHARS && label.test(entry)));
  assert.ok(entries.slice(0, -1).every(entry => entry.endsWith('sıralandı.')), 'cut at sentence ends');
  assert.equal(compact(entries.map(entry => entry.replace(label, '')).join('')), compact(text));
});

test('parts never exceed their maximum count; more falls back to a document', () => {
  const paragraphs = Array.from({length: 19}, (_, i) => `${i}`.padEnd(3000, 'p'));
  const text = paragraphs.join('\n\n');
  assert.equal(scopedReplyParts(text, SCOPED_REPLY_PART_CHARS), null);
  const entries = chunk(text, {maxReplyChars: 60000});
  assert.equal(entries.length, 2);
  assert.ok(entries[0].endsWith(marker) && entries[0].length <= SCOPED_REPLY_PART_CHARS);
  assert.equal(entries[1].document.text, text);
});

test('a reply over the budget is one preview message plus the full text as a Markdown document', () => {
  const text = `${'a'.repeat(3500)}\n\n${'b'.repeat(30000)}\n\n${'c'.repeat(10000)}`;
  const entries = chunk(text);
  assert.equal(entries.length, 2);
  assert.equal(entries[0], `${'a'.repeat(3500)}${marker}`);
  assert.deepEqual(entries[1], {document: {filename: entries[1].document.filename, mimetype: 'text/markdown', text}});
  assert.match(entries[1].document.filename, /^reply-[0-9a-f]{10}\.md$/);
  assert.equal(chunk(text)[1].document.filename, entries[1].document.filename, 'the name is stable for the same message');
});

test('the preview prefers a paragraph, then a line break, in the last quarter of the window', () => {
  assert.equal(scopedReplyPreview(`${'a'.repeat(3500)}\n\n${'b'.repeat(1000)}`, 4000), 'a'.repeat(3500));
  assert.equal(scopedReplyPreview(`${'a'.repeat(2000)}\n\n${'c'.repeat(1600)}\n${'d'.repeat(1000)}`, 4000), `${'a'.repeat(2000)}\n\n${'c'.repeat(1600)}`);
  assert.equal(scopedReplyPreview(`${'x'.repeat(3300)}. Next ${'y'.repeat(1000)}`, 4000), `${'x'.repeat(3300)}.`);
  const spaced = scopedReplyPreview(words(1000), 4000);
  assert.ok(spaced.length <= 4000 && spaced.length >= 3000 && /word\d+$/.test(spaced));
  assert.ok(words(1000).startsWith(`${spaced} `), 'no word is cut');
});

test('text without whitespace is hard cut at a part', () => {
  const entries = chunk('z'.repeat(45000));
  assert.equal(entries[0], 'z'.repeat(SCOPED_REPLY_PART_CHARS - marker.length) + marker);
  assert.equal(entries[1].document.text, 'z'.repeat(45000));
  const parts = chunk('z'.repeat(9000));
  assert.deepEqual(parts.map(entry => entry.match(label)[0]), ['(1/3)\n', '(2/3)\n', '(3/3)\n']);
  assert.equal(parts.map(entry => entry.replace(label, '')).join(''), 'z'.repeat(9000));
});

test('emoji, surrogate pairs and joined emoji sequences are never split by the preview', () => {
  for (const emoji of ['👍', '👨‍👩‍👧‍👦', '🇹🇷', '👋🏽', '1️⃣']) {
    for (let offset = 0; offset < emoji.length + 1; offset++) {
      const text = 'q'.repeat(4000 - offset) + emoji + 'r'.repeat(500);
      const preview = scopedReplyPreview(text, 4000);
      assert.ok(preview.length <= 4000 && !loneSurrogate(preview), `${emoji} at offset ${offset}`);
      assert.ok(text.startsWith(preview));
      assert.ok(preview.endsWith('q') || preview.endsWith(emoji), `${emoji} stays whole at offset ${offset}`);
    }
  }
  assert.equal(scopedReplyPreview('😀'.repeat(5000), 4001), '😀'.repeat(2000));
});

test('the footer rides on the last part only', () => {
  const text = Array.from({length: 6}, (_, i) => `Section ${i}. ${words(250)}`).join('\n\n');
  const entries = chunk(text, {appendDebugFooter: true}, {}, true);
  assert.ok(entries.length >= 2);
  assert.match(entries.at(-1), /\n\ndbg: codex\/example-model/);
  assert.ok(entries.slice(0, -1).every(entry => !entry.includes('dbg:') && entry.length <= SCOPED_REPLY_PART_CHARS));
  const embedded = 'dbg: claude-code/example · rt:coordinator · msg:*final*';
  const own = chunk(`${text}\n\n${embedded}`);
  assert.ok(own.at(-1).endsWith(`\n\n${embedded}`));
  assert.ok(own.slice(0, -1).every(entry => !entry.includes('dbg:')));
});

test('the footer stays on the message, for short and for attached replies', () => {
  const short = chunk(words(500).slice(0, 2500), {appendDebugFooter: true}, {}, true);
  assert.equal(short.length, 1);
  assert.match(short[0], /^word0 [\s\S]*\n\ndbg: codex\/example-model/);
  const full = words(5000);
  const long = chunk(full, {appendDebugFooter: true}, {}, true);
  assert.equal(long.length, 2);
  assert.ok(long[0].includes(`${SCOPED_ATTACHED_MARKER}\n\ndbg: codex/example-model`));
  assert.ok(long[0].length <= SCOPED_SEND_MAX_TEXT_LENGTH);
  assert.equal(long[1].document.text, full, 'the document holds the full text without the footer');
});

test('an env override changes the budget for new payloads', () => {
  const text = words(600);
  const entries = chunk(text, {}, {ORKESTR_WHATSAPP_MAX_REPLY_CHARS: '1000'});
  assert.equal(entries.length, 2);
  assert.ok(entries[0].length <= 1000 && entries[0].endsWith(marker));
  assert.equal(entries[1].document.text, text);
});

test('the reply prefix starts the message; the document keeps the reply as written', () => {
  const entries = chunk(words(5000), {replyPrefix: 'agent:'});
  assert.ok(entries[0].startsWith('agent: word0'));
  assert.ok(entries[1].document.text.startsWith('word0'));
});

test('stored entries round-trip, and old plain texts stay texts', () => {
  const document = {filename: 'reply-0123456789.md', mimetype: 'text/markdown', text: '# full\n\nreply'};
  const stored = encodeReplyEntry({document});
  assert.deepEqual(decodeReplyEntry(stored), {document});
  assert.deepEqual(replyEntrySendFields(stored), {document});
  assert.deepEqual(replyEntrySendFields('[Timer: x]\nold chunk'), {text: '[Timer: x]\nold chunk'});
  assert.equal(typeof decodeReplyEntry('{"document":{"filename":"evil.sh","mimetype":"text/markdown","text":"x"}}'), 'string');
});

test('entries carry no edge whitespace, so they match what the bridge actually sends', () => {
  assert.deepEqual(chunk('[Timer: x]\nanswer  \n'), ['[Timer: x]\nanswer']);
  const entries = chunk(`  ${words(5000)}\n\n`);
  assert.equal(entries[0], entries[0].trim());
  assert.equal(entries[1].document.text, words(5000));
});

test('a reply mirrored from a remote runtime carries the remote debug footer', () => {
  const entries = scopedGroupReplyChunks({text: 'Done', deliveryType: 'final',
    message: {id: 'm2', chatId: 'group-1', role: 'assistant', source: 'rust-v2-pilot', phase: 'final_answer', remoteBackend: 'rust-v2', remoteMessageId: 'r1'},
    thread: {codexModel: 'example-model', binding: {remoteBackend: 'rust-v2'}}, messages: [], config: {appendDebugFooter: true}, formatter, env: {}});
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^Done\n\n🤖 Agent · msg:\*final\*\n/);
});

test('a footer embedded at the end of a long reply stays on the message', () => {
  const footer = 'dbg: claude-code/example · rt:coordinator · msg:*update*\nsession: abcd1234 · 23:30 CEST';
  const text = `${words(5000)}\n\n${footer}`;
  const entries = chunk(text);
  assert.ok(entries[0].endsWith(`${SCOPED_ATTACHED_MARKER}\n\n${footer}`));
  assert.equal(entries[1].document.text, text);
  const short = chunk(`hello\n\n${footer}`);
  assert.deepEqual(short, [`hello\n\n${footer}`]);
});
