import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readRuntimeSettings } from "../packages/core/src/runtime-settings.js";
import { readConnectorConfig } from "../packages/storage/src/config.js";
import { runDemoVmReadyNotify } from "../scripts/demo-vm-ready-notify.mjs";

function response(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() {
      return payload;
    },
  };
}

test("demo VM notifier sends one relay readiness message and seeds relay settings", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-demo-vm-"));
  const calls = [];
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_DEMO_WHATSAPP_NUMBER: "+49 176 123456",
    ORKESTR_DEMO_SETUP_URL: "http://127.0.0.1:3000/setup",
    ORKESTR_DEMO_WHATSAPP_RELAY_URL: "http://relay.local/api/connectors/whatsapp/bridge",
    ORKESTR_DEMO_WHATSAPP_RELAY_TOKEN: "relay-secret",
    ORKESTR_DEMO_WHATSAPP_RELAY_ACCOUNT_ID: "responder",
    ORKESTR_DEMO_NOTIFY_HEALTH_TIMEOUT_MS: "0",
  };
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.pathname.endsWith("/health")) {
      return response({ ok: true, ready: true, accounts: [{ id: "responder", ready: true, state: "ready" }] });
    }
    assert.equal(url.pathname, "/api/connectors/whatsapp/bridge/send-text");
    assert.equal(options.headers.authorization, "Bearer relay-secret");
    const body = JSON.parse(options.body);
    assert.equal(body.to, "49176123456@c.us");
    assert.equal(body.accountId, "responder");
    assert.match(body.text, /Orkestr demo VM is ready/);
    assert.match(body.text, /complete Codex login\/sign-in/i);
    assert.match(body.text, /http:\/\/127\.0\.0\.1:3000\/setup/);
    assert.match(body.text, /Start the orkest thread/);
    assert.match(body.text, /No public app URL is required/);
    return response({ ok: true, sent: [{ id: "sent-demo-ready" }] });
  };

  const first = await runDemoVmReadyNotify(env, { fetchImpl });
  const second = await runDemoVmReadyNotify(env, { fetchImpl });
  const settings = await readRuntimeSettings(env);
  const connectorConfig = await readConnectorConfig("whatsapp", env);
  const state = JSON.parse(await fs.readFile(path.join(home, "demo-vm-ready-notification.json"), "utf8"));

  assert.equal(first.ok, true);
  assert.equal(first.sent, true);
  assert.equal(second.skipped, true);
  assert.equal(second.reason, "already_sent");
  assert.equal(calls.filter((call) => call.url.pathname.endsWith("/send-text")).length, 1);
  assert.equal(settings.connectors.whatsapp.accessMode, "relay");
  assert.equal(settings.connectors.whatsapp.bridgeMode, "relay");
  assert.equal(connectorConfig.bridgeMode, "external");
  assert.equal(connectorConfig.bridgeUrl, "http://relay.local/api/connectors/whatsapp/bridge");
  assert.equal(connectorConfig.apiToken, "relay-secret");
  assert.equal(state.sent, true);
  assert.equal(state.state, "sent");
  assert.equal(state.setupUrl, "http://127.0.0.1:3000/setup");
  assert.equal(state.targetKey.length, 64);
  assert.doesNotMatch(JSON.stringify(state), /49176123456|176123456|relay-secret/);
});

test("demo VM notifier blocks without a pre-provisioned relay URL but keeps startup non-fatal", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-demo-vm-no-relay-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_DEMO_WHATSAPP_NUMBER: "+49 176 654321",
    ORKESTR_DEMO_NOTIFY_HEALTH_TIMEOUT_MS: "0",
  };

  const result = await runDemoVmReadyNotify(env, {
    async fetchImpl() {
      throw new Error("fetch_should_not_run");
    },
  });
  const settings = await readRuntimeSettings(env);
  const state = JSON.parse(await fs.readFile(path.join(home, "demo-vm-ready-notification.json"), "utf8"));

  assert.equal(result.ok, false);
  assert.equal(result.reason, "relay_bridge_url_missing");
  assert.equal(settings.connectors.whatsapp.accessMode, "relay");
  assert.equal(state.sent, false);
  assert.equal(state.reason, "relay_bridge_url_missing");
});

test("demo VM contract is private, WhatsApp-number driven, and part of smoke scripts", async () => {
  const [entrypoint, values, deployment, smoke, pkg, readme] = await Promise.all([
    fs.readFile("docker-entrypoint.sh", "utf8"),
    fs.readFile("charts/orkestr/values.yaml", "utf8"),
    fs.readFile("charts/orkestr/templates/deployment.yaml", "utf8"),
    fs.readFile("scripts/smoke-k3s-oss-demo.mjs", "utf8"),
    fs.readFile("package.json", "utf8"),
    fs.readFile("README.md", "utf8"),
  ]);

  assert.match(entrypoint, /ORKESTR_DEMO_WHATSAPP_NUMBER/);
  assert.match(entrypoint, /demo-vm-ready-notify\.mjs/);
  assert.match(values, /demo:/);
  assert.match(values, /whatsappNumber: ""/);
  assert.match(values, /type: ClusterIP/);
  assert.match(deployment, /ORKESTR_DEMO_WHATSAPP_NUMBER/);
  assert.match(deployment, /ORKESTR_DEMO_WHATSAPP_RELAY_TOKEN/);
  assert.match(smoke, /demo-vm-ready-notify\.mjs/);
  assert.match(pkg, /"smoke:demo-vm": "node --test test\/demo-vm-bootstrap\.test\.js"/);
  assert.match(pkg, /"e2e:whatsapp-demo-onboarding": "node scripts\/real-wa-demo-onboarding\.mjs"/);
  assert.match(readme, /Private VM Demo/);
  assert.match(readme, /ORKESTR_DEMO_WHATSAPP_NUMBER/);
  assert.doesNotMatch(readme, /app\.orkestr\.de/);
});
