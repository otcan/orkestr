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
  createTenantVm,
  deleteTenantVm,
  getTenantVmForOwner,
  getTenantVmForPrincipal,
  listTenantVmsForPrincipal,
  publicTenantVm,
} from "../packages/core/src/tenant-vm-registry.js";

async function read(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : {};
}

test("tenant VM registry keeps one active tenant instance per owner", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-tenant-vms-core-"));
  const env = { ORKESTR_HOME: home };

  const vm = await createTenantVm({
    id: "Otcan Test",
    ownerUserId: "otcan",
    displayName: "Otcan tenant",
    resources: { vcpus: 2, memoryMiB: 8192, diskGiB: 100 },
    endpoint: { domain: "tenant.example.test", baseUrl: "https://tenant.example.test", publicIp: "192.0.2.10" },
    kubevirt: { namespace: "orkestr-tenants", vmName: "otcan-vm" },
    bootstrap: { firstThreadName: "otcantest" },
    connectors: { whatsappChatName: "otcantest" },
  }, env);

  assert.equal(vm.id, "otcan-test");
  assert.equal(vm.ownerUserId, "otcan");
  assert.equal(vm.status, "planned");
  assert.equal(vm.resources.memoryMiB, 8192);
  assert.equal(vm.endpoint.domain, "tenant.example.test");
  assert.equal(vm.kubevirt.vmName, "otcan-vm");
  assert.equal(vm.bootstrap.firstThreadName, "otcantest");
  assert.equal(vm.connectors.whatsappChatName, "otcantest");

  await assert.rejects(
    () => createTenantVm({ id: "otcan-second", ownerUserId: "otcan" }, env),
    /tenant_vm_owner_already_has_instance/,
  );
  assert.equal((await getTenantVmForOwner("otcan", env)).id, "otcan-test");
  assert.deepEqual((await listTenantVmsForPrincipal(userPrincipal({ id: "otcan" }), env)).map((item) => item.id), ["otcan-test"]);
  assert.deepEqual(await listTenantVmsForPrincipal(userPrincipal({ id: "bob" }), env), []);
  assert.deepEqual(await listTenantVmsForPrincipal({}, env), []);
  await assert.rejects(
    () => getTenantVmForPrincipal("otcan-test", userPrincipal({ id: "bob" }), env),
    /tenant_vm_access_forbidden/,
  );

  const publicVm = publicTenantVm({ ...vm, token: "secret", password: "secret" });
  assert.equal(Object.hasOwn(publicVm, "token"), false);
  assert.equal(Object.hasOwn(publicVm, "password"), false);

  const deleted = await deleteTenantVm("otcan-test", env);
  assert.equal(deleted.status, "deleted");
  assert.ok(deleted.deletedAt);
  const replacement = await createTenantVm({ id: "otcan-next", ownerUserId: "otcan" }, env);
  assert.equal(replacement.id, "otcan-next");
});

test("tenant VM registry API is admin-only and returns public-safe records", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-tenant-vms-api-"));
  const priorHome = process.env.ORKESTR_HOME;
  const priorAuth = process.env.ORKESTR_AUTH_REQUIRED;
  const priorRecover = process.env.ORKESTR_RECOVER_RUNNING_ON_START;
  process.env.ORKESTR_HOME = home;
  process.env.ORKESTR_AUTH_REQUIRED = "1";
  process.env.ORKESTR_RECOVER_RUNNING_ON_START = "0";
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

    const created = await read(await fetch(`${baseUrl}/api/tenant-vms`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({
        id: "alice-tenant",
        ownerUserId: "alice",
        displayName: "Alice tenant",
        resources: { vcpus: 3, memoryMiB: 6144, diskGiB: 80 },
        endpoint: { domain: "alice.example.test", baseUrl: "https://alice.example.test" },
        kubevirt: { namespace: "tenant-a", vmName: "alice-vm", storageClass: "local-path" },
        connectors: { whatsappChatName: "alice-wa" },
        token: "must-not-be-persisted",
      }),
    }));
    assert.equal(created.tenantVm.id, "alice-tenant");
    assert.equal(created.tenantVm.ownerUserId, "alice");
    assert.equal(created.tenantVm.resources.vcpus, 3);
    assert.equal(created.tenantVm.endpoint.baseUrl, "https://alice.example.test");
    assert.equal(Object.hasOwn(created.tenantVm, "token"), false);

    const duplicate = await fetch(`${baseUrl}/api/tenant-vms`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ id: "alice-duplicate", ownerUserId: "alice" }),
    });
    const duplicatePayload = await read(duplicate);
    assert.equal(duplicate.status, 409);
    assert.equal(duplicatePayload.error, "tenant_vm_owner_already_has_instance");

    const updated = await read(await fetch(`${baseUrl}/api/tenant-vms/alice-tenant/status`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ status: "running" }),
    }));
    assert.equal(updated.tenantVm.status, "running");

    const listed = await read(await fetch(`${baseUrl}/api/tenant-vms`, { headers: { cookie: adminCookie } }));
    assert.deepEqual(listed.tenantVms.map((tenantVm) => tenantVm.id), ["alice-tenant"]);

    await createUser({
      email: "alice@example.test",
      phoneNumber: "+15551234567",
      role: "user",
      displayName: "Alice",
    }, process.env);
    const userChallenge = await read(await fetch(`${baseUrl}/api/setup/security/challenges`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: adminCookie },
      body: JSON.stringify({ userId: "alice-example.test" }),
    }));
    await approvePairingChallenge(userChallenge.challengeId, { env: process.env });
    const userPair = await fetch(`${baseUrl}/api/setup/security/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ challengeId: userChallenge.challengeId }),
    });
    const userCookie = userPair.headers.get("set-cookie") || "";
    assert.equal(userPair.status, 200);

    const denied = await fetch(`${baseUrl}/api/tenant-vms`, { headers: { cookie: userCookie } });
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
  }
});
