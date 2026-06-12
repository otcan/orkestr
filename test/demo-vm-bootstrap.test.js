import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { readRuntimeSettings } from "../packages/core/src/runtime-settings.js";
import { readConnectorConfig } from "../packages/storage/src/config.js";
import { runDemoVmReadyNotify } from "../scripts/demo-vm-ready-notify.mjs";

const BROKER_UUID = "11111111-2222-4333-8444-555555555555";

function response(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() {
      return payload;
    },
  };
}

function brokerRegistrationPayload(instanceId = BROKER_UUID) {
  return {
    ok: true,
    instanceId,
    channelId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    registeredAt: "2026-06-11T00:00:00.000Z",
    broker: {
      keyId: "broker-key-1",
      publicKey: "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VuAyEA2IFd3Rdi7NTih5q0Glq82pzgjEycOnu/MpuxJdGzGn4=\n-----END PUBLIC KEY-----\n",
    },
    encryptedWelcome: {
      alg: "X25519-HKDF-SHA256+A256GCM",
      iv: "MTIzNDU2Nzg5MDEy",
      ciphertext: "Y2lwaGVydGV4dA==",
      tag: "MTIzNDU2Nzg5MDEyMzQ1Ng==",
    },
  };
}

function fakeCloudflaredSpawn(calls = []) {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 4242;
    child.kill = () => {
      child.killed = true;
      return true;
    };
    child.unref = () => {};
    child.stdout.unref = () => {};
    child.stderr.unref = () => {};
    calls.push({ command, args, options });
    setImmediate(() => {
      child.stderr.write("Your quick Tunnel has been created! Visit it at https://demo-onboarding.trycloudflare.com\n");
    });
    return child;
  };
}

test("demo VM notifier sends one relay readiness message and seeds relay settings", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-demo-vm-"));
  const calls = [];
  const tunnelCalls = [];
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_DEMO_WHATSAPP_NUMBER: "+49 176 123456",
    ORKESTR_DEMO_INSTANCE_ID: "orkestr-ui",
    ORKESTR_DEMO_SETUP_URL: "http://127.0.0.1:3000/setup",
    ORKESTR_CONNECT_PUBLIC_BASE_URL: "https://connect.orkestr.de",
    ORKESTR_DEMO_WHATSAPP_RELAY_URL: "http://relay.local/api/connectors/whatsapp/bridge",
    ORKESTR_DEMO_WHATSAPP_RELAY_TOKEN: "relay-secret",
    ORKESTR_DEMO_WHATSAPP_RELAY_ACCOUNT_ID: "responder",
    ORKESTR_DEMO_CLOUDFLARE_FALLBACK: "1",
    ORKESTR_DEMO_NOTIFY_HEALTH_TIMEOUT_MS: "0",
  };
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.pathname === "/api/broker/instances/register") {
      const body = JSON.parse(options.body);
      assert.match(body.encryptionPublicKey, /BEGIN PUBLIC KEY/);
      assert.equal(body.instanceId, undefined);
      return response(brokerRegistrationPayload());
    }
    if (url.pathname.endsWith("/health")) {
      return response({ ok: true, ready: true, accounts: [{ id: "responder", ready: true, state: "ready" }] });
    }
    assert.equal(url.pathname, "/api/connectors/whatsapp/bridge/send-text");
    assert.equal(options.headers.authorization, "Bearer relay-secret");
    const body = JSON.parse(options.body);
    assert.equal(body.to, "49176123456@c.us");
    assert.equal(body.accountId, "responder");
    assert.match(body.text, /Orkestr connect setup is ready/);
    assert.match(body.text, /challenge-gated connect link/);
    assert.match(body.text, /complete Codex login\/sign-in/i);
    assert.match(body.text, new RegExp(`https://connect\\.orkestr\\.de/i/${BROKER_UUID}/setup`));
    assert.doesNotMatch(body.text, /orkestr-ui/);
    assert.doesNotMatch(body.text, /127\.0\.0\.1|localhost/);
    assert.match(body.text, /Start the orkest thread/);
    assert.match(body.text, /browser-pairing challenge/);
    return response({ ok: true, sent: [{ id: "sent-demo-ready" }] });
  };

  const first = await runDemoVmReadyNotify(env, { fetchImpl, spawnImpl: fakeCloudflaredSpawn(tunnelCalls) });
  const second = await runDemoVmReadyNotify(env, { fetchImpl, spawnImpl: fakeCloudflaredSpawn(tunnelCalls) });
  const settings = await readRuntimeSettings(env);
  const connectorConfig = await readConnectorConfig("whatsapp", env);
  const state = JSON.parse(await fs.readFile(path.join(home, "demo-vm-ready-notification.json"), "utf8"));

  assert.equal(first.ok, true);
  assert.equal(first.sent, true);
  assert.equal(second.skipped, true);
  assert.equal(second.reason, "already_sent");
  assert.equal(tunnelCalls.length, 0);
  assert.equal(calls.filter((call) => call.url.pathname === "/api/broker/instances/register").length, 1);
  assert.equal(calls.filter((call) => call.url.pathname.endsWith("/send-text")).length, 1);
  assert.equal(settings.connectors.whatsapp.accessMode, "relay");
  assert.equal(settings.connectors.whatsapp.bridgeMode, "relay");
  assert.equal(connectorConfig.bridgeMode, "external");
  assert.equal(connectorConfig.bridgeUrl, "http://relay.local/api/connectors/whatsapp/bridge");
  assert.equal(connectorConfig.apiToken, "relay-secret");
  assert.equal(state.sent, true);
  assert.equal(state.state, "sent");
  assert.equal(state.setupUrl, `https://connect.orkestr.de/i/${BROKER_UUID}/setup`);
  assert.equal(state.setupUrlSource, "public_base_url");
  assert.equal(state.instanceId, BROKER_UUID);
  assert.equal(state.targetKey.length, 64);
  assert.doesNotMatch(JSON.stringify(state), /49176123456|176123456|relay-secret/);
});

test("demo VM notifier can use Cloudflare quick tunnel only as explicit fallback", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-demo-vm-cloudflare-"));
  const calls = [];
  const tunnelCalls = [];
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_DEMO_WHATSAPP_NUMBER: "+49 176 123456",
    ORKESTR_DEMO_SETUP_URL: "http://127.0.0.1:3000/setup",
    ORKESTR_DEMO_WHATSAPP_RELAY_URL: "http://relay.local/api/connectors/whatsapp/bridge",
    ORKESTR_DEMO_WHATSAPP_RELAY_TOKEN: "relay-secret",
    ORKESTR_DEMO_WHATSAPP_RELAY_ACCOUNT_ID: "responder",
    ORKESTR_DEMO_CLOUDFLARE_FALLBACK: "1",
    ORKESTR_DEMO_NOTIFY_HEALTH_TIMEOUT_MS: "0",
  };
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.pathname === "/api/broker/instances/register") return response(brokerRegistrationPayload());
    if (url.pathname.endsWith("/health")) {
      return response({ ok: true, ready: true, accounts: [{ id: "responder", ready: true, state: "ready" }] });
    }
    const body = JSON.parse(options.body);
    assert.match(body.text, new RegExp(`https://demo-onboarding\\.trycloudflare\\.com/i/${BROKER_UUID}/setup`));
    return response({ ok: true, sent: [{ id: "sent-demo-ready" }] });
  };

  const result = await runDemoVmReadyNotify(env, { fetchImpl, spawnImpl: fakeCloudflaredSpawn(tunnelCalls) });
  const state = JSON.parse(await fs.readFile(path.join(home, "demo-vm-ready-notification.json"), "utf8"));
  const tunnelState = JSON.parse(await fs.readFile(path.join(home, "demo-cloudflare-tunnel.json"), "utf8"));

  assert.equal(result.ok, true);
  assert.equal(result.sent, true);
  assert.equal(tunnelCalls.length, 1);
  assert.deepEqual(tunnelCalls[0].args, ["tunnel", "--url", "http://127.0.0.1:3000", "--no-autoupdate"]);
  assert.equal(state.setupUrlSource, "cloudflare_quick_tunnel");
  assert.equal(state.instanceId, BROKER_UUID);
  assert.equal(tunnelState.state, "ready");
  assert.equal(tunnelState.url, "https://demo-onboarding.trycloudflare.com");
  assert.equal(calls.filter((call) => call.url.pathname.endsWith("/send-text")).length, 1);
});

test("demo VM notifier keeps legacy demo public URL env compatibility", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-demo-vm-legacy-url-"));
  const calls = [];
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_DEMO_WHATSAPP_NUMBER: "+49 176 123456",
    ORKESTR_DEMO_PUBLIC_BASE_URL: "https://legacy-demo.example.test",
    ORKESTR_DEMO_WHATSAPP_RELAY_URL: "http://relay.local/api/connectors/whatsapp/bridge",
    ORKESTR_DEMO_NOTIFY_HEALTH_TIMEOUT_MS: "0",
  };
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.pathname === "/api/broker/instances/register") return response(brokerRegistrationPayload());
    if (url.pathname.endsWith("/health")) return response({ ok: true, ready: true, accounts: [{ id: "responder", ready: true, state: "ready" }] });
    const body = JSON.parse(options.body);
    assert.match(body.text, new RegExp(`https://legacy-demo\\.example\\.test/i/${BROKER_UUID}/setup`));
    return response({ ok: true, sent: [{ id: "sent-demo-ready" }] });
  };

  const result = await runDemoVmReadyNotify(env, { fetchImpl });

  assert.equal(result.ok, true);
  assert.equal(result.sent, true);
  assert.equal(calls.filter((call) => call.url.pathname.endsWith("/send-text")).length, 1);
});

test("demo VM notifier blocks without a pre-provisioned relay URL but keeps startup non-fatal", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-demo-vm-no-relay-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_DEMO_WHATSAPP_NUMBER: "+49 176 654321",
    ORKESTR_DEMO_PUBLIC_BASE_URL: "https://demo-public.example.test",
    ORKESTR_DEMO_NOTIFY_HEALTH_TIMEOUT_MS: "0",
  };

  const result = await runDemoVmReadyNotify(env, {
    async fetchImpl(url) {
      assert.equal(url.pathname, "/api/broker/instances/register");
      return response(brokerRegistrationPayload());
    },
  });
  const settings = await readRuntimeSettings(env);
  const state = JSON.parse(await fs.readFile(path.join(home, "demo-vm-ready-notification.json"), "utf8"));

  assert.equal(result.ok, false);
  assert.equal(result.reason, "relay_bridge_url_missing");
  assert.equal(settings.connectors.whatsapp.accessMode, "relay");
  assert.equal(state.sent, false);
  assert.equal(state.reason, "relay_bridge_url_missing");
  assert.equal(state.setupUrl, `https://demo-public.example.test/i/${BROKER_UUID}/setup`);
  assert.equal(state.instanceId, BROKER_UUID);
});

test("demo VM notifier blocks instead of sending a localhost setup link when Cloudflare is unavailable", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-demo-vm-no-cloudflare-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_DEMO_WHATSAPP_NUMBER: "+49 176 654321",
    ORKESTR_DEMO_WHATSAPP_RELAY_URL: "http://relay.local/api/connectors/whatsapp/bridge",
    ORKESTR_DEMO_CLOUDFLARE_FALLBACK: "1",
    ORKESTR_DEMO_NOTIFY_HEALTH_TIMEOUT_MS: "0",
  };
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    child.unref = () => {};
    setImmediate(() => child.emit("error", Object.assign(new Error("not found"), { code: "ENOENT" })));
    return child;
  };

  const result = await runDemoVmReadyNotify(env, {
    spawnImpl,
    async fetchImpl(url) {
      assert.equal(url.pathname, "/api/broker/instances/register");
      return response(brokerRegistrationPayload());
    },
  });
  const state = JSON.parse(await fs.readFile(path.join(home, "demo-vm-ready-notification.json"), "utf8"));

  assert.equal(result.ok, false);
  assert.equal(result.reason, "cloudflared_not_found");
  assert.equal(state.sent, false);
  assert.equal(state.reason, "cloudflared_not_found");
  assert.doesNotMatch(JSON.stringify(state), /127\.0\.0\.1|localhost/);
});

test("demo VM notifier does not start Cloudflare unless fallback is enabled", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-demo-vm-no-public-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_DEMO_WHATSAPP_NUMBER: "+49 176 654321",
    ORKESTR_DEMO_WHATSAPP_RELAY_URL: "http://relay.local/api/connectors/whatsapp/bridge",
    ORKESTR_DEMO_NOTIFY_HEALTH_TIMEOUT_MS: "0",
  };

  const result = await runDemoVmReadyNotify(env, {
    spawnImpl() {
      throw new Error("cloudflare_should_not_start");
    },
    async fetchImpl(url) {
      assert.equal(url.pathname, "/api/broker/instances/register");
      return response(brokerRegistrationPayload());
    },
  });
  const state = JSON.parse(await fs.readFile(path.join(home, "demo-vm-ready-notification.json"), "utf8"));

  assert.equal(result.ok, false);
  assert.equal(result.reason, "cloudflare_tunnel_not_enabled");
  assert.equal(state.reason, "cloudflare_tunnel_not_enabled");
  assert.doesNotMatch(JSON.stringify(state), /127\.0\.0\.1|localhost/);
});

test("demo VM contract is private, WhatsApp-number driven, and part of smoke scripts", async () => {
  const [entrypoint, dockerfile, values, deployment, smoke, pkg, readme] = await Promise.all([
    fs.readFile("docker-entrypoint.sh", "utf8"),
    fs.readFile("Dockerfile", "utf8"),
    fs.readFile("charts/orkestr/values.yaml", "utf8"),
    fs.readFile("charts/orkestr/templates/deployment.yaml", "utf8"),
    fs.readFile("scripts/smoke-k3s-oss-demo.mjs", "utf8"),
    fs.readFile("package.json", "utf8"),
    fs.readFile("README.md", "utf8"),
  ]);

  assert.match(entrypoint, /ORKESTR_DEMO_WHATSAPP_NUMBER/);
  assert.match(entrypoint, /demo-vm-ready-notify\.mjs/);
  assert.match(entrypoint, /ORKESTR_DEMO_MODE/);
  assert.match(entrypoint, /ORKESTR_DESKTOP_IDLE_STOP_MS/);
  assert.match(entrypoint, /ORKESTR_DESKTOP_GEOMETRY/);
  assert.match(entrypoint, /MALLOC_ARENA_MAX/);
  assert.match(dockerfile, /ORKESTR_DESKTOP_IDLE_STOP_MS=600000/);
  assert.match(dockerfile, /ORKESTR_DESKTOP_GEOMETRY=1280x720x16/);
  assert.match(dockerfile, /ORKESTR_DESKTOP_WINDOW_SIZE=1280,720/);
  assert.match(dockerfile, /MALLOC_ARENA_MAX=2/);
  assert.match(values, /demo:/);
  assert.match(values, /whatsappNumber: ""/);
  assert.doesNotMatch(values, /instanceId: ""/);
  assert.match(values, /publicBaseUrl: ""/);
  assert.match(values, /cloudflareFallback: false/);
  assert.match(values, /type: ClusterIP/);
  assert.match(deployment, /ORKESTR_DEMO_WHATSAPP_NUMBER/);
  assert.doesNotMatch(deployment, /ORKESTR_DEMO_INSTANCE_ID/);
  assert.match(deployment, /ORKESTR_DEMO_BROKER_BASE_URL/);
  assert.match(deployment, /ORKESTR_DEMO_BROKER_REGISTRATION_TOKEN/);
  assert.match(deployment, /ORKESTR_CONNECT_PUBLIC_BASE_URL/);
  assert.match(deployment, /ORKESTR_CONNECT_PUBLIC_SETUP_URL/);
  assert.match(deployment, /ORKESTR_DEMO_PUBLIC_BASE_URL/);
  assert.match(deployment, /ORKESTR_DEMO_CLOUDFLARE_FALLBACK/);
  assert.match(deployment, /ORKESTR_DEMO_CLOUDFLARE_DISABLE/);
  assert.match(deployment, /ORKESTR_DEMO_WHATSAPP_RELAY_TOKEN/);
  assert.match(smoke, /demo-vm-ready-notify\.mjs/);
  assert.match(pkg, /"smoke:demo-vm": "node --test test\/demo-vm-bootstrap\.test\.js"/);
  assert.match(pkg, /"e2e:whatsapp-demo-onboarding": "node scripts\/real-wa-demo-onboarding\.mjs"/);
  assert.match(readme, /Private VM Demo/);
  assert.match(readme, /ORKESTR_DEMO_WHATSAPP_NUMBER/);
  assert.match(readme, /ORKESTR_CONNECT_PUBLIC_BASE_URL/);
  assert.match(readme, /https:\/\/connect\.orkestr\.de/);
  assert.match(readme, /Cloudflare quick tunnel fallback/);
  assert.match(readme, /browser pairing/);
});
