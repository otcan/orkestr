import {test} from 'node:test';
import assert from 'node:assert/strict';
import {acceptedPayload} from '../src/accepted_payload_request.mjs';
const id = '00000000-0000-4000-8000-000000000001';
const input = {conversation: id, payload: id};
test('fixed protected route and raw response preserve integer bytes', async () => {
    const raw = '{"revision":18446744073709551615}';
    const result = await acceptedPayload(input, async (path, options) => {
        assert.equal(path, `/api/v2/conversations/${id}/payloads/${id}`);
        assert.equal(options.credentials, 'same-origin');
        assert.equal(options.redirect, 'error');
        return new Response(raw);
    });
    assert.equal(result.text, raw);
});
test('refusal cancels body without publishing bytes', async () => {
    let cancelled = false;
    const result = await acceptedPayload(input, async () => ({status: 404, body: {cancel: async () => {cancelled = true;}}}));
    assert.deepEqual(result, {status: 404, text: ''});
    assert.equal(cancelled, true);
});
test('empty-chunk flood is bounded and cancelled', async () => {
    let reads = 0, cancelled = false;
    await assert.rejects(acceptedPayload(input, async () => ({status: 200, body: {getReader: () => ({
        read: async () => {reads++; return {done: false, value: new Uint8Array()};},
        cancel: async () => {cancelled = true;},
    })}})), /read limit/);
    assert.equal(reads, 4096);
    assert.equal(cancelled, true);
});
test('oversize and invalid UTF-8 refuse', async () => {
    await assert.rejects(acceptedPayload(input, async () => new Response(new Uint8Array(1048577))), /exceeds/);
    await assert.rejects(acceptedPayload(input, async () => new Response(new Uint8Array([255]))));
});
test('invalid route identity performs no request', async () => {
    await assert.rejects(acceptedPayload({...input, payload: '../other'}, () => {throw new Error('fetch called');}), /identity/);
});
