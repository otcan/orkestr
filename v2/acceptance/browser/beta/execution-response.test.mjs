import {test} from 'node:test';
import assert from 'node:assert/strict';
import contract from './fixtures/control-http-0756.json' with {type: 'json'};
import {freshControlResponse} from './execution-response.mjs';

// The fixture records each reviewed primary handler at the exact app revision,
// including its file hash; it is independent of the driver's status table.
test('each fresh mutation requires its primary route status, never a generic 2xx', () => {
  for (const [operation, route] of Object.entries(contract.operations)) {
    const observation = {request: '{"expected_revision":9007199254740991}',
      response: '{"revision":9007199254740992}', status: route.fresh_status};
    const decoded = freshControlResponse(operation, observation);
    assert.equal(decoded.request.expected_revision, 9007199254740991n);
    assert.equal(decoded.receipt.revision, 9007199254740992n);
    for (let status = 100; status <= 599; status++) {
      if (status === route.fresh_status) continue;
      assert.throws(() => freshControlResponse(operation, {...observation, status}),
        /control_response_not_successful/, `${operation} must refuse ${status}`);
    }
    for (const status of [undefined, null, String(route.fresh_status), NaN]) {
      assert.throws(() => freshControlResponse(operation, {...observation, status}), /control_response_not_successful/);
    }
  }
});

test('unsupported operations and malformed successful bodies remain refused', () => {
  assert.throws(() => freshControlResponse('unknown', {status: 200}), /unknown_control_operation/);
  for (const [operation, {fresh_status: status}] of Object.entries(contract.operations)) {
    for (const body of ['request', 'response']) {
      assert.throws(() => freshControlResponse(operation,
        {status, request: '{}', response: '{}', [body]: '{'}), SyntaxError);
    }
  }
});
