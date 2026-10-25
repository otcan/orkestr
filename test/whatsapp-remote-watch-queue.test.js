import test from 'node:test';
import assert from 'node:assert/strict';
import {startScopedRemoteWatch} from '../packages/connectors/src/whatsapp-scoped-remote-watch.js';

const until = async predicate => {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('watch queue deadline');
    await new Promise(resolve => setImmediate(resolve));
  }
};

test('blocked initial snapshot imports cannot consume capacity for a fresh export', async () => {
  const delivered = [], syncing = [];
  let notify, initial = true;
  const api = async (url, options) => {
    if (url.endsWith('/watches')) return {version: 2, backends: ['backend']};
    if (url.includes('/changes?')) {
      if (initial) {initial = false; return {cursor: 'epoch:1', reset: true, threadIds: Array.from({length: 10}, (_, i) => `slow-${i}`)};}
      return new Promise((_resolve, reject) => {
        notify = () => _resolve({cursor: 'epoch:2', reset: false, threadIds: ['fast']});
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), {once: true});
      });
    }
    const id = new URL(url, 'http://v1.test').searchParams.get('thread');
    syncing.push(id);
    if (id === 'fast') return {ok: true, threadId: id};
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), {once: true}));
  };
  const watch = startScopedRemoteWatch({api, deliver: async ids => delivered.push(...ids)});
  try {
    await until(() => syncing.length === 2 && notify);
    notify();
    await until(() => delivered.includes('fast'));
    assert.equal(syncing.filter(id => id.startsWith('slow-')).length, 2);
    assert.deepEqual(delivered, ['fast']);
  } finally {await watch.close();}
});

test('a change while its thread is importing coalesces into a second read without concurrent duplicates', async () => {
  let version = 0, notify, finish, reads = 0, concurrent = 0, maximum = 0, delivered = 0;
  const api = async (url, options) => {
    if (url.endsWith('/watches')) return {version: 2, backends: ['backend']};
    if (url.includes('/changes?')) return new Promise((resolve, reject) => {
      notify = () => resolve({cursor: 'epoch:' + ++version, threadIds: ['same']});
      options.signal.addEventListener('abort', () => reject(new Error('aborted')), {once: true});
    });
    reads++; concurrent++; maximum = Math.max(maximum, concurrent);
    if (reads === 1) await new Promise(resolve => {finish = resolve;});
    concurrent--; return {ok: true, threadId: 'same'};
  };
  const watch = startScopedRemoteWatch({api, deliver: async () => {delivered++;}});
  try {
    await until(() => notify); notify(); await until(() => finish && version === 1);
    notify(); await until(() => version === 2); finish();
    await until(() => delivered === 2);
    assert.equal(reads, 2); assert.equal(maximum, 1);
  } finally {await watch.close();}
});

test('older V1 gateways keep the original cursor-after-delivery recovery contract', async () => {
  let attempts = 0;
  const cursors = [];
  const api = async (url, options) => {
    if (url.endsWith('/watches')) return {backends: ['legacy']};
    assert.equal(url.includes('signalOnly'), false);
    const cursor = new URL(url, 'http://v1.test').searchParams.get('cursor'); cursors.push(cursor);
    if (!cursor) return {cursor: 'next', threadIds: ['thread']};
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), {once: true}));
  };
  const watch = startScopedRemoteWatch({api, deliver: async () => {if (++attempts === 1) throw new Error('retry');}});
  try {
    await until(() => attempts === 2);
    assert.deepEqual(cursors.slice(0, 2), ['', '']);
  } finally {await watch.close();}
});
