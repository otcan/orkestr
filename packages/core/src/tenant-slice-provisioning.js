import { spawn } from "node:child_process";
import {
  getTenantSlice,
  normalizeTenantSlice,
  publicTenantSlice,
  setTenantSliceStatus,
} from "./tenant-slices.js";
import { normalizeTenantControlPlane, publicTenantControlPlane } from "./tenant-control-plane.js";
import {
  createTenantVm,
  getTenantVm,
  getTenantVmForOwner,
  normalizeTenantVm,
  publicTenantVm,
  setTenantVmStatus,
  updateTenantVm,
} from "./tenant-vm-registry.js";
import { buildTenantVmProvisioningPlan } from "./tenant-vm-provisioning.js";
import { configureTenantWhatsAppRoute } from "./tenant-whatsapp-routing.js";

function nowIso() {
  return new Date().toISOString();
}

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

function uniqueList(values = []) {
  return [...new Set(values.map((value) => clean(value)).filter(Boolean))];
}

function vmCapabilities(slice) {
  const capabilities = new Set(uniqueList(slice.capabilities || []));
  if (capabilities.has("linkedin")) {
    capabilities.add("desks");
    capabilities.delete("linkedin");
  }
  if (slice.connectors?.linkedin?.enabled !== false) capabilities.add("desks");
  if (slice.connectors?.gmail?.enabled !== false) capabilities.add("gmail");
  if (slice.connectors?.whatsapp?.enabled !== false) capabilities.add("whatsapp");
  if (slice.connectors?.oxrm?.enabled !== false) capabilities.add("oxrm");
  capabilities.add("codex");
  capabilities.add("files");
  capabilities.add("timers");
  return [...capabilities];
}

function sharedControlPlane(slice, input = {}, env = process.env) {
  return normalizeTenantControlPlane(input.controlPlane || input.sharedControlPlane || slice.controlPlane || {}, env, { defaultEnabled: true });
}

function tenantVmInputForSlice(sliceInput = {}, input = {}, env = process.env) {
  const slice = normalizeTenantSlice(sliceInput, env);
  const vm = slice.vm || {};
  const desktopSlug = clean(slice.connectors?.linkedin?.desktopSlug || "linkedin") || "linkedin";
  const targetBaseUrl = clean(input.targetBaseUrl || input.whatsappTargetBaseUrl || vm.endpoint?.baseUrl);
  const targetBrokerBaseUrl = clean(input.whatsappBrokerBaseUrl || input.routeBrokerBaseUrl || vm.endpoint?.brokerBaseUrl);
  const whatsappRouteMode = targetBrokerBaseUrl
    ? "broker"
    : targetBaseUrl
      ? "direct"
      : clean(slice.connectors?.whatsapp?.routeMode || "parent-forward");
  return normalizeTenantVm({
    id: clean(input.tenantVmId || input.vmId || vm.tenantVmId || vm.id) || `${slice.id}-vm`,
    ownerUserId: slice.ownerUserId,
    displayName: clean(input.vmDisplayName || input.displayName || `${slice.displayName} VM`),
    status: "planned",
    resources: vm.resources,
    endpoint: {
      ...vm.endpoint,
      domain: clean(input.domain || vm.endpoint?.domain),
      baseUrl: targetBaseUrl,
      brokerBaseUrl: targetBrokerBaseUrl,
      publicIp: clean(input.publicIp || vm.endpoint?.publicIp),
    },
    kubevirt: {
      namespace: clean(input.namespace || vm.namespace || vm.kubevirt?.namespace),
      vmName: clean(input.vmName || vm.vmName || vm.kubevirt?.vmName || vm.id || `${slice.id}-vm`),
      storageClass: clean(input.storageClass || vm.storageClass || vm.kubevirt?.storageClass),
    },
    bootstrap: {
      firstThreadName: clean(input.firstThreadName || slice.displayName || slice.ownerUserId),
      firstThreadId: clean(input.firstThreadId || slice.id),
      desks: slice.connectors?.linkedin?.enabled === false ? [] : [desktopSlug],
      skills: vmCapabilities(slice),
    },
    desktops: {
      enabled: slice.connectors?.linkedin?.enabled !== false,
      provisioned: ["warming", "running"].includes(slice.status),
      defaultSlug: desktopSlug,
      visibleSlugs: slice.connectors?.linkedin?.enabled === false ? [] : [desktopSlug],
      status: slice.status === "error" ? "error" : slice.status === "running" ? "ready" : "not_provisioned",
    },
    connectors: {
      whatsappChatId: clean(slice.connectors?.whatsapp?.chatId),
      whatsappAccountId: clean(slice.connectors?.whatsapp?.accountId),
      whatsappRouteEnabled: false,
      whatsappRouteMode,
      whatsappBrokerBaseUrl: targetBrokerBaseUrl,
      gmailAccountId: clean(slice.connectors?.gmail?.accountId),
      linkedinDesktopSlug: desktopSlug,
    },
    capabilities: vmCapabilities(slice),
    labels: {
      ...slice.labels,
      tenantSliceId: slice.id,
      boundary: "tenant-vm",
    },
  }, env);
}

function vmProvisionInput(slice, tenantVm, input = {}, env = process.env) {
  const controlPlane = sharedControlPlane(slice, input, env);
  const runtimeEnv = input.runtimeEnv && typeof input.runtimeEnv === "object" && !Array.isArray(input.runtimeEnv) ? input.runtimeEnv : {};
  return {
    ...input,
    tenantVmId: tenantVm.id,
    tenantSliceId: slice.id,
    ownerUserId: slice.ownerUserId,
    controlPlane,
    sharedControlPlane: controlPlane,
    brokerBaseUrl: input.brokerBaseUrl || controlPlane.brokerBaseUrl,
    connectPublicBaseUrl: input.connectPublicBaseUrl || input.publicConnectBaseUrl || controlPlane.connectPublicBaseUrl,
    connectPublicSetupUrl: input.connectPublicSetupUrl || input.publicSetupUrl || controlPlane.connectPublicSetupUrl,
    port: input.port || input.orkestrPort || slice.portBlock?.ports?.orkestr || "19812",
    instanceDesktopsProvisioned: slice.connectors?.linkedin?.enabled === false ? "0" : "1",
    runtimeEnv: {
      ORKESTR_TENANT_SLICE_ID: slice.id,
      ORKESTR_TENANT_VM_ID: tenantVm.id,
      ORKESTR_ADMIN_USER_ID: slice.ownerUserId,
      ORKESTR_DEPLOYMENT_TRACK: "tenant-vm-slice",
      ORKESTR_DEFAULT_DESKTOP_SLUG: clean(slice.connectors?.linkedin?.desktopSlug || "linkedin") || "linkedin",
      ORKESTR_API_AGENT_TENANT_BUDGETS_JSON: JSON.stringify({ [slice.ownerUserId]: slice.budget }),
      ...runtimeEnv,
    },
  };
}

function spawnWithInput(command, args, options, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(`kubectl_apply_failed:${code}`);
      error.statusCode = 500;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
    child.stdin.end(input);
  });
}

export function buildTenantSliceProvisioningPlan(sliceInput = {}, input = {}, env = process.env) {
  const slice = normalizeTenantSlice(sliceInput, env);
  const tenantVm = tenantVmInputForSlice(slice, input, env);
  const provisionInput = vmProvisionInput(slice, tenantVm, input, env);
  const vmPlan = buildTenantVmProvisioningPlan(tenantVm, provisionInput, env);
  const execute = truthy(input.execute, false) && input.dryRun !== true;
  return {
    ok: true,
    boundary: "tenant-vm",
    dryRun: !execute,
    tenantSlice: publicTenantSlice(slice),
    tenantVm: publicTenantVm(tenantVm),
    sharedControlPlane: publicTenantControlPlane(provisionInput.sharedControlPlane),
    namespace: vmPlan.namespace,
    vmName: vmPlan.vmName,
    cloudInitSecretName: vmPlan.cloudInitSecretName,
    bootstrapProfilePath: vmPlan.bootstrapProfilePath,
    bootstrapProfile: vmPlan.bootstrapProfile,
    runtimeEnv: vmPlan.runtimeEnv,
    manifest: vmPlan.manifest,
    commands: vmPlan.commands,
  };
}

async function ensureTenantVm(tenantVm, env = process.env) {
  const existingById = await getTenantVm(tenantVm.id, env);
  if (existingById) return updateTenantVm(tenantVm.id, tenantVm, env);
  const existingForOwner = await getTenantVmForOwner(tenantVm.ownerUserId, env);
  if (existingForOwner && existingForOwner.id !== tenantVm.id) {
    throw tenantSliceError("tenant_vm_owner_already_has_instance", 409);
  }
  return createTenantVm(tenantVm, env);
}

async function stageTenantSliceWhatsAppRoute(slice, tenantVm, input = {}, env = process.env) {
  if (slice.connectors?.whatsapp?.enabled === false) return null;
  const chatId = clean(slice.connectors?.whatsapp?.chatId);
  if (!chatId) return null;
  const route = await configureTenantWhatsAppRoute(tenantVm.id, {
    chatId,
    chatName: clean(input.chatName || input.displayName || slice.displayName),
    accountId: clean(slice.connectors?.whatsapp?.accountId),
    routeMode: clean(tenantVm.connectors?.whatsappRouteMode),
    brokerBaseUrl: clean(tenantVm.endpoint?.brokerBaseUrl || tenantVm.connectors?.whatsappBrokerBaseUrl),
    baseUrl: clean(tenantVm.endpoint?.baseUrl),
    enabled: false,
    allowPending: true,
  }, env);
  const { token: _token, tokenSync: _tokenSync, ...safeRoute } = route.route || {};
  return {
    route: safeRoute,
    token: clean(route.route?.token),
  };
}

export async function provisionTenantSlice(tenantSliceId, input = {}, env = process.env, options = {}) {
  const slice = await getTenantSlice(tenantSliceId, env);
  if (!slice) throw tenantSliceError("tenant_slice_not_found", 404);
  const plan = buildTenantSliceProvisioningPlan(slice, input, env);
  if (plan.dryRun) return plan;

  let registryVm = null;
  await setTenantSliceStatus(slice.id, "provisioning", { lastError: "" }, env);
  try {
    registryVm = await ensureTenantVm(plan.tenantVm, env);
    const stagedWhatsappRoute = await stageTenantSliceWhatsAppRoute(slice, registryVm, input, env);
    const executionInput = stagedWhatsappRoute?.token
      ? {
        ...input,
        runtimeEnv: {
          ...(input.runtimeEnv && typeof input.runtimeEnv === "object" && !Array.isArray(input.runtimeEnv) ? input.runtimeEnv : {}),
          ORKESTR_WHATSAPP_INBOUND_TOKEN: stagedWhatsappRoute.token,
        },
      }
      : input;
    const executionPlan = stagedWhatsappRoute?.token
      ? buildTenantSliceProvisioningPlan(slice, executionInput, env)
      : plan;
    const [command, ...args] = executionPlan.commands.apply;
    const runner = options.spawnWithInput || spawnWithInput;
    const output = await runner(command, args, {
      env: { ...process.env, ...env, ...(input.kubeconfig ? { KUBECONFIG: clean(input.kubeconfig) } : {}) },
      maxBuffer: 1024 * 1024 * 16,
    }, executionPlan.manifest);
    const [tenantSlice, tenantVm] = await Promise.all([
      setTenantSliceStatus(slice.id, "provisioning", { lastError: "" }, env),
      setTenantVmStatus(registryVm.id, "provisioning", { lastError: "" }, env),
    ]);
    return {
      ...plan,
      dryRun: false,
      tenantSlice: publicTenantSlice(tenantSlice),
      tenantVm: publicTenantVm(tenantVm),
      ...(stagedWhatsappRoute?.route ? { whatsappRoute: stagedWhatsappRoute.route } : {}),
      output,
    };
  } catch (error) {
    const lastError = clean(error?.stderr || error?.message || error).slice(0, 1000);
    await setTenantSliceStatus(slice.id, "error", { lastError }, env).catch(() => {});
    if (registryVm) await setTenantVmStatus(registryVm.id, "error", { lastError }, env).catch(() => {});
    throw error;
  }
}

export async function tenantSliceRuntimeStatus(tenantSliceId, env = process.env) {
  const slice = await getTenantSlice(tenantSliceId, env);
  if (!slice) throw tenantSliceError("tenant_slice_not_found", 404);
  const tenantVmId = clean(slice.vm?.tenantVmId || slice.vm?.id || `${slice.id}-vm`);
  const tenantVm = await getTenantVm(tenantVmId, env).catch(() => null) ||
    await getTenantVmForOwner(slice.ownerUserId, env).catch(() => null);
  const vmName = clean(tenantVm?.kubevirt?.vmName || slice.vm?.vmName || tenantVmId);
  const namespace = clean(tenantVm?.kubevirt?.namespace || slice.vm?.namespace || "orkestr-tenants");
  return {
    ok: Boolean(tenantVm) && !["error", "deleted"].includes(tenantVm.status),
    boundary: "tenant-vm",
    tenantSlice: publicTenantSlice(slice),
    tenantVm: tenantVm ? publicTenantVm(tenantVm) : null,
    service: {
      name: vmName,
      namespace,
      activeState: clean(tenantVm?.status || slice.status || "unknown"),
      subState: tenantVm ? clean(tenantVm.trust?.trustLevel || "registered") : "tenant_vm_not_registered",
    },
    error: tenantVm ? "" : "tenant_vm_not_registered",
    generatedAt: nowIso(),
  };
}
