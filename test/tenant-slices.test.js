import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../apps/server/src/server.js";
import { approvePairingChallenge } from "../packages/core/src/security.js";
import { userPrincipal } from "../packages/core/src/principal.js";
import { createUser } from "../packages/core/src/users.js";
import {
  buildTenantSliceProvisioningPlan,
  createTenantSlice,
  deleteTenantSlice,
  getTenantSlice,
  getTenantSliceForOwner,
  getTenantSliceForPrincipal,
  listTenantSlicesForPrincipal,
  provisionTenantSlice,
  publicTenantSlice,
  tenantSliceRuntimeStatus,
} from "../packages/core/src/tenant-slices.js";

async function read(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

test("tenant slice registry keeps one active same-box instance per owner", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-tenant-slices-core-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_TENANT_SLICE_ROOT: "/tenant-root",
    ORKESTR_TENANT_SLICE_PORT_BASE: "23000",
  };

  const slice = await createTenantSlice({
    id: "Alice Slice",
    ownerUserId: "alice",
    displayName: "Alice local slice",
    resources: { memoryHighMiB: 4096, memoryMaxMiB: 6144, cpuQuotaPercent: 150, tasksMax: 1024, diskSoftGiB: 60 },
    budget: { dailyUsd: 3.5, monthlyUsd: 42 },
    connectors: {
      whatsapp: { chatId: "alice-chat@g.us", accountId: "sender" },
      linkedin: { desktopSlug: "linkedin-alice" },
    },
  }, env);

  assert.equal(slice.id, "alice-slice");
  assert.equal(slice.boundary, "local-slice");
  assert.equal(slice.ownerUserId, "alice");
  assert.equal(slice.status, "planned");
  assert.equal(slice.system.user, "orkt_aliceslice");
  assert.equal(slice.system.serviceName, "orkestr-tenant-alice-slice.service");
  assert.equal(slice.paths.root, "/tenant-root/alice-slice");
  assert.equal(slice.paths.dataRoot, "/tenant-root/alice-slice/data");
  assert.equal(slice.paths.browserRoot, "/tenant-root/alice-slice/browsers");
  assert.equal(slice.portBlock.base, 23000);
  assert.equal(slice.portBlock.ports.orkestr, 23000);
  assert.equal(slice.portBlock.ports.oxrmWeb, 23010);
  assert.equal(slice.resources.memoryHighMiB, 4096);
  assert.equal(slice.resources.memoryMaxMiB, 6144);
  assert.equal(slice.budget.dailyUsd, 3.5);
  assert.equal(slice.budget.monthlyUsd, 42);
  assert.equal(slice.connectors.whatsapp.chatId, "alice-chat@g.us");
  assert.equal(slice.connectors.linkedin.desktopSlug, "linkedin-alice");
  assert.equal(slice.oxrm.composeProject, "oxrm-tenant-alice-slice");
  assert.equal(slice.oxrm.webUrl, "http://127.0.0.1:23010");

  await assert.rejects(
    () => createTenantSlice({ id: "alice-second", ownerUserId: "alice" }, env),
    /tenant_slice_owner_already_has_instance/,
  );
  assert.equal((await getTenantSliceForOwner("alice", env)).id, "alice-slice");
  assert.deepEqual((await listTenantSlicesForPrincipal(userPrincipal({ id: "alice" }), env)).map((item) => item.id), ["alice-slice"]);
  assert.deepEqual(await listTenantSlicesForPrincipal(userPrincipal({ id: "bob" }), env), []);
  assert.deepEqual(await listTenantSlicesForPrincipal({}, env), []);
  await assert.rejects(
    () => getTenantSliceForPrincipal("alice-slice", userPrincipal({ id: "bob" }), env),
    /tenant_slice_access_forbidden/,
  );

  const publicSlice = publicTenantSlice({ ...slice, token: "secret", password: "secret" });
  assert.equal(Object.hasOwn(publicSlice, "token"), false);
  assert.equal(Object.hasOwn(publicSlice, "password"), false);

  const deleted = await deleteTenantSlice("alice-slice", env);
  assert.equal(deleted.status, "deleted");
  assert.ok(deleted.deletedAt);
  const replacement = await createTenantSlice({ id: "alice-next", ownerUserId: "alice" }, env);
  assert.equal(replacement.id, "alice-next");
  assert.equal(replacement.portBlock.base, 23050);
});

test("tenant slice provisioning builds a resource-limited local plan", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-tenant-slices-plan-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_TENANT_SLICE_ROOT: "/tenant-root",
    ORKESTR_TENANT_SLICE_PORT_BASE: "24000",
  };
  const slice = await createTenantSlice({
    id: "bob-slice",
    ownerUserId: "bob",
    resources: { memoryHighMiB: 2048, memoryMaxMiB: 4096, cpuQuotaPercent: 125, tasksMax: 512, diskSoftGiB: 30 },
    budget: { dailyUsd: 2, monthlyUsd: 20 },
    connectors: { linkedin: { desktopSlug: "linkedin-bob" } },
  }, env);

  const plan = buildTenantSliceProvisioningPlan(slice, { systemdUnitDir: "/run/systemd/system" }, env);
  const runtimeEnvFile = plan.files.find((file) => file.path === slice.paths.envFile);
  const oxrmEnvFile = plan.files.find((file) => file.path === slice.paths.composeEnvFile);
  const serviceFile = plan.files.find((file) => file.path.endsWith(slice.system.serviceName));
  const sliceFile = plan.files.find((file) => file.path.endsWith(slice.system.sliceName));
  const allFileContent = plan.files.map((file) => file.content).join("\n");

  assert.equal(plan.dryRun, true);
  assert.equal(plan.tenantSlice.id, "bob-slice");
  assert.deepEqual(plan.directories, [
    "/tenant-root/bob-slice",
    "/tenant-root/bob-slice/home",
    "/tenant-root/bob-slice/data",
    "/tenant-root/bob-slice/workspace",
    "/tenant-root/bob-slice/browsers",
    "/tenant-root/bob-slice/oxrm",
    "/tenant-root/bob-slice/run",
    "/tenant-root/bob-slice/logs",
  ]);
  assert.equal(plan.runtimeEnv.ORKESTR_HOME, "/tenant-root/bob-slice/data");
  assert.equal(plan.runtimeEnv.ORKESTR_PORT, "24000");
  assert.equal(plan.runtimeEnv.ORKESTR_ADMIN_USER_ID, "bob");
  assert.equal(plan.runtimeEnv.ORKESTR_DEPLOYMENT_TRACK, "tenant-local-slice");
  assert.equal(plan.runtimeEnv.ORKESTR_CONTAINED_USER_RUNTIME_POLICY, "1");
  assert.equal(plan.runtimeEnv.ORKESTR_DEFAULT_DESKTOP_SLUG, "linkedin-bob");
  assert.deepEqual(JSON.parse(plan.runtimeEnv.ORKESTR_API_AGENT_TENANT_BUDGETS_JSON), {
    bob: { dailyUsd: 2, monthlyUsd: 20 },
  });
  assert.equal(plan.oxrmEnv.COMPOSE_PROJECT_NAME, "oxrm-tenant-bob-slice");
  assert.equal(plan.oxrmEnv.OXRM_WEB_PORT, "24010");
  assert.match(runtimeEnvFile.content, /^ORKESTR_HOME='\/tenant-root\/bob-slice\/data'$/m);
  assert.match(runtimeEnvFile.content, /^ORKESTR_API_AGENT_TENANT_BUDGETS_JSON='\{"bob":\{"dailyUsd":2,"monthlyUsd":20\}\}'$/m);
  assert.match(oxrmEnvFile.content, /^OXRM_TENANT_ID='bob-slice'$/m);
  assert.match(serviceFile.content, /Slice=orkestr-tenant-bob-slice\.slice/);
  assert.match(serviceFile.content, /ReadWritePaths=\/tenant-root\/bob-slice/);
  assert.match(serviceFile.content, /MemoryHigh=2048M/);
  assert.match(serviceFile.content, /MemoryMax=4096M/);
  assert.match(serviceFile.content, /CPUQuota=125%/);
  assert.match(sliceFile.content, /TasksMax=512/);
  assert.deepEqual(plan.commands.start, ["systemctl", "start", "orkestr-tenant-bob-slice.service", "orkestr-tenant-bob-slice-oxrm.service"]);
  assert.equal(/password|token|secret/i.test(allFileContent), false);
});

test("tenant slice provisioning execute path and runtime status are observable", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-tenant-slices-exec-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_TENANT_SLICE_ROOT: "/tenant-root",
    ORKESTR_TENANT_SLICE_PORT_BASE: "25000",
  };
  await createTenantSlice({ id: "charlie-slice", ownerUserId: "charlie" }, env);
  const calls = [];

  const result = await provisionTenantSlice("charlie-slice", { execute: true }, env, {
    applyPlan: async (plan) => {
      calls.push(plan);
    },
  });

  assert.equal(result.dryRun, false);
  assert.equal(result.tenantSlice.status, "stopped");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].dryRun, false);
  assert.equal((await getTenantSlice("charlie-slice", env)).status, "stopped");

  const statusCalls = [];
  const status = await tenantSliceRuntimeStatus("charlie-slice", env, {
    execFile: async (command, args, options) => {
      statusCalls.push({ command, args, options });
      return { stdout: "ActiveState=active\nSubState=running\nMemoryCurrent=12345\nCPUUsageNSec=987654\n" };
    },
  });
  assert.equal(status.ok, true);
  assert.equal(status.service.name, "orkestr-tenant-charlie-slice.service");
  assert.equal(status.service.activeState, "active");
  assert.equal(status.service.subState, "running");
  assert.equal(status.service.memoryCurrentBytes, 12345);
  assert.equal(status.service.cpuUsageNSec, 987654);
  assert.equal(statusCalls[0].command, "systemctl");
  assert.deepEqual(statusCalls[0].args.slice(0, 2), ["show", "orkestr-tenant-charlie-slice.service"]);

  await createTenantSlice({ id: "failed-slice", ownerUserId: "failed" }, env);
  await assert.rejects(
    () => provisionTenantSlice("failed-slice", { execute: true }, env, {
      applyPlan: async () => {
        throw new Error("apply failed");
      },
    }),
    /apply failed/,
  );
  const failed = await getTenantSlice("failed-slice", env);
  assert.equal(failed.status, "error");
  assert.equal(failed.lastError, "apply failed");
});

test("tenant slice API is admin-only and returns provisioning plans", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-tenant-slices-api-"));
  const priorHome = process.env.ORKESTR_HOME;
  const priorAuth = process.env.ORKESTR_AUTH_REQUIRED;
  const priorRecover = process.env.ORKESTR_RECOVER_RUNNING_ON_START;
  const priorRoot = process.env.ORKESTR_TENANT_SLICE_ROOT;
  const priorPortBase = process.env.ORKESTR_TENANT_SLICE_PORT_BASE;
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
  process.env.ORKESTR_TENANT_SLICE_ROOT = "/tenant-root";
  process.env.ORKESTR_TENANT_SLICE_PORT_BASE = "26000";
  const server = await startServer({ port: 0, host: "127.0.0.1" });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const firstChallenge = await read(await fetch(`${baseUrl}/api/setup/security/challenges`, { method: "POST" }));
    await approvePairingChallenge(firstChallenge.challengeId, { env: process.env });
    const adminPair = await fetch(`${baseUrl}/api/setup/security/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: firstChallenge.challengeId }),
    });
    const adminCookie = adminPair.headers.get("set-cookie") || "";
    assert.equal(adminPair.status, 200);

    const createdResponse = await fetch(`${baseUrl}/api/tenant-slices`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({
        id: "dana-slice",
        ownerUserId: "dana",
        displayName: "Dana slice",
        resources: { memoryHighMiB: 3072, memoryMaxMiB: 5120, cpuQuotaPercent: 175 },
        budget: { dailyUsd: 4, monthlyUsd: 40 },
        connectors: {
          whatsapp: { chatId: "dana@g.us", accountId: "sender" },
          linkedin: { desktopSlug: "linkedin-dana" },
        },
      }),
    });
    const created = await read(createdResponse);
    assert.equal(createdResponse.status, 201);
    assert.equal(created.tenantSlice.id, "dana-slice");
    assert.equal(created.tenantSlice.ownerUserId, "dana");
    assert.equal(created.tenantSlice.boundary, "local-slice");
    assert.equal(created.tenantSlice.portBlock.ports.orkestr, 26000);
    assert.equal(created.tenantSlice.connectors.whatsapp.chatId, "dana@g.us");

    const listed = await read(await fetch(`${baseUrl}/api/tenant-slices`, { headers: { cookie: adminCookie } }));
    assert.deepEqual(listed.tenantSlices.map((tenantSlice) => tenantSlice.id), ["dana-slice"]);

    const provisioned = await read(await fetch(`${baseUrl}/api/tenant-slices/dana-slice/provision`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ systemdUnitDir: "/run/systemd/system" }),
    }));
    assert.equal(provisioned.dryRun, true);
    assert.equal(provisioned.tenantSlice.id, "dana-slice");
    assert.equal(provisioned.runtimeEnv.ORKESTR_ADMIN_USER_ID, "dana");
    assert.equal(provisioned.runtimeEnv.ORKESTR_DEFAULT_DESKTOP_SLUG, "linkedin-dana");
    assert.equal(provisioned.systemd.serviceName, "orkestr-tenant-dana-slice.service");
    assert.deepEqual(JSON.parse(provisioned.runtimeEnv.ORKESTR_API_AGENT_TENANT_BUDGETS_JSON), {
      dana: { dailyUsd: 4, monthlyUsd: 40 },
    });

    const executeResponse = await fetch(`${baseUrl}/api/tenant-slices/dana-slice/provision`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ execute: true }),
    });
    const executePayload = await read(executeResponse);
    assert.equal(executeResponse.status, 501);
    assert.equal(executePayload.error, "tenant_slice_execute_not_configured");

    await createUser({
      email: "dana@example.test",
      phoneNumber: "+15551239999",
      role: "user",
      displayName: "Dana",
    }, process.env);
    const userChallenge = await read(await fetch(`${baseUrl}/api/setup/security/challenges`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ userId: "dana-example.test" }),
    }));
    await approvePairingChallenge(userChallenge.challengeId, { env: process.env });
    const userPair = await fetch(`${baseUrl}/api/setup/security/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: userChallenge.challengeId }),
    });
    const userCookie = userPair.headers.get("set-cookie") || "";
    assert.equal(userPair.status, 200);

    const denied = await fetch(`${baseUrl}/api/tenant-slices`, { headers: { cookie: userCookie } });
    const deniedPayload = await read(denied);
    assert.equal(denied.status, 403);
    assert.equal(deniedPayload.error, "control_plane_admin_required");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (priorHome === undefined) delete process.env.ORKESTR_HOME;
    else process.env.ORKESTR_HOME = priorHome;
    if (priorAuth === undefined) delete process.env.ORKESTR_AUTH_REQUIRED;
    else process.env.ORKESTR_AUTH_REQUIRED = priorAuth;
    if (priorRecover === undefined) delete process.env.ORKESTR_RECOVER_RUNNING_ON_START;
    else process.env.ORKESTR_RECOVER_RUNNING_ON_START = priorRecover;
    if (priorRoot === undefined) delete process.env.ORKESTR_TENANT_SLICE_ROOT;
    else process.env.ORKESTR_TENANT_SLICE_ROOT = priorRoot;
    if (priorPortBase === undefined) delete process.env.ORKESTR_TENANT_SLICE_PORT_BASE;
    else process.env.ORKESTR_TENANT_SLICE_PORT_BASE = priorPortBase;
  }
});
