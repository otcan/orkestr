// Read-only, same-origin execution/host status channel. The owning component sends cancellation on drop.
// Between reads it waits on the page's live channel (live_channel.js): a new
// read when the server reports a change, else every `legacy` ms (2 s) against
// a server without the channel, or on the channel's slow fallback timer.
const {path, legacy = 2000} = await dioxus.recv();
const uuid = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const base = `/api/v2/conversations/${uuid}`;
const executionPath = new RegExp(`^${base}/(?:fast/)?execution(?:\\?run_id=${uuid})?$`);
const workersPath = new RegExp(`^${base}/workers\\?${"(?:after=" + uuid + "&)?"}limit=25$`);
const heldPath = new RegExp(`^${base}/held-inputs\\?after_sequence=(?:0|[1-9][0-9]{0,18})&limit=50$`);
const tasksPath = new RegExp(`^${base}/worker-tasks\\?parent_run_id=${uuid}$`);
const timerPath = new RegExp(`^/api/v2/timers/${uuid}$`);
const v1WorkersPath = new RegExp(`^${base}/v1-workers$`);
if (path !== "/api/v2/resources" && ![executionPath, workersPath, heldPath, tasksPath, timerPath, v1WorkersPath].some(p => p.test(path))) throw new Error("Invalid status path");
let stopped = false, controller, wake, retryTimer;
const live = globalThis.orkestrLive, waiting = new AbortController();
let since = null;
const now = () => Math.floor(performance.now());
dioxus.recv().then(() => {
    stopped = true;
    controller?.abort();
    waiting.abort();
    clearTimeout(retryTimer);
    wake?.();
});
// `live`: the server watches this path, so the last answer is current.
const tick = setInterval(() => { if (!stopped) dioxus.send({kind: "tick", now: now(), live: !!live?.current(path)}); }, 1000);
try {
    while (!stopped) {
        let ok = false;
        controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        try {
            const response = await fetch(path, {method: "GET", credentials: "same-origin", cache: "no-store", signal: controller.signal});
            let body = null;
            if (response.status === 200) {
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let bytes = 0, text = "";
                try {
                    while (true) {
                        const {done, value} = await reader.read();
                        if (done) { text += decoder.decode(); break; }
                        bytes += value.byteLength;
                        if (bytes > 65536) throw new Error("Status exceeds limit");
                        text += decoder.decode(value, {stream: true});
                    }
                } finally { await reader.cancel().catch(() => {}); }
                body = JSON.parse(text);
            } else { await response.body?.cancel(); }
            if (!stopped) dioxus.send({kind: "response", now: now(), status: response.status, body});
            if (response.status === 401 || response.status === 403) break;
            ok = true;
        } catch (_) {
            if (!stopped) dioxus.send({kind: "failure", now: now()});
        } finally { clearTimeout(timeout); controller.abort(); }
        if (stopped) break;
        if (live && ok) {
            // A wait that only hit its bound or saw the channel recover needs no read.
            let reason;
            do {
                const woke = await live.wait(path, since, legacy, waiting.signal);
                since = woke.version;
                reason = woke.reason;
            } while (!stopped && (reason === "timeout" || reason === "recovered"));
        } else {
            await new Promise(resolve => { wake = resolve; retryTimer = setTimeout(resolve, legacy); });
        }
        wake = undefined;
    }
} finally { stopped = true; clearInterval(tick); clearTimeout(retryTimer); controller?.abort(); wake?.(); }
return null;
