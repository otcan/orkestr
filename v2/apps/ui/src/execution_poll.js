// Read-only, same-origin execution/host status channel. The owning component sends cancellation on drop.
const {path} = await dioxus.recv();
const uuid = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const base = `/api/v2/conversations/${uuid}`;
const executionPath = new RegExp(`^${base}/execution(?:\\?run_id=${uuid})?$`);
const workersPath = new RegExp(`^${base}/workers\\?${"(?:after=" + uuid + "&)?"}limit=25$`);
const heldPath = new RegExp(`^${base}/held-inputs\\?after_sequence=(?:0|[1-9][0-9]{0,18})&limit=50$`);
if (path !== "/api/v2/resources" && !executionPath.test(path) && !workersPath.test(path) && !heldPath.test(path)) throw new Error("Invalid status path");
let stopped = false, controller, wake, retryTimer;
const now = () => Math.floor(performance.now());
dioxus.recv().then(() => {
    stopped = true;
    controller?.abort();
    clearTimeout(retryTimer);
    wake?.();
});
const tick = setInterval(() => { if (!stopped) dioxus.send({kind: "tick", now: now()}); }, 1000);
try {
    while (!stopped) {
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
        } catch (_) {
            if (!stopped) dioxus.send({kind: "failure", now: now()});
        } finally { clearTimeout(timeout); controller.abort(); }
        if (!stopped) await new Promise(resolve => { wake = resolve; retryTimer = setTimeout(resolve, 2000); });
        wake = undefined;
    }
} finally { stopped = true; clearInterval(tick); clearTimeout(retryTimer); controller?.abort(); wake?.(); }
return null;
