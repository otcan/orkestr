import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getSetupStatus } from "../packages/core/src/setup.js";
import { getWhatsAppStatus } from "../packages/connectors/src/whatsapp.js";
import { writeConnectorConfig } from "../packages/storage/src/config.js";

function response(payload, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() {
      return payload;
    },
  };
}

test("whatsapp status reports not configured without bridge URL", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-empty-"));
  const status = await getWhatsAppStatus({ ORKESTR_HOME: home });
  assert.equal(status.state, "not_configured");
});

test("whatsapp status reports paired from health readiness", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-ready-"));
  const env = { ORKESTR_HOME: home };
  await writeConnectorConfig("whatsapp", { bridgeUrl: "http://wa.local" }, env);

  const status = await getWhatsAppStatus(env, async (url) => {
    assert.equal(url.pathname, "/health");
    return response({ ok: true, ready: true });
  });

  assert.equal(status.state, "paired");
});

test("whatsapp status reports qr needed when health is reachable and qr exists", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-qr-"));
  const env = { ORKESTR_HOME: home };
  await writeConnectorConfig("whatsapp", { bridgeUrl: "http://wa.local/" }, env);

  const status = await getWhatsAppStatus(env, async (url) => {
    if (url.pathname === "/health") return response({ ok: true, ready: false });
    if (url.pathname === "/qr.svg") return response({}, true, 200);
    throw new Error(`unexpected ${url.pathname}`);
  });

  assert.equal(status.state, "qr_needed");
  assert.equal(status.qrUrl, "http://wa.local/qr.svg");
});

test("whatsapp setup status maps unreachable bridge to broken", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-wa-broken-"));
  const env = { ORKESTR_HOME: home, WHATSAPP_BRIDGE_URL: "http://127.0.0.1:1" };
  const setup = await getSetupStatus({ env, home });
  const whatsapp = setup.connectors.find((connector) => connector.id === "whatsapp");

  assert.equal(whatsapp.state, "broken");
});

