import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";

async function request(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  assert.ok(response.ok, `${route} returned ${response.status}`);
  return response.json();
}

test("server exposes health, readiness, version, and agent message APIs", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-api-"));
  const priorHome = process.env.ORKESTR_HOME;
  process.env.ORKESTR_HOME = home;
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const health = await request(baseUrl, "/api/health");
    const ready = await request(baseUrl, "/api/ready");
    const version = await request(baseUrl, "/api/version");
    const queued = await request(baseUrl, "/api/agents/job-search-assistant/messages", {
      method: "POST",
      body: JSON.stringify({ text: "hello" }),
    });
    const execution = await request(baseUrl, "/api/agents/job-search-assistant/run-next", {
      method: "POST",
      body: JSON.stringify({ executorId: "noop" }),
    });
    const listed = await request(baseUrl, "/api/agents/job-search-assistant/messages");

    assert.equal(health.ok, true);
    assert.equal(ready.ok, true);
    assert.equal(version.name, "orkestr-oss");
    assert.equal(queued.message.state, "queued");
    assert.equal(execution.execution.state, "completed");
    assert.equal(listed.messages.length, 1);
    assert.equal(listed.messages[0].state, "completed");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
  }
});
