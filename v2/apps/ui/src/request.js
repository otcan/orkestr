// Audited platform bridge: only fixed same-origin API paths from Rust.
const input = await dioxus.recv();
const route = /^\/api\/v2\/(?:setup|browser\/session|projects|conversations\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?:\/messages|\/message-attachments)?)(?:\?after=[0-9]+&limit=100)?$/;
// Owner management of one conversation: settings, timers, desktops, posts.
const manage = /^\/api\/v2\/conversations\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/(?:settings|provider-handoffs(?:\/[A-Za-z0-9._:-]{1,128})?|timers|desktops|desktop-binding|message-times\?after=[0-9]{1,18}&limit=200|posts\?limit=50)$/;
// Sidebar observation, read marks, linked V1 history and input, old V1 deep links.
const sidebar = /^\/api\/v2\/(?:sidebar(?:\/read|\?include_hidden=true)?|v1-threads\/[A-Za-z0-9._:-]{1,200}\/(?:messages(?:\?before=[0-9]{1,18})?|uploads)|v1-links\/thr_[A-Za-z0-9_-]{22}\?instance=ins_[A-Za-z0-9_-]{22}|whatsapp-chats|v1-threads\/[A-Za-z0-9._:-]{1,200}\/(?:settings|whatsapp|desktops|timers(?:\/[A-Za-z0-9._:-]{1,200}(?:\/(?:pause|resume))?)?))$/;
const localAccount = input.path === "/api/v2/oss-setup/account" && ["GET", "POST"].includes(input.method);
if (!localAccount && !route.test(input.path) && !(manage.test(input.path) && !input.path.includes("..")) && !(sidebar.test(input.path) && !input.path.includes(".."))) throw new Error("Invalid API path");
const headers = {"Content-Type": "application/json"};
if (localAccount) headers["x-orkestr-local-setup"] = "1";
if (input.csrf && !["GET", "HEAD"].includes(input.method)) headers["x-orkestr-csrf"] = input.csrf;
if (input.bootstrap) headers["x-orkestr-bootstrap"] = input.bootstrap;
// Poll reads revalidate: the last body per GET path is kept in memory with
// its ETag, and a 304 answers with that body. The server's tag is a digest of
// what it would send this session, so a match is always the current body.
const etags = (globalThis.__orkestrEtags ??= new Map());
const revalidate = input.method === "GET" ? etags.get(input.path) : undefined;
if (revalidate) headers["If-None-Match"] = revalidate.etag;
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 15000);
try {
    const response = await fetch(input.path, {
        method: input.method, headers, credentials: "same-origin", cache: "no-store",
        signal: controller.signal,
        body: input.body === null ? undefined : JSON.stringify(input.body)
    });
    if (response.status === 204) return {status: 204, body: null};
    if (response.status === 304 && revalidate) return {status: 200, body: revalidate.body};
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
    const etag = response.headers.get("etag");
    if (input.method === "GET") {
        etags.delete(input.path);
        if (response.status === 200 && etag) {
            etags.set(input.path, {etag, body});
            if (etags.size > 32) etags.delete(etags.keys().next().value);
        }
    }
    return {status: response.status, body};
} finally { clearTimeout(timer); }
