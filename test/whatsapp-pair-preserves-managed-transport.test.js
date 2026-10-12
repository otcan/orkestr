import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { configuredWhatsAppBridgeUrl } from "../packages/connectors/src/whatsapp.js";
import { readConnectorConfig, writeConnectorConfig } from "../packages/storage/src/config.js";
import {
  resetLocalWhatsAppBridgeForTest,
  setLocalWhatsAppRuntimeForTest,
} from "../dist/server/packages/connectors/src/whatsapp-local-bridge.js";

const envKeys = [
  "ORKESTR_HOME",
  "ORKESTR_RECOVER_RUNNING_ON_START",
  "ORKESTR_WHATSAPP_ACCOUNT_IDS",
  "ORKESTR_WHATSAPP_AUTOSTART",
  "WHATSAPP_BRIDGE_MODE",
  "WHATSAPP_BRIDGE_URL",
  "ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED",
];

async function post(origin, route, body) {
  const response = await fetch(`${origin}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

test("QR pairing preserves an existing managed transport through preference, start, switch-back, and refresh", { timeout: 60_000 }, async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-pair-transport-"));
  const previous = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  Object.assign(process.env, {
    ORKESTR_HOME: home,
    ORKESTR_RECOVER_RUNNING_ON_START: "0",
    ORKESTR_WHATSAPP_ACCOUNT_IDS: "account-1",
    ORKESTR_WHATSAPP_AUTOSTART: "0",
  });
  await writeConnectorConfig("whatsapp", {
    bridgeMode: "relay",
    bridgeUrl: "https://relay.example.test/synthetic",
  }, process.env);
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const origin = `http://127.0.0.1:${server.address().port}`;

  try {
    assert.equal(await configuredWhatsAppBridgeUrl(process.env), "https://relay.example.test/synthetic");

    // This is the exact request now made by the QR panel before starting its local account.
    const selectedSelfHosted = await post(origin, "/api/setup/demo-preferences", { whatsappAccessMode: "self_hosted" });
    assert.equal(selectedSelfHosted.status, 200, JSON.stringify(selectedSelfHosted.body));
    assert.equal(await configuredWhatsAppBridgeUrl(process.env), "");
    const localConfig = await readConnectorConfig("whatsapp", process.env);
    assert.equal(localConfig.bridgeMode, "local");
    assert.equal(localConfig.managedBridgeMode, "relay");
    assert.equal(localConfig.bridgeUrl, "https://relay.example.test/synthetic");

    // A synthetic runtime makes the real account-start API safe and deterministic.
    setLocalWhatsAppRuntimeForTest("account-1", {
      client: {
        info: { wid: { _serialized: "15550000001@c.us", user: "15550000001" } },
        async destroy() {},
      },
    }, {
      state: "qr_needed",
      ready: false,
      authenticated: false,
      qrAvailable: true,
    }, process.env);
    const started = await post(origin, "/api/connectors/whatsapp/bridge/accounts/account-1/start", {});
    assert.equal(started.status, 202, JSON.stringify(started.body));

    const selectedManaged = await post(origin, "/api/setup/demo-preferences", { whatsappAccessMode: "managed" });
    assert.equal(selectedManaged.status, 200, JSON.stringify(selectedManaged.body));
    assert.equal((await readConnectorConfig("whatsapp", process.env)).bridgeMode, "relay");
    assert.equal(await configuredWhatsAppBridgeUrl(process.env), "https://relay.example.test/synthetic");

    const refreshed = await (await fetch(`${origin}/api/setup/status`)).json();
    assert.equal(refreshed.whatsappOnboarding?.selectedMode, "managed");
    assert.ok(refreshed.whatsappOnboarding?.availableModes?.includes("managed"));
    assert.equal((await readConnectorConfig("whatsapp", process.env)).bridgeUrl, "https://relay.example.test/synthetic");

    const panel = await fs.readFile("apps/web/src/app/whatsapp-pair-panel.component.ts", "utf8");
    const bundle = await fs.readFile("dist/web/browser/main.js", "utf8");
    assert.doesNotMatch(panel, /saveConnectorConfig\(["']whatsapp["']/);
    assert.match(panel, /saveSetupDemoPreferences\(\{\s*whatsappAccessMode:\s*["']self_hosted["']/);
    assert.doesNotMatch(bundle, /saveConnectorConfig\(["']whatsapp["'],\{bridgeMode:["']local["']\}\)/);
    assert.match(bundle, /saveSetupDemoPreferences\(\{whatsappAccessMode:["']self_hosted["']\}\)/);
  } finally {
    await resetLocalWhatsAppBridgeForTest(process.env);
    await new Promise((resolve) => server.close(resolve));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
});
