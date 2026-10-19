import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {attachmentDiagnostics, observedDownloadManager, threadFilesCategory, sampleThreadFiles} from './attachment-diagnostics.mjs';
import {savedBytes} from './saved-bytes.mjs';
import {attachmentRoundtrip} from './attachments.mjs';

const origin = 'https://beta.example.test';
function page(notice, {foreign = false, sections = 1, statuses = 1, disabled = false} = {}) {
  const section = {querySelectorAll(selector) {
    if (selector === ':scope > p[role="status"]') return Array.from({length: statuses}, () => ({textContent: notice}));
    if (selector === 'button') return [{textContent: 'Verify and download', disabled}];
    throw Error('unexpected_selector');
  }};
  return {async evaluate(fn, expectedOrigin) {
    const result = vm.runInNewContext(`(${fn.toString()})(expectedOrigin)`, {
      expectedOrigin, location: {origin: foreign ? 'https://foreign.example.test' : origin},
      document: {querySelectorAll: () => Array.from({length: sections}, () => section)},
    });
    return JSON.parse(JSON.stringify(result));
  }};
}

test('only fixed status categories leave the owned page, including refusal and offered', async () => {
  for (const [text, category] of [
    ['File verified and download offered.', 'offered'], ['File request refused', 'request_refused'],
    ['File response metadata mismatch', 'response_metadata_refused'], ['Attachment digest mismatch', 'integrity_refused'],
    ['secret filename https://private.example.test/?token=sensitive', 'other'], ['x'.repeat(10000), 'other'],
  ]) {
    const value = await page(text).evaluate(threadFilesCategory, origin);
    assert.deepEqual(value, {notice: category, verify_button: 'enabled'});
    assert(!JSON.stringify(value).includes(text));
  }
  assert.equal((await page('File request refused', {foreign: true}).evaluate(threadFilesCategory, origin)).notice, 'foreign_origin');
  for (const options of [{sections: 0}, {sections: 2}, {statuses: 2}]) {
    assert.equal((await page('File request refused', options).evaluate(threadFilesCategory, origin)).notice, 'missing');
  }
});

test('metadata state is bounded and snapshots retain no event identifiers or arbitrary fields', () => {
  const diagnostics = attachmentDiagnostics();
  diagnostics.step('download_poll'); diagnostics.step('secret-step');
  diagnostics.accepted({kind: 'begin', guid: 'secret-guid', filename: 'secret-file'});
  for (let i = 0; i < 100; i++) diagnostics.accepted({kind: 'progress', state: 'inProgress', guid: 'secret-guid'});
  diagnostics.application({notice: 'secret-notice', verify_button: 'secret-button', token: 'secret'});
  const result = diagnostics.snapshot();
  assert.equal(result.step, 'download_poll');
  assert.deepEqual(result.download, {arm: 'not_started', accepted_begin: true, accepted_progress_count: 64,
    last_accepted_progress: 'in_progress', recorder_refused: false, overflow: true});
  assert.deepEqual(result.application, {notice: 'other', verify_button: 'unknown'});
  assert(!JSON.stringify(result).includes('secret'));
  result.download.accepted_begin = false;
  assert.equal(diagnostics.snapshot().download.accepted_begin, true);
});

test('existing record must accept before counting, with exact arguments and rejection preserved', async () => {
  class Base { constructor(options) { this.options = options; } }
  const diagnostics = attachmentDiagnostics();
  const state = {}, root = {}, signal = new AbortController().signal, event = {kind: 'begin', guid: 'private'};
  let passedRecord, accepted = false, release;
  const original = {async arm(actualState, actualRoot, record, actualSignal) {
    assert.equal(actualState, state); assert.equal(actualRoot, root); assert.equal(actualSignal, signal);
    passedRecord = record; await record(event); return 'original-result';
  }, abandon() {}};
  const Manager = observedDownloadManager(Base, diagnostics);
  const manager = new Manager({contexts: original, operationTimeoutMs: 6000});
  assert.equal(manager.options.operationTimeoutMs, 6000);
  assert.equal(manager.options.contexts.abandon, original.abandon);
  assert.notEqual(manager.options.contexts, original);
  const pending = manager.options.contexts.arm(state, root, received => {
    assert.equal(received, event);
    return new Promise(resolve => { release = () => { accepted = true; resolve(); }; });
  }, signal);
  await Promise.resolve();
  assert.equal(diagnostics.snapshot().download.accepted_begin, false);
  release(); assert.equal(await pending, 'original-result'); assert.equal(accepted, true);
  assert.equal(diagnostics.snapshot().download.accepted_begin, true);
  assert.equal(diagnostics.snapshot().download.arm, 'ready');
  const failure = new Error('private rejection text');
  // A distinct arm receives its own original rejecting callback.
  await assert.rejects(manager.options.contexts.arm(state, root, async () => { throw failure; }, signal), error => error === failure);
  assert.equal(diagnostics.snapshot().download.recorder_refused, true);
  assert.equal(diagnostics.snapshot().download.arm, 'refused');
  assert.equal(typeof passedRecord, 'function');
  assert(!JSON.stringify(diagnostics.snapshot()).includes('private'));
});

test('no begin and begun-incomplete produce distinct timeout diagnostics with one arm and click', async () => {
  for (const begun of [false, true]) {
    const diagnostics = attachmentDiagnostics(); let arms = 0, clicks = 0;
    const timeout = Object.assign(new Error('timeout'), {code: 'timeout'});
    const adapter = {
      async beginDownloads() {
        arms++; diagnostics.arm('ready');
        if (begun) {
          diagnostics.accepted({kind: 'begin'});
          diagnostics.accepted({kind: 'progress', state: 'inProgress'});
        }
        return {run: 'private-run'};
      },
      async dispatch(method, params) {
        assert.equal(method, 'awaitDownload'); assert.deepEqual(params, {run: 'private-run', timeoutMs: 0});
        throw timeout;
      },
    };
    await assert.rejects(savedBytes({adapter, click: async () => { clicks++; }, expected: Buffer.from([1]),
      filename: 'synthetic-copy.bin', timeoutMs: 1, step: diagnostics.step}), error => error === timeout);
    assert.equal(arms, 1); assert.equal(clicks, 1);
    assert.equal(diagnostics.snapshot().step, 'download_poll');
    assert.equal(diagnostics.snapshot().download.accepted_begin, begun);
    assert.equal(diagnostics.snapshot().download.last_accepted_progress, begun ? 'in_progress' : 'none');
  }
});

test('sampling uses one bounded read, honors exhausted/aborted phase, and ignores late results', async () => {
  const diagnostics = attachmentDiagnostics(); let calls = 0, finish;
  const pendingPage = {evaluate() { calls++; return new Promise(resolve => { finish = resolve; }); }};
  const value = await sampleThreadFiles(pendingPage, origin, 5, new AbortController().signal);
  diagnostics.application(value);
  const frozen = diagnostics.snapshot();
  assert.equal(frozen.application.notice, 'unavailable'); assert.equal(calls, 1);
  finish({notice: 'offered', verify_button: 'enabled'}); await Promise.resolve();
  assert.deepEqual(diagnostics.snapshot(), frozen);
  const controller = new AbortController(); controller.abort();
  await sampleThreadFiles(pendingPage, origin, 10, controller.signal);
  await sampleThreadFiles(pendingPage, origin, 0);
  assert.equal(calls, 1);
  assert.deepEqual(await sampleThreadFiles(page('File request refused', {disabled: true}), origin, 100),
    {notice: 'request_refused', verify_button: 'disabled'});
});

test('real attachment caller keeps its one-shot sequence and exposes the failed download boundary', async () => {
  const diagnostics = attachmentDiagnostics(), actions = [];
  const refusal = Object.assign(new Error('recorder refused'), {code: 'revoked'});
  const page = {
    async waitForSelector() {}, async waitForFunction() {},
    async evaluate(_fn, label) { if (label) actions.push(label); },
    async $eval(_selector, _fn, input) { actions.push('upload'); assert.equal(input.bytes.length, 10); },
    async reload() { actions.push('reload'); return {url: () => origin}; }, url: () => origin,
  };
  const adapter = {
    async beginDownloads() { actions.push('arm'); return {run: 'owned'}; },
    async dispatch(method, params) {
      actions.push(method); assert.deepEqual(params, {run: 'owned', timeoutMs: 0}); throw refusal;
    },
  };
  await assert.rejects(attachmentRoundtrip({page, adapter, verifyLease: async () => true, origin,
    signal: new AbortController().signal, diagnostics}), error => error === refusal);
  assert.deepEqual(actions, ['upload', 'Save file copy', 'reload', 'Open saved copy: synthetic-copy.bin',
    'arm', 'Verify and download', 'awaitDownload']);
  assert.equal(diagnostics.snapshot().step, 'download_poll');
});
