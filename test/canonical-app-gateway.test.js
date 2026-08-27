import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { startServer } from "../apps/server/src/server.js";
import { writeInstanceIdentity } from "../packages/core/src/instance-identity.js";
import { createThread } from "../packages/core/src/threads.js";
import {
  __brokerInstanceRegistryTestInternals,
  registerBrokerInstance,
  updateBrokerInstanceRecord,
} from "../packages/core/src/broker-instance-registry.js";
import {
  approvePairingChallenge,
  createPairingChallenge,
  pairBrowser,
  sessionCookieHeader,
} from "../packages/core/src/security.js";
import {
  parseCanonicalAppUrl,
  resolveCanonicalRoute,
} from "../dist/server/apps/server/src/canonical-app-gateway.js";
import { legacyInstanceRouteTarget } from "../dist/server/apps/server/src/legacy-instance-redirects.js";

const instanceRef = "ins_AQEBAQEBAQEBAQEBAQEBAQ";
const threadRef = "thr_AgICAgICAgICAgICAgICAg";

test("legacy cockpit GET routes map to the lean instance surface without touching attended primitives", () => {
  assert.equal(legacyInstanceRouteTarget("/launcher"), "/launcher");
  assert.equal(legacyInstanceRouteTarget("/ng/launcher?tab=ops"), "/launcher?tab=ops");
  assert.equal(legacyInstanceRouteTarget("/files?folder=notes"), "/files?folder=notes");
  assert.equal(legacyInstanceRouteTarget("/ng/files"), "/files");
  assert.equal(legacyInstanceRouteTarget("/timers?view=due"), "/timers?view=due");
  assert.equal(legacyInstanceRouteTarget("/desk"), "/desktops");
  assert.equal(legacyInstanceRouteTarget("/desktops"), "/desktops");
  assert.equal(legacyInstanceRouteTarget("/ng/desk"), "/desktops");
  assert.equal(legacyInstanceRouteTarget("/jobs"), "/settings");
  assert.equal(legacyInstanceRouteTarget("/ng/jobs"), "/settings");
  assert.equal(legacyInstanceRouteTarget("/ops/connectors"), "/settings");
  assert.equal(legacyInstanceRouteTarget("/ops/mailboxes"), "/settings");
  assert.equal(legacyInstanceRouteTarget("/mailboxes"), "/settings");
  assert.equal(legacyInstanceRouteTarget("/connectors"), "/settings");
  assert.equal(legacyInstanceRouteTarget("/setup/whatsapp"), "/setup/whatsapp");
  assert.equal(legacyInstanceRouteTarget("/setup/whatsapp", { setupReady: true }), "/settings");
  assert.equal(legacyInstanceRouteTarget("/setup/pairing"), "");
  assert.equal(legacyInstanceRouteTarget("/connectors/gmail?intent=1"), "");
  assert.equal(legacyInstanceRouteTarget("/oauth/gmail/callback?state=test"), "");
});

test("canonical app paths preserve opaque refs, suffixes, and query strings", () => {
  assert.deepEqual(parseCanonicalAppUrl(`/instance/${instanceRef}/thread/${threadRef}/history?before=a%2Fb&limit=4`), {
    instancePublicRef: instanceRef,
    threadPublicRef: threadRef,
    upstreamPath: `/thread/${threadRef}/history?before=a%2Fb&limit=4`,
    prefixPath: `/instance/${instanceRef}/`,
  });
  assert.deepEqual(parseCanonicalAppUrl(`/instance/${instanceRef}/api/version?verbose=1`), {
    instancePublicRef: instanceRef,
    threadPublicRef: "",
    upstreamPath: "/api/version?verbose=1",
    prefixPath: `/instance/${instanceRef}/`,
  });
  assert.throws(() => parseCanonicalAppUrl("/instance/not-an-opaque-ref/thread/name"), /instance_public_ref_invalid/);
  assert.throws(() => parseCanonicalAppUrl(`/instance/${instanceRef}/thread/not-an-opaque-ref`), /thread_public_ref_invalid/);
  assert.throws(() => parseCanonicalAppUrl(`/instance/${instanceRef}/thread/%E0%A4%A`), /URI malformed/);
  for (const path of [
    `/instance/${instanceRef}/%74hread/${threadRef}`,
    `/instance/${instanceRef}/t%68read/${threadRef}`,
    `/in%73tance/ins_%41QEBAQEBAQEBAQEBAQEBAQ/thread/${threadRef}`,
  ]) {
    const route = parseCanonicalAppUrl(path);
    assert.equal(route.instancePublicRef, instanceRef);
    assert.equal(route.threadPublicRef, threadRef);
    assert.equal(route.upstreamPath, `/thread/${threadRef}`);
  }
});

test("instance denial stops before thread authorization or tenant dispatch", async () => {
  const route = parseCanonicalAppUrl(`/instance/${instanceRef}/thread/${threadRef}`);
  let threadLookups = 0;
  let upstreamTouches = 0;
  const denied = await resolveCanonicalRoute(route, {}, {
    resolveInstance: async () => null,
    authorizeThread: async () => { threadLookups += 1; upstreamTouches += 1; return true; },
  });
  assert.equal(denied, null);
  assert.equal(threadLookups, 0);
  assert.equal(upstreamTouches, 0);
});

test("local thread authorization follows instance authorization while broker dispatch does not inspect parent threads", async () => {
  const route = parseCanonicalAppUrl(`/instance/${instanceRef}/thread/${threadRef}`);
  let localLookups = 0;
  const local = await resolveCanonicalRoute(route, {}, {
    resolveInstance: async () => ({ kind: "local", internalInstanceId: "private-local-id" }),
    authorizeThread: async () => { localLookups += 1; return true; },
  });
  assert.equal(local.internalInstanceId, "private-local-id");
  assert.equal(localLookups, 1);

  let brokerLookups = 0;
  const broker = await resolveCanonicalRoute(route, {}, {
    resolveInstance: async () => ({ kind: "broker", internalInstanceId: "private-broker-id" }),
    authorizeThread: async () => { brokerLookups += 1; return false; },
  });
  assert.equal(broker.internalInstanceId, "private-broker-id");
  assert.equal(brokerLookups, 0);
});

test("local canonical gateway serves an instance-scoped SPA and uses uniform 404 failures", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-canonical-gateway-"));
  const keys = [
    "ORKESTR_HOME", "ORKESTR_THREAD_STORE", "ORKESTR_BROKER_INSTANCE_STORE",
    "ORKESTR_CANONICAL_INSTANCE_URLS", "ORKESTR_CANONICAL_APP_GATEWAY", "ORKESTR_CANONICAL_APP_LINKS",
    "ORKESTR_APP_HOST", "ORKESTR_PUBLIC_APP_URL", "ORKESTR_PUBLIC_URL", "ORKESTR_PUBLIC_HTTPS_URL",
    "ORKESTR_INSTANCE_ID", "ORKESTR_OVERLAY_DIR", "ORKESTR_AUTH_REQUIRED",
    "ORKESTR_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED",
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    ORKESTR_HOME: home,
    ORKESTR_THREAD_STORE: "json",
    ORKESTR_BROKER_INSTANCE_STORE: "json",
    ORKESTR_CANONICAL_INSTANCE_URLS: "1",
    ORKESTR_CANONICAL_APP_GATEWAY: "1",
    ORKESTR_CANONICAL_APP_LINKS: "1",
    ORKESTR_APP_HOST: "app.example.test",
    ORKESTR_INSTANCE_ID: "private-local-id",
    ORKESTR_AUTH_REQUIRED: "0",
    ORKESTR_UNSAFE_ALLOW_PUBLIC_UNAUTHENTICATED: "1",
  });
  for (const key of ["ORKESTR_OVERLAY_DIR", "ORKESTR_PUBLIC_APP_URL", "ORKESTR_PUBLIC_URL", "ORKESTR_PUBLIC_HTTPS_URL"]) {
    delete process.env[key];
  }
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  await writeInstanceIdentity({ internalInstanceId: "private-local-id", publicRef: instanceRef }, process.env);
  const thread = await createThread({ id: "private-thread-id", name: "Private thread name" }, process.env);
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(home, { recursive: true, force: true });
  });
  const port = server.address().port;
  const known = await fetch(`http://127.0.0.1:${port}/instance/${instanceRef}/thread/${thread.publicRef}`);
  const knownHtml = await known.text();
  assert.equal(known.status, 200);
  assert.match(knownHtml, new RegExp(`<base href="/instance/${instanceRef}/"`));
  assert.doesNotMatch(knownHtml, /private-local-id|private-thread-id|Private thread name/);
  const launcher = await fetch(`http://127.0.0.1:${port}/instance/${instanceRef}/launcher`, {
    redirect: "manual",
  });
  const launcherHtml = await launcher.text();
  assert.equal(launcher.status, 200);
  assert.match(launcherHtml, new RegExp(`<base href="/instance/${instanceRef}/"`));
  assert.doesNotMatch(launcherHtml, /private-local-id|private-thread-id|Private thread name/);
  const legacyFiles = await fetch(`http://127.0.0.1:${port}/files?folder=notes`, {
    redirect: "manual",
    headers: { host: "app.example.test" },
  });
  assert.equal(legacyFiles.status, 302);
  assert.equal(legacyFiles.headers.get("location"), `https://app.example.test/instance/${instanceRef}/files?folder=notes`);
  assert.equal(legacyFiles.headers.get("deprecation"), "true");

  const failures = await Promise.all([
    fetch(`http://127.0.0.1:${port}/instance/ins_AwMDAwMDAwMDAwMDAwMDAw/thread/${thread.publicRef}`),
    fetch(`http://127.0.0.1:${port}/instance/${instanceRef}/thread/thr_BAQEBAQEBAQEBAQEBAQEBA`),
    fetch(`http://127.0.0.1:${port}/instance/${instanceRef}/thread/private-thread-id`),
  ]);
  for (const response of failures) {
    assert.equal(response.status, 404);
    assert.equal(await response.text(), "not found");
  }

  const api = await fetch(`http://127.0.0.1:${port}/instance/${instanceRef}/api/version?source=canonical`);
  assert.equal(api.status, 200);
  assert.equal((await api.json()).name, "orkestr-oss");
  const instanceContext = await fetch(`http://127.0.0.1:${port}/instance/${instanceRef}/api/instance/context`);
  assert.equal(instanceContext.status, 200);
  assert.deepEqual((await instanceContext.json()).instance, {
    publicRef: instanceRef,
    canonicalPath: `/instance/${instanceRef}/`,
  });
  const instanceConfig = await fetch(`http://127.0.0.1:${port}/instance/${instanceRef}/api/instance/config`);
  assert.equal(instanceConfig.status, 200);
  assert.equal(instanceConfig.headers.get("etag"), '"1"');
  const patchedConfig = await fetch(`http://127.0.0.1:${port}/instance/${instanceRef}/api/instance/config`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "if-match": '"1"' },
    body: JSON.stringify({ patch: { metadata: { label: "Canonical instance" } } }),
  });
  assert.equal(patchedConfig.status, 200);
  const patchedConfigPayload = await patchedConfig.json();
  assert.equal(patchedConfigPayload.config.generation, 2);
  assert.equal(patchedConfigPayload.config.metadata.label, "Canonical instance");
  const stalePatch = await fetch(`http://127.0.0.1:${port}/instance/${instanceRef}/api/instance/config`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "if-match": '"1"' },
    body: JSON.stringify({ patch: { metadata: { label: "Stale" } } }),
  });
  assert.equal(stalePatch.status, 409);
  const instanceFiles = await fetch(`http://127.0.0.1:${port}/instance/${instanceRef}/api/instance/files`);
  assert.equal(instanceFiles.status, 200);
  const instanceFilesPayload = await instanceFiles.json();
  assert.ok(instanceFilesPayload.mount.id);
  assert.ok(instanceFilesPayload.mounts.every((mount) => !("path" in mount) && !("rootPath" in mount)));
  const summaryResponse = await fetch(`http://127.0.0.1:${port}/instance/${instanceRef}/api/threads`);
  assert.equal(summaryResponse.status, 200);
  const summary = (await summaryResponse.json()).threads.find((item) => item.publicRef === thread.publicRef);
  assert.equal(summary.canonicalUrl, `https://app.example.test/instance/${instanceRef}/thread/${thread.publicRef}`);
  assert.equal(summary.canonicalPath, `/instance/${instanceRef}/thread/${thread.publicRef}`);
  assert.doesNotMatch(summary.canonicalUrl, /private-local-id|private-thread-id|Private thread name/);

  const userChallenge = await createPairingChallenge({
    env: process.env,
    instanceId: "private-local-id",
    userId: "synthetic-user",
    role: "user",
  });
  await approvePairingChallenge(userChallenge.challengeId, { approvedBy: "node:test", env: process.env });
  const userSession = await pairBrowser({ challengeId: userChallenge.challengeId, env: process.env });
  const userCookie = sessionCookieHeader(userSession.token, process.env).split(";")[0];
  const restricted = await Promise.all([
    fetch(`http://127.0.0.1:${port}/instance/${instanceRef}/api/settings`, { headers: { cookie: userCookie } }),
    fetch(`http://127.0.0.1:${port}/instance/${instanceRef}/api/instance/status`, { headers: { cookie: userCookie } }),
    fetch(`http://127.0.0.1:${port}/instance/${instanceRef}/api/connectors/linkedin`, { headers: { cookie: userCookie } }),
    fetch(`http://127.0.0.1:${port}/instance/${instanceRef}/api/threads/private-thread-id`, { headers: { cookie: userCookie } }),
  ]);
  assert.deepEqual(restricted.map((response) => response.status), [403, 403, 403, 403]);
  const unauthorizedPage = await fetch(
    `http://127.0.0.1:${port}/instance/${instanceRef}/thread/${thread.publicRef}`,
    { headers: { cookie: userCookie } },
  );
  assert.equal(unauthorizedPage.status, 404);
  assert.equal(await unauthorizedPage.text(), "not found");
  for (const encodedPath of [
    `/instance/${instanceRef}/%74hread/${thread.publicRef}`,
    `/instance/${instanceRef}/t%68read/${thread.publicRef}`,
    `/in%73tance/ins_%41QEBAQEBAQEBAQEBAQEBAQ/thread/${thread.publicRef}`,
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}${encodedPath}`, { headers: { cookie: userCookie } });
    assert.equal(response.status, 404, encodedPath);
    assert.equal(await response.text(), "not found", encodedPath);
  }
  const malformedEncodedInstance = await fetch(
    `http://127.0.0.1:${port}/instance/%E0%A4%A/thread/${thread.publicRef}`,
    { headers: { cookie: userCookie } },
  );
  assert.equal(malformedEncodedInstance.status, 404);
  assert.equal(await malformedEncodedInstance.text(), "not found");

  for (const apiPath of ["api/threads", "%61pi/threads"]) {
    const unauthenticatedApi = await fetch(
      `http://127.0.0.1:${port}/instance/${instanceRef}/${apiPath}`,
    );
    assert.equal(unauthenticatedApi.status, 401, apiPath);
  }

  const adminChallenge = await createPairingChallenge({
    env: process.env,
    instanceId: "private-local-id",
  });
  await approvePairingChallenge(adminChallenge.challengeId, { approvedBy: "node:test", env: process.env });
  const adminSession = await pairBrowser({ challengeId: adminChallenge.challengeId, env: process.env });
  const adminCookie = sessionCookieHeader(adminSession.token, process.env, {
    path: `/instance/${instanceRef}`,
  }).split(";")[0];
  const authenticatedApi = await fetch(
    `http://127.0.0.1:${port}/instance/${instanceRef}/api/threads`,
    { headers: { cookie: adminCookie } },
  );
  assert.equal(authenticatedApi.status, 200);
  const logout = await fetch(
    `http://127.0.0.1:${port}/instance/${instanceRef}/api/setup/security/logout`,
    { method: "POST", headers: { cookie: adminCookie } },
  );
  assert.equal(logout.status, 200);
  assert.deepEqual(await logout.json(), { ok: true });
  assert.match(logout.headers.get("set-cookie") || "", /Max-Age=0/);
  const afterLogout = await fetch(
    `http://127.0.0.1:${port}/instance/${instanceRef}/api/threads`,
    { headers: { cookie: adminCookie } },
  );
  assert.equal(afterLogout.status, 401);
  const repeatedLogout = await fetch(
    `http://127.0.0.1:${port}/instance/${instanceRef}/api/setup/security/logout`,
    { method: "POST", headers: { cookie: adminCookie } },
  );
  assert.equal(repeatedLogout.status, 200);
  assert.deepEqual(await repeatedLogout.json(), { ok: true });
  assert.match(repeatedLogout.headers.get("set-cookie") || "", /Max-Age=0/);
  const repeatedRootLogout = await fetch(
    `http://127.0.0.1:${port}/api/setup/security/logout`,
    { method: "POST", headers: { cookie: adminCookie } },
  );
  assert.equal(repeatedRootLogout.status, 200);
  assert.deepEqual(await repeatedRootLogout.json(), { ok: true });
  assert.match(repeatedRootLogout.headers.get("set-cookie") || "", /Path=\/;[^,]*Max-Age=0/);
});

test("broker canonical gateway preserves HTTP bodies, queries, HTML base, streaming, and canonical cookie scope", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-canonical-broker-"));
  const keys = [
    "ORKESTR_HOME", "ORKESTR_THREAD_STORE", "ORKESTR_BROKER_INSTANCE_STORE",
    "ORKESTR_CANONICAL_INSTANCE_URLS", "ORKESTR_CANONICAL_APP_GATEWAY",
    "ORKESTR_OVERLAY_DIR", "ORKESTR_AUTH_REQUIRED",
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, {
    ORKESTR_HOME: home,
    ORKESTR_THREAD_STORE: "json",
    ORKESTR_BROKER_INSTANCE_STORE: "json",
    ORKESTR_CANONICAL_INSTANCE_URLS: "1",
    ORKESTR_CANONICAL_APP_GATEWAY: "1",
    ORKESTR_AUTH_REQUIRED: "0",
  });
  delete process.env.ORKESTR_OVERLAY_DIR;
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await fs.rm(home, { recursive: true, force: true });
  });

  const upstream = http.createServer((request, response) => {
    if (request.url === "/api/setup/status") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, url: request.url }));
      return;
    }
    if (request.url?.includes("/stream")) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: first\n\n");
      setTimeout(() => response.end("data: final\n\n"), 20);
      return;
    }
    if (request.method === "POST") {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ method: request.method, url: request.url, body: Buffer.concat(chunks).toString("utf8") }));
      });
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><base href=\"/\"><main>tenant</main>");
  });
  const upstreamWss = new WebSocketServer({ noServer: true });
  t.after(() => new Promise((resolve) => {
    for (const clientSocket of upstreamWss.clients) clientSocket.terminate();
    upstreamWss.close(() => resolve());
  }));
  upstream.on("upgrade", (request, socket, head) => {
    upstreamWss.handleUpgrade(request, socket, head, (clientSocket) => {
      clientSocket.on("message", (body) => clientSocket.send(`${request.url}|${body.toString()}`));
    });
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => upstream.close(resolve)));
  const client = __brokerInstanceRegistryTestInternals.createX25519Identity();
  const registration = await registerBrokerInstance({
    env: process.env,
    trustedAdmin: true,
    request: { ip: "127.0.0.1", headers: { "user-agent": "node:test" } },
    body: {
      encryptionPublicKey: client.publicKey,
      endpointBaseUrl: `http://127.0.0.1:${upstream.address().port}`,
      displayName: "Synthetic tenant",
    },
  });
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const port = server.address().port;
  const challenge = await createPairingChallenge({ env: process.env, instanceId: registration.instanceId });
  await approvePairingChallenge(challenge.challengeId, { approvedBy: "node:test", env: process.env });
  const pairedResponse = await fetch(`http://127.0.0.1:${port}/api/setup/security/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId: challenge.challengeId }),
  });
  assert.equal(pairedResponse.status, 200);
  const setCookies = pairedResponse.headers.getSetCookie();
  assert.ok(setCookies.some((value) => value.includes(`Path=/i/${registration.instanceId}/app`)));
  const canonicalCookie = setCookies.find((value) => value.includes(`Path=/instance/${registration.publicRef}`));
  assert.ok(canonicalCookie);
  assert.doesNotMatch(canonicalCookie, new RegExp(registration.instanceId));
  const cookie = canonicalCookie.split(";")[0];
  const base = `http://127.0.0.1:${port}/instance/${registration.publicRef}`;

  let wrongInstanceUpstreamHits = 0;
  const otherUpstream = http.createServer((_request, response) => {
    wrongInstanceUpstreamHits += 1;
    response.end("should not be reached");
  });
  await new Promise((resolve) => otherUpstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => otherUpstream.close(resolve)));
  const otherClient = __brokerInstanceRegistryTestInternals.createX25519Identity();
  const otherRegistration = await registerBrokerInstance({
    env: process.env,
    trustedAdmin: true,
    request: { ip: "127.0.0.1", headers: { "user-agent": "node:test" } },
    body: {
      encryptionPublicKey: otherClient.publicKey,
      endpointBaseUrl: `http://127.0.0.1:${otherUpstream.address().port}`,
      displayName: "Other synthetic tenant",
    },
  });
  const wrongInstance = await fetch(
    `http://127.0.0.1:${port}/instance/${otherRegistration.publicRef}/thread/${threadRef}`,
    { headers: { cookie } },
  );
  assert.equal(wrongInstance.status, 404);
  assert.equal(await wrongInstance.text(), "not found");
  assert.equal(wrongInstanceUpstreamHits, 0);

  const htmlResponse = await fetch(`${base}/thread/${threadRef}`, { headers: { cookie } });
  assert.equal(htmlResponse.status, 200);
  assert.match(await htmlResponse.text(), new RegExp(`<base href="/instance/${registration.publicRef}/"`));
  const postResponse = await fetch(`${base}/api/echo?keep=a%2Fb&n=2`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ hello: "world" }),
  });
  assert.deepEqual(await postResponse.json(), {
    method: "POST",
    url: "/api/echo?keep=a%2Fb&n=2",
    body: JSON.stringify({ hello: "world" }),
  });
  const setupStatusResponse = await fetch(`${base}/api/setup/status`, { headers: { cookie } });
  assert.equal(setupStatusResponse.headers.get("content-type"), "application/json");
  assert.deepEqual(await setupStatusResponse.json(), { ok: true, url: "/api/setup/status" });
  const streamResponse = await fetch(`${base}/api/stream`, { headers: { cookie } });
  assert.equal(streamResponse.headers.get("content-type"), "text/event-stream");
  assert.equal(await streamResponse.text(), "data: first\n\ndata: final\n\n");
  const wsMessage = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/instance/${registration.publicRef}/api/socket?keep=1`, {
      headers: { cookie },
    });
    let message = "";
    socket.once("open", () => socket.send("ping"));
    socket.once("message", (body) => { message = body.toString(); socket.close(); });
    socket.once("close", () => resolve(message));
    socket.once("error", reject);
  });
  assert.equal(wsMessage, "/api/socket?keep=1|ping");

  const logout = await fetch(`${base}/api/setup/security/logout`, {
    method: "POST",
    headers: { cookie },
  });
  assert.equal(logout.status, 200);
  assert.deepEqual(await logout.json(), { ok: true });
  assert.match(logout.headers.get("set-cookie") || "", /Max-Age=0/);
  const afterLogout = await fetch(`${base}/api/version`, { headers: { cookie } });
  assert.equal(afterLogout.status, 404);
  const repeatedLogout = await fetch(`${base}/api/setup/security/logout`, {
    method: "POST",
    headers: { cookie },
  });
  assert.equal(repeatedLogout.status, 200);
  assert.deepEqual(await repeatedLogout.json(), { ok: true });
  assert.match(repeatedLogout.headers.get("set-cookie") || "", /Max-Age=0/);

  const disabledChallenge = await createPairingChallenge({ env: process.env, instanceId: registration.instanceId });
  await approvePairingChallenge(disabledChallenge.challengeId, { approvedBy: "node:test", env: process.env });
  const disabledPair = await fetch(`http://127.0.0.1:${port}/api/setup/security/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId: disabledChallenge.challengeId }),
  });
  const disabledCookie = disabledPair.headers.getSetCookie()
    .find((value) => value.includes(`Path=/instance/${registration.publicRef}`))
    .split(";")[0];

  await updateBrokerInstanceRecord(registration.instanceId, { disabledAt: new Date().toISOString() }, process.env);
  const disabled = await fetch(`${base}/api/version`, { headers: { cookie: disabledCookie } });
  assert.equal(disabled.status, 404);
  assert.equal(await disabled.text(), "not found");
});
