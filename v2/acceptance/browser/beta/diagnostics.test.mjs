import {test} from 'node:test';
import assert from 'node:assert/strict';
import {errorChain, failure} from './diagnostics.mjs';

test('closed error projection preserves structure without arbitrary text or IDs', () => {
  const secret = 'synthetic-secret-that-must-not-appear';
  const error = new AggregateError([new Error(secret), failure('timeout')], secret,
    {cause: Object.assign(new TypeError(secret), {code: secret})});
  const receipt = errorChain(error);
  assert.equal(receipt.nodes.length, 4);
  assert.deepEqual(receipt.nodes.map(item => item.parent), [null, 0, 0, 0]);
  assert.deepEqual(receipt.nodes.map(item => item.code), ['unknown', 'unknown', 'timeout', 'unknown']);
  assert(!JSON.stringify(receipt).includes(secret));
});

test('diagnostic getters are never invoked; cyclic and oversized chains are bounded', () => {
  let reads = 0;
  const error = {get message() { reads++; throw Error('secret'); }, cause: null};
  error.cause = error;
  assert.equal(errorChain(error).truncated, true);
  assert.equal(reads, 0);
  const huge = errorChain(new AggregateError(Array.from({length: 100}, () => Error('private'))));
  assert.equal(huge.truncated, true);
  assert(huge.nodes.length <= 16);
  assert.throws(() => failure('arbitrary-private-string'), RangeError);
});
