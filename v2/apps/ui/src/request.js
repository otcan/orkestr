// Audited platform bridge: only fixed same-origin API paths from Rust.
const input = await dioxus.recv();
const route = /^\/api\/v2\/(?:setup|browser\/session|projects|conversations\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?:\/messages)?)(?:\?after=[0-9]+&limit=100)?$/;
// Sidebar observation, read marks, linked V1 history and input, old V1 deep links.
const sidebar = /^\/api\/v2\/(?:sidebar(?:\/read)?|v1-threads\/[A-Za-z0-9._:-]{1,200}\/messages(?:\?before=[0-9]{1,18})?|v1-links\/thr_[A-Za-z0-9_-]{22}\?instance=ins_[A-Za-z0-9_-]{22}|whatsapp-chats)$/;
if (!route.test(input.path) && !(sidebar.test(input.path) && !input.path.includes(".."))) throw new Error("Invalid API path");
const headers = {"Content-Type": "application/json"};
if (input.csrf && !["GET", "HEAD"].includes(input.method)) headers["x-orkestr-csrf"] = input.csrf;
if (input.bootstrap) headers["x-orkestr-bootstrap"] = input.bootstrap;
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 15000);
try {
    const response = await fetch(input.path, {
        method: input.method, headers, credentials: "same-origin", cache: "no-store",
        signal: controller.signal,
        body: input.body === null ? undefined : JSON.stringify(input.body)
    });
    if (response.status === 204) return {status: 204, body: null};
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0, text = "";
    try {
        while (true) {
            const {done, value} = await reader.read();
            if (done) { text += decoder.decode(); break; }
            bytes += value.byteLength;
            if (bytes > 8 * 1024 * 1024) throw new Error("Response exceeds client limit");
            text += decoder.decode(value, {stream: true});
        }
    } finally { await reader.cancel().catch(() => {}); }
    let body;
    try { body = JSON.parse(text); }
    catch { body = {code: "invalid_response", message: "Unexpected server response"}; }
    return {status: response.status, body};
} finally { clearTimeout(timer); }
