import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTenantVm, getTenantVm } from "../packages/core/src/tenant-vm-registry.js";
import { buildTenantVmProvisioningPlan, provisionTenantVm } from "../packages/core/src/tenant-vm-provisioning.js";

const fakePublicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEPublicTenantProvisioningTestKeyOnly test@example.test";

test("tenant VM provisioning builds a public-safe KubeVirt plan", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-tenant-vm-provision-plan-"));
  const env = { ORKESTR_HOME: home, ORKESTR_PUBLIC_URL: "https://app.example.test" };
  const tenantVm = await createTenantVm({
    id: "alice-tenant",
    ownerUserId: "alice",
    resources: { vcpus: 2, memoryMiB: 8192, diskGiB: 100 },
    endpoint: { domain: "alice.example.test", baseUrl: "https://alice.example.test", publicIp: "203.0.113.10" },
    kubevirt: { namespace: "tenant-a", vmName: "alice-vm", storageClass: "local-path" },
    bootstrap: { firstThreadName: "Alice Launch", skills: ["salesnav"], desks: ["linkedin"] },
    capabilities: ["codex", "desks", "files", "timers", "whatsapp"],
  }, env);

  const plan = buildTenantVmProvisioningPlan(tenantVm, {
    sshPublicKeys: [fakePublicKey],
    repoUrl: "https://github.com/example/orkestr.git",
    gitRef: "main",
  }, env);
  const manifest = JSON.parse(plan.manifest);
  const vm = manifest.items.find((item) => item.kind === "VirtualMachine");
  const cloudInitSecret = manifest.items.find((item) => item.kind === "Secret" && item.metadata.name === "alice-vm-cloudinit");
  const cloudInitVolume = vm.spec.template.spec.volumes.find((volume) => volume.name === "cloudinitdisk").cloudInitNoCloud;
  const userData = cloudInitSecret.stringData.userdata;
  const profile = JSON.parse(Buffer.from(userData.match(/content: ([A-Za-z0-9+/=]+)/)[1], "base64").toString("utf8"));
  const envFile = Buffer.from(
    userData.match(/path: \/etc\/orkestr\/orkestr\.env[\s\S]*?content: ([A-Za-z0-9+/=]+)/)[1],
    "base64",
  ).toString("utf8");

  assert.equal(plan.namespace, "tenant-a");
  assert.equal(plan.vmName, "alice-vm");
  assert.match(plan.macAddress, /^02(?::[0-9a-f]{2}){5}$/);
  assert.equal(plan.cloudInitSecretName, "alice-vm-cloudinit");
  assert.equal(plan.runtimeEnv.ORKESTR_HOST, "0.0.0.0");
  assert.equal(
    plan.runtimeEnv.ORKESTR_DESKTOP_SHARE_URL_TEMPLATE,
    "https://app.example.test/desktop-share/tvm/alice-tenant/{subdomain}/{shareId}?key={key}",
  );
  assert.equal(plan.bootstrapProfilePath, "/etc/orkestr/tenant-bootstrap-profile.json");
  assert.equal(plan.bootstrapProfile.firstChat.name, "Alice Launch");
  assert.equal(plan.bootstrapProfile.codex.model, "gpt-5.5");
  assert.equal(plan.bootstrapProfile.codex.reasoningEffort, "medium");
  assert.equal(plan.bootstrapProfile.policy.singleThreadLimit, true);
  assert.deepEqual(plan.bootstrapProfile.desks.map((desk) => desk.slug), ["linkedin"]);
  assert.ok(plan.bootstrapProfile.skills.includes("learning"));
  assert.ok(plan.bootstrapProfile.skills.includes("whatsapp"));
  assert.ok(plan.bootstrapProfile.skills.includes("salesnav"));
  assert.equal(plan.bootstrapProfile.connectors.whatsapp.chatId, "");
  assert.deepEqual(profile, plan.bootstrapProfile);
  assert.equal(vm.spec.template.spec.domain.cpu.cores, 2);
  assert.equal(vm.spec.template.spec.domain.resources.requests.memory, "8192Mi");
  assert.deepEqual(vm.spec.template.spec.domain.devices.interfaces[0], {
    name: "default",
    bridge: {},
    macAddress: plan.macAddress,
  });
  assert.equal(vm.spec.dataVolumeTemplates[0].spec.pvc.resources.requests.storage, "100Gi");
  assert.match(vm.spec.dataVolumeTemplates[0].spec.source.http.url, /noble-server-cloudimg-amd64\.img/);
  assert.deepEqual(cloudInitVolume, { secretRef: { name: "alice-vm-cloudinit" } });
  assert.ok(userData.length > 2048);
  assert.match(userData, /bootstrap-vps\.sh/);
  assert.match(userData, /write_files:/);
  assert.match(userData, /\/etc\/orkestr\/tenant-bootstrap-profile\.json/);
  assert.match(userData, /--domain' 'alice\.example\.test/);
  assert.match(userData, /--with-whatsapp/);
  assert.match(userData, /--tenant-bootstrap-profile' '\/etc\/orkestr\/tenant-bootstrap-profile\.json/);
  assert.match(userData, /ssh-ed25519/);
  assert.match(envFile, /^ORKESTR_HOST='0\.0\.0\.0'$/m);
  assert.match(envFile, /^ORKESTR_DESKTOP_SHARE_URL_TEMPLATE='https:\/\/app\.example\.test\/desktop-share\/tvm\/alice-tenant\/\{subdomain\}\/\{shareId\}\?key=\{key\}'$/m);
  assert.deepEqual(plan.commands.apply, ["kubectl", "apply", "-f", "-"]);
  assert.deepEqual(plan.commands.publicIpRoute.slice(0, 7), [
    "bash",
    "scripts/k3s-vm-public-ip.sh",
    "install-systemd",
    "--namespace",
    "tenant-a",
    "--vm",
    "alice-vm",
  ]);
  assert.equal(plan.manifest.includes("password"), false);
  assert.equal(plan.manifest.includes("token"), false);
});

test("tenant VM demo cloud-init includes local Orkestr port for the notifier", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-tenant-vm-demo-env-"));
  const env = { ORKESTR_HOME: home };
  const tenantVm = await createTenantVm({
    id: "demo-tenant",
    ownerUserId: "demo",
    kubevirt: { namespace: "demo", vmName: "demo-vm" },
  }, env);

  const plan = buildTenantVmProvisioningPlan(tenantVm, {
    demoMode: true,
    whatsappNumber: "+49 176 123456",
    brokerBaseUrl: "https://connect.example.test",
    entryBaseUrl: "https://orkestr.example.test",
  }, env);
  const manifest = JSON.parse(plan.manifest);
  const cloudInitSecret = manifest.items.find((item) => item.kind === "Secret" && item.metadata.name === "demo-vm-cloudinit");
  const userData = cloudInitSecret.stringData.userdata;
  const envFile = Buffer.from(
    userData.match(/path: \/etc\/orkestr\/orkestr\.env[\s\S]*?content: ([A-Za-z0-9+/=]+)/)[1],
    "base64",
  ).toString("utf8");

  assert.match(envFile, /^ORKESTR_HOME='\/opt\/orkestr\/data'$/m);
  assert.match(envFile, /^ORKESTR_HOST='0\.0\.0\.0'$/m);
  assert.match(envFile, /^ORKESTR_PORT='19812'$/m);
  assert.match(envFile, /^PORT='19812'$/m);
  assert.match(envFile, /^ORKESTR_DEMO_WHATSAPP_NUMBER='\+49 176 123456'$/m);
  assert.match(envFile, /^ORKESTR_DEMO_ENTRY_BASE_URL='https:\/\/orkestr\.example\.test'$/m);
  assert.doesNotMatch(envFile, /whatsappChatHash|chatId/i);
});

test("tenant VM provisioning derives central setup URLs from connect base", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-tenant-vm-public-url-"));
  const env = {
    ORKESTR_HOME: home,
    ORKESTR_CONNECT_PUBLIC_URL: "https://connect.example.test",
    ORKESTR_PAIRING_URL: "https://connect.example.test/setup/pairing",
  };
  const tenantVm = await createTenantVm({
    id: "firat-jobs-vm",
    ownerUserId: "firat",
    kubevirt: { namespace: "tenant-firat", vmName: "firat-jobs-vm" },
  }, env);

  const plan = buildTenantVmProvisioningPlan(tenantVm, {}, env);
  const manifest = JSON.parse(plan.manifest);
  const cloudInitSecret = manifest.items.find((item) => item.kind === "Secret" && item.metadata.name === "firat-jobs-vm-cloudinit");
  const envFile = Buffer.from(
    cloudInitSecret.stringData.userdata.match(/path: \/etc\/orkestr\/orkestr\.env[\s\S]*?content: ([A-Za-z0-9+/=]+)/)[1],
    "base64",
  ).toString("utf8");

  assert.equal(plan.runtimeEnv.ORKESTR_HOST, "0.0.0.0");
  assert.equal(plan.runtimeEnv.ORKESTR_PUBLIC_URL, "https://connect.example.test");
  assert.equal(plan.runtimeEnv.ORKESTR_PUBLIC_HTTPS_URL, "https://connect.example.test");
  assert.equal(plan.runtimeEnv.ORKESTR_CONNECT_PUBLIC_BASE_URL, "https://connect.example.test");
  assert.equal(plan.runtimeEnv.ORKESTR_CONNECT_PUBLIC_SETUP_URL, "https://connect.example.test/i/firat-jobs-vm/setup");
  assert.equal(plan.runtimeEnv.ORKESTR_PAIRING_URL, "https://connect.example.test/setup/pairing");
  assert.match(envFile, /^ORKESTR_CONNECT_PUBLIC_SETUP_URL='https:\/\/connect\.example\.test\/i\/firat-jobs-vm\/setup'$/m);
  assert.doesNotMatch(plan.runtimeEnv.ORKESTR_CONNECT_PUBLIC_SETUP_URL, /0\.0\.0\.0|127\.0\.0\.1|localhost|10\./);
});

test("tenant VM provisioning execute path applies manifest and updates registry status", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-tenant-vm-provision-exec-"));
  const env = { ORKESTR_HOME: home };
  await createTenantVm({
    id: "bob-tenant",
    ownerUserId: "bob",
    resources: { vcpus: 3, memoryMiB: 6144, diskGiB: 80 },
    endpoint: { domain: "bob.example.test" },
  }, env);
  const calls = [];

  const result = await provisionTenantVm("bob-tenant", {
    execute: true,
    repoUrl: "https://github.com/example/orkestr.git",
    sshPublicKeys: [fakePublicKey],
    kubeconfig: "/tmp/k3s.yaml",
  }, env, {
    spawnWithInput: async (command, args, options, input) => {
      calls.push({ command, args, options, input });
      return { stdout: "applied", stderr: "" };
    },
  });

  assert.equal(result.dryRun, false);
  assert.equal(result.tenantVm.status, "provisioning");
  assert.equal(result.cloudInitSecretName, "bob-tenant-cloudinit");
  assert.equal(result.bootstrapProfile.firstChat.name, "bob");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "kubectl");
  assert.deepEqual(calls[0].args, ["apply", "-f", "-"]);
  assert.equal(calls[0].options.env.KUBECONFIG, "/tmp/k3s.yaml");
  assert.equal(JSON.parse(calls[0].input).items.some((item) => item.kind === "VirtualMachine"), true);
  assert.equal((await getTenantVm("bob-tenant", env)).status, "provisioning");
});

test("tenant VM provisioning refuses credentialed public URLs", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "orkestr-tenant-vm-provision-secret-url-"));
  const env = { ORKESTR_HOME: home };
  const tenantVm = await createTenantVm({ id: "charlie-tenant", ownerUserId: "charlie" }, env);

  assert.throws(
    () => buildTenantVmProvisioningPlan(tenantVm, { repoUrl: "https://token@example.test/repo.git" }, env),
    /repo_url_must_not_include_credentials/,
  );
});
