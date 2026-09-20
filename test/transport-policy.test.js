import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { assessTransportResponse as assess, probeTransportPolicy, traefikTransportMiddlewares } from "../scripts/security/transport-policy.mjs";
const target = { hostname: "app.example.invalid", path: "/callback", hstsMaxAge: 86400 };

test("transport requires same-host permanent redirect and exact reviewed HSTS", () => {
  assert.equal(assess(target, "http", { status: 308, location: "https://app.example.invalid/callback" }).ok, true);
  for (const location of ["https://other.example.invalid/callback", "http://app.example.invalid/callback", "https://app.example.invalid/", "https://user@app.example.invalid/callback"]) assert.equal(assess(target, "http", { status: 301, location }).ok, false);
  for (const hsts of ["", "max-age=0", "max-age=86400; preload", "max-age=86400; includeSubDomains", "max-age=86400;max-age=1"]) assert.equal(assess(target, "https", { status: 200, tlsAuthorized: true, hsts }).ok, false);
  assert.equal(assess(target, "https", { status: 200, tlsAuthorized: true, hsts: "max-age=86400" }).ok, true);
});

test("probes use HEAD only, pin both TLS versions, never follow redirects or leak headers", async () => {
  const calls = [];
  const request = (options, callback) => {
    calls.push(options); const req = new EventEmitter(); req.destroy = () => {};
    req.end = () => queueMicrotask(() => callback({ statusCode: 200, headers: { location: "https://unauthorized.invalid/", "strict-transport-security": "max-age=86400", "set-cookie": "PRIVATE" }, socket: { authorized: true }, resume() {} }));
    return req;
  };
  const result = await probeTransportPolicy(target, { http: request, https: request });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.method === "HEAD" && call.agent === false));
  assert.deepEqual(calls.filter(call => call.protocol === "https:").map(call => call.minVersion), ["TLSv1.2", "TLSv1.3"]);
  assert.equal(result.ok, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|unauthorized/);
});

test("middleware proposal excludes blanket CSP, preload and subdomain policy", () => {
  const result = traefikTransportMiddlewares({ namespace: "example", name: "transport", hstsMaxAge: 86400, compatibilityReviewed: true });
  assert.equal(result.applyEnabled, false);
  assert.equal(result.objects[1].spec.headers.stsPreload, false);
  assert.equal(result.objects[1].spec.headers.stsIncludeSubdomains, false);
  assert.equal(result.objects[1].spec.headers.contentSecurityPolicy, undefined);
  assert.throws(() => traefikTransportMiddlewares({ namespace: "example", name: "transport", hstsMaxAge: 86400 }), /reviewed/);
});
