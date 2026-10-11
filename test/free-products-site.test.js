import assert from "node:assert/strict";
import test from "node:test";
import { renderPublicSite, renderPublicSitemap } from "../dist/server/apps/server/src/public-site.js";
import { maybeServeFreeProduct, workoutLogCsp } from "../dist/server/apps/server/src/free-products-static.js";
import { maybeServePublicSite } from "../dist/server/apps/server/src/public-site-static.js";
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

const host = { host: "product.example.test" };
function servePage(route) {
  const { response, result } = fakeResponse();
  const handled = maybeServePublicSite({ headers: host }, response, route, env);
  return { handled, ...result };
}

test("workout log is registered through the shared catalog and listed as Live on /free", () => {
  const entry = publicCatalog.find((item) => item.section === "free" && item.slug === "workout-log");
  assert.ok(entry && publicCatalogEntryIsLive(entry), "workout log catalog entry is live");
  assert.equal(typeof entry.render, "function");
  const page = entry.render(env);
  assert.equal(page.id, "free");
  assert.equal(page.canonicalPath, "/free/workout-log");
  const html = renderPublicSite("/free", env, host);
  assert.match(html, /<span class="hub-badge hub-status-live">Live<\/span><\/div><h3><a href="\/free\/workout-log">Workout log<\/a>/);
  assert.doesNotMatch(html, /\/api\/public\/events|sendBeacon|orkestrTrack|<form/);
  assert.match(renderPublicSitemap(env), /<loc>https:\/\/product\.example\.test\/free\/workout-log<\/loc>/);
});

test("workout log page renders in the site shell with a strict CSP and only same-origin assets", () => {
  const result = servePage("/free/workout-log");
  assert.equal(result.handled, true);
  assert.equal(result.status, 200);
  assert.equal(result.headers["content-security-policy"], workoutLogCsp);
  assert.match(workoutLogCsp, /default-src 'none'/);
  assert.match(workoutLogCsp, /connect-src 'none'/);
  assert.equal(servePage("/free").headers["content-security-policy"], undefined, "the CSP is scoped to the workout log route");
  assert.match(result.body, /<title>Free Workout Log – No Signup, No Data Uploads \| Orkestr<\/title>/);
  assert.match(result.body, /<link rel="canonical" href="https:\/\/product\.example\.test\/free\/workout-log">/);
  assert.match(result.body, /<a href="\/free" aria-current="true">/, "shell nav marks Free products");
  assert.doesNotMatch(result.body, /\son[a-z]+="/i, "no inline event handlers");
  assert.doesNotMatch(result.body, /style="/, "no inline styles");
  assert.doesNotMatch(result.body, /<(?:script|img|iframe|link)\b[^>]*(?:src|href)="https?:\/\/(?!product\.example\.test)/, "no third-party resources");
  assert.match(result.body, /does not give training, health, or medical advice/);
  // Wording rule: the claim is about calls after load, not about how the page is delivered.
  assert.match(result.body, /After this page loads, it sends nothing back: no analytics, no data uploads\. Your entries stay in this browser/);
  assert.match(result.body, /its own files \(page, scripts, styles\) are downloaded from our server/);
  assert.doesNotMatch(result.body, /no network|never uploaded|sent anywhere|data never leaves/i, "no absolute no-network claims");
  for (const href of ["/free", "/impressum", "/privacy"]) assert.match(result.body, new RegExp(`href="${href}"`));
  for (const asset of ["/free/workout-log/app.js", "/free/workout-log/data-panel.js", "/free/workout-log/progression.js", "/free/workout-log/app.css", "/free/workout-log-sw.js"]) {
    const served = fakeResponse();
    assert.equal(maybeServeFreeProduct(served.response, asset), true, asset);
    assert.equal(served.result.status, 200, asset);
    assert.ok(served.result.body.length > 100, asset);
  }
  const redirect = servePage("/free/workout-log/");
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.location, "/free/workout-log");
  assert.equal(maybeServeFreeProduct(fakeResponse().response, "/free/workout-log/../secret"), false);
  assert.equal(maybeServeFreeProduct(fakeResponse().response, "/free/other"), false);
});

const beacon = /\/api\/public\/events|sendBeacon|orkestrTrack|data-(?:view-)?event=/;
const networkApis = /\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|EventSource|RTCPeerConnection|navigator\.connection|new\s+Image\s*\(|\bimport\(|https?:\/\//;

test("free routes contain no analytics beacon script or event hooks", () => {
  for (const route of ["/free", "/free/workout-log"]) {
    const { response, result } = fakeResponse();
    assert.equal(maybeServePublicSite({ headers: { host: "product.example.test" } }, response, route, env), true, route);
    assert.equal(result.status, 200, route);
    assert.doesNotMatch(result.body, beacon, `${route} has no beacon`);
  }
  const page = fakeResponse();
  maybeServePublicSite({ headers: { host: "product.example.test" } }, page.response, "/free/workout-log", env);
  const scripts = [...page.result.body.matchAll(/<script\b[^>]*>/g)].map((match) => match[0]);
  assert.deepEqual(scripts, ['<script type="application/ld+json">', '<script type="module" src="/free/workout-log/app.js">'], "only structured data and the page's own module");
});

test("workout log page code contains no network APIs", () => {
  for (const file of ["app.js", "data-panel.js", "progression.js", "store.js", "timer.js"]) {
    const { response, result } = fakeResponse();
    assert.equal(maybeServeFreeProduct(response, `/free/workout-log/${file}`), true, file);
    const code = result.body.replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, networkApis, `${file} makes no network requests`);
    for (const [, specifier] of code.matchAll(/from\s+"([^"]+)"/g)) assert.match(specifier, /^\.\/[a-z-]+\.js$/, `${file} imports only sibling modules`);
  }
  // The service worker is the only code that fetches, and only the page's own files.
  const worker = fakeResponse();
  maybeServeFreeProduct(worker.response, "/free/workout-log-sw.js");
  assert.match(worker.result.body, /url\.origin !== self\.location\.origin \|\| !ASSETS\.includes\(url\.pathname\)/);
  assert.match(worker.result.body, /if \(request\.method !== "GET"\) return;/, "the worker only serves GETs");
  assert.doesNotMatch(worker.result.body.replace(/^\s*\/\/.*$/gm, ""), /https?:\/\/|sendBeacon|XMLHttpRequest|WebSocket|EventSource|localStorage/);
});
