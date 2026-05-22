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
    assert.equal(typeof version.dirty, "boolean");
    assert.ok("tag" in version);
    assert.ok("describe" in version);
    assert.ok("channel" in version);
    assert.ok("releaseId" in version);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("version endpoint includes release manifest metadata when present", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-version-release-"));
  const manifestPath = path.join(home, "release-manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify({
    schemaVersion: 1,
    releaseId: "v0.1.7-f0c1538",
    channel: "production",
    deployedAt: "2026-05-22T09:00:00.000Z",
    git: {
      commit: "f0c1538c3596acae8d7535c29a6c1fe90e53c64a",
      branch: "main",
      tag: "v0.1.7",
      describe: "v0.1.7-0-gf0c1538",
      dirty: false,
    },
  }), "utf8");
  const priorHome = process.env.ORKESTR_HOME;
  const priorManifest = process.env.ORKESTR_RELEASE_MANIFEST;
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_RELEASE_MANIFEST = manifestPath;
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();

  try {
    const version = await request(`http://127.0.0.1:${port}`, "/api/version");
    assert.equal(version.commit, "f0c1538c3596acae8d7535c29a6c1fe90e53c64a");
    assert.equal(version.branch, "main");
    assert.equal(version.tag, "v0.1.7");
    assert.equal(version.describe, "v0.1.7-0-gf0c1538");
    assert.equal(version.dirty, false);
    assert.equal(version.channel, "production");
    assert.equal(version.releaseId, "v0.1.7-f0c1538");
    assert.equal(version.deployedAt, "2026-05-22T09:00:00.000Z");
    assert.equal(version.manifestSchemaVersion, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
    if (priorManifest === undefined) delete process.env.ORKESTR_RELEASE_MANIFEST;
    else process.env.ORKESTR_RELEASE_MANIFEST = priorManifest;
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
