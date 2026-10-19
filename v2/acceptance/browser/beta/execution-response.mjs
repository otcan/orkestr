import assert from 'node:assert/strict';
import {decodeExact} from './window-evidence.mjs';

// This runner submits fresh, one-shot UI actions. The primary HTTP contracts
// distinguish new intake (202) and admission (201) from duplicate replay (200).
// A replay must not count as this fixture's new input or window admission.
const FRESH_STATUS = Object.freeze({messages: 202, window: 201, stop: 200, steer: 200, accept: 200});

export function freshControlResponse(operation, observed) {
  assert(Object.hasOwn(FRESH_STATUS, operation), 'unknown_control_operation');
  assert.equal(observed.status, FRESH_STATUS[operation], 'control_response_not_successful');
  return {request: decodeExact(observed.request), receipt: decodeExact(observed.response)};
}
