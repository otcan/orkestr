import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { __brokerInstanceRegistryTestInternals, registerBrokerInstance } from "../packages/core/src/broker-instance-registry.js";
import { createTenantVm } from "../packages/core/src/tenant-vm-registry.js";
import { userDataPaths } from "../packages/storage/src/paths.js";
import { eventsOfType, findFiles, pairedCookie, rawRequest, startFixtureServer } from "./support/connector-security-fixture.js";

// ORK-512: the tenant Google Workspace connect flow through the parent broker
// proxy, end to end with a fake tenant upstream and fake OAuth configuration.

async function brokerFixture() {
  const fixture = await startFixtureServer();
  const upstreamRequests = [];
  const upstream = http.createServer((request, response) => {
    upstreamRequests.push({ method: request.method, url: request.url });
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("not found");
  });
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const client = __brokerInstanceRegistryTestInternals.createX25519Identity();
  const registration = await registerBrokerInstance({
    env: process.env,
    trustedAdmin: true,
    request: { ip: "127.0.0.1", headers: { "user-agent": "node:test" } },
    body: {
      encryptionPublicKey: client.publicKey,
      displayName: "tenant-demo",
      endpointBaseUrl: `http://127.0.0.1:${upstream.address().port}`,
    },
  });
  await createTenantVm({ id: "tenant-demo-vm", ownerUserId: "tenant-owner", labels: { brokerInstanceId: registration.instanceId } }, process.env);
  const instanceId = registration.instanceId;
  const authIntentCookie = () => pairedCookie({
    instanceId,
    userId: "tenant-owner",
    role: "user",
    requestedPath: `/i/${instanceId}/app/connectors/gmail`,
    allowedActions: ["orkestr_auth.google.connect"],
    authIntent: {
      mcp: "tools/call",
      tool: "orkestr_auth",
      service: "gmail",
      provider: "google_workspace",
      action: "connect",
      instanceId,
      userId: "tenant-owner",
      threadId: "tenant-thread",
      connectionAlias: "work",
    },
  });
  const call = (pathname, { method = "POST", cookie = "", body = {}, headers = {} } = {}) => rawRequest(fixture.port, {
    method,
    pathname: `/i/${instanceId}/app/api/connectors/gmail/oauth/${pathname}`,
    headers: {
      ...(method === "POST" ? { "content-type": "application/json", origin: fixture.origin } : {}),
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: method === "POST" ? body : "",
  });
  return {
    fixture,
    instanceId,
    upstreamRequests,
    authIntentCookie,
    call,
    stateFile: path.join(userDataPaths("tenant-owner", process.env).oauth, "gmail-state.json"),
    async close() {
      await new Promise((resolve) => upstream.close(resolve));
      await fixture.close();
    },
  };
}

test("tenant connect: intent then start writes brokered OAuth state bound to the instance owner", async () => {
  const item = await brokerFixture();
  try {
    const cookie = await item.authIntentCookie();
    const intent = await item.call("intent", { cookie, body: { account: "Owner@Example.test", capabilities: ["gmail_send"] } });
    assert.equal(intent.status, 201, intent.text);
    const started = await item.call("start", { cookie, body: { intentId: intent.json.intentId, token: intent.json.token } });
    assert.equal(started.status, 200, started.text);
    assert.equal(started.json.provider, "google_workspace");
    assert.deepEqual(started.json.capabilities, ["gmail_send"]);
    assert.equal(new URL(started.json.authorizeUrl).searchParams.get("login_hint"), "owner@example.test");

    const saved = JSON.parse(await fs.readFile(item.stateFile, "utf8"));
    assert.equal(saved.state, started.json.state);
    assert.equal(saved.userId, "tenant-owner");
    assert.equal(saved.initiatorUserId, "tenant-owner");
    assert.equal(saved.brokerInstanceId, item.instanceId);
    assert.equal(saved.brokerTenantVmId, "tenant-demo-vm");
    assert.equal(saved.threadId, "tenant-thread");
    assert.equal(saved.connectionAlias, "work");
    assert.equal(item.upstreamRequests.some((request) => String(request.url).startsWith("/api/connectors/gmail/oauth")), false);

    const replay = await item.call("start", { cookie, body: { intentId: intent.json.intentId, token: intent.json.token } });
    assert.equal(replay.status, 403);
    assert.equal(replay.json.error, "connector_use_intent_replayed");
    assert.equal(JSON.parse(await fs.readFile(item.stateFile, "utf8")).state, started.json.state);
  } finally {
    await item.close();
  }
});

test("tenant connect: anonymous, GET, cross-site, other-session and substituted starts fail without state", async () => {
  const item = await brokerFixture();
  try {
    const cookie = await item.authIntentCookie();
    const otherSession = await item.authIntentCookie();

    const anonymousIntent = await item.call("intent", { body: {} });
    assert.equal(anonymousIntent.status, 401);
    assert.equal(anonymousIntent.text, "broker_instance_pairing_required");

    const legit = (await item.call("intent", { cookie, body: { account: "owner@example.test" } })).json;
    const anonymousStart = await item.call("start", { body: legit });
    assert.equal(anonymousStart.status, 401);

    const getStart = await item.call(`start?account=victim%40example.test`, { method: "GET", cookie });
    assert.equal(getStart.status, 405);
    assert.equal(getStart.json.error, "oauth_start_requires_post");

    const crossSite = await item.call("start", { cookie, body: legit, headers: { origin: "https://attacker.example.test" } });
    assert.equal(crossSite.status, 403);
    assert.equal(crossSite.json.error, "origin_not_allowed");

    const hijacked = await item.call("start", { cookie: otherSession, body: legit });
    assert.equal(hijacked.status, 403);
    assert.equal(hijacked.json.error, "connector_use_intent_session_mismatch");

    const second = (await item.call("intent", { cookie, body: { account: "owner@example.test" } })).json;
    const substituted = await item.call("start", { cookie, body: { ...second, account: "attacker@example.test" } });
    assert.equal(substituted.status, 403);
    assert.equal(substituted.json.error, "connector_use_intent_binding_mismatch");

    assert.deepEqual(await findFiles(item.fixture.home, "gmail-state.json"), []);
    assert.equal(item.upstreamRequests.length, 0, "rejected brokered starts are never forwarded to the tenant");
    assert.ok((await eventsOfType("gmail_oauth_start_rejected")).some((event) => event.reason === "oauth_start_requires_post"));
  } finally {
    await item.close();
  }
});
