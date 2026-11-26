// One push channel per tab (docs/v2/live-channel.md). Installed once per
// page as `globalThis.orkestrLive`; every poller waits on it instead of a
// timer. The server watches the exact GET paths the pollers read and says
// when an answer changed; a poller then reads again. While the channel is
// down, waits end on a slow fallback timer instead; against a server without
// the channel they end on each poller's previous interval.
//
//   orkestrLive.wait(path, since, legacyMs, signal) -> {reason, version, live}
//     reason: "changed" | "retry" | "fallback" | "legacy" | "timeout" | "aborted"
//             | "recovered" (the channel is healthy again; nothing to read)
//   orkestrLive.current(path)  the server is watching path on a healthy channel
//   orkestrLive.status()       {state, transport}
//   orkestrLive.start()        connect now (after sign-in)
//
// Same-origin only; the HttpOnly session cookie authenticates. No storage.
const g = globalThis;
if (!g.orkestrLive) g.orkestrLive = (() => {
    const tuning = g.orkestrLiveTuning && typeof g.orkestrLiveTuning === "object" ? g.orkestrLiveTuning : {};
    const ms = (name, fallback, min) => {
        const value = Number(tuning[name]);
        return Number.isFinite(value) && value >= min ? value : fallback;
    };
    const T = {
        stallMs: ms("stallMs", 30000, 50),      // no frame for 2.5 heartbeats
        helloMs: ms("helloMs", 10000, 50),
        fallbackMs: ms("fallbackMs", 30000, 50),
        maxWaitMs: ms("maxWaitMs", 120000, 50), // bounds a wait nobody listens to
        graceMs: ms("graceMs", 10000, 0),       // a path stays watched between reads
        syncMs: ms("syncMs", 50, 0),
        sseSyncMs: ms("sseSyncMs", 300, 0),     // batches event-stream reopens
        offRetryMs: ms("offRetryMs", 300000, 50),
        backoffMs: [1000, 2000, 4000, 8000, 16000, 32000, 60000].map(v => ms("backoffScale", 1, 0.001) * v),
    };
    const now = () => Date.now();
    const entries = new Map();
    let state = "connecting";
    let mode = typeof g.WebSocket === "function" ? "websocket" : "sse";
    let transport = null, connectedOnce = false, dropped = false, attempts = 0;
    let wsWorked = false, wsFailures = 0;
    let retryTimer = null, syncTimer = null, lastFrame = 0, unhealthySince = now();
    let sent = new Set();
    const counts = {fallback_polls: 0, reconnects: 0};

    const entry = path => {
        let e = entries.get(path);
        if (!e) {
            e = {refs: 0, version: 0, etag: null, inflight: 0, server: null, confirmed: null,
                 refused: false, waiters: new Set(), used: now()};
            entries.set(path, e);
            if (entries.size > 400) {
                for (const [key, old] of entries) {
                    if (entries.size <= 300) break;
                    if (old.refs === 0 && !old.waiters.size && !old.inflight) entries.delete(key);
                }
            }
        }
        e.used = now();
        return e;
    };
    const watched = () => [...entries].filter(([, e]) => e.refs > 0 && !e.refused).map(([path]) => path);
    const healthy = () => state === "live";
    const exact = fp => typeof fp === "string" && fp.startsWith('W/"');
    const bump = e => {
        e.version += 1;
        for (const w of [...e.waiters]) w.done("changed");
    };
    const current = path => {
        const e = entries.get(path);
        return !!(e && healthy() && transport && e.refs > 0 && !e.refused && e.confirmed === transport);
    };

    function schedule(e, w) {
        clearTimeout(w.timer);
        let at, reason;
        if (state === "off" || e.refused) {
            at = w.start + w.legacy; reason = "legacy";
        } else if (!healthy()) {
            at = Math.max(w.start, unhealthySince) + Math.max(T.fallbackMs, w.legacy); reason = "fallback";
        } else {
            at = w.start + T.maxWaitMs; reason = "timeout";
        }
        w.mode = reason;
        w.timer = setTimeout(() => w.done(reason), Math.max(0, at - now()));
    }
    const rescheduleAll = () => {
        for (const e of entries.values()) for (const w of e.waiters) schedule(e, w);
    };
    function setState(next) {
        if (state === next) return;
        if (state === "live") unhealthySince = now();
        state = next;
        try { if (g.document?.documentElement) g.document.documentElement.dataset.live = next; } catch {}
        // Waits on the fallback timer end: their readers may show the
        // channel as down. What changed meanwhile arrives as `watching`.
        if (next === "live") {
            for (const e of entries.values()) for (const w of [...e.waiters]) if (w.mode === "fallback") w.done("recovered");
        }
        rescheduleAll();
    }

    function wait(path, since, legacyMs, signal) {
        if (typeof path !== "string" || !path.startsWith("/api/v2/") || path.length > 2048) {
            return Promise.reject(new Error("Invalid live path"));
        }
        const e = entry(path);
        e.refs += 1;
        sync();
        return new Promise(resolve => {
            const w = {start: now(), legacy: Math.max(100, Number(legacyMs) || 0), timer: null};
            const abort = () => w.done("aborted");
            w.done = reason => {
                if (!e.waiters.delete(w)) return;
                clearTimeout(w.timer);
                signal?.removeEventListener?.("abort", abort);
                if (reason === "fallback") counts.fallback_polls += 1;
                // The path stays watched for the poller's next read.
                setTimeout(() => {
                    e.refs = Math.max(0, e.refs - 1);
                    if (!e.refs) sync();
                }, reason === "aborted" ? 0 : T.graceMs);
                resolve({reason, version: e.version, live: current(path)});
            };
            e.waiters.add(w);
            if (signal?.aborted) return abort();
            signal?.addEventListener?.("abort", abort);
            if (Number.isFinite(since) && e.version > since) return w.done("changed");
            schedule(e, w);
        });
    }

    // Records the ETag of the page's own same-origin API reads, so a pushed
    // fingerprint equal to what the page already holds needs no refetch.
    const realFetch = typeof g.fetch === "function" ? g.fetch.bind(g) : null;
    if (realFetch) g.fetch = function (input, init) {
        let key = null;
        try {
            const method = String(init?.method || (typeof input === "object" && input?.method) || "GET").toUpperCase();
            const url = new URL(typeof input === "string" ? input : String(input?.url ?? input), g.location.href);
            if (method === "GET" && url.origin === g.location.origin && url.pathname.startsWith("/api/v2/")
                && !url.pathname.startsWith("/api/v2/live")) key = url.pathname + url.search;
        } catch { key = null; }
        if (!key) return realFetch(input, init);
        const e = entry(key);
        const started = now();
        e.inflight += 1;
        const settle = tag => {
            e.inflight = Math.max(0, e.inflight - 1);
            if (tag === undefined) return;
            e.etag = tag;
            const s = e.server;
            // The server's first read may postdate this one: read once more.
            if (s && !s.used && exact(s.fp) && tag !== s.fp && started < s.at) { s.used = true; bump(e); }
        };
        return realFetch(input, init).then(response => {
            settle(response.status === 200 || response.status === 304 ? response.headers.get("etag") : null);
            return response;
        }, error => { settle(undefined); throw error; });
    };

    function observe(conn, path, fp, initial, recent) {
        const e = entries.get(path);
        if (!e) return;
        e.confirmed = conn;
        e.server = {fp, at: now(), used: !initial};
        if (e.etag === fp) return;
        if (!initial) return bump(e);
        if (e.inflight > 0) return;
        if ((exact(fp) && e.etag) || recent) bump(e);
    }

    function frame(conn, text) {
        if (conn !== transport) return;
        lastFrame = now();
        let f;
        try { f = JSON.parse(text); } catch { return; }
        if (!f || typeof f.t !== "string") return;
        if (f.t === "hello") {
            conn.hello = true;
            if (conn.mode === "websocket") { wsWorked = true; wsFailures = 0; }
            clearTimeout(conn.helloTimer);
            conn.catchup = dropped;
            dropped = false;
            attempts = 0;
            connectedOnce = true;
            setState("live");
            // The open request carried these counts to the server.
            counts.fallback_polls = Math.max(0, counts.fallback_polls - conn.reported.fallback_polls);
            counts.reconnects = Math.max(0, counts.reconnects - conn.reported.reconnects);
            sync();
        } else if (f.t === "watching" || f.t === "changed") {
            for (const item of Array.isArray(f.paths) ? f.paths : []) {
                if (item && typeof item.path === "string") {
                    observe(conn, item.path, String(item.fp), f.t === "watching", !!f.recent || conn.catchup);
                }
            }
        } else if (f.t === "refused") {
            const e = entries.get(f.path);
            if (e) { e.refused = true; for (const w of e.waiters) schedule(e, w); }
        } else if (f.t === "expired") {
            fail(conn, "expired");
        } else if (f.t === "bye") {
            fail(conn, f.reason === "shutdown" ? "shutdown" : f.reason === "replaced" ? "replaced" : "bye");
        }
    }

    function query(resume) {
        const params = new URLSearchParams();
        for (const path of watched()) params.append("w", path);
        if (resume) params.set("resume", "1");
        if (counts.fallback_polls) params.set("fallback_polls", String(counts.fallback_polls));
        if (counts.reconnects) params.set("reconnects", String(counts.reconnects));
        return params.toString();
    }

    function openWebSocket(conn, search) {
        let socket;
        try {
            const scheme = g.location.protocol === "https:" ? "wss:" : "ws:";
            socket = new g.WebSocket(`${scheme}//${g.location.host}/api/v2/live?${search}`);
        } catch { return fail(conn, "refused"); }
        conn.send = value => { try { socket.send(JSON.stringify(value)); } catch {} };
        conn.close = () => { try { socket.close(); } catch {} };
        socket.onmessage = event => frame(conn, typeof event.data === "string" ? event.data : "");
        socket.onclose = () => fail(conn, conn.hello ? "closed" : "refused");
        socket.onerror = () => {};
    }

    async function openStream(conn, search) {
        const controller = new AbortController();
        conn.close = () => controller.abort();
        try {
            const response = await realFetch(`/api/v2/live/events?${search}`, {
                credentials: "same-origin", cache: "no-store", signal: controller.signal,
                headers: {accept: "text/event-stream"},
            });
            if (response.status === 404 || response.status === 405) return fail(conn, "unsupported");
            if (response.status === 401 || response.status === 403) return fail(conn, "unauthorized");
            if (!response.ok || !response.headers.get("content-type")?.startsWith("text/event-stream")) {
                return fail(conn, "refused");
            }
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            while (true) {
                const {done, value} = await reader.read();
                if (done) return fail(conn, conn.hello ? "closed" : "refused");
                if (conn !== transport) return;
                buffer += decoder.decode(value, {stream: true});
                let match;
                while ((match = /\r?\n\r?\n/.exec(buffer))) {
                    const block = buffer.slice(0, match.index);
                    buffer = buffer.slice(match.index + match[0].length);
                    lastFrame = now();
                    const data = block.split(/\r?\n/).filter(line => line.startsWith("data:"))
                        .map(line => line.slice(5).replace(/^ /, "")).join("\n");
                    if (data) frame(conn, data);
                }
                if (buffer.length > 262144) return fail(conn, "refused");
            }
        } catch { fail(conn, conn.hello ? "closed" : "refused"); }
    }

    // `reopen`: a deliberate new event stream for a new watch set, not a reconnect.
    function connect(reopen = false) {
        clearTimeout(retryTimer);
        retryTimer = null;
        if (transport) return;
        const resume = connectedOnce && !reopen;
        if (resume) counts.reconnects += 1;
        const conn = {mode, hello: false, catchup: false, send: null, close: null, reported: {...counts}};
        transport = conn;
        lastFrame = now();
        const search = query(resume);
        sent = new Set(watched());
        conn.helloTimer = background(setTimeout(() => { if (!conn.hello) fail(conn, "stalled"); }, T.helloMs));
        if (mode === "websocket") openWebSocket(conn, search); else openStream(conn, search);
    }

    // Timers that only keep the channel going never hold a test process open.
    const background = timer => { timer?.unref?.(); return timer; };
    function retry(delay, reopen = false) {
        clearTimeout(retryTimer);
        retryTimer = background(setTimeout(() => connect(reopen), Math.max(0, delay)));
    }

    function fail(conn, why) {
        if (conn !== transport) return;
        transport = null;
        clearTimeout(conn.helloTimer);
        try { conn.close?.(); } catch {}
        // A healthy channel that went away: catch up on the next one.
        if (conn.hello && why !== "bye") dropped = true;
        // A planned close (lifetime): a new channel at once, not a reconnect.
        // An event stream tries the WebSocket again unless it is ruled out.
        if (why === "bye") {
            if (conn.mode === "sse" && typeof g.WebSocket === "function" && (wsWorked || wsFailures < 3)) {
                if (wsWorked) wsFailures = 0;
                mode = "websocket";
            }
            return retry(0, true);
        }
        if (why === "unsupported") {
            setState(connectedOnce ? "degraded" : "off");
            return retry(T.offRetryMs);
        }
        if (why === "unauthorized" || why === "expired") {
            setState("degraded");
            return retry(60000);
        }
        // Which transport next. A WebSocket that never opened here, or keeps
        // being refused, or stalls after opening (a proxy holding frames),
        // gives way to the event stream; a WebSocket refused while the
        // server restarts is tried again. An event stream that does not
        // open or stalls gives way to the WebSocket unless that is ruled out.
        if (conn.mode === "websocket") {
            if (!conn.hello) wsFailures += 1;
            if ((conn.hello && why === "stalled") || (!conn.hello && (!wsWorked || wsFailures >= 3))) mode = "sse";
        } else if (typeof g.WebSocket === "function" && wsFailures < 3 && (!conn.hello || why === "stalled")) {
            mode = "websocket";
        }
        setState("degraded");
        const delay = T.backoffMs[Math.min(attempts, T.backoffMs.length - 1)] * (0.8 + Math.random() * 0.4);
        attempts += 1;
        // The first switch to the other transport is immediate.
        retry(why === "replaced" ? 30000 : mode !== conn.mode && attempts === 1 ? 0 : delay);
    }

    // Keeps the server's watch set equal to the waited-on paths.
    function sync() {
        if (syncTimer) return;
        const delay = transport && !transport.send ? T.sseSyncMs : T.syncMs;
        syncTimer = setTimeout(() => {
            syncTimer = null;
            const desired = new Set(watched());
            const conn = transport;
            if (!conn || !conn.hello) return;
            const add = [...desired].filter(path => !sent.has(path));
            const remove = [...sent].filter(path => !desired.has(path));
            if (conn.send) {
                if (add.length || remove.length) conn.send({t: "watch", add, remove});
                sent = desired;
            } else if (add.length) {
                // An event stream takes its watch set from the URL: reopen it.
                transport = null;
                try { conn.close?.(); } catch {}
                clearTimeout(conn.helloTimer);
                connect(true);
            }
        }, delay);
    }

    background(setInterval(() => {
        const conn = transport;
        if (conn?.hello && now() - lastFrame > T.stallMs) fail(conn, "stalled");
    }, Math.max(50, Math.min(5000, T.stallMs / 3))));

    // Back now: reconnect at once instead of waiting out the backoff.
    const wake = () => { if (!transport && state !== "off") connect(); };
    g.addEventListener?.("online", wake);
    g.addEventListener?.("focus", wake);
    g.document?.addEventListener?.("visibilitychange", () => {
        if (g.document.visibilityState === "visible") wake();
    });
    // Retry (the connection bar) refreshes every waiting reader.
    g.addEventListener?.("orkestr-stream-retry", () => {
        for (const e of entries.values()) for (const w of [...e.waiters]) w.done("retry");
        if (!transport) connect();
    });

    try { if (g.document?.documentElement) g.document.documentElement.dataset.live = state; } catch {}
    return {
        wait,
        current,
        version: path => entries.get(path)?.version ?? 0,
        status: () => ({state, transport: mode}),
        // Signed in (again): connect now instead of after a backoff.
        start: () => { if (!transport) { attempts = 0; connect(); } },
    };
})();
return null;
