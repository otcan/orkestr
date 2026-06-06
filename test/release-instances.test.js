import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { approvePairingChallenge } from "../packages/core/src/security.js";
import { createTenantVm } from "../packages/core/src/tenant-vm-registry.js";
import { verifyReleaseInstanceConnectivity } from "../packages/core/src/release-connectivity.js";
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
        connectivityRecoveryCommand: "recover-edge {{id}}",
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
  const publicEdge = publicReleaseInstance(instances.find((instance) => instance.id === "edge"));
  assert.equal(publicEdge.hasConnectivityRecoveryCommand, true);
  assert.equal(Object.hasOwn(publicEdge, "connectivityRecoveryCommand"), false);

  const probedUrls = [];
  const probed = await listReleaseInstances(env, {
    probe: true,
    fetchImpl: async (url) => {
      probedUrls.push(String(url));
      return new Response(JSON.stringify({ releaseId: String(url).includes("127.0.0.1") ? "central-loopback" : "remote-release" }));
    },
  });
  assert.equal(probed.find((instance) => instance.id === "central").currentVersion.releaseId, "central-loopback");
  assert.equal(probedUrls[0], "http://127.0.0.1:19812/api/version");

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

test("release instance deploy verifies configured connectivity commands", async () => {
  const spawned = [];
  const instances = [
    {
      id: "local",
      kind: "local-service",
      releaseTrainEnabled: true,
    },
    {
      id: "edge",
      displayName: "Edge",
      kind: "remote-service",
      releaseTrainEnabled: true,
      deployCommand: ["deploy-edge", "{{ref}}"],
      connectivityCommand: ["check-edge", "{{ref}}"],
      labels: { requiredWhatsAppAccounts: "sender,responder" },
    },
  ];
  const report = await deployReleaseInstances({
    instances,
    ref: "feed1234",
    channel: "main",
    spawnImpl(command, args, options) {
      spawned.push({ command, args, env: options.env });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  });
  const connectivity = await verifyReleaseInstanceConnectivity(instances, {
    ref: "feed1234",
    channel: "main",
    spawnImpl(command, args, options) {
      spawned.push({ command, args, env: options.env });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  });

  assert.equal(report.ok, true);
  assert.equal(connectivity.ok, true);
  assert.equal(connectivity.counts.connected, 1);
  assert.deepEqual(spawned.map((entry) => [entry.command, entry.args]), [
    ["deploy-edge", ["feed1234"]],
    ["check-edge", ["feed1234"]],
  ]);
  assert.equal(spawned[1].env.ORKESTR_RELEASE_CONNECTIVITY_CHECK, "1");
  assert.equal(spawned[1].env.ORKESTR_RELEASE_REQUIRED_WHATSAPP_ACCOUNTS, "sender,responder");
});

test("release deploy scopes required WhatsApp account env to WhatsApp-routed instances", async () => {
  const spawned = [];
  const instances = [
    {
      id: "plain-vm",
      kind: "tenant-vm",
      releaseTrainEnabled: true,
      deployCommand: ["deploy-plain"],
      connectivityCommand: ["check-plain"],
    },
    {
      id: "wa-vm",
      kind: "tenant-vm",
      releaseTrainEnabled: true,
      deployCommand: ["deploy-wa"],
      connectivityCommand: ["check-wa"],
      labels: { router: "parent-whatsapp" },
    },
  ];
  const report = await deployReleaseInstances({
    instances,
    ref: "feed1234",
    channel: "main",
    spawnImpl(command, args, options) {
      spawned.push({ command, args, env: options.env });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  }, {
    ORKESTR_RELEASE_REQUIRED_WHATSAPP_ACCOUNTS: "sender,responder",
  });
  const connectivity = await verifyReleaseInstanceConnectivity(instances, {
    ref: "feed1234",
    channel: "main",
    spawnImpl(command, args, options) {
      spawned.push({ command, args, env: options.env });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  }, {
    ORKESTR_RELEASE_REQUIRED_WHATSAPP_ACCOUNTS: "sender,responder",
  });

  assert.equal(report.ok, true);
  assert.equal(connectivity.ok, true);
  assert.equal(spawned.find((entry) => entry.command === "deploy-plain").env.ORKESTR_RELEASE_REQUIRED_WHATSAPP_ACCOUNTS, undefined);
  assert.equal(spawned.find((entry) => entry.command === "deploy-wa").env.ORKESTR_RELEASE_REQUIRED_WHATSAPP_ACCOUNTS, "sender,responder");
  assert.equal(spawned.find((entry) => entry.command === "check-plain").env.ORKESTR_RELEASE_REQUIRED_WHATSAPP_ACCOUNTS, undefined);
  assert.equal(spawned.find((entry) => entry.command === "check-wa").env.ORKESTR_RELEASE_REQUIRED_WHATSAPP_ACCOUNTS, "sender,responder");
});

test("release connectivity retries transient command failures", async () => {
  const spawned = [];
  const instances = [
    {
      id: "edge",
      displayName: "Edge",
      kind: "remote-service",
      releaseTrainEnabled: true,
      connectivityCommand: ["check-edge", "{{ref}}"],
    },
  ];
  const report = await verifyReleaseInstanceConnectivity(instances, {
    ref: "feed1234",
    channel: "main",
    connectivityAttempts: 2,
    connectivityRetryDelayMs: 0,
    spawnImpl(command, args, options) {
      spawned.push({ command, args, env: options.env });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("exit", spawned.length === 1 ? 1 : 0));
      return child;
    },
  });

  assert.equal(report.ok, true);
  assert.equal(report.counts.connected, 1);
  assert.equal(report.results[0].attempts, 2);
  assert.deepEqual(spawned.map((entry) => [entry.command, entry.args]), [
    ["check-edge", ["feed1234"]],
    ["check-edge", ["feed1234"]],
  ]);
});

test("release connectivity runs recovery command before retrying transient failures", async () => {
  const spawned = [];
  const instances = [
    {
      id: "edge",
      displayName: "Edge",
      kind: "remote-service",
      releaseTrainEnabled: true,
      connectivityCommand: ["check-edge", "{{ref}}"],
      connectivityRecoveryCommand: ["recover-edge", "{{id}}", "{{attempt}}", "{{nextAttempt}}"],
    },
  ];
  const report = await verifyReleaseInstanceConnectivity(instances, {
    ref: "feed1234",
    channel: "main",
    connectivityAttempts: 2,
    connectivityRetryDelayMs: 0,
    spawnImpl(command, args, options) {
      spawned.push({ command, args, env: options.env });
      const child = new EventEmitter();
      const checkCount = spawned.filter((entry) => entry.command === "check-edge").length;
      const code = command === "check-edge" && checkCount === 1 ? 1 : 0;
      queueMicrotask(() => child.emit("exit", code));
      return child;
    },
  });

  assert.equal(report.ok, true);
  assert.equal(report.counts.connected, 1);
  assert.equal(report.results[0].attempts, 2);
  assert.equal(report.results[0].recoveryAttempts, 1);
  assert.deepEqual(spawned.map((entry) => [entry.command, entry.args]), [
    ["check-edge", ["feed1234"]],
    ["recover-edge", ["edge", "1", "2"]],
    ["check-edge", ["feed1234"]],
  ]);
  assert.equal(spawned[1].env.ORKESTR_RELEASE_CONNECTIVITY_RECOVERY, "1");
  assert.equal(spawned[1].env.ORKESTR_RELEASE_CONNECTIVITY_ATTEMPT, "1");
  assert.equal(spawned[1].env.ORKESTR_RELEASE_CONNECTIVITY_NEXT_ATTEMPT, "2");
  assert.equal(spawned[1].env.ORKESTR_RELEASE_CONNECTIVITY_ERROR, "connectivity_command_failed:1");
});

test("release connectivity can use an environment recovery command", async () => {
  const spawned = [];
  const instances = [
    {
      id: "edge",
      displayName: "Edge",
      kind: "remote-service",
      releaseTrainEnabled: true,
      connectivityCommand: ["check-edge", "{{ref}}"],
    },
  ];
  const report = await verifyReleaseInstanceConnectivity(instances, {
    ref: "feed1234",
    channel: "main",
    connectivityAttempts: 2,
    connectivityRetryDelayMs: 0,
    spawnImpl(command, args, options) {
      spawned.push({ command, args, env: options.env });
      const child = new EventEmitter();
      const checkCount = spawned.filter((entry) => entry.command === "check-edge").length;
      const code = command === "check-edge" && checkCount === 1 ? 1 : 0;
      queueMicrotask(() => child.emit("exit", code));
      return child;
    },
  }, {
    ORKESTR_RELEASE_CONNECTIVITY_RECOVERY_COMMAND: "recover-edge {{instanceId}} {{error}}",
  });

  assert.equal(report.ok, true);
  assert.equal(report.results[0].recoveryAttempts, 1);
  assert.deepEqual(spawned.map((entry) => [entry.command, entry.args]), [
    ["check-edge", ["feed1234"]],
    ["sh", ["-lc", "recover-edge edge connectivity_command_failed:1"]],
    ["check-edge", ["feed1234"]],
  ]);
});

test("release command connectivity verifies the deployed instance commit", async () => {
  const instances = [
    {
      id: "edge",
      displayName: "Edge",
      kind: "remote-service",
      releaseTrainEnabled: true,
      baseUrl: "https://edge.example.test",
      versionUrl: "https://edge.example.test/api/version",
      connectivityCommand: ["check-edge", "{{ref}}"],
      labels: { router: "parent-whatsapp" },
    },
  ];
  const spawnOk = (command, args, options) => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  };
  const okUrls = [];
  const ok = await verifyReleaseInstanceConnectivity(instances, {
    ref: "abcdef1234567890",
    channel: "main",
    spawnImpl: spawnOk,
    fetchImpl: async (url) => {
      okUrls.push(String(url));
      return new Response(JSON.stringify({
        releaseId: "main-abcdef123456",
        commit: "abcdef1234567890",
      }));
    },
  });

  assert.equal(ok.ok, true);
  assert.equal(ok.results[0].method, "command+http");
  assert.equal(ok.results[0].commit, "abcdef1234567890");
  assert.deepEqual(okUrls, ["https://edge.example.test/api/version"]);

  const failed = await verifyReleaseInstanceConnectivity(instances, {
    ref: "abcdef1234567890",
    channel: "main",
    spawnImpl: spawnOk,
    fetchImpl: async () => new Response(JSON.stringify({
      releaseId: "main-deadbeef0000",
      commit: "deadbeef00000000",
    })),
  });

  assert.equal(failed.ok, false);
  assert.equal(failed.counts.connection_failed, 1);
  assert.match(failed.results[0].error, /release_commit_mismatch:abcdef1234567890:deadbeef00000000/);
});

test("release connectivity check fails WhatsApp-routed instances that are not paired", async () => {
  const checkedUrls = [];
  const report = await verifyReleaseInstanceConnectivity([
    {
      id: "vm-orkestr-de",
      kind: "tenant-vm",
      releaseTrainEnabled: true,
      baseUrl: "https://app.example.test",
      versionUrl: "https://app.example.test/api/version",
      labels: { router: "parent-whatsapp" },
    },
  ], {
    fetchImpl: async (url) => {
      checkedUrls.push(String(url));
      if (String(url).endsWith("/api/version")) {
        return new Response(JSON.stringify({ releaseId: "release-one", commit: "abc123" }));
      }
      return new Response(JSON.stringify({ state: "failed" }));
    },
  });

  assert.equal(report.ok, false);
  assert.equal(report.counts.connection_failed, 1);
  assert.match(report.results[0].error, /whatsapp_not_ready/);
  assert.deepEqual(checkedUrls, [
    "https://app.example.test/api/version",
    "https://app.example.test/api/connectors/whatsapp/status",
  ]);
});

test("release connectivity check requires configured WhatsApp accounts", async () => {
  const baseInstance = {
    id: "vm-orkestr-de",
    kind: "tenant-vm",
    releaseTrainEnabled: true,
    baseUrl: "https://app.example.test",
    versionUrl: "https://app.example.test/api/version",
    labels: {
      router: "parent-whatsapp",
      requiredWhatsAppAccounts: "sender,responder",
    },
  };
  const failed = await verifyReleaseInstanceConnectivity([baseInstance], {
    fetchImpl: async (url) => {
      if (String(url).endsWith("/api/version")) {
        return new Response(JSON.stringify({ releaseId: "release-one", commit: "abc123" }));
      }
      return new Response(JSON.stringify({
        state: "paired",
        health: { ready: true },
        accounts: [
          { accountId: "sender", state: "idle", ready: false },
          { accountId: "responder", state: "ready", ready: true },
        ],
      }));
    },
  });

  assert.equal(failed.ok, false);
  assert.equal(failed.counts.connection_failed, 1);
  assert.match(failed.results[0].error, /whatsapp_required_accounts_not_ready:sender/);

  const ok = await verifyReleaseInstanceConnectivity([baseInstance], {
    fetchImpl: async (url) => {
      if (String(url).endsWith("/api/version")) {
        return new Response(JSON.stringify({ releaseId: "release-one", commit: "abc123" }));
      }
      return new Response(JSON.stringify({
        state: "paired",
        accounts: [
          { accountId: "sender", state: "ready", ready: true },
          { accountId: "responder", state: "ready", ready: true },
        ],
      }));
    },
  });

  assert.equal(ok.ok, true);
  assert.deepEqual(ok.results[0].whatsappRequiredAccounts, ["sender", "responder"]);
  assert.deepEqual(ok.results[0].whatsappReadyAccounts, ["sender", "responder"]);
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
