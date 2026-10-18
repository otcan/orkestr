// Audited platform bridge: only fixed same-origin API paths from Rust.
const input = await dioxus.recv();
if (!/^\/api\/v2\//.test(input.path)) throw new Error("Invalid API path");
const headers = {"Content-Type": "application/json"};
if (input.token) headers.Authorization = `Bearer ${input.token}`;
if (input.bootstrap) headers["x-orkestr-bootstrap"] = input.bootstrap;
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 15000);
try {
    const response = await fetch(input.path, {
        method: input.method, headers, credentials: "omit", cache: "no-store",
        signal: controller.signal,
        body: input.body === null ? undefined : JSON.stringify(input.body)
    });
    const text = await response.text();
    if (text.length > 1024 * 1024) throw new Error("Response exceeds client limit");
    let body;
    try { body = JSON.parse(text); }
    catch { body = {code: "invalid_response", message: "Unexpected server response"}; }
    return {status: response.status, body};
} finally { clearTimeout(timer); }
