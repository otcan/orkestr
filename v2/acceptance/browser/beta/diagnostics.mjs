// Closed metadata only. Never retain messages, stacks, URLs, identifiers or hashes
// of arbitrary error text in a beta acceptance receipt.
const NAMES = new Set(['Error', 'AggregateError', 'AssertionError', 'TypeError',
  'RangeError', 'TimeoutError', 'ProtocolError', 'TargetCloseError', 'AbortError']);
const CODES = new Set(['cleanup_unknown', 'invalid_timeout', 'revoked',
  'identity_changed', 'not_completed', 'timeout', 'interrupted', 'invalid_sample',
  'continuity_gap', 'continuity_identity_changed', 'continuity_unavailable',
  'readiness_unavailable', 'invalid_action', 'request_budget', 'unexpected_origin',
  'ERR_ASSERTION', 'ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ETIMEDOUT']);

function data(object, key) {
  try {
    for (let depth = 0; object && depth < 4; depth++, object = Object.getPrototypeOf(object)) {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor) return 'value' in descriptor ? descriptor.value : undefined;
    }
  } catch { /* Untrusted diagnostic objects do not acquire authority. */ }
}

export function failure(code) {
  if (!CODES.has(code)) throw new RangeError('invalid_action');
  return Object.assign(new Error(code), {code});
}

export function errorChain(error) {
  const nodes = [], seen = new Set();
  let truncated = false;
  function visit(value, parent, relation, depth) {
    if (nodes.length >= 16 || depth > 4 || (value && typeof value === 'object' && seen.has(value))) {
      truncated = true; return;
    }
    if (value && typeof value === 'object') seen.add(value);
    const name = data(value, 'name'), code = data(value, 'code'), message = data(value, 'message');
    const index = nodes.length;
    nodes.push({parent, relation, name: NAMES.has(name) ? name : 'unknown',
      code: CODES.has(code) ? code : CODES.has(message) ? message : 'unknown'});
    const errors = data(value, 'errors');
    if (Array.isArray(errors)) {
      if (errors.length > 8) truncated = true;
      for (let slot = 0; slot < Math.min(errors.length, 8); slot++) {
        const item = Object.getOwnPropertyDescriptor(errors, String(slot));
        if (item && 'value' in item) visit(item.value, index, 'aggregate', depth + 1);
      }
    }
    const cause = data(value, 'cause');
    if (cause !== undefined) visit(cause, index, 'cause', depth + 1);
  }
  visit(error, null, 'root', 0);
  return {version: 1, nodes, truncated};
}
