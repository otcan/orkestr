import assert from "node:assert/strict";
import test from "node:test";
import { renderPublicSite, renderPublicSitemap } from "../dist/server/apps/server/src/public-site.js";
import { maybeServeFreeProduct, workoutLogCsp } from "../dist/server/apps/server/src/free-products-static.js";
import { publicCatalog, publicCatalogEntryIsLive } from "../dist/server/apps/server/src/public-site-catalog.js";

const env = { ORKESTR_PUBLIC_SITE_URL: "https://product.example.test", ORKESTR_PUBLIC_REPO_URL: "https://github.com/otcan/orkestr" };

function fakeResponse() {
  const result = { status: 0, headers: {}, type: "", body: "" };
  const response = {
    status(code) { result.status = code; return response; },
    header(key, value) { result.headers[key.toLowerCase()] = value; return response; },
    type(value) { result.type = value; return response; },
    send(body) { result.body = String(body); return response; },
  };
  return { response, result };
}

test("free products catalog links the live workout log without the event beacon", () => {
  const html = renderPublicSite("/free", env, { host: "product.example.test" });
  const entry = publicCatalog.find((item) => item.section === "free" && item.slug === "workout-log");
  assert.ok(entry && publicCatalogEntryIsLive(entry), "workout log is a live standalone catalog entry");
  assert.equal(entry.render, undefined, "served outside the shell");
  assert.match(html, /<a href="\/free\/workout-log">Workout log<\/a>/);
  assert.doesNotMatch(html, /\/api\/public\/events|sendBeacon|orkestrTrack/);
  assert.doesNotMatch(html, /<form/);
  assert.match(renderPublicSitemap(env), /<loc>https:\/\/product\.example\.test\/free\/workout-log<\/loc>/);
  assert.equal(renderPublicSite("/free/workout-log", env, { host: "product.example.test" }), "", "the shell never renders the standalone page");
});

test("workout log page is served with a strict no-network CSP and only same-origin assets", () => {
  const { response, result } = fakeResponse();
  assert.equal(maybeServeFreeProduct(response, "/free/workout-log", env), true);
  assert.equal(result.status, 200);
  assert.equal(result.headers["content-security-policy"], workoutLogCsp);
  assert.match(workoutLogCsp, /default-src 'none'/);
  assert.match(workoutLogCsp, /connect-src 'none'/);
  assert.doesNotMatch(result.body, /<script(?![^>]*\bsrc="\/free\/workout-log\/app\.js")/, "no inline scripts");
  assert.doesNotMatch(result.body, /\son[a-z]+="/i, "no inline event handlers");
  assert.doesNotMatch(result.body, /style="/, "no inline styles");
  assert.doesNotMatch(result.body, /https?:\/\/(?!product\.example\.test)/, "no third-party URLs");
  assert.match(result.body, /does not give training, health, or medical advice/);
  for (const href of ["/free", "/impressum", "/privacy"]) assert.match(result.body, new RegExp(`href="${href}"`));
  for (const asset of ["/free/workout-log/app.js", "/free/workout-log/progression.js", "/free/workout-log/app.css", "/free/workout-log-sw.js"]) {
    const served = fakeResponse();
    assert.equal(maybeServeFreeProduct(served.response, asset, env), true, asset);
    assert.equal(served.result.status, 200, asset);
    assert.ok(served.result.body.length > 100, asset);
  }
  const client = fakeResponse();
  maybeServeFreeProduct(client.response, "/free/workout-log/app.js", env);
  assert.doesNotMatch(client.result.body, /\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource/);
  const redirect = fakeResponse();
  maybeServeFreeProduct(redirect.response, "/free/workout-log/", env);
  assert.equal(redirect.result.status, 301);
  assert.equal(maybeServeFreeProduct(fakeResponse().response, "/free/workout-log/../secret", env), false);
  assert.equal(maybeServeFreeProduct(fakeResponse().response, "/free/other", env), false);
});

const beacon = /\/api\/public\/events|sendBeacon|orkestrTrack|data-(?:view-)?event=/;
const networkApis = /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|RTCPeerConnection|navigator\.connection|new\s+Image\s*\(|\bimport\(|https?:\/\//;

test("free routes served through the static handler contain no beacon script or event hooks", async () => {
  const { maybeServePublicSite } = await import("../dist/server/apps/server/src/public-site-static.js");
  for (const route of ["/free", "/free/workout-log"]) {
    const { response, result } = fakeResponse();
    assert.equal(maybeServePublicSite({ headers: { host: "product.example.test" } }, response, route, env), true, route);
    assert.equal(result.status, 200, route);
    assert.doesNotMatch(result.body, beacon, `${route} has no beacon`);
  }
  const page = fakeResponse();
  maybeServePublicSite({ headers: { host: "product.example.test" } }, page.response, "/free/workout-log", env);
  const scripts = [...page.result.body.matchAll(/<script\b[^>]*>/g)].map((match) => match[0]);
  assert.deepEqual(scripts, ['<script type="module" src="/free/workout-log/app.js">'], "only the page's own module");
});

test("workout log page code contains no network APIs", () => {
  for (const file of ["app.js", "data-panel.js", "progression.js", "store.js", "timer.js"]) {
    const { response, result } = fakeResponse();
    assert.equal(maybeServeFreeProduct(response, `/free/workout-log/${file}`, env), true, file);
    const code = result.body.replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, networkApis, `${file} makes no network requests`);
    for (const [, specifier] of code.matchAll(/from\s+"([^"]+)"/g)) assert.match(specifier, /^\.\/[a-z-]+\.js$/, `${file} imports only sibling modules`);
  }
  // The service worker is the only code that fetches, and only the page's own files.
  const worker = fakeResponse();
  maybeServeFreeProduct(worker.response, "/free/workout-log-sw.js", env);
  assert.match(worker.result.body, /url\.origin !== self\.location\.origin \|\| !ASSETS\.includes\(url\.pathname\)/);
  assert.match(worker.result.body, /if \(request\.method !== "GET"\) return;/, "the worker only serves GETs");
  assert.doesNotMatch(worker.result.body.replace(/^\s*\/\/.*$/gm, ""), /https?:\/\/|sendBeacon|XMLHttpRequest|WebSocket|EventSource|localStorage/);
});
