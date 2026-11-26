// The page-wide live channel client (src/live_channel.js) against a scripted
// server: pushed changes end waits, matching ETags need no refetch, a stalled
// channel falls back to the slow poll and reconnects over the other
// transport, and a server without the channel keeps the old intervals.
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

const code = await readFile(new URL('../src/live_channel.js', import.meta.url), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
const install = new AsyncFunction('dioxus', 'globalThis', code);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const SIDEBAR = '/api/v2/sidebar?include_hidden=true';
const STATUS = '/api/v2/conversations/00000000-0000-4000-8000-000000000001/execution';

async function until(check, what, ms = 3000) {
    const deadline = Date.now() + ms;
    while (!check()) {
        assert.ok(Date.now() < deadline, what);
        await sleep(5);
    }
}

// A scripted page: WebSocket and event-stream servers the test drives.
function page({websocket = true, events = 'stream', tuning = {}} = {}) {
    const sockets = [], streams = [], reads = [];
    const listeners = {};
    class FakeWebSocket {
        constructor(url) {
            this.url = new URL(url);
            this.sent = [];
            sockets.push(this);
            if (websocket === 'refuse') queueMicrotask(() => this.onclose?.());
        }
        send(text) { this.sent.push(JSON.parse(text)); }
        close() { this.closed = true; }
        push(frame) { this.onmessage?.({data: JSON.stringify(frame)}); }
    }
    const g = {
        WebSocket: websocket ? FakeWebSocket : undefined,
        location: {protocol: 'https:', host: 'app.invalid', origin: 'https://app.invalid', href: 'https://app.invalid/'},
        document: {documentElement: {dataset: {}}, visibilityState: 'visible', addEventListener() {}},
        addEventListener: (type, f) => (listeners[type] ??= []).push(f),
        orkestrLiveTuning: {stallMs: 150, helloMs: 150, fallbackMs: 250, maxWaitMs: 2000, graceMs: 0, syncMs: 0, sseSyncMs: 0, backoffScale: 0.01, offRetryMs: 60000, ...tuning},
        fetch: async (input, init = {}) => {
            const url = new URL(input, 'https://app.invalid/');
            if (url.pathname === '/api/v2/live/events') {
                if (events === 'missing') return new Response('{}', {status: 404});
                let control;
                const body = new ReadableStream({start(c) { control = c; }});
                const stream = {url, frames: [], push(frame) { control.enqueue(new TextEncoder().encode(`event: ${frame.t}\ndata: ${JSON.stringify(frame)}\n\n`)); }};
                streams.push(stream);
                init.signal?.addEventListener('abort', () => { try { control.error(new Error('aborted')); } catch {} });
                queueMicrotask(() => control.enqueue(new TextEncoder().encode(`: ${' '.repeat(2048)}\n\n`)));
                return new Response(body, {status: 200, headers: {'content-type': 'text/event-stream'}});
            }
            reads.push(url.pathname + url.search);
            return new Response('{}', {status: 200, headers: {'content-type': 'application/json', etag: g.etag ?? 'W/"a"'}});
        },
    };
    const hello = transport => ({t: 'hello', v: 1, channel: 'c', transport, heartbeat_ms: 12000, max_paths: 32});
    return {g, sockets, streams, reads, hello, fire: type => (listeners[type] ?? []).forEach(f => f())};
}

test('pushed changes end waits; an ETag the page already holds needs no refetch', async () => {
    const p = page();
    await install(null, p.g);
    const live = p.g.orkestrLive;
    live.start();
    assert.equal(p.sockets.length, 1);
    assert.equal(p.sockets[0].url.href, 'wss://app.invalid/api/v2/live?');
    p.sockets[0].push(p.hello('websocket'));
    assert.equal(live.status().state, 'live');
    assert.equal(p.g.document.documentElement.dataset.live, 'live');

    // The page's own read is observed, then the poller waits.
    await p.g.fetch(SIDEBAR);
    const waiting = live.wait(SIDEBAR, null, 4000);
    await until(() => p.sockets[0].sent.length, 'watch frame');
    assert.deepEqual(p.sockets[0].sent[0], {t: 'watch', add: [SIDEBAR], remove: []});
    // The server's first fingerprint equals the page's ETag: nothing to do.
    p.sockets[0].push({t: 'watching', paths: [{path: SIDEBAR, fp: 'W/"a"'}], recent: true});
    assert.equal(live.current(SIDEBAR), true);
    let settled = false;
    waiting.then(() => { settled = true; });
    await sleep(30);
    assert.equal(settled, false, 'no refetch for an unchanged answer');
    p.sockets[0].push({t: 'changed', paths: [{path: SIDEBAR, fp: 'W/"b"'}]});
    const woke = await waiting;
    assert.equal(woke.reason, 'changed');
    assert.equal(woke.live, true);
    // A change during the next read ends the following wait at once.
    p.sockets[0].push({t: 'changed', paths: [{path: SIDEBAR, fp: 'W/"c"'}]});
    assert.equal((await live.wait(SIDEBAR, woke.version, 4000)).reason, 'changed');
    // A fingerprint that the page's newest read already returned is skipped.
    p.g.etag = 'W/"d"';
    await p.g.fetch(SIDEBAR);
    const again = live.wait(SIDEBAR, live.version(SIDEBAR), 4000);
    p.sockets[0].push({t: 'changed', paths: [{path: SIDEBAR, fp: 'W/"d"'}]});
    let done = false;
    again.then(() => { done = true; });
    await sleep(30);
    assert.equal(done, false);
    // Retry (the connection bar) refreshes every waiting reader.
    p.fire('orkestr-stream-retry');
    assert.equal((await again).reason, 'retry');
});

test('a first fingerprint that differs from the page read, or a recent change, refetches once', async () => {
    const p = page();
    await install(null, p.g);
    const live = p.g.orkestrLive;
    live.start();
    p.sockets[0].push(p.hello('websocket'));
    await p.g.fetch(SIDEBAR);
    const exact = live.wait(SIDEBAR, null, 4000);
    p.sockets[0].push({t: 'watching', paths: [{path: SIDEBAR, fp: 'W/"newer"'}], recent: false});
    assert.equal((await exact).reason, 'changed');
    // Without an ETag to compare (read-time samples left out), `recent` decides.
    const quiet = live.wait(STATUS, null, 2000);
    p.sockets[0].push({t: 'watching', paths: [{path: STATUS, fp: '~0a'}], recent: false});
    let ended = false;
    quiet.then(() => { ended = true; });
    await sleep(30);
    assert.equal(ended, false);
    p.sockets[0].push({t: 'changed', paths: [{path: STATUS, fp: '~0b'}]});
    assert.equal((await quiet).reason, 'changed');
    const other = '/api/v2/conversations/00000000-0000-4000-8000-000000000001/posts?limit=50';
    const recent = live.wait(other, null, 3000);
    p.sockets[0].push({t: 'watching', paths: [{path: other, fp: '~0c'}], recent: true});
    assert.equal((await recent).reason, 'changed');
});

test('a stalled channel falls back to the slow poll, reconnects over SSE and catches up', async () => {
    const p = page({tuning: {helloMs: 3000}});
    await install(null, p.g);
    const live = p.g.orkestrLive;
    live.start();
    p.sockets[0].push(p.hello('websocket'));
    await p.g.fetch(STATUS);
    const started = Date.now();
    const waiting = live.wait(STATUS, null, 100);
    p.sockets[0].push({t: 'watching', paths: [{path: STATUS, fp: 'W/"a"'}], recent: false});
    // No heartbeat any more: the watchdog closes the socket and polls slowly.
    await until(() => live.status().state === 'degraded', 'stall detected', 2000);
    assert.equal(p.sockets[0].closed, true);
    const woke = await waiting;
    assert.equal(woke.reason, 'fallback');
    assert.ok(Date.now() - started >= 250, 'the fallback is the slow interval, not the poller\'s 100 ms');
    // It reconnects over the event stream, reporting what happened.
    await until(() => p.streams.length === 1, 'event stream opened');
    const query = p.streams[0].url.searchParams;
    assert.deepEqual(query.getAll('w'), [STATUS]);
    assert.equal(query.get('resume'), '1');
    assert.equal(query.get('reconnects'), '1');
    // The poller read again on the fallback timer; after the reconnect a
    // changed answer is caught up once, an unchanged one is not.
    await p.g.fetch(STATUS);
    const next = live.wait(STATUS, woke.version, 100);
    p.streams[0].push(p.hello('sse'));
    await until(() => live.status().state === 'live', 'live over SSE');
    assert.equal(live.status().transport, 'sse');
    // Healthy again: the fallback wait ends without a read...
    const recovered = await next;
    assert.equal(recovered.reason, 'recovered');
    // ...and what changed during the outage is read once.
    const after = live.wait(STATUS, recovered.version, 100);
    p.streams[0].push({t: 'watching', paths: [{path: STATUS, fp: 'W/"moved"'}], recent: false});
    const caught = await after;
    assert.equal(caught.reason, 'changed');
    // A new path on an event stream reopens it with the new watch set.
    live.wait(STATUS, caught.version, 100);
    live.wait(SIDEBAR, null, 100);
    await until(() => p.streams.length === 2, 'event stream reopened');
    assert.deepEqual(p.streams[1].url.searchParams.getAll('w').sort(), [SIDEBAR, STATUS].sort());
    assert.equal(p.streams[1].url.searchParams.get('resume'), null, 'a new watch set is not a reconnect');
    // The fallback poll made while the channel was down is reported.
    assert.equal(p.streams[1].url.searchParams.get('fallback_polls'), '1');
});

test('a server without the channel keeps the previous poll intervals', async () => {
    const p = page({websocket: 'refuse', events: 'missing'});
    await install(null, p.g);
    const live = p.g.orkestrLive;
    live.start();
    await until(() => live.status().state === 'off', 'unsupported', 2000);
    assert.equal(p.g.document.documentElement.dataset.live, 'off');
    const started = Date.now();
    const woke = await live.wait(SIDEBAR, null, 120);
    assert.equal(woke.reason, 'legacy');
    assert.ok(Date.now() - started >= 100 && Date.now() - started < 240);
    assert.equal(woke.live, false);
});

test('refused paths poll on their own interval; aborted and invalid waits end', async () => {
    const p = page();
    await install(null, p.g);
    const live = p.g.orkestrLive;
    live.start();
    p.sockets[0].push(p.hello('websocket'));
    const odd = '/api/v2/conversations/00000000-0000-4000-8000-000000000001/tracker';
    const refused = live.wait(odd, null, 120);
    p.sockets[0].push({t: 'refused', path: odd, reason: 'not_watchable'});
    assert.equal((await refused).reason, 'legacy');
    const stop = new AbortController();
    const aborted = live.wait(SIDEBAR, null, 4000, stop.signal);
    stop.abort();
    assert.equal((await aborted).reason, 'aborted');
    await assert.rejects(live.wait('https://elsewhere.invalid/api/v2/sidebar', null, 100), /Invalid live path/);
    // Bye after the lifetime: reconnect at once on the same transport.
    p.sockets[0].push({t: 'bye', reason: 'lifetime'});
    await until(() => p.sockets.length === 2, 'reconnected');
    assert.equal(p.sockets[1].url.searchParams.get('resume'), null);
});
