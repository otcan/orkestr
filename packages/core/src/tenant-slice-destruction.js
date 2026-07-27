import { spawn } from "node:child_process";
import { appendEvent } from "../../storage/src/store.js";
import { deleteTenantSlice, getTenantSlice, publicTenantSlice, setTenantSliceStatus } from "./tenant-slices.js";
import { deleteTenantVm, getTenantVm, publicTenantVm, setTenantVmStatus } from "./tenant-vm-registry.js";
import { tenantVmProvisioningEnv } from "./tenant-vm-placement.js";
import { disableTenantWhatsAppRoute } from "./tenant-whatsapp-routing.js";

function clean(value = "") {
  return String(value || "").trim();
}

function truthy(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return value === true || value === 1 || ["1", "true", "yes", "on"].includes(clean(value).toLowerCase());
}

function tenantSliceError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function resourceName(value, field) {
  const name = clean(value);
  if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(name)) {
    throw tenantSliceError(`${field}_invalid`);
  }
  return name;
}

function derivedResourceName(vmName, suffix, field) {
  return resourceName(`${vmName}${suffix}`.slice(0, 63), field);
}

function resourcesFor(slice = {}, tenantVm = {}) {
  const vm = tenantVm || {};
  const tenantVmId = clean(slice.vm?.tenantVmId || slice.vm?.id || vm.id || `${slice.id}-vm`);
  const namespace = resourceName(vm.kubevirt?.namespace || slice.vm?.namespace || "orkestr-tenants", "tenant_slice_namespace");
  const vmName = resourceName(vm.kubevirt?.vmName || slice.vm?.vmName || tenantVmId, "tenant_slice_vm_name");
  return {
    namespace,
    vmName,
    serviceName: derivedResourceName(vmName, "-svc", "tenant_slice_service_name"),
    cloudInitSecretName: derivedResourceName(vmName, "-cloudinit", "tenant_slice_cloudinit_secret_name"),
    rootDiskName: derivedResourceName(vmName, "-rootdisk", "tenant_slice_root_disk_name"),
  };
}

function spawnCommand(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      const error = new Error(`kubectl_delete_failed:${code}`);
      error.statusCode = 500;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

export function buildTenantSliceDestructionPlan(sliceInput = {}, tenantVmInput = null, input = {}, env = process.env) {
  const slice = sliceInput || {};
  const tenantVm = tenantVmInput || null;
  const resources = resourcesFor(slice, tenantVm || {});
  const execute = truthy(input.execute, false) && input.dryRun !== true;
  const kubectl = clean(env.ORKESTR_KUBECTL || "kubectl");
  return {
    ok: true,
    boundary: "tenant-vm",
    dryRun: !execute,
    tenantSlice: publicTenantSlice(slice),
    tenantVm: tenantVm ? publicTenantVm(tenantVm) : null,
    ...resources,
    commands: {
      delete: [
        kubectl,
        "--namespace", resources.namespace,
        "delete",
        "virtualmachine", resources.vmName,
        "service", resources.serviceName,
        "secret", resources.cloudInitSecretName,
        "datavolume", resources.rootDiskName,
        "pvc", resources.rootDiskName,
        "--ignore-not-found=true",
        "--wait=true",
      ],
    },
  };
}

export async function destroyTenantSlice(tenantSliceId, input = {}, env = process.env, options = {}) {
  const slice = await getTenantSlice(tenantSliceId, env);
  if (!slice) throw tenantSliceError("tenant_slice_not_found", 404);
  const tenantVmId = clean(slice.vm?.tenantVmId || slice.vm?.id || `${slice.id}-vm`);
  const tenantVm = tenantVmId ? await getTenantVm(tenantVmId, env).catch(() => null) : null;
  const plan = buildTenantSliceDestructionPlan(slice, tenantVm, input, env);
  if (plan.dryRun) return plan;

  await setTenantSliceStatus(slice.id, "destroying", { lastError: "" }, env);
  if (tenantVm) await setTenantVmStatus(tenantVm.id, "destroying", { lastError: "" }, env);
  try {
    if (tenantVm?.connectors?.whatsappRouteEnabled) await disableTenantWhatsAppRoute(tenantVm.id, env);
    const [command, ...args] = plan.commands.delete;
    const runner = options.spawnCommand || spawnCommand;
    const output = await runner(command, args, {
      env: tenantVmProvisioningEnv({}, env),
      maxBuffer: 1024 * 1024 * 16,
    });
    const [deletedSlice, deletedVm] = await Promise.all([
      deleteTenantSlice(slice.id, env),
      tenantVm ? deleteTenantVm(tenantVm.id, env) : Promise.resolve(null),
    ]);
    await appendEvent({
      type: "tenant_slice_resources_destroyed",
      tenantSliceId: deletedSlice.id,
      tenantVmId: deletedVm?.id || tenantVmId,
      ownerUserId: deletedSlice.ownerUserId,
      namespace: plan.namespace,
      vmName: plan.vmName,
    }, env).catch(() => {});
    return {
      ...plan,
      dryRun: false,
      tenantSlice: publicTenantSlice(deletedSlice),
      tenantVm: deletedVm ? publicTenantVm(deletedVm) : null,
      output,
    };
  } catch (error) {
    const lastError = clean(error?.stderr || error?.message || error).slice(0, 1000);
    await setTenantSliceStatus(slice.id, "error", { lastError }, env).catch(() => {});
    if (tenantVm) await setTenantVmStatus(tenantVm.id, "error", { lastError }, env).catch(() => {});
    throw error;
  }
}
