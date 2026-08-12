import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  attachHostBoundaryUpgrade,
  effectiveRequestOrigin,
  enforceHostBoundaryRequest,
  hostBoundaryUpgradeDenied,
  rejectUnknownHostBoundaryRequest,
  sanitizeForwardedHostHeaders,
} from "../dist/server/apps/server/src/host-boundaries.js";
import { writeInstanceIdentity } from "../packages/core/src/instance-identity.js";
import { approvePairingChallenge } from "../packages/core/src/security.js";
import { createThread } from "../packages/core/src/threads.js";
import { hostBoundaryDoctorChecks } from "../packages/core/src/host-boundary-doctor.js";
import { startServer } from "../dist/server/apps/server/src/server.js";

const instanceRef = "ins_AQEBAQEBAQEBAQEBAQEBAQ";

function env(home, extra = {}) {
  return {
    ORKESTR_HOME: home,
    ORKESTR_THREAD_STORE: "json",
    ORKESTR_HOST_BOUNDARIES: "1",
    ORKESTR_CANONICAL_INSTANCE_URLS: "1",
    ORKESTR_CANONICAL_APP_GATEWAY: "1",
    ORKESTR_CANONICAL_APP_LINKS: "1",
    ORKESTR_PUBLIC_APP_URL: "https://app.example.test",
    ORKESTR_CONNECT_PUBLIC_URL: "https://connect.example.test",
    ...extra,
  };
}

function request(url, host, extra = {}) {
  return {
    originalUrl: url,
    url,
    protocol: "https",
    method: extra.method || "GET",
    headers: { ...(host ? { host } : {}), ...(extra.headers || {}) },
    socket: { remoteAddress: extra.remoteAddress || "203.0.113.8", encrypted: true },
    orkestrPrincipal: extra.principal || { role: "admin", userId: "admin" },
  };
}

function responseSpy() {
  const result = { statusCode: 0, headers: {}, body: "" };
  const response = {
    status(value) { result.statusCode = value; return response; },
    header(name, value) { result.headers[String(name).toLowerCase()] = String(value); return response; },
    type(value) { result.headers["content-type"] = value; return response; },
    send(value) { result.body = String(value); return response; },
  };
  return { response, result };
}

function cleanup(home) {
  return fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
}

async function enforce(req, runtimeEnv) {
  const spy = responseSpy();
  const handled = await enforceHostBoundaryRequest(req, spy.response, runtimeEnv);
  return { handled, ...spy.result };
}

async function upgrade(port, host, target) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let response = "";
    socket.setTimeout(2_000, () => socket.destroy(new Error("upgrade_timeout")));
    socket.on("connect", () => socket.write(
      `GET ${target} HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
    ));
    socket.on("data", (chunk) => { response += chunk.toString(); });
    socket.on("error", reject);
    socket.on("close", () => resolve(response));
  });
}

async function httpCall(port, target, host, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body || "";
    const req = http.request({
      hostname: "127.0.0.1",
      port,
      path: target,
      method: options.method || "GET",
      headers: { Host: host, ...(options.headers || {}), ...(body ? { "content-length": Buffer.byteLength(body) } : {}) },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

test("forwarded host and proto are ignored unless the direct peer is explicitly trusted", () => {
  const spoofed = request("/", "app.example.test", {
    headers: { "x-forwarded-host": "attacker.invalid", "x-forwarded-proto": "http" },
  });
  assert.equal(effectiveRequestOrigin(spoofed, {}), "https://app.example.test");
  assert.equal(effectiveRequestOrigin(spoofed, { ORKESTR_TRUST_PROXY_HEADERS: "1", ORKESTR_TRUSTED_PROXY_IPS: "127.0.0.1" }), "https://app.example.test");

  const trusted = request("/", "127.0.0.1:3000", {
    remoteAddress: "127.0.0.1",
    headers: { "x-forwarded-host": "app.example.test:8443", "x-forwarded-proto": "https" },
  });
  assert.equal(effectiveRequestOrigin(trusted, { ORKESTR_TRUST_PROXY_HEADERS: "1", ORKESTR_TRUSTED_PROXY_IPS: "127.0.0.1" }), "https://app.example.test:8443");
  trusted.headers["x-forwarded-host"] = "app.example.test,attacker.invalid";
  assert.equal(effectiveRequestOrigin(trusted, { ORKESTR_TRUST_PROXY_HEADERS: "1", ORKESTR_TRUSTED_PROXY_IPS: "127.0.0.1" }), "https://127.0.0.1:3000");
});

test("forwarded host headers are removed for untrusted peers and normalized for trusted proxies", () => {
  const featureOff = request("/", "app.example.test", {
    headers: { "x-forwarded-host": "legacy-proxy.example.test", "x-forwarded-proto": "https" },
  });
  sanitizeForwardedHostHeaders(featureOff, {});
  assert.equal(featureOff.headers["x-forwarded-host"], "legacy-proxy.example.test");

  const direct = request("/", "app.example.test", {
    headers: { "x-forwarded-host": "attacker.invalid", "x-forwarded-proto": "http" },
  });
  sanitizeForwardedHostHeaders(direct, { ORKESTR_HOST_BOUNDARIES: "1" });
  assert.equal(direct.headers["x-forwarded-host"], undefined);
  assert.equal(direct.headers["x-forwarded-proto"], undefined);

  const proxied = request("/", "127.0.0.1:3000", {
    remoteAddress: "127.0.0.1",
    headers: { "x-forwarded-host": "app.example.test:8443", "x-forwarded-proto": "https" },
  });
  sanitizeForwardedHostHeaders(proxied, {
    ORKESTR_TRUST_PROXY_HEADERS: "1",
    ORKESTR_TRUSTED_PROXY_IPS: "127.0.0.1",
  });
  assert.equal(proxied.headers["x-forwarded-host"], "app.example.test:8443");
  assert.equal(proxied.headers["x-forwarded-proto"], "https");
});

test("handoff routes allow only connect/auth origins, redirect app, and reject unknown or missing hosts", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-host-handoff-"));
  const runtimeEnv = env(home);
  const allowed = await enforce(request("/connect/google?return=%2Fsetup", "connect.example.test"), runtimeEnv);
  const redirected = await enforce(request("/setup/pairing?return=%2Fthread%2Fone", "app.example.test"), runtimeEnv);
  const attacker = await enforce(request("/oauth/gmail/callback?code=sample", "attacker.invalid"), runtimeEnv);
  const missing = await enforce(request("/connect/google", ""), runtimeEnv);

  assert.equal(allowed.handled, false);
  assert.equal(redirected.statusCode, 308);
  assert.equal(redirected.headers.location, "https://connect.example.test/setup/pairing?return=%2Fthread%2Fone");
  assert.deepEqual([attacker.statusCode, attacker.body], [404, "not found"]);
  assert.deepEqual([missing.statusCode, missing.body], [404, "not found"]);
  await cleanup(home);
});

test("direct loopback reaches authentication but only probes and exact verified machine routes bypass host boundaries", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-host-probes-"));
  const runtimeEnv = env(home);
  const direct = request("/metrics", "127.0.0.1:19812", { remoteAddress: "127.0.0.1" });
  const directSpy = responseSpy();
  assert.equal(rejectUnknownHostBoundaryRequest(direct, directSpy.response, runtimeEnv), false);
  assert.equal((await enforce(direct, runtimeEnv)).handled, false);

  const version = request("/api/version", "127.0.0.1:19812", { remoteAddress: "127.0.0.1" });
  const versionSpy = responseSpy();
  assert.equal(rejectUnknownHostBoundaryRequest(version, versionSpy.response, runtimeEnv), false);
  assert.equal((await enforce(version, runtimeEnv)).handled, false);

  const cli = request("/api/threads", "127.0.0.1:19812", { remoteAddress: "127.0.0.1" });
  cli.orkestrMachineAuth = "cli";
  const cliSpy = responseSpy();
  assert.equal(rejectUnknownHostBoundaryRequest(cli, cliSpy.response, runtimeEnv), false);
  assert.equal((await enforce(cli, runtimeEnv)).handled, false);

  for (const pathname of [
    "/api/connectors/whatsapp/inbound",
    "/api/connectors/whatsapp/inbound-media",
  ]) {
    const inbound = request(pathname, "127.0.0.1:19812", { method: "POST", remoteAddress: "127.0.0.1" });
    inbound.orkestrMachineAuth = "whatsapp_inbound";
    assert.equal((await enforce(inbound, runtimeEnv)).handled, false, pathname);
  }

  const wrongInboundMethod = request("/api/connectors/whatsapp/inbound", "127.0.0.1:19812", {
    method: "GET",
    remoteAddress: "127.0.0.1",
  });
  wrongInboundMethod.orkestrMachineAuth = "whatsapp_inbound";
  assert.equal((await enforce(wrongInboundMethod, runtimeEnv)).statusCode, 404);

  const wrongInboundRoute = request("/api/threads", "127.0.0.1:19812", { method: "POST", remoteAddress: "127.0.0.1" });
  wrongInboundRoute.orkestrMachineAuth = "whatsapp_inbound";
  assert.equal((await enforce(wrongInboundRoute, runtimeEnv)).statusCode, 404);

  const remoteInbound = request("/api/connectors/whatsapp/inbound", "app.example.test", { method: "POST" });
  remoteInbound.orkestrMachineAuth = "whatsapp_inbound";
  assert.equal((await enforce(remoteInbound, runtimeEnv)).handled, false);

  const unauthenticated = request("/api/threads", "127.0.0.1:19812", { remoteAddress: "127.0.0.1" });
  const unauthenticatedSpy = responseSpy();
  assert.equal(rejectUnknownHostBoundaryRequest(unauthenticated, unauthenticatedSpy.response, runtimeEnv), false);
  assert.equal((await enforce(unauthenticated, runtimeEnv)).statusCode, 404);

  const spoof = request("/metrics", "attacker.invalid", {
    remoteAddress: "127.0.0.1",
    headers: { "x-forwarded-host": "127.0.0.1:19812" },
  });
  const spoofSpy = responseSpy();
  assert.equal(rejectUnknownHostBoundaryRequest(spoof, spoofSpy.response, runtimeEnv), true);
  assert.deepEqual([spoofSpy.result.statusCode, spoofSpy.result.body], [404, "not found"]);
  await cleanup(home);
});

test("canonical and legacy thread routes move to the app origin only after safe resolution", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-host-thread-"));
  t.after(() => cleanup(home));
  const runtimeEnv = env(home);
  await writeInstanceIdentity({ internalInstanceId: "private-instance", publicRef: instanceRef }, runtimeEnv);
  const thread = await createThread({ id: "private-thread", name: "friendly-thread" }, runtimeEnv);
  const canonicalPath = `/instance/${instanceRef}/thread/${thread.publicRef}/history?before=a%2Fb`;

  const canonicalConnect = await enforce(request(canonicalPath, "connect.example.test"), runtimeEnv);
  const canonicalApp = await enforce(request(canonicalPath, "app.example.test"), runtimeEnv);
  const canonicalAttacker = await enforce(request(canonicalPath, "attacker.invalid"), runtimeEnv);
  const legacy = await enforce(request("/thread/friendly-thread/history?before=a%2Fb", "connect.example.test"), runtimeEnv);
  const unknown = await enforce(request("/thread/missing", "connect.example.test"), runtimeEnv);
  const attackerExisting = await enforce(request("/thread/friendly-thread", "attacker.invalid"), runtimeEnv);
  const attackerMissing = await enforce(request("/thread/missing", "attacker.invalid"), runtimeEnv);

  assert.equal(canonicalConnect.headers.location, `https://app.example.test${canonicalPath}`);
  assert.equal(canonicalApp.handled, false);
  assert.equal(canonicalAttacker.statusCode, 404);
  assert.equal(legacy.headers.location, `https://app.example.test/instance/${instanceRef}/thread/${thread.publicRef}/history?before=a%2Fb`);
  assert.deepEqual([unknown.statusCode, unknown.body], [404, "not found"]);
  assert.deepEqual(attackerExisting, attackerMissing);
  assert.doesNotMatch(unknown.body, /missing|private|friendly/);
});

test("ambiguous and unauthorized legacy routes fail uniformly without identity disclosure", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-host-ambiguous-"));
  t.after(() => cleanup(home));
  const runtimeEnv = env(home);
  await writeInstanceIdentity({ internalInstanceId: "private-instance", publicRef: instanceRef }, runtimeEnv);
  await createThread({ id: "one", name: "collision", ownerUserId: "owner-a" }, runtimeEnv);
  await createThread({ id: "two", name: "collision", ownerUserId: "owner-b" }, runtimeEnv);
  await createThread({ id: "restricted", name: "restricted-name", ownerUserId: "owner-b" }, runtimeEnv);

  const ambiguous = await enforce(request("/thread/collision", "app.example.test"), runtimeEnv);
  const unauthorized = await enforce(request("/thread/restricted-name", "app.example.test", {
    principal: { role: "user", userId: "owner-a" },
  }), runtimeEnv);
  assert.deepEqual([ambiguous.statusCode, ambiguous.body], [404, "not found"]);
  assert.deepEqual([unauthorized.statusCode, unauthorized.body], [404, "not found"]);
  assert.doesNotMatch(`${ambiguous.body}${unauthorized.body}`, /collision|restricted|owner/);
});

test("feature-off and compatibility routes preserve legacy behavior", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-host-compat-"));
  const runtimeEnv = env(home);
  assert.equal((await enforce(request("/thread/legacy", "attacker.invalid"), { ...runtimeEnv, ORKESTR_HOST_BOUNDARIES: "0" })).handled, false);
  assert.equal((await enforce(request("/i/private/app/thread/legacy", "connect.example.test"), runtimeEnv)).handled, false);
  assert.equal((await enforce(request("/i/private/a/sample/s/token", "connect.example.test"), runtimeEnv)).handled, false);
  assert.equal((await enforce(request("/i/private/app/thread/legacy", "app.example.test"), runtimeEnv)).handled, false);
  assert.equal((await enforce(request("/i/private/a/sample/s/token", "attacker.invalid"), runtimeEnv)).statusCode, 404);
  assert.equal((await enforce(request("/i/private/app/thread/legacy", ""), runtimeEnv)).statusCode, 404);
  await cleanup(home);
});

test("connect host serves only method-specific pairing primitives and OAuth start", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-host-support-"));
  const runtimeEnv = env(home);
  for (const [method, url] of [
    ["GET", "/"],
    ["GET", "/main.js"],
    ["GET", "/polyfills.js"],
    ["GET", "/styles.css"],
    ["GET", "/favicon.svg"],
    ["GET", "/api/version"],
    ["GET", "/api/setup/status"],
    ["GET", "/api/setup/security/status"],
    ["GET", "/api/setup/security/session-scope?return=%2F"],
    ["POST", "/api/setup/security/challenges"],
    ["GET", "/api/setup/security/challenges/sample"],
    ["POST", "/api/setup/security/pair"],
    ["GET", "/api/connectors/gmail/oauth/start?account=sample%40example.test"],
    ["POST", "/api/broker/instances/register"],
    ["POST", "/api/broker/instances/sample/heartbeat"],
    ["POST", "/api/broker/instances/sample/whatsapp/onboarding"],
    ["POST", "/api/broker/instances/sample/whatsapp/history"],
    ["POST", "/api/broker/instances/sample/google-workspace/connect-link"],
    ["POST", "/api/broker/instances/sample/google-workspace/refresh-token"],
    ["POST", "/api/broker/google-workspace/grants"],
  ]) {
    assert.equal((await enforce(request(url, "connect.example.test", { method }), runtimeEnv)).handled, false, `${method} ${url}`);
  }
  for (const [method, url] of [
    ["GET", "/api/threads"],
    ["GET", "/api/system"],
    ["GET", "/api/files"],
    ["GET", "/jobs"],
    ["GET", "/main.js/extra"],
    ["GET", "/api/setup/security/challenges"],
    ["GET", "/api/setup/security/sessions"],
    ["POST", "/api/setup/security/challenges/sample/approve"],
    ["POST", "/api/setup/security/challenges/sample/reject"],
    ["DELETE", "/api/setup/security/challenges/sample"],
    ["POST", "/api/setup/security/enabled"],
    ["POST", "/api/setup/security/sessions/revoke"],
    ["POST", "/api/setup/security/sessions/sample/revoke"],
    ["POST", "/api/connectors/gmail/oauth/start"],
    ["GET", "/api/broker/instances"],
    ["GET", "/api/broker/instances/sample/heartbeat"],
    ["POST", "/api/broker/instances/sample/other"],
  ]) {
    const denied = await enforce(request(url, "connect.example.test", { method }), runtimeEnv);
    assert.deepEqual([denied.statusCode, denied.body], [404, "not found"], `${method} ${url}`);
  }
  const attackerAsset = await enforce(request("/main.js", "attacker.invalid"), runtimeEnv);
  assert.equal(attackerAsset.statusCode, 404);
  await cleanup(home);
});

test("doctor requires a shared cookie scope and accepts the public URL inferred primary domain", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-host-cookie-doctor-"));
  t.after(() => cleanup(home));
  const missing = await hostBoundaryDoctorChecks(env(home));
  assert.equal(missing.find((item) => item.id === "host_boundary_cookie_scope")?.status, "error");

  const inferred = await hostBoundaryDoctorChecks(env(home, {
    ORKESTR_PRIMARY_DOMAIN: "example.test",
  }));
  assert.equal(inferred.find((item) => item.id === "host_boundary_cookie_scope")?.status, "ok");

  const incompatible = await hostBoundaryDoctorChecks(env(home, {
    ORKESTR_COOKIE_DOMAIN: "unrelated.test",
  }));
  assert.equal(incompatible.find((item) => item.id === "host_boundary_cookie_scope")?.status, "error");
});

test("upgrade gate rejects connect and unknown thread WebSockets before downstream listeners", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-host-ws-"));
  const runtimeEnv = env(home, {
    ORKESTR_PUBLIC_APP_URL: "http://app.example.test",
    ORKESTR_CONNECT_PUBLIC_URL: "http://connect.example.test",
  });
  let downstreamTouches = 0;
  const server = http.createServer();
  server.on("upgrade", (req, socket) => {
    if (hostBoundaryUpgradeDenied(req)) return;
    downstreamTouches += 1;
    socket.end("HTTP/1.1 418 Teapot\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  attachHostBoundaryUpgrade(server, runtimeEnv);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await cleanup(home);
  });
  const port = server.address().port;

  const connectThread = await upgrade(port, "connect.example.test", "/api/threads/sample/stream");
  const unknownThread = await upgrade(port, "attacker.invalid", "/api/threads/sample/stream");
  assert.match(connectThread, /^HTTP\/1\.1 404 Not Found/);
  assert.match(unknownThread, /^HTTP\/1\.1 404 Not Found/);
  assert.equal(downstreamTouches, 0);

  const compatible = await upgrade(port, "connect.example.test", "/i/sample/app/api/threads/sample/stream");
  const canonical = await upgrade(port, "app.example.test", `/instance/${instanceRef}/thread/thr_AgICAgICAgICAgICAgICAg/stream`);
  assert.match(compatible, /^HTTP\/1\.1 418 Teapot/);
  assert.match(canonical, /^HTTP\/1\.1 418 Teapot/);
  assert.equal(downstreamTouches, 2);
});

test("live server keeps the connect pairing page, assets, and primitive APIs on their bounded host", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-host-live-"));
  const keys = [
    "ORKESTR_HOME", "ORKESTR_THREAD_STORE", "ORKESTR_HOST_BOUNDARIES",
    "ORKESTR_CANONICAL_INSTANCE_URLS", "ORKESTR_CANONICAL_APP_GATEWAY",
    "ORKESTR_CANONICAL_APP_LINKS", "ORKESTR_PUBLIC_APP_URL",
    "ORKESTR_CONNECT_PUBLIC_URL", "ORKESTR_PUBLIC_AUTH_URL",
    "ORKESTR_PRIMARY_DOMAIN", "ORKESTR_COOKIE_DOMAIN",
    "ORKESTR_AUTH_REQUIRED", "ORKESTR_OVERLAY_DIR", "ORKESTR_RECOVER_RUNNING_ON_START",
    "ORKESTR_TRUST_PROXY_HEADERS", "ORKESTR_TRUSTED_PROXY_IPS",
    "ORKESTR_WHATSAPP_INBOUND_TOKEN",
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, env(home, {
    ORKESTR_PUBLIC_APP_URL: "http://app.example.test",
    ORKESTR_CONNECT_PUBLIC_URL: "http://connect.example.test",
    ORKESTR_PRIMARY_DOMAIN: "example.test",
    ORKESTR_COOKIE_DOMAIN: "example.test",
    ORKESTR_AUTH_REQUIRED: "0",
    ORKESTR_RECOVER_RUNNING_ON_START: "0",
  }));
  for (const key of ["ORKESTR_PUBLIC_AUTH_URL", "ORKESTR_OVERLAY_DIR", "ORKESTR_TRUST_PROXY_HEADERS", "ORKESTR_TRUSTED_PROXY_IPS"]) {
    delete process.env[key];
  }
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await cleanup(home);
  });
  const port = server.address().port;
  const call = (pathname, host, options = {}) => httpCall(port, pathname, host, options);

  const page = await call("/setup/pairing", "connect.example.test");
  const html = page.body.toString();
  assert.equal(page.status, 200);
  assert.match(html, /main\.js/);
  assert.equal((await call("/main.js", "connect.example.test")).status, 200);
  assert.equal((await call("/api/version", "connect.example.test")).status, 200);
  assert.equal((await call("/api/setup/status", "connect.example.test")).status, 200);
  assert.equal((await call("/api/setup/security/status", "connect.example.test")).status, 401);
  const disallowedUnpaired = await call("/api/threads", "connect.example.test");
  assert.equal(disallowedUnpaired.status, 404);
  assert.equal(disallowedUnpaired.body.toString(), "not found");

  const challenge = await call("/api/setup/security/challenges", "connect.example.test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(challenge.status, 200);
  const challengePayload = JSON.parse(challenge.body.toString());
  await approvePairingChallenge(challengePayload.challenge.approveCode, { env: process.env });
  const paired = await call("/api/setup/security/pair", "connect.example.test", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-host": "attacker.invalid", "x-forwarded-proto": "http" },
    body: JSON.stringify({ challengeId: challengePayload.challengeId }),
  });
  assert.equal(paired.status, 200);
  assert.match(String(paired.headers["set-cookie"] || ""), /Domain=example\.test/);
  assert.doesNotMatch(String(paired.headers["set-cookie"] || ""), /attacker\.invalid/);
  const disallowedPaired = await call("/api/threads", "connect.example.test", {
    headers: { cookie: String(paired.headers["set-cookie"] || "") },
  });
  assert.deepEqual([disallowedPaired.status, disallowedPaired.body.toString()], [404, "not found"]);
  assert.equal((await call("/api/setup/security/enabled", "connect.example.test", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: false }),
  })).status, 404);

  process.env.ORKESTR_WHATSAPP_INBOUND_TOKEN = "test-whatsapp-inbound-token";
  const inbound = await call("/api/connectors/whatsapp/inbound", `127.0.0.1:${port}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-whatsapp-inbound-token",
    },
    body: JSON.stringify({}),
  });
  assert.equal(inbound.status, 400);
  assert.equal(JSON.parse(inbound.body.toString()).error, "whatsapp_event_id_required");

  const handoff = await call("/setup/pairing?return=%2Fsetup", "app.example.test");
  assert.equal(handoff.status, 308);
  assert.equal(handoff.headers.location, "http://connect.example.test/setup/pairing?return=%2Fsetup");
  assert.equal((await call("/main.js", "attacker.invalid")).status, 404);
  assert.equal((await call("/metrics", "attacker.invalid")).status, 404);
});
