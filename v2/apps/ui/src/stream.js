// One event per bounded fetch; Rust applies it before reconnecting from its cursor.
// No EventSource, token URLs, DOM injection, storage, or unbounded message channel.
const input = await dioxus.recv();
if (!/^\/api\/v2\/conversations\/[a-f0-9-]+\/events$/.test(input.path)) {
    throw new Error("Invalid stream path");
}
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 25000);
let reader;
try {
    const response = await fetch(input.path, {
        headers: {Authorization: `Bearer ${input.token}`, "Last-Event-ID": String(input.cursor)},
        credentials: "omit", cache: "no-store", signal: controller.signal
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
            if (data.length) return {status: 200, event, id, body: JSON.parse(data.join("\n"))};
        }
        if (buffer.length > 65536) throw new Error("SSE frame exceeds client limit");
    }
} finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) await reader.cancel().catch(() => {});
}
