import assert from 'node:assert/strict';
import {executionUi} from './execution-ui.mjs';

export const CONVERSATION = '00000000-0000-4000-8000-000000000001';
export const RUN = '00000000-0000-4000-8000-000000000002';
export const FOREIGN = '00000000-0000-4000-8000-000000000003';
export const ORIGIN = 'https://example.invalid';
const payloadId = index => `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const text = index => `Synthetic committed progress ${index}`;

// Real executionUi, with the product's two-second display cadence and a
// continuously advancing 35 Hz canonical projection. No browser is started.
export function streamFixture(options = {}) {
  const started = performance.now(), controller = new AbortController();
  const calls = [], snapshots = [];
  let executionReads = 0;
  const sample = () => {
    const elapsed = performance.now() - started;
    return {canonical: 8 + Math.floor(elapsed * 35 / 1000),
      displayed: 1 + Math.floor(elapsed / 2000) * 70};
  };
  const page = {
    url: () => ORIGIN,
    async evaluate(callback, argument) {
      const value = sample(); snapshots.push(value);
      const attributes = {
        'data-conversation-id': options.domConversation ?? CONVERSATION,
        'data-run-id': options.domRun ?? RUN,
        'data-payload-id': options.domPayload ?? payloadId(value.displayed),
      };
      const node = {textContent: options.domText ?? text(value.displayed),
        getAttribute: name => attributes[name] ?? null};
      const priorDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
      const priorLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
      Object.defineProperty(globalThis, 'document', {configurable: true, value: {
        querySelectorAll(selector) {
          assert(selector.includes('Execution and resources') && selector.includes('Provider output'));
          return options.missing ? [] : options.duplicate ? [node, node] : [node];
        },
      }});
      Object.defineProperty(globalThis, 'location', {configurable: true,
        value: {origin: options.pageOrigin ?? ORIGIN}});
      try { return await callback(argument); }
      finally {
        if (priorDocument) Object.defineProperty(globalThis, 'document', priorDocument);
        else delete globalThis.document;
        if (priorLocation) Object.defineProperty(globalThis, 'location', priorLocation);
        else delete globalThis.location;
      }
    },
  };
  const read = async (kind, selector) => {
    calls.push({kind, selector});
    const value = sample();
    if (kind === 'execution') {
      assert.equal(selector, RUN); executionReads++;
      return {schema_version: 1, conversation_id: CONVERSATION,
        run_id: executionReads > 1 && options.changedRun ? FOREIGN : RUN,
        phase: executionReads > 1 && options.terminal ? 'completed' : 'running',
        revision: value.canonical, observed_at_ms: 200000 + value.canonical,
        control_revision: 1, capabilities: {stop: true, steer: true},
        progress: {payload_id: payloadId(value.canonical), observed_at_ms: 100000 + value.canonical}};
    }
    assert.equal(kind, 'payload');
    if (options.revokeAtPayload) controller.abort();
    if (options.payloadRefused) throw Error('owner_observation_unavailable');
    const index = Number(selector.slice(-12));
    return {conversation_id: options.payloadConversation ?? CONVERSATION,
      run_id: options.payloadRun ?? RUN, payload_id: options.payloadId ?? selector,
      text: options.removed ? null : options.payloadText ?? text(index)};
  };
  const controls = executionUi({page, origin: ORIGIN, conversation: CONVERSATION,
    read, capture: {take: () => assert.fail('progress must not consume controls')},
    signal: controller.signal, verifyLease: () => assert.fail('read-only progress cannot mutate')});
  return {controls, calls, snapshots, controller};
}
