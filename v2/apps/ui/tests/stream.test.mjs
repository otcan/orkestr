import {readFile} from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
const code = await readFile(new URL('../src/stream.js', import.meta.url), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
async function run(chunks, status = 200) {
    const input = {path:'/api/v2/conversations/00000000-0000-4000-8000-000000000003/events',cursor:7};
    let cancelled = false;
    const response = new Response(new ReadableStream({
        start(controller) { for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk)); },
        cancel() { cancelled = true; }
    }), {status,headers:{'Content-Type':'text/event-stream'}});
    const fetch = async (path, options) => {
        assert.equal(path, input.path);
        assert.equal(options.headers.Authorization, undefined);
        assert.equal(options.headers['Last-Event-ID'], '7');
        assert.equal(options.credentials, 'same-origin');
        return response;
    };
    const result = await new AsyncFunction('dioxus','fetch',code)({recv:async()=>input},fetch);
    return {result,cancelled};
}
test('split CRLF frames/comments parse and cancel after first event', async () => {
    const {result,cancelled} = await run([': keepalive\r\n\r\n','id: 8\r\nevent: message_accepted\r\ndata: {"sequence":','8}\r\n\r\n']);
    assert.deepEqual(result,{status:200,event:'message_accepted',id:'8',body:{sequence:8}});
    assert.equal(cancelled,true);
});
test('session expiry does not masquerade as empty message',async()=>{
    assert.equal((await run(['event: session_expired\ndata: {}\n\n'])).result.event,'session_expired');
});
test('resync and HTTP expiry are explicit',async()=>{
    assert.equal((await run(['event: resync_required\ndata: {}\n\n'])).result.event,'resync_required');
    assert.equal((await run([],401)).result.status,401);
});
test('oversized incomplete SSE is rejected',async()=>{
    await assert.rejects(run(['data: '+ 'x'.repeat(65537)]),/exceeds client limit/);
});


test('coalesced small backlog frames do not trip the individual frame limit',async()=>{
    const frame = 'id: 8\nevent: message_accepted\ndata: {"sequence":8}\n\n';
    const {result,cancelled} = await run([frame.repeat(2000)]);
    assert.equal(result.id,'8');
    assert.equal(result.body.sequence,8);
    assert.equal(cancelled,true);
});

test('oversized complete frame remains rejected',async()=>{
    await assert.rejects(run(['data: '+ 'x'.repeat(65537)+'\n\n']),/exceeds client limit/);
});

test('unknown event variants require resync without exposing an unvalidated body',async()=>{
    const {result,cancelled} = await run(['id: 8\nevent: future_runtime_success\ndata: {"text":"must not render"}\n\n']);
    assert.deepEqual(result,{status:200,event:'resync_required'});
    assert.equal(cancelled,true);
});

test('malformed known event JSON requires resync rather than repeat decoding',async()=>{
    const {result,cancelled} = await run(['id: 8\nevent: message_accepted\ndata: {broken\n\n']);
    assert.deepEqual(result,{status:200,event:'resync_required'});
    assert.equal(cancelled,true);
});

test('canonical metadata fixture and legacy intake retain distinct SSE names and bodies',async()=>{
    for (const [name,file] of [['fixture_provider_observed','fixture-provider-observed.json'],['message_accepted','event.json']]) {
        const fixture = JSON.parse(await readFile(new URL('../../../fixtures/'+file,import.meta.url),'utf8'));
        const {result,cancelled} = await run([`id: ${fixture.sequence}\nevent: ${name}\ndata: ${JSON.stringify(fixture)}\n\n`]);
        assert.equal(result.event,name);
        assert.equal(result.id,String(fixture.sequence));
        assert.deepEqual(result.body,fixture);
        assert.equal(cancelled,true);
    }
});
