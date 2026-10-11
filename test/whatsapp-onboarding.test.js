import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readConnectorConfig, writeConnectorConfig } from "../packages/storage/src/config.js";
import { configuredWhatsAppBridgeUrl, effectiveWhatsAppBridgeMode } from "../packages/connectors/src/whatsapp.js";
import { assertWhatsAppOnboardingModeAvailable, whatsappOnboardingStatus } from "../packages/connectors/src/whatsapp-onboarding.js";
import { saveWhatsAppOnboardingMode } from "../packages/core/src/whatsapp-onboarding-preferences.js";

async function withTempHome(run) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-whatsapp-onboarding-"));
  try {
    await run({ ORKESTR_HOME: home });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

async function saveMode(mode, env) {
  return saveWhatsAppOnboardingMode(mode, env, effectiveWhatsAppBridgeMode);
}

test("self-hosted onboarding is the default and never advertises an unconfigured managed relay", async () => {
  await withTempHome(async (env) => {
    const status = await whatsappOnboardingStatus({ env, settings: {}, connectors: [] });
    assert.deepEqual(status.availableModes, ["self_hosted"]);
    assert.equal(status.selectedMode, "self_hosted");
    assert.equal(status.pairingState, "not_started");
    assert.equal(status.health, "not_connected");
    assert.equal(await assertWhatsAppOnboardingModeAvailable("own", env), "own");
    await assert.rejects(() => assertWhatsAppOnboardingModeAvailable("managed", env), { code: "whatsapp_managed_mode_unavailable", statusCode: 409 });
  });
});

test("managed mode is advertised only from server bridge configuration and contains no endpoint or account data", async () => {
  await withTempHome(async (baseEnv) => {
    const env = { ...baseEnv };
    await writeConnectorConfig("whatsapp", { bridgeMode: "relay", bridgeUrl: "https://relay.example.test/private" }, env);
    const settings = { connectors: { whatsapp: { accessMode: "relay" } } };
    const connector = {
      id: "whatsapp",
      state: "partial",
      details: { state: "pairing_code", pairingCode: "not-for-projection", accounts: [{ id: "synthetic-account" }] },
    };
    const status = await whatsappOnboardingStatus({ env, settings, connectors: [connector] });
    assert.deepEqual(status.availableModes, ["self_hosted", "managed"]);
    assert.equal(status.selectedMode, "managed");
    assert.equal(status.health, "partial");
    assert.equal(status.pairingState, "pairing_code");
    assert.equal(await assertWhatsAppOnboardingModeAvailable("managed", env), "relay");
    const projection = JSON.stringify(status);
    assert.doesNotMatch(projection, /relay\.example\.test|not-for-projection|synthetic-account/);
  });
});

test("status follows effective relay transport instead of a stale self-hosted preference", async () => {
  await withTempHome(async (env) => {
    await writeConnectorConfig("whatsapp", { bridgeMode: "relay", bridgeUrl: "https://relay.example.test/private" }, env);
    const status = await whatsappOnboardingStatus({
      env,
      settings: { connectors: { whatsapp: { accessMode: "own", bridgeMode: "local" } } },
      connectors: [],
    });
    assert.equal(status.selectedMode, "managed");
  });
});

test("managed selection cannot promote a disabled external connector based only on its saved URL", async () => {
  await withTempHome(async (env) => {
    await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://relay.example.test" }, env);
    assert.equal(await configuredWhatsAppBridgeUrl(env), "", "external mode is locally disabled without the environment enable gate");
    await assert.rejects(async () => {
      const transport = await assertWhatsAppOnboardingModeAvailable("managed", env);
      await saveMode(transport, env);
    }, { code: "whatsapp_managed_mode_unavailable", statusCode: 409 });
    assert.equal((await readConnectorConfig("whatsapp", env)).bridgeMode, "external");
    assert.equal(await configuredWhatsAppBridgeUrl(env), "");
  });
});

test("enabled external configuration may select managed without rewriting it to an ungated relay alias", async () => {
  await withTempHome(async (baseEnv) => {
    const env = { ...baseEnv, ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "true" };
    await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://relay.example.test" }, env);
    assert.equal(await configuredWhatsAppBridgeUrl(env), "http://relay.example.test");
    assert.equal(await assertWhatsAppOnboardingModeAvailable("managed", env), "relay");

    await saveMode("relay", env);

    assert.equal((await readConnectorConfig("whatsapp", env)).bridgeMode, "external");
    assert.equal(await configuredWhatsAppBridgeUrl(env), "http://relay.example.test");
  });
});

test("invalid access mode fails closed instead of silently switching to a relay", async () => {
  await withTempHome(async (env) => {
    await assert.rejects(() => assertWhatsAppOnboardingModeAvailable("surprise", env), { code: "whatsapp_access_mode_invalid", statusCode: 400 });
  });
});

test("forced external bridge mode disables local pairing and denies it server-side", async () => {
  await withTempHome(async (baseEnv) => {
    const env = { ...baseEnv, WHATSAPP_BRIDGE_MODE: "external" };
    const status = await whatsappOnboardingStatus({ env, settings: {}, connectors: [] });
    assert.deepEqual(status.availableModes, []);
    assert.equal(status.selectedMode, null);
    await assert.rejects(() => assertWhatsAppOnboardingModeAvailable("own", env), { code: "whatsapp_self_hosted_mode_unavailable", statusCode: 409 });
  });
});

test("selecting self-hosted must switch an existing relay connector to its local transport", async () => {
  await withTempHome(async (env) => {
    await writeConnectorConfig("whatsapp", { bridgeMode: "relay", bridgeUrl: "https://relay.example.test/private" }, env);
    assert.equal(await configuredWhatsAppBridgeUrl(env), "https://relay.example.test/private");

    const result = await saveMode("own", env);

    assert.equal((await readConnectorConfig("whatsapp", env)).bridgeMode, "local");
    assert.equal(await configuredWhatsAppBridgeUrl(env), "", "connector must not keep routing through the old relay after self-hosted is selected");
  });
});

test("fresh install self-hosted selection persists the same effective local transport", async () => {
  await withTempHome(async (env) => {
    await saveMode("own", env);
    assert.equal((await readConnectorConfig("whatsapp", env)).bridgeMode, "local");
    assert.equal(await configuredWhatsAppBridgeUrl(env), "");
  });
});

test("managed selection stays on the configured relay and can switch back from self-hosted", async () => {
  await withTempHome(async (env) => {
    await writeConnectorConfig("whatsapp", { bridgeMode: "relay", bridgeUrl: "https://relay.example.test/private" }, env);
    await saveMode("own", env);
    assert.equal(await configuredWhatsAppBridgeUrl(env), "");

    await saveMode("relay", env);
    assert.equal((await readConnectorConfig("whatsapp", env)).bridgeMode, "relay");
    assert.equal(await configuredWhatsAppBridgeUrl(env), "https://relay.example.test/private");
  });
});

test("environment-forced relay refuses self-hosted selection without changing effective transport", async () => {
  await withTempHome(async (baseEnv) => {
    await writeConnectorConfig("whatsapp", { bridgeMode: "relay", bridgeUrl: "https://relay.example.test/private" }, baseEnv);
    const env = { ...baseEnv, WHATSAPP_BRIDGE_MODE: "external" };
    await assert.rejects(() => assertWhatsAppOnboardingModeAvailable("self_hosted", env), { code: "whatsapp_self_hosted_mode_unavailable", statusCode: 409 });
    assert.equal(await configuredWhatsAppBridgeUrl(env), "https://relay.example.test/private");
  });
});
