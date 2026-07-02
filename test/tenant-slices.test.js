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
  createTenantSlice,
  deleteTenantSlice,
  getTenantSlice,
  getTenantSliceForOwner,
  getTenantSliceForPrincipal,
  listTenantSlicesForPrincipal,
  publicTenantSlice,
} from "../packages/core/src/tenant-slices.js";
import { listTenantWhatsAppRoutes, tenantWhatsAppInboundForwardRoute } from "../packages/core/src/tenant-whatsapp-routing.js";
import {
  buildTenantSliceProvisioningPlan,
  provisionTenantSlice,
  tenantSliceRuntimeStatus,
} from "../packages/core/src/tenant-slice-provisioning.js";
import { getTenantVm } from "../packages/core/src/tenant-vm-registry.js";

async function read(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

test("tenant slice registry keeps one active tenant VM slice per owner", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-tenant-slices-core-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_TENANT_SLICE_ROOT: "/tenant-root",
    ORKESTR_TENANT_SLICE_PORT_BASE: "23000",
    ORKESTR_AUTH_URL: "https://auth.example.test",
    ORKESTR_PAIRING_URL: "https://connect.example.test/setup/pairing",
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
  assert.equal(slice.boundary, "tenant-vm");
  assert.equal(slice.ownerUserId, "alice");
  assert.equal(slice.status, "planned");
  assert.equal(slice.vm.tenantVmId, "alice-slice-vm");
  assert.equal(slice.vm.namespace, "orkestr-tenants");
  assert.equal(slice.vm.vmName, "alice-slice-vm");
  assert.equal(slice.vm.resources.vcpus, 2);
  assert.equal(slice.vm.resources.memoryMiB, 6144);
  assert.equal(slice.vm.resources.diskGiB, 60);
  assert.equal(slice.controlPlane.enabled, true);
  assert.equal(slice.controlPlane.sharedAuthorization, true);
  assert.equal(slice.controlPlane.sharedChallenges, true);
  assert.equal(slice.controlPlane.authUrl, "https://auth.example.test");
  assert.equal(slice.controlPlane.pairingUrl, "https://connect.example.test/setup/pairing");
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

test("tenant slice provisioning builds a VM-backed plan", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-tenant-slices-plan-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_TENANT_SLICE_ROOT: "/tenant-root",
    ORKESTR_TENANT_SLICE_PORT_BASE: "24000",
    ORKESTR_AUTH_URL: "https://auth.example.test",
    ORKESTR_PAIRING_URL: "https://connect.example.test/setup/pairing",
    ORKESTR_CONNECT_PUBLIC_BASE_URL: "https://connect.example.test",
    ORKESTR_BROKER_BASE_URL: "https://broker.example.test",
  };
  const slice = await createTenantSlice({
    id: "bob-slice",
    ownerUserId: "bob",
    resources: { memoryHighMiB: 2048, memoryMaxMiB: 4096, cpuQuotaPercent: 125, tasksMax: 512, diskSoftGiB: 30 },
    budget: { dailyUsd: 2, monthlyUsd: 20 },
    connectors: { linkedin: { desktopSlug: "linkedin-bob" } },
  }, env);

  const plan = buildTenantSliceProvisioningPlan(slice, {
    namespace: "tenant-bob",
    vmName: "bob-vm",
    repoUrl: "https://github.com/example/orkestr.git",
    gitRef: "main",
  }, env);
  const manifest = JSON.parse(plan.manifest);
  const vm = manifest.items.find((item) => item.kind === "VirtualMachine");
  const cloudInitSecret = manifest.items.find((item) => item.kind === "Secret" && item.metadata.name === "bob-vm-cloudinit");
  const userData = cloudInitSecret.stringData.userdata;
  const runtimeEnvFile = Buffer.from(
    userData.match(/path: \/etc\/orkestr\/orkestr\.env[\s\S]*?content: ([A-Za-z0-9+/=]+)/)[1],
    "base64",
  ).toString("utf8");

  assert.equal(plan.boundary, "tenant-vm");
  assert.equal(plan.dryRun, true);
  assert.equal(plan.tenantSlice.id, "bob-slice");
  assert.equal(plan.tenantSlice.boundary, "tenant-vm");
  assert.equal(plan.tenantVm.id, "bob-slice-vm");
  assert.equal(plan.tenantVm.resources.memoryMiB, 4096);
  assert.equal(plan.tenantVm.resources.diskGiB, 30);
  assert.equal(plan.tenantVm.endpoint.brokerBaseUrl, "");
  assert.equal(plan.tenantVm.connectors.whatsappRouteEnabled, false);
  assert.equal(plan.tenantVm.connectors.whatsappBrokerBaseUrl, "");
  assert.equal(plan.namespace, "tenant-bob");
  assert.equal(plan.vmName, "bob-vm");
  assert.equal(plan.cloudInitSecretName, "bob-vm-cloudinit");
  assert.equal(plan.runtimeEnv.ORKESTR_HOME, "/opt/orkestr/data");
  assert.equal(plan.runtimeEnv.ORKESTR_PORT, "24000");
  assert.equal(plan.runtimeEnv.ORKESTR_TENANT_SLICE_ID, "bob-slice");
  assert.equal(plan.runtimeEnv.ORKESTR_TENANT_VM_ID, "bob-slice-vm");
  assert.equal(plan.runtimeEnv.ORKESTR_ADMIN_USER_ID, "bob");
  assert.equal(plan.runtimeEnv.ORKESTR_DEPLOYMENT_TRACK, "tenant-vm-slice");
  assert.equal(plan.runtimeEnv.ORKESTR_CONTAINED_USER_RUNTIME_POLICY, "1");
  assert.equal(plan.runtimeEnv.ORKESTR_SHARED_CONTROL_PLANE, "1");
  assert.equal(plan.runtimeEnv.ORKESTR_AUTH_URL, "https://auth.example.test");
  assert.equal(plan.runtimeEnv.ORKESTR_PAIRING_URL, "https://connect.example.test/setup/pairing");
  assert.equal(plan.runtimeEnv.ORKESTR_BROKER_BASE_URL, "https://broker.example.test");
  assert.equal(plan.runtimeEnv.ORKESTR_DEFAULT_DESKTOP_SLUG, "linkedin-bob");
  assert.deepEqual(JSON.parse(plan.runtimeEnv.ORKESTR_API_AGENT_TENANT_BUDGETS_JSON), {
    bob: { dailyUsd: 2, monthlyUsd: 20 },
  });
  assert.equal(plan.bootstrapProfile.policy.boundary, "tenant-vm");
  assert.equal(plan.bootstrapProfile.policy.sharedAuthorization, true);
  assert.equal(plan.bootstrapProfile.policy.sharedChallenges, true);
  assert.equal(plan.bootstrapProfile.controlPlane.authUrl, "https://auth.example.test");
  assert.equal(plan.bootstrapProfile.controlPlane.pairingUrl, "https://connect.example.test/setup/pairing");
  assert.deepEqual(plan.bootstrapProfile.desks.map((desk) => desk.slug), ["linkedin-bob"]);
  assert.equal(vm.spec.template.spec.domain.cpu.cores, 2);
  assert.equal(vm.spec.template.spec.domain.resources.requests.memory, "4096Mi");
  assert.equal(vm.spec.dataVolumeTemplates[0].spec.pvc.resources.requests.storage, "30Gi");
  assert.match(runtimeEnvFile, /^ORKESTR_TENANT_SLICE_ID='bob-slice'$/m);
  assert.match(runtimeEnvFile, /^ORKESTR_TENANT_VM_ID='bob-slice-vm'$/m);
  assert.match(runtimeEnvFile, /^ORKESTR_SHARED_CONTROL_PLANE='1'$/m);
  assert.match(runtimeEnvFile, /^ORKESTR_API_AGENT_TENANT_BUDGETS_JSON='\{"bob":\{"dailyUsd":2,"monthlyUsd":20\}\}'$/m);
  assert.deepEqual(plan.commands.apply, ["kubectl", "apply", "-f", "-"]);
  assert.equal(plan.manifest.includes("password"), false);
  assert.equal(plan.manifest.includes("token"), false);
});

test("tenant slice provisioning execute path and runtime status are observable", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-tenant-slices-exec-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_TENANT_SLICE_ROOT: "/tenant-root",
    ORKESTR_TENANT_SLICE_PORT_BASE: "25000",
    ORKESTR_AUTH_URL: "https://auth.example.test",
  };
  await createTenantSlice({
    id: "charlie-slice",
    ownerUserId: "charlie",
    connectors: { whatsapp: { chatId: "charlie-wa@g.us", accountId: "sender" } },
  }, env);
  const calls = [];

  const result = await provisionTenantSlice("charlie-slice", {
    execute: true,
    namespace: "tenant-charlie",
    vmName: "charlie-vm",
    repoUrl: "https://github.com/example/orkestr.git",
  }, env, {
    spawnWithInput: async (command, args, options, input) => {
      calls.push({ command, args, options, input });
      return { stdout: "applied", stderr: "" };
    },
  });

  assert.equal(result.dryRun, false);
  assert.equal(result.tenantSlice.status, "provisioning");
  assert.equal(result.tenantVm.status, "provisioning");
  assert.equal(result.whatsappRoute.chatId, "charlie-wa@g.us");
  assert.equal(result.whatsappRoute.enabled, false);
  assert.equal(result.whatsappRoute.forwardingReady, false);
  assert.equal(result.whatsappRoute.tokenConfigured, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "kubectl");
  assert.deepEqual(calls[0].args, ["apply", "-f", "-"]);
  const appliedManifest = JSON.parse(calls[0].input);
  const appliedCloudInitSecret = appliedManifest.items.find((item) => item.kind === "Secret" && item.metadata.name === "charlie-vm-cloudinit");
  const appliedRuntimeEnvFile = Buffer.from(
    appliedCloudInitSecret.stringData.userdata.match(/path: \/etc\/orkestr\/orkestr\.env[\s\S]*?content: ([A-Za-z0-9+/=]+)/)[1],
    "base64",
  ).toString("utf8");
  assert.equal(appliedManifest.items.some((item) => item.kind === "VirtualMachine"), true);
  assert.match(appliedRuntimeEnvFile, /^ORKESTR_WHATSAPP_INBOUND_TOKEN='owt_[^']+'$/m);
  assert.equal(result.whatsappRoute.token, undefined);
  assert.equal(result.whatsappRoute.tokenSync, undefined);
  assert.equal(result.manifest.includes("ORKESTR_WHATSAPP_INBOUND_TOKEN"), false);
  assert.equal((await getTenantSlice("charlie-slice", env)).status, "provisioning");
  assert.equal((await getTenantVm("charlie-slice-vm", env)).status, "provisioning");
  assert.equal(await tenantWhatsAppInboundForwardRoute({ chatId: "charlie-wa@g.us", accountId: "sender" }, env), null);
  assert.equal((await listTenantWhatsAppRoutes(env)).find((route) => route.tenantVmId === "charlie-slice-vm").tokenConfigured, true);

  const status = await tenantSliceRuntimeStatus("charlie-slice", env);
  assert.equal(status.ok, true);
  assert.equal(status.boundary, "tenant-vm");
  assert.equal(status.service.name, "charlie-vm");
  assert.equal(status.service.namespace, "tenant-charlie");
  assert.equal(status.service.activeState, "provisioning");
  assert.equal(status.service.subState, "untrusted");

  await createTenantSlice({ id: "failed-slice", ownerUserId: "failed" }, env);
  await assert.rejects(
    () => provisionTenantSlice("failed-slice", { execute: true }, env, {
      spawnWithInput: async () => {
        throw new Error("apply failed");
      },
    }),
    /apply failed/,
  );
  const failed = await getTenantSlice("failed-slice", env);
  assert.equal(failed.status, "error");
  assert.equal(failed.lastError, "apply failed");
  assert.equal((await getTenantVm("failed-slice-vm", env)).status, "error");
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
    assert.equal(created.tenantSlice.boundary, "tenant-vm");
    assert.equal(created.tenantSlice.vm.tenantVmId, "dana-slice-vm");
    assert.equal(created.tenantSlice.portBlock.ports.orkestr, 26000);
    assert.equal(created.tenantSlice.connectors.whatsapp.chatId, "dana@g.us");

    const listed = await read(await fetch(`${baseUrl}/api/tenant-slices`, { headers: { cookie: adminCookie } }));
    assert.deepEqual(listed.tenantSlices.map((tenantSlice) => tenantSlice.id), ["dana-slice"]);

    const provisioned = await read(await fetch(`${baseUrl}/api/tenant-slices/dana-slice/provision`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({
        namespace: "tenant-dana",
        vmName: "dana-vm",
        repoUrl: "https://github.com/example/orkestr.git",
      }),
    }));
    assert.equal(provisioned.dryRun, true);
    assert.equal(provisioned.boundary, "tenant-vm");
    assert.equal(provisioned.tenantSlice.id, "dana-slice");
    assert.equal(provisioned.tenantVm.id, "dana-slice-vm");
    assert.equal(provisioned.namespace, "tenant-dana");
    assert.equal(provisioned.vmName, "dana-vm");
    assert.equal(provisioned.runtimeEnv.ORKESTR_ADMIN_USER_ID, "dana");
    assert.equal(provisioned.runtimeEnv.ORKESTR_DEFAULT_DESKTOP_SLUG, "linkedin-dana");
    assert.equal(provisioned.runtimeEnv.ORKESTR_TENANT_SLICE_ID, "dana-slice");
    assert.equal(provisioned.bootstrapProfile.policy.boundary, "tenant-vm");
    assert.deepEqual(provisioned.commands.apply, ["kubectl", "apply", "-f", "-"]);
    assert.deepEqual(JSON.parse(provisioned.runtimeEnv.ORKESTR_API_AGENT_TENANT_BUDGETS_JSON), {
      dana: { dailyUsd: 4, monthlyUsd: 40 },
    });

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
