import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { personalAgentLocalRuntimeStatus } from "../packages/core/src/personal-agent-local-runtime.js";
import { localModelServer } from "./fixtures/local-model-server.js";

const enabled = { ORKESTR_PERSONAL_AGENT_ENABLED: "1" };
test("assistant health requires explicit local endpoint and model", async t => {
  const { baseUrl, seen } = await localModelServer(t);
  for (const env of [enabled, { ...enabled, ORKESTR_PERSONAL_AGENT_LOCAL_MODEL: "fake-local" }, { ...enabled, ORKESTR_PERSONAL_AGENT_LOCAL_BASE_URL: baseUrl }, { ...enabled, ORKESTR_PERSONAL_AGENT_LOCAL_MODEL: "fake-local", ORKESTR_PERSONAL_AGENT_LOCAL_BASE_URL: "https://forbidden.example.invalid/v1" }]) {
    const status = await personalAgentLocalRuntimeStatus(env);
    assert.equal(status.available, false);
    assert.equal(status.reason, "not_configured");
    assert.ok(Number.isFinite(Date.parse(status.checkedAt)));
  }
  assert.equal(seen.length, 0);
});

test("assistant health sanitizes endpoint failures without altering capability fields", async t => {
  const server = http.createServer((_req, res) => { res.statusCode = 503; res.end("fake-provider-private-detail"); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const status = await personalAgentLocalRuntimeStatus({ ...enabled, ORKESTR_PERSONAL_AGENT_LOCAL_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, ORKESTR_PERSONAL_AGENT_LOCAL_MODEL: "fake-local" });
  assert.equal(status.reason, "local_runtime_unavailable");
  assert.equal(status.available, false);
  assert.deepEqual(Object.keys(status).sort(), ["available", "checkedAt", "model", "reason"]);
  assert.ok(!JSON.stringify(status).includes("fake-provider-private-detail"));
});

test("assistant health exposes only the agreed projection for an installed or missing model", async t => {
  const { baseUrl } = await localModelServer(t);
  const env = { ...enabled, ORKESTR_PERSONAL_AGENT_LOCAL_BASE_URL: baseUrl, ORKESTR_PERSONAL_AGENT_LOCAL_MODEL: "fake-local" };
  const healthy = await personalAgentLocalRuntimeStatus(env);
  assert.equal(healthy.available, true);
  assert.equal(healthy.model, "fake-local");
  assert.deepEqual(Object.keys(healthy).sort(), ["available", "checkedAt", "model"]);
  const missing = await personalAgentLocalRuntimeStatus({ ...env, ORKESTR_PERSONAL_AGENT_LOCAL_MODEL: "missing" });
  assert.equal(missing.available, false);
  assert.equal(missing.reason, "local_runtime_unavailable");
  assert.deepEqual(Object.keys(missing).sort(), ["available", "checkedAt", "model", "reason"]);
});
