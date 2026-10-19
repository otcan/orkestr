import assert from 'node:assert/strict';
import {executionStatus} from './execution-evidence.mjs';
import {failure} from './diagnostics.mjs';

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const live = status => ['running', 'awaiting_acceptance'].includes(status.phase);

async function rendered(page, origin) {
  return page.evaluate(({origin}) => {
    if (location.origin !== origin) throw Error('unexpected_origin');
    const nodes = [...document.querySelectorAll(
      'section[aria-label="Execution and resources"] section[aria-label="Provider output"] pre')];
    if (nodes.length > 1) throw Error('invalid_sample');
    if (!nodes.length) return null;
    const node = nodes[0], text = node.textContent;
    if (typeof text !== 'string' || text.length > 32768) throw Error('request_budget');
    return {conversation_id: node.getAttribute('data-conversation-id'),
      run_id: node.getAttribute('data-run-id'), payload_id: node.getAttribute('data-payload-id'), text};
  }, {origin});
}

function scoped(value, conversation, run) {
  assert.equal(value.conversation_id, conversation, 'rendered_conversation_changed');
  assert.equal(value.run_id, run, 'rendered_run_changed');
  assert(typeof value.payload_id === 'string' && UUID.test(value.payload_id) &&
    value.payload_id !== '00000000-0000-0000-0000-000000000000', 'rendered_payload_id_required');
  assert(typeof value.text === 'string' && Buffer.byteLength(value.text) > 0 &&
    Buffer.byteLength(value.text) <= 32768, 'actual_rendered_text_required');
}

// The UI samples status independently. Its immutable rendered payload may be
// older than the latest progress pointer; both still belong to this exact run.
// DOM attributes are locators only: the ordinary owner read proves the payload.
export async function renderedProgress({page, origin, conversation, run, read, signal}) {
  const status = await read('execution', run);
  if (!status) return null;
  executionStatus(status, conversation, run);
  if (['failed', 'blocked', 'cancelled', 'completed'].includes(status.phase)) throw failure('not_completed');
  if (!live(status) || !status.progress) return null;
  signal.throwIfAborted();
  const first = await rendered(page, origin);
  signal.throwIfAborted();
  if (!first) return null;
  scoped(first, conversation, run);
  const payload = await read('payload', first.payload_id);
  assert.equal(payload.conversation_id, conversation);
  assert.equal(payload.run_id, run);
  assert.equal(payload.payload_id, first.payload_id);
  assert(typeof payload.text === 'string' && Buffer.byteLength(payload.text) > 0 &&
    Buffer.byteLength(payload.text) <= 32768, 'actual_text_payload_required');
  assert.equal(payload.text, first.text, 'rendered_payload_bytes_changed');
  signal.throwIfAborted();
  const current = executionStatus(await read('execution', run), conversation, run);
  if (!live(current) || !current.progress) throw failure('not_completed');
  signal.throwIfAborted();
  const last = await rendered(page, origin);
  signal.throwIfAborted();
  if (!last) return null;
  scoped(last, conversation, run);
  if (last.payload_id !== first.payload_id || last.text !== first.text) return null;
  return {status: current, proof: {committed_payload: true, exact_run_payload: true, visible_text: true,
    rendered_immutable_payload: true, latest_progress_pointer_may_advance: true}};
}
