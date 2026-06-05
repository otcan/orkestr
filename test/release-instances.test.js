import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { approvePairingChallenge } from "../packages/core/src/security.js";
import { createTenantVm } from "../packages/core/src/tenant-vm-registry.js";
import {
  deployReleaseInstances,
  listReleaseInstances,
  publicReleaseInstance,
} from "../packages/core/src/release-instances.js";
import { dataPaths } from "../packages/storage/src/paths.js";
import { writeJson } from "../packages/storage/src/store.js";

async function read(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

test("release instance broker merges local, tenant VM, and private registry targets", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-release-instances-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_INSTANCE_ID: "central",
    ORKESTR_INSTANCE_NAME: "Central broker",
    ORKESTR_PUBLIC_URL: "https://central.example.test",
  };

  await createTenantVm({
    id: "tenant-one",
    ownerUserId: "alice",
    displayName: "Tenant One",
    status: "running",
    endpoint: { baseUrl: "https://tenant.example.test" },
    capabilities: ["codex", "release-train"],
    labels: { releaseInstanceId: "vm-tenant-one" },
  }, env);
  await writeJson(dataPaths(env).releaseInstances, {
    instances: [
      {
        id: "vm-tenant-one",
        releaseTrainEnabled: true,
        deployCommand: ["deploy-vm", "--ref", "{{ref}}", "--channel", "{{channel}}"],
      },
      {
        id: "edge",
        displayName: "Edge service",
        kind: "remote-service",
        baseUrl: "https://edge.example.test",
        releaseTrainEnabled: true,
        deployCommand: "deploy-edge {{ref}} {{channel}}",
      },
    ],
  });

  const instances = await listReleaseInstances(env);
  assert.deepEqual(instances.map((instance) => instance.id), ["central", "edge", "vm-tenant-one"]);
  const tenant = instances.find((instance) => instance.id === "vm-tenant-one");
  assert.equal(tenant.status, "running");
  assert.equal(tenant.kind, "tenant-vm");
  assert.equal(tenant.baseUrl, "https://tenant.example.test");
  assert.equal(tenant.releaseTrainEnabled, true);
  assert.deepEqual(tenant.deployCommand, ["deploy-vm", "--ref", "{{ref}}", "--channel", "{{channel}}"]);

  const publicTenant = publicReleaseInstance(tenant);
  assert.equal(publicTenant.hasDeployCommand, true);
  assert.equal(Object.hasOwn(publicTenant, "deployCommand"), false);
  assert.equal(Object.hasOwn(publicTenant, "commandEnv"), false);

  const spawned = [];
  const report = await deployReleaseInstances({
    instances,
    ref: "abc123def456",
    channel: "main",
    spawnImpl(command, args, options) {
      spawned.push({ command, args, env: options.env });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  }, env);

  assert.equal(report.ok, true);
  assert.equal(report.counts.deployed, 2);
  assert.equal(report.counts.skipped, 1);
  assert.deepEqual(report.results.find((result) => result.id === "central"), {
    id: "central",
    displayName: "Central broker",
    kind: "local-service",
    status: "skipped",
    reason: "local_already_deployed",
  });
  assert.equal(spawned[0].command, "sh");
  assert.deepEqual(spawned[0].args, ["-lc", "deploy-edge abc123def456 main"]);
  assert.equal(spawned[1].command, "deploy-vm");
  assert.deepEqual(spawned[1].args, ["--ref", "abc123def456", "--channel", "main"]);
  assert.equal(spawned[1].env.ORKESTR_RELEASE_INSTANCE_ID, "vm-tenant-one");
});

test("release instances API is admin-only and returns public-safe broker records", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-release-instances-api-"));
  const priorHome = process.env.ORKESTR_HOME;
  const priorAuth = process.env.ORKESTR_AUTH_REQUIRED;
  const priorRecover = process.env.ORKESTR_RECOVER_RUNNING_ON_START;
  const priorInstanceId = process.env.ORKESTR_INSTANCE_ID;
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  process.env.ORKESTR_INSTANCE_ID = "central-api";
  await writeJson(dataPaths(process.env).releaseInstances, {
    instances: [
      {
        id: "remote-api",
        baseUrl: "https://remote.example.test",
        releaseTrainEnabled: true,
        deployCommand: ["ssh", "remote.example.test", "orkestr", "update"],
      },
    ],
  });
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const denied = await fetch(`${baseUrl}/api/release/instances`);
    const deniedPayload = await read(denied);
    assert.equal(denied.status, 401);
    assert.ok(deniedPayload.error);

    const challenge = await read(await fetch(`${baseUrl}/api/setup/security/challenges`, { method: "POST" }));
    await approvePairingChallenge(challenge.challengeId, { env: process.env });
    const pair = await fetch(`${baseUrl}/api/setup/security/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: challenge.challengeId }),
    });
    const cookie = pair.headers.get("set-cookie") || "";
    assert.equal(pair.status, 200);

    const payload = await read(await fetch(`${baseUrl}/api/release/instances`, { headers: { cookie } }));
    assert.deepEqual(payload.instances.map((instance) => instance.id), ["central-api", "remote-api"]);
    const remote = payload.instances.find((instance) => instance.id === "remote-api");
    assert.equal(remote.releaseTrainEnabled, true);
    assert.equal(remote.hasDeployCommand, true);
    assert.equal(remote.baseUrl, "https://remote.example.test");
    assert.equal(Object.hasOwn(remote, "deployCommand"), false);
    assert.equal(Object.hasOwn(remote, "commandEnv"), false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
    if (priorAuth === undefined) delete process.env.ORKESTR_AUTH_REQUIRED;
    else process.env.ORKESTR_AUTH_REQUIRED = priorAuth;
    if (priorRecover === undefined) delete process.env.ORKESTR_RECOVER_RUNNING_ON_START;
    else process.env.ORKESTR_RECOVER_RUNNING_ON_START = priorRecover;
    if (priorInstanceId === undefined) delete process.env.ORKESTR_INSTANCE_ID;
    else process.env.ORKESTR_INSTANCE_ID = priorInstanceId;
  }
});
