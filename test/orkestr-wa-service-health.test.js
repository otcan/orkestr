import assert from "node:assert/strict";
import test from "node:test";
import { createOrkestrWaService } from "../scripts/orkestr-wa-service.mjs";

async function withWaService(env, bridge, fn) {
  const server = createOrkestrWaService({ env, bridge });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    return await fn(baseUrl);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("standalone WA service health returns HTTP 503 for ok false health payloads", async () => {
  const env = { ORKESTR_WA_SERVICE_AUTH_DISABLED: "1" };
  const calls = [];
  const bridge = {
    async getLocalWhatsAppBridgeStatus(actualEnv, options) {
      calls.push({ actualEnv, options });
      return { ok: false, state: "failed", accounts: [] };
    },
  };

  await withWaService(env, bridge, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/health`);
    const payload = await response.json();

    assert.equal(response.status, 503);
    assert.equal(payload.ok, false);
    assert.equal(payload.state, "failed");
    assert.deepEqual(calls, [{ actualEnv: env, options: { probeChatOps: false } }]);
  });
});
