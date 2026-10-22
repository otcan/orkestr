// One event per bounded fetch; Rust applies it before reconnecting from its cursor.
// HttpOnly session cookie; no Bearer, token URLs, storage or unbounded channel.
const input = await dioxus.recv();
if (!/^\/api\/v2\/conversations\/[a-f0-9-]+\/events$/.test(input.path)) {
    throw new Error("Invalid stream path");
}
const controller = new AbortController();
// A quiet stream ends as "idle" (not an error) so Rust re-reads history after
// its cursor and reconnects. Showing the tab, regaining focus, coming back
// online or pressing Retry ends it as "wake" for the same catch-up.
let reason = null;
const end = why => { if (!reason) { reason = why; controller.abort(); } };
const timer = setTimeout(() => end("idle"), 25000);
const opened = Date.now();
const wake = () => { if (Date.now() - opened > 2000) end("wake"); };
const page = globalThis.document, view = globalThis.window;
const visible = () => { if (page?.visibilityState === "visible") wake(); };
const retry = () => end("wake");
page?.addEventListener("visibilitychange", visible);
view?.addEventListener("focus", wake);
view?.addEventListener("online", retry);
view?.addEventListener("orkestr-stream-retry", retry);
let reader;
try {
    const response = await fetch(input.path, {
        headers: {"Last-Event-ID": String(input.cursor)},
        credentials: "same-origin", cache: "no-store", signal: controller.signal
    });
    if (!response.ok) return {status: response.status, event: "http_error"};
    if (!response.headers.get("content-type")?.startsWith("text/event-stream")) {
        throw new Error("Expected SSE response");
    }
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
        const {done, value} = await reader.read();
        if (done) return {status: 200, event: "disconnected"};
        buffer += decoder.decode(value, {stream: true});
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
            if (match.index > 65536) throw new Error("SSE frame exceeds client limit");
            const frame = buffer.slice(0, match.index);
            buffer = buffer.slice(match.index + match[0].length);
            let event = "message", id = null;
            const data = [];
            for (const line of frame.split(/\r?\n/)) {
                if (line.startsWith(":")) continue;
                const colon = line.indexOf(":");
                const field = colon < 0 ? line : line.slice(0, colon);
                let value = colon < 0 ? "" : line.slice(colon + 1);
                if (value.startsWith(" ")) value = value.slice(1);
                if (field === "event") event = value;
                if (field === "id") id = value;
                if (field === "data") data.push(value);
            }
            if (event === "session_expired" || event === "resync_required") {
                return {status: 200, event};
            }
            if (data.length) {
                if (!["message_accepted", "fixture_provider_observed", "fixture_cancellation_requested", "fixture_provider_stopped", "provider_observed", "cancellation_requested", "provider_stopped", "execution_accepted"].includes(event)) {
                    return {status: 200, event: "resync_required"};
                }
                let body;
                try { body = JSON.parse(data.join("\n")); }
                catch { return {status: 200, event: "resync_required"}; }
                // Canonical DTO/schema/conversation/cursor validation belongs to Rust.
                return {status: 200, event, id, body};
            }
        }
        if (buffer.length > 65536) throw new Error("SSE frame exceeds client limit");
    }
} catch (error) {
    if (reason) return {status: 200, event: reason};
    throw error;
} finally {
    clearTimeout(timer);
    page?.removeEventListener("visibilitychange", visible);
    view?.removeEventListener("focus", wake);
    view?.removeEventListener("online", retry);
    view?.removeEventListener("orkestr-stream-retry", retry);
    controller.abort();
    if (reader) await reader.cancel().catch(() => {});
}
