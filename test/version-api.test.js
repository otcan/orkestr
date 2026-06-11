import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createApp } from "../apps/server/src/server.js";

async function request(baseUrl, route) {
  const response = await fetch(`${baseUrl}${route}`);
  assert.ok(response.ok, `${route} returned ${response.status}`);
  return response.json();
}

const isolatedServerEnvKeys = [
  "ORKESTR_HOME",
  "ORKESTR_CODEX_BIN",
  "ORKESTR_DEPLOY_CHANNEL",
  "ORKESTR_RELEASE_MANIFEST",
  "ORKESTR_RECOVER_RUNNING_ON_START",
  "ORKESTR_RUNTIME_MONITOR_INTERVAL_MS",
  "ORKESTR_PANE_PROGRESS_INTERVAL_MS",
  "ORKESTR_TIMER_LOOP_INTERVAL_MS",
  "ORKESTR_WHATSAPP_AUTOSTART",
  "WHATSAPP_LOCAL_AUTOSTART",
];

function saveEnv(keys) {
  return Object.fromEntries(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(prior) {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function configureIsolatedServerEnv(home, extra = {}) {
  for (const key of isolatedServerEnvKeys) delete process.env[key];
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_CODEX_BIN = "__orkestr_codex_disabled_on_macos__";
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  process.env.ORKESTR_RUNTIME_MONITOR_INTERVAL_MS = "3600000";
  process.env.ORKESTR_PANE_PROGRESS_INTERVAL_MS = "3600000";
  process.env.ORKESTR_TIMER_LOOP_INTERVAL_MS = "3600000";
  process.env.ORKESTR_WHATSAPP_AUTOSTART = "0";
  process.env.WHATSAPP_LOCAL_AUTOSTART = "0";
  for (const [key, value] of Object.entries(extra)) process.env[key] = value;
}

test("version endpoint exposes package and build identity", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-version-"));
  const prior = saveEnv(isolatedServerEnvKeys);
  configureIsolatedServerEnv(home);
  const app = await createApp();
  await app.listen(0, "127.0.0.1");
  const server = app.getHttpServer();
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
    await app.close();
    restoreEnv(prior);
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("version endpoint includes release manifest metadata when present", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-version-release-"));
  const manifestPath = path.join(home, "release-manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify({
    schemaVersion: 1,
    releaseId: "v0.1.7-f0c1538",
    releaseLabel: "v0.1.7",
    releaseVersion: "0.1.7",
    buildId: "v0.1.7-f0c1538",
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
  const prior = saveEnv(isolatedServerEnvKeys);
  configureIsolatedServerEnv(home, { ORKESTR_RELEASE_MANIFEST: manifestPath });
  const app = await createApp();
  await app.listen(0, "127.0.0.1");
  const server = app.getHttpServer();
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
    assert.equal(version.releaseLabel, "v0.1.7");
    assert.equal(version.releaseVersion, "0.1.7");
    assert.equal(version.buildId, "v0.1.7-f0c1538");
    assert.equal(version.deployedAt, "2026-05-22T09:00:00.000Z");
    assert.equal(version.manifestSchemaVersion, 1);
  } finally {
    await app.close();
    restoreEnv(prior);
    await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
