import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeConnectorConfig } from "../packages/storage/src/config.js";
import { assertWhatsAppOnboardingModeAvailable, whatsappOnboardingStatus } from "../packages/connectors/src/whatsapp-onboarding.js";

async function withTempHome(run) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-whatsapp-onboarding-"));
  try {
    await run({ ORKESTR_HOME: home });
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
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
