import test from 'node:test';
import assert from 'node:assert/strict';
import {streamFixture, RUN, FOREIGN} from './rendered-progress-fixture.mjs';
import {errorChain, failure} from './diagnostics.mjs';

test('rendered immutable progress remains provable with 2s UI sampling and 35Hz canonical updates', async () => {
  const fixture = streamFixture();
  try {
    const result = await fixture.controls.progress(RUN);
    assert.deepEqual(result.proof, {committed_payload: true, exact_run_payload: true, visible_text: true,
      rendered_immutable_payload: true, latest_progress_pointer_may_advance: true});
    assert(fixture.snapshots.length > 0);
    assert(fixture.snapshots.every(row => row.canonical > row.displayed));
    const payload = fixture.calls.find(row => row.kind === 'payload');
    assert.equal(Number(payload.selector.slice(-12)), fixture.snapshots[0].displayed);
    assert.notEqual(result.status.progress.payload_id, payload.selector, 'latest status must not be rewritten');
    assert.deepEqual(fixture.controls.counts(), {messages: 0, stop: 0, acceptance: 0, steering: 0});
  } finally { fixture.controller.abort(); }
});

test('revocation or owner payload refusal cannot produce proof or retry a read', async () => {
  for (const options of [{revokeAtPayload: true}, {payloadRefused: true}]) {
    const fixture = streamFixture(options);
    try {
      await assert.rejects(fixture.controls.progress(RUN));
      assert.equal(fixture.calls.filter(row => row.kind === 'payload').length, 1);
      assert.equal(fixture.calls.filter(row => row.kind === 'execution').length, 1);
      assert.deepEqual(fixture.controls.counts(), {messages: 0, stop: 0, acceptance: 0, steering: 0});
    } finally { fixture.controller.abort(); }
  }
});

test('foreign or malformed rendered locators refuse before any payload lookup', async () => {
  for (const options of [{domConversation: FOREIGN}, {domRun: FOREIGN}, {domPayload: 'invalid'},
    {domPayload: '00000000-0000-0000-0000-000000000000'}, {duplicate: true}]) {
    const fixture = streamFixture(options);
    try {
      await assert.rejects(fixture.controls.progress(RUN));
      assert.equal(fixture.calls.filter(row => row.kind === 'payload').length, 0);
    } finally { fixture.controller.abort(); }
  }
});

test('canonical payload scope, exact text and nonremoved content remain mandatory', async () => {
  for (const options of [{payloadConversation: FOREIGN}, {payloadRun: FOREIGN},
    {payloadId: FOREIGN}, {removed: true}, {payloadText: 'unrelated text'}, {domText: ''}]) {
    const fixture = streamFixture(options);
    try { await assert.rejects(fixture.controls.progress(RUN)); }
    finally { fixture.controller.abort(); }
  }
});

test('cross-origin display and a changed or terminal current run refuse progress proof', async () => {
  for (const options of [{pageOrigin: 'https://foreign.invalid'}, {changedRun: true}, {terminal: true}]) {
    const fixture = streamFixture(options);
    try { await assert.rejects(fixture.controls.progress(RUN)); }
    finally { fixture.controller.abort(); }
  }
});

test('missing rendered output stays pending and aborts without fetching or mutating', async () => {
  const fixture = streamFixture({missing: true});
  const timer = setTimeout(() => fixture.controller.abort(), 20);
  try {
    await assert.rejects(fixture.controls.progress(RUN));
    assert.equal(fixture.calls.filter(row => row.kind === 'payload').length, 0);
    assert.deepEqual(fixture.controls.counts(), {messages: 0, stop: 0, acceptance: 0, steering: 0});
  } finally { clearTimeout(timer); fixture.controller.abort(); }
});

test('phase and progress timeout diagnostics remain closed and distinguishable', () => {
  for (const code of ['phase_timeout', 'progress_timeout']) {
    assert.deepEqual(errorChain(failure(code)).nodes, [{parent: null, relation: 'root', name: 'Error', code}]);
  }
  assert.throws(() => failure('arbitrary-provider-text'));
});
