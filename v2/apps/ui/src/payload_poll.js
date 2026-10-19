// Bounded same-origin output revalidation; cancellation belongs to the mounted selection.
const {path} = await dioxus.recv();
if (!/^\/api\/v2\/conversations\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/payloads\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(path)) throw new Error("Invalid output path");
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
                        if (bytes > 1048576) throw new Error("Output exceeds limit");
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
        if (!stopped) await new Promise(resolve => { wake = resolve; retryTimer = setTimeout(resolve, 5000); });
        wake = undefined;
    }
} finally { stopped = true; clearInterval(tick); clearTimeout(retryTimer); controller?.abort(); wake?.(); }
return null;
