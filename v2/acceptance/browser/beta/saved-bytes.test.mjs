import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {savedBytes} from './saved-bytes.mjs';

const expected = Buffer.from([0, 255, 128, 1, 13, 10, 65, 66, 0, 99]);
function fixture({wrongBytes = false, missingDelete = false, wrongCompletion = false} = {}) {
  const events = [], completionReceipt = {run: 'synthetic-run', context: 'synthetic-owned-context'};
  return {events, adapter: {
    async beginDownloads() { events.push('armed'); return {run: 'synthetic-run'}; },
    async dispatch(operation) {
      events.push(operation);
      if (operation === 'awaitDownload') return {run: 'synthetic-run', filename: 'synthetic-copy.bin',
        download: 'synthetic-download', byteLength: expected.length, contextEpoch: 'synthetic-epoch',
        sha256: createHash('sha256').update(expected).digest('hex'), completionReceipt};
      if (operation === 'readDownload') return {bytes: wrongBytes ? Buffer.alloc(expected.length) : Buffer.from(expected),
        completionReceipt: wrongCompletion ? {run: 'foreign-run'} : completionReceipt};
      if (operation === 'deleteDownload') return {deleted: true, absenceConfirmed: !missingDelete,
        deletionReceipt: {...completionReceipt, deletionId: 'synthetic-deletion'}};
      throw Error('unexpected operation');
    },
  }};
}

test('binary comparison requires actual read and exact deletion after recorder precedes click', async () => {
  const {adapter, events} = fixture();
  const proof = await savedBytes({adapter, expected, filename: 'synthetic-copy.bin',
    click: async () => events.push('click')});
  assert.deepEqual(proof.bytes, expected);
  assert.deepEqual(events, ['armed', 'click', 'awaitDownload', 'readDownload', 'deleteDownload']);
});

test('wrong downloaded bytes or completion binding fail while still deleting the exact owned copy', async () => {
  for (const options of [{wrongBytes: true}, {wrongCompletion: true}]) {
    const {adapter, events} = fixture(options);
    await assert.rejects(savedBytes({adapter, expected, filename: 'synthetic-copy.bin', click: async () => {}}));
    assert.equal(events.at(-1), 'deleteDownload');
  }
});

test('successful download without proved deletion absence is not an attachment pass', async () => {
  const {adapter} = fixture({missingDelete: true});
  await assert.rejects(savedBytes({adapter, expected, filename: 'synthetic-copy.bin', click: async () => {}}));
});
