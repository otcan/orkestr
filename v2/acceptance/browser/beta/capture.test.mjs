import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {captureControls} from './capture.mjs';

const CONVERSATION = '00000000-0000-4000-8000-000000000001';
const base = `https://example.invalid/api/v2/conversations/${CONVERSATION}`;
const event = (url, body = '{"accepted":true}') => ({url: () => url, status: () => 200,
  request: () => ({method: () => 'POST', postData: () => '{"request_key":"synthetic"}'}), text: async () => body});

test('only the selected conversation control receipts are captured, never login or foreign scope', async () => {
  const page = new EventEmitter(), capture = captureControls(page, 'https://example.invalid', CONVERSATION);
  page.emit('response', event('https://example.invalid/api/v2/browser/session', 'private'));
  page.emit('response', event(base.replace(CONVERSATION, '00000000-0000-4000-8000-000000000002') + '/stop', 'foreign'));
  page.emit('response', event(base + '/window'));
  assert.equal(await capture.close(), true);
  assert.deepEqual(capture.take('window'), {operation: 'window', status: 200,
    request: '{"request_key":"synthetic"}', response: '{"accepted":true}'});
  assert.equal(capture.take('stop'), null);
  assert.equal(page.listenerCount('response'), 0);
});

test('body read failures are joined and prevent a successful capture receipt', async () => {
  const page = new EventEmitter(), capture = captureControls(page, 'https://example.invalid', CONVERSATION);
  const response = event(base + '/stop'); response.text = async () => { throw Error('failed read'); };
  page.emit('response', response);
  await assert.rejects(capture.close());
  assert.throws(() => capture.take('stop'));
});

test('the control budget cannot be reset by draining the local receipt queue', async () => {
  const page = new EventEmitter(), capture = captureControls(page, 'https://example.invalid', CONVERSATION);
  for (let index = 0; index < 33; index++) page.emit('response', event(base + '/window'));
  await assert.rejects(capture.close(), {code: 'request_budget'});
});
