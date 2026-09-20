import assert from "node:assert/strict";
import test from "node:test";
import { inspectCanonicalRouting as inspect } from "../scripts/security/canonical-routing-guard.mjs";
const proxy = dial => ({ handler: "reverse_proxy", upstreams: [{ dial }] });
const config = () => ({ apps: { http: { servers: { example: { routes: [{ match: [{ host: ["app.example.invalid"] }], handle: [{ handler: "subroute", routes: [
  { match: [{ path: ["/micro/*"] }], handle: [proxy("127.0.0.1:9001")] },
  { handle: [proxy("127.0.0.1:9000")] },
] }] }] } } } } });
const policy = { bindings: [{ host: "app.example.invalid", server: "example", upstreams: ["127.0.0.1:9000"] }] };

test("canonical guard follows fallback without disturbing microfrontend routing", () => {
  const input = config(), before = JSON.stringify(input);
  assert.equal(inspect(input, policy).ok, true);
  assert.equal(JSON.stringify(input), before);
});
test("wrong fallback runtime and dynamic route ambiguity fail closed", () => {
  const input = config();
  input.apps.http.servers.example.routes[0].handle[0].routes[1].handle[0].upstreams[0].dial = "127.0.0.1:9002";
  assert.equal(inspect(input, policy).ok, false);
  input.apps.http.servers.example.routes[0].match = [{ expression: "unknown" }];
  assert.equal(inspect(input, policy).results[0].reason, "route_graph_requires_manual_review");
});
test("GET correctness cannot hide a split POST pairing route", () => {
  const input = config();
  input.apps.http.servers.example.routes[0].handle[0].routes.unshift({ match: [{ method: ["POST"] }], handle: [proxy("127.0.0.1:9002")] });
  const report = inspect(input, policy);
  assert.equal(report.ok, false);
  assert.ok(report.results.filter(row => row.method === "GET").every(row => row.ok));
  assert.ok(report.results.filter(row => row.method === "POST").every(row => !row.ok));
});

test("group semantics and nested terminal fallthrough never create false success", () => {
  for (const first of [
    { group: "exclusive", handle: [{ handler: "headers" }] },
    { handle: [{ handler: "subroute", routes: [{ terminal: true, handle: [{ handler: "headers" }] }] }] },
  ]) {
    const input = config();
    input.apps.http.servers.example.routes = [first, { handle: [proxy("127.0.0.1:9000")] }];
    assert.equal(inspect(input, policy).ok, false);
  }
  const input = config();
  input.apps.http.servers.example.routes.unshift({ match: [], handle: [proxy("127.0.0.1:9002")] });
  assert.equal(inspect(input, policy).ok, false);
});
