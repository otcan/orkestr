import test from 'node:test';
import assert from 'node:assert/strict';
import {File} from 'node:buffer';
import {webcrypto} from 'node:crypto';
import {uploadPastedText} from '../src/attachments/pasted_text.mjs';
globalThis.File ??= File;
globalThis.crypto ??= webcrypto;

test('native pasted text above the legacy limit stays a File and returns receipts only', async () => {
  const element = {value: 'ü'.repeat(9 * 1024 * 1024)};
  const receipt = {manifest_id: 'synthetic', attachments: [], note: 'Verified file'};
  let called = 0;
  const result = await uploadPastedText(element, async files => {
    called++;
    assert.equal(files.length, 1);
    const file = files[0];
    assert.equal(file.type, 'text/plain');
    assert.equal(file.size, 18 * 1024 * 1024);
    assert.match(file.name, /^pasted-text-.*\.txt$/);
    assert.equal('content_base64' in file, false);
    assert.equal(await file.slice(0, 2).text(), 'ü');
    return {receipts: [receipt]};
  }, {scope: 'synthetic-conversation:csrf'});
  assert.equal(called, 1);
  assert.deepEqual(result, {receipts: [receipt]});
});

test('an interrupted paste retries the exact File; edits and a new session get fresh identities', async () => {
  const element = {value: 'first text'}, files = [];
  let interrupted = true;
  const describe = async batch => {
    files.push(batch[0]);
    if (interrupted) return {error: 'Interrupted'};
    return {receipts: [{verified: true}]};
  };
  const options = {scope: 'conversation:session-one'};
  await uploadPastedText(element, describe, options);
  await uploadPastedText(element, describe, options);
  assert.equal(files[0], files[1], 'reuses name, bytes and lastModified for resumable upload');
  element.value = 'other text';
  await uploadPastedText(element, describe, options);
  assert.notEqual(files[1], files[2]);
  assert.notEqual(files[1].name, files[2].name);
  await uploadPastedText(element, describe, {scope: 'conversation:session-two'});
  assert.notEqual(files[2], files[3], 'never reuses another session draft');
  interrupted = false;
  await uploadPastedText(element, describe, {scope: 'conversation:session-two'});
  await uploadPastedText(element, describe, {scope: 'conversation:session-two'});
  assert.notEqual(files.at(-2), files.at(-1), 'success releases the previous in-memory file');
});

test('simultaneous clicks share one transfer and errors retain the paste for retry', async () => {
  const element = {value: 'text'};
  let complete, calls = 0;
  const describe = () => {calls++; return new Promise(resolve => {complete = resolve;});};
  const first = uploadPastedText(element, describe, {scope: 'synthetic'});
  const second = uploadPastedText(element, describe, {scope: 'synthetic'});
  assert.equal(calls, 1);
  complete({error: 'Network interrupted'});
  assert.deepEqual(await first, {error: 'Network interrupted'});
  assert.deepEqual(await second, {error: 'Network interrupted'});
  assert.equal(element.value, 'text');
  const result = await uploadPastedText(element, async () => {throw Error('Unavailable');}, {scope: 'synthetic'});
  assert.deepEqual(result, {error: 'Unavailable'});
});

test('a missing or empty paste does not start an upload', async () => {
  const describe = () => assert.fail('No upload for missing text');
  assert.match((await uploadPastedText(null, describe)).error, /text/i);
  assert.match((await uploadPastedText({value: ''}, describe)).error, /text/i);
});
