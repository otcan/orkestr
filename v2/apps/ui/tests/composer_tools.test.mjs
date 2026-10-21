import test from 'node:test';
import assert from 'node:assert/strict';
import { enterSends, installEnterSend } from '../src/composer_keys.mjs';
import { describe, pastedText, safeName, toBase64 } from '../src/attach_files.mjs';

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
