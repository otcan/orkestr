// Isolated qualification consumer. Adapter owns roots, context, GUID and sealing.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export async function savedBytes({adapter, click, expected, filename, timeoutMs=10000, step=()=>{}}) {
  assert(Buffer.isBuffer(expected) && expected.length <= 16777216);
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000);
  step('download_arm');
  const {run} = await adapter.beginDownloads({runLabel:'synthetic-attachment',maxBytes:expected.length});
  assert.equal(typeof run,'string');
  step('download_click');
  await click(); // begin must install destination + recorder BEFORE the actual click.
  const deadline = performance.now() + timeoutMs;
  step('download_poll');
  let completed;
  while (!completed) {
    try { completed = await adapter.dispatch('awaitDownload',{run,timeoutMs:0}); }
    catch(error) {
      if(error.code !== 'timeout' || performance.now() >= deadline) throw error;
      await new Promise(resolve=>setTimeout(resolve,25));
    }
  }
  step('download_completion');
  assert.equal(completed.run,run);
  assert.equal(completed.filename,filename);
  assert.equal(completed.byteLength,expected.length);
  assert.equal(completed.sha256,sha(expected));
  assert.equal(typeof completed.contextEpoch,'string');
  const identity = {run,download:completed.download};
  step('download_read');
  const read = await adapter.dispatch('readDownload',identity);
  // Always attempt exact-owned deletion after a successful read, including mismatch.
  let deletion;
  try {
    step('download_compare');
    assert(Buffer.isBuffer(read.bytes));
    assert.deepEqual(read.completionReceipt,completed.completionReceipt);
    assert.equal(read.bytes.length,expected.length);
    assert.equal(sha(read.bytes),sha(expected));
    assert.deepEqual(read.bytes,expected);
  } finally {
    step('download_delete');
    deletion = await adapter.dispatch('deleteDownload',identity);
    assert.equal(deletion.deleted,true);
    assert.equal(deletion.absenceConfirmed,true);
    const {deletionId,...receipt}=deletion.deletionReceipt;
    assert.equal(typeof deletionId,'string');
    assert.deepEqual(receipt,completed.completionReceipt);
  }
  step('download_verified');
  return {bytes:Buffer.from(read.bytes),completion:completed.completionReceipt,deletion:deletion.deletionReceipt};
}
