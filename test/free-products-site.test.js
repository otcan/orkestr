import assert from "node:assert/strict";
import test from "node:test";
import { renderPublicSite, renderPublicSitemap } from "../dist/server/apps/server/src/public-site.js";
import { maybeServeFreeProduct, workoutLogCsp } from "../dist/server/apps/server/src/free-products-static.js";
import { freeProducts } from "../dist/server/apps/server/src/free-products-catalog.js";

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

test("free products catalog lists the workout log without the event beacon", () => {
  const html = renderPublicSite("/free", env, { host: "product.example.test" });
  assert.match(html, /<title>Free Products \| Orkestr<\/title>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/product\.example\.test\/free">/);
  for (const product of freeProducts) assert.match(html, new RegExp(`href="${product.path}"`));
  assert.match(html, /href="\/free\/workout-log"/);
  assert.doesNotMatch(html, /\/api\/public\/events|sendBeacon/);
  assert.doesNotMatch(html, /<form/);
  assert.match(renderPublicSitemap(env), /<loc>https:\/\/product\.example\.test\/free<\/loc>/);
  assert.match(renderPublicSite("/", env, { host: "product.example.test" }), /\/api\/public\/events/, "other pages keep their existing shell");
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
