import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getWhatsAppStatus } from "../packages/connectors/src/whatsapp.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";

function externalBridgeEnv(home) {
  return {
    ORKESTR_HOME: home,
    ORKESTR_WHATSAPP_EXTERNAL_BRIDGE_ENABLED: "1",
    ORKESTR_WA_WORKER_SOCKET: "/run/orkestr-wa/sender.sock",
  };
}

test("whatsapp status prefers a configured dedicated worker over a stale external bridge snapshot", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-worker-status-"));
  const env = externalBridgeEnv(home);
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, env);
  let externalFetches = 0;

  const status = await getWhatsAppStatus(env, async () => {
    externalFetches += 1;
    throw new Error("stale external bridge should not be queried");
  }, {
    workerHealthFn: async () => ({
      ok: true,
      state: "ready",
      ready: true,
      clientReady: true,
      authenticated: true,
      accounts: [{ accountId: "sender", state: "ready", ready: true, authenticated: true, chatOpsReady: true, runtimeUsable: true }],
    }),
  });

  assert.equal(status.state, "paired");
  assert.equal(status.mode, "worker");
  assert.equal(status.accounts[0].state, "ready");
  assert.equal(status.accounts[0].ready, true);
  assert.equal(externalFetches, 0);
});

test("dedicated worker status keeps phone pairing codes available", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-worker-pair-code-"));
  const env = externalBridgeEnv(home);
  await writeConnectorConfig("whatsapp", { bridgeMode: "external", bridgeUrl: "http://wa.local" }, env);

  const status = await getWhatsAppStatus(env, async () => {
    throw new Error("external bridge must not override dedicated worker pairing state");
  }, {
    workerHealthFn: async () => ({
      ok: true,
      state: "pairing_code",
      ready: false,
      authenticated: false,
      accounts: [{
        accountId: "sender",
        state: "pairing_code",
        ready: false,
        pairingCode: "ABCD1234",
        pairingCodeUpdatedAt: "2026-08-18T09:00:00.000Z",
      }],
    }),
  });

  assert.equal(status.state, "pairing_code");
  assert.equal(status.mode, "worker");
  assert.equal(status.pairingCode, "ABCD1234");
  assert.equal(status.accounts[0].pairingCode, "ABCD1234");
});
