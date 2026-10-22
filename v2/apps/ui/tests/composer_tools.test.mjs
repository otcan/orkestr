import test from 'node:test';
import assert from 'node:assert/strict';
import { enterSends, installEnterSend } from '../src/composer_keys.mjs';
import { carriesFiles, describe, installDropZone, pastedFiles, pastedText, safeName, toBase64 } from '../src/attach_files.mjs';

const key = (extra = {}) => ({ key: 'Enter', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false, keyCode: 13, ...extra });

test('Enter sends; Shift+Enter, modifiers and IME composition do not', () => {
  assert.equal(enterSends(key()), true);
  assert.equal(enterSends(key({ shiftKey: true })), false);
  assert.equal(enterSends(key({ isComposing: true })), false);
  assert.equal(enterSends(key({ keyCode: 229 })), false);
  assert.equal(enterSends(key({ ctrlKey: true })), false);
  assert.equal(enterSends(key({ key: 'a' })), false);
});

test('installed handler submits the form once and leaves other keys alone', () => {
  let submitted = 0, prevented = 0, listener;
  const submit = { disabled: false };
  const textarea = { dataset: {}, form: { querySelector: () => submit, requestSubmit: () => { submitted++; } },
    addEventListener: (_, cb) => { listener = cb; } };
  assert.equal(installEnterSend(textarea), true);
  assert.equal(installEnterSend(textarea), false, 'installs once');
  listener({ ...key(), preventDefault: () => prevented++ });
  listener({ ...key({ shiftKey: true }), preventDefault: () => prevented++ });
  listener({ ...key({ isComposing: true }), preventDefault: () => prevented++ });
  assert.deepEqual([submitted, prevented], [1, 1]);
  submit.disabled = true;
  listener({ ...key(), preventDefault: () => prevented++ });
  assert.equal(submitted, 1, 'a busy composer does not send again');
});

test('files and pasted text become bounded base64 uploads', async () => {
  const file = (name, type, text) => ({ name, type, size: text.length, arrayBuffer: async () => new TextEncoder().encode(text).buffer });
  const { files } = await describe([file('a/b/photo.png', 'image/png', 'png-bytes'), file('notes', '', 'x')]);
  assert.deepEqual(files.map(f => [f.filename, f.media_type]), [['photo.png', 'image/png'], ['notes', 'application/octet-stream']]);
  assert.equal(Buffer.from(files[0].content_base64, 'base64').toString(), 'png-bytes');
  assert.match((await describe(Array(9).fill(file('a', 'text/plain', 'x')))).error, /at most 8/);
  assert.match((await describe([file('e', 'text/plain', '')])).error, /empty/);
  const pasted = pastedText('ü'.repeat(5000), new Date('2026-01-02T03:04:05Z'));
  assert.equal(pasted.filename, 'pasted-text-20260102030405.txt');
  assert.equal(Buffer.from(pasted.content_base64, 'base64').toString(), 'ü'.repeat(5000));
  assert.equal(safeName('\u0000../x'), 'x');
  assert.equal(toBase64(new Uint8Array([255, 0, 1])), '/wAB');
});

test('only file drags and text-free pastes attach', () => {
  assert.equal(carriesFiles({ types: ['Files'] }), true);
  assert.equal(carriesFiles({ types: ['text/plain'] }), false);
  assert.equal(carriesFiles(null), false);
  const image = { name: 'shot.png' };
  assert.deepEqual(pastedFiles({ types: ['Files'], files: [image] }), [image]);
  assert.deepEqual(pastedFiles({ types: ['text/plain', 'Files'], files: [image] }), [], 'text paste stays text');
  assert.deepEqual(pastedFiles({ types: ['text/plain'], files: [] }), []);
});

test('drop zone highlights, describes dropped files and uninstalls', async () => {
  const listeners = target => { const map = {}; return Object.assign(target, {
    addEventListener: (type, cb) => { map[type] = cb; }, removeEventListener: (type, cb) => { if (map[type] === cb) delete map[type]; }, map }); };
  const classes = new Set();
  const doc = listeners({});
  const zone = listeners({ ownerDocument: doc, contains: node => node === 'inside',
    classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)) } });
  const textarea = listeners({});
  const sent = [];
  const off = installDropZone(zone, textarea, batch => sent.push(batch));
  const file = (name, text) => ({ name, type: 'text/plain', size: text.length, arrayBuffer: async () => new TextEncoder().encode(text).buffer });
  let prevented = 0;
  const event = (types, files = []) => ({ dataTransfer: { types, files, dropEffect: '' }, preventDefault: () => prevented++, target: 'inside' });
  zone.map.dragenter(event(['Files'])); zone.map.dragenter(event(['Files']));
  assert.ok(classes.has('drop-active'));
  zone.map.dragleave(event(['Files']));
  assert.ok(classes.has('drop-active'), 'leaving a child keeps the highlight');
  await zone.map.drop(event(['Files'], [file('a.txt', 'a'), file('b.txt', 'bb')]));
  assert.ok(!classes.has('drop-active'));
  assert.deepEqual(sent[0].files.map(f => f.filename), ['a.txt', 'b.txt']);
  await zone.map.drop(event(['Files'], Array(9).fill(file('x', 'x'))));
  assert.match(sent[1].error, /at most 8/);
  const before = prevented;
  zone.map.dragover(event(['text/plain']));
  assert.equal(prevented, before, 'text drags are left to the browser');
  const outside = { ...event(['Files']), target: 'sidebar' };
  doc.map.drop(outside);
  assert.equal(prevented, before + 1, 'a file dropped elsewhere does not navigate away');
  await textarea.map.paste({ clipboardData: { types: ['Files'], files: [file('shot.png', 'png')] }, preventDefault: () => prevented++ });
  assert.equal(sent[2].files[0].filename, 'shot.png');
  off();
  assert.deepEqual([Object.keys(zone.map), Object.keys(textarea.map), Object.keys(doc.map)], [[], [], []]);
});

test('unreadable entries (folders) are refused with a clear error', async () => {
  const folder = { name: 'photos', type: '', size: 4096, arrayBuffer: async () => { throw new Error('NotReadable'); } };
  assert.match((await describe([folder])).error, /photos could not be read \(folders cannot be attached\)/);
  assert.match((await describe([{ ...folder, size: 0 }])).error, /photos is empty or a folder/);
});
