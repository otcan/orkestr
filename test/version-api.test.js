import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";

async function request(baseUrl, route) {
  const response = await fetch(`${baseUrl}${route}`);
  assert.ok(response.ok, `${route} returned ${response.status}`);
  return response.json();
}

test("version endpoint exposes package and build identity", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-version-"));
  const priorHome = process.env.ORKESTR_HOME;
  process.env.ORKESTR_HOME = home;
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();

  try {
    const version = await request(`http://127.0.0.1:${port}`, "/api/version");
    assert.equal(version.name, "orkestr-oss");
    assert.equal(typeof version.version, "string");
    assert.equal(typeof version.generatedAt, "string");
    assert.equal(typeof version.commit, "string");
    assert.equal(typeof version.branch, "string");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
    await fs.rm(home, { recursive: true, force: true });
  }
});
