import { randomUUID } from "node:crypto";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { assertOwnerAccess, isAdminPrincipal } from "./policy.js";
import { adminUserId, normalizeUserId } from "./users.js";

const statuses = new Set(["planned", "provisioning", "running", "stopped", "error", "deleting", "deleted"]);

function nowIso() {
  return new Date().toISOString();
}

function clean(value = "") {
  return String(value || "").trim();
}

function safeTenantVmId(value = "") {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

function tenantVmError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeStatus(value = "planned") {
  const status = clean(value).toLowerCase();
  return statuses.has(status) ? status : "planned";
}

function normalizeNumber(value, fallback, { min = 1, max = 1_000_000 } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function normalizeStringList(values = []) {
  const list = Array.isArray(values) ? values : String(values || "").split(",");
  return [...new Set(list.map((value) => clean(value)).filter(Boolean))];
}

function normalizeLabels(labels = {}) {
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) return {};
  return Object.fromEntries(
    Object.entries(labels)
      .map(([key, value]) => [clean(key).slice(0, 64), clean(value).slice(0, 160)])
      .filter(([key]) => key),
  );
}

function normalizeResources(resources = {}) {
  const input = resources && typeof resources === "object" && !Array.isArray(resources) ? resources : {};
  return {
    vcpus: normalizeNumber(input.vcpus ?? input.cpu ?? 2, 2, { min: 1, max: 64 }),
    memoryMiB: normalizeNumber(input.memoryMiB ?? input.memoryMb ?? input.memory ?? 8192, 8192, { min: 512, max: 1048576 }),
    diskGiB: normalizeNumber(input.diskGiB ?? input.diskGb ?? input.disk ?? 100, 100, { min: 5, max: 16384 }),
  };
}

function normalizeEndpoint(endpoint = {}, input = {}) {
  const source = endpoint && typeof endpoint === "object" && !Array.isArray(endpoint) ? endpoint : {};
  return {
    domain: clean(source.domain || input.domain),
    baseUrl: clean(source.baseUrl || source.url || input.baseUrl || input.url),
    brokerBaseUrl: clean(source.brokerBaseUrl || source.controlPlaneBaseUrl || source.internalBaseUrl || input.brokerBaseUrl || input.controlPlaneBaseUrl || input.internalBaseUrl),
    publicIp: clean(source.publicIp || source.ip || input.publicIp || input.ip),
    sshHost: clean(source.sshHost || input.sshHost),
    sshUser: clean(source.sshUser || input.sshUser || "root"),
  };
}

function normalizeKubevirt(kubevirt = {}, input = {}) {
  const source = kubevirt && typeof kubevirt === "object" && !Array.isArray(kubevirt) ? kubevirt : {};
  return {
    namespace: clean(source.namespace || input.namespace || "orkestr-tenants"),
    vmName: clean(source.vmName || source.name || input.vmName),
    vmiName: clean(source.vmiName || input.vmiName),
    storageClass: clean(source.storageClass || input.storageClass),
    template: clean(source.template || input.template),
  };
}

function normalizeBootstrap(bootstrap = {}) {
  const source = bootstrap && typeof bootstrap === "object" && !Array.isArray(bootstrap) ? bootstrap : {};
  return {
    firstThreadName: clean(source.firstThreadName || source.threadName || ""),
    firstThreadId: clean(source.firstThreadId || source.threadId || ""),
    workspacePath: clean(source.workspacePath || ""),
    filesRoot: clean(source.filesRoot || ""),
    codexModel: clean(source.codexModel || ""),
    codexReasoningEffort: clean(source.codexReasoningEffort || ""),
    codexMode: clean(source.codexMode || ""),
    autoWakeFirstThread: source.autoWakeFirstThread !== false,
    desks: normalizeStringList(source.desks || []),
    skills: normalizeStringList(source.skills || source.learningSkills || []),
  };
}

function normalizeConnectors(connectors = {}) {
  const source = connectors && typeof connectors === "object" && !Array.isArray(connectors) ? connectors : {};
  return {
    whatsappChatName: clean(source.whatsappChatName || source.waChatName || ""),
    whatsappChatId: clean(source.whatsappChatId || source.waChatId || ""),
    whatsappAccountId: clean(source.whatsappAccountId || source.waAccountId || ""),
    whatsappRouteEnabled: source.whatsappRouteEnabled === true || source.waRouteEnabled === true,
    whatsappRouteMode: clean(source.whatsappRouteMode || source.waRouteMode || source.whatsappMode || ""),
    whatsappBrokerBaseUrl: clean(source.whatsappBrokerBaseUrl || source.waBrokerBaseUrl || source.whatsappControlPlaneBaseUrl || source.whatsappInternalBaseUrl || ""),
    gmailAccountId: clean(source.gmailAccountId || ""),
    outlookAccountId: clean(source.outlookAccountId || ""),
    linkedinDesktopSlug: clean(source.linkedinDesktopSlug || source.linkedin || "linkedin"),
  };
}

export function normalizeTenantVm(input = {}, env = process.env) {
  const ownerUserId = normalizeUserId(input.ownerUserId || input.userId || env.ORKESTR_ADMIN_USER_ID || adminUserId);
  const displayName = clean(input.displayName || input.name || ownerUserId);
  const id = safeTenantVmId(input.id || input.tenantVmId || `${ownerUserId}-tenant`);
  const kubevirt = normalizeKubevirt(input.kubevirt, input);
  return {
    id,
    ownerUserId,
    displayName,
    status: normalizeStatus(input.status),
    resources: normalizeResources(input.resources),
    endpoint: normalizeEndpoint(input.endpoint, input),
    kubevirt: {
      ...kubevirt,
      vmName: kubevirt.vmName || id,
      vmiName: kubevirt.vmiName || kubevirt.vmName || id,
    },
    bootstrap: normalizeBootstrap(input.bootstrap),
    connectors: normalizeConnectors(input.connectors),
    capabilities: normalizeStringList(input.capabilities || ["codex", "desks", "timers", "files", "whatsapp"]),
    labels: normalizeLabels(input.labels),
    lastError: clean(input.lastError || input.error),
    createdAt: clean(input.createdAt) || nowIso(),
    updatedAt: clean(input.updatedAt) || nowIso(),
    deletedAt: clean(input.deletedAt),
  };
}

export function publicTenantVm(vm = {}) {
  const normalized = normalizeTenantVm(vm);
  return {
    id: normalized.id,
    ownerUserId: normalized.ownerUserId,
    displayName: normalized.displayName,
    status: normalized.status,
    resources: { ...normalized.resources },
    endpoint: { ...normalized.endpoint },
    kubevirt: { ...normalized.kubevirt },
    bootstrap: { ...normalized.bootstrap },
    connectors: { ...normalized.connectors },
    capabilities: [...normalized.capabilities],
    labels: { ...normalized.labels },
    lastError: normalized.lastError,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    deletedAt: normalized.deletedAt || "",
  };
}

async function readTenantVmFile(env = process.env) {
  const paths = await ensureDataDirs(env);
  const rows = await readJson(paths.tenantVms, []);
  return Array.isArray(rows) ? rows : [];
}

async function writeTenantVmFile(rows, env = process.env) {
  await writeJson(dataPaths(env).tenantVms, rows);
}

function activeTenantVm(vm = {}) {
  return !vm.deletedAt && vm.status !== "deleted";
}

export async function listTenantVms(env = process.env) {
  return (await readTenantVmFile(env)).map((item) => normalizeTenantVm(item, env));
}

export async function listTenantVmsForPrincipal(principal = {}, env = process.env) {
  const vms = await listTenantVms(env);
  if (isAdminPrincipal(principal)) return vms;
  if (!clean(principal?.userId)) return [];
  const owner = normalizeUserId(principal.userId);
  return vms.filter((vm) => vm.ownerUserId === owner);
}

export async function getTenantVm(tenantVmId, env = process.env) {
  const id = safeTenantVmId(tenantVmId);
  return (await listTenantVms(env)).find((vm) => vm.id === id) || null;
}

export async function getTenantVmForOwner(ownerUserId, env = process.env) {
  if (!clean(ownerUserId)) return null;
  const owner = normalizeUserId(ownerUserId);
  return (await listTenantVms(env)).find((vm) => activeTenantVm(vm) && vm.ownerUserId === owner) || null;
}

export async function getTenantVmForPrincipal(tenantVmId, principal = {}, env = process.env) {
  const vm = await getTenantVm(tenantVmId, env);
  if (!vm) return null;
  assertOwnerAccess(principal, vm.ownerUserId, "tenant_vm_access", env);
  return vm;
}

export async function createTenantVm(input = {}, env = process.env) {
  if (!clean(input.ownerUserId || input.userId)) throw tenantVmError("tenant_vm_owner_required", 400);
  const now = nowIso();
  const vm = normalizeTenantVm({ ...input, id: input.id || input.tenantVmId || randomUUID(), createdAt: now, updatedAt: now }, env);
  const existing = await listTenantVms(env);
  if (existing.some((item) => item.id === vm.id)) throw tenantVmError("tenant_vm_already_exists", 409);
  if (activeTenantVm(vm) && existing.some((item) => activeTenantVm(item) && item.ownerUserId === vm.ownerUserId)) {
    throw tenantVmError("tenant_vm_owner_already_has_instance", 409);
  }
  const next = [...existing, vm];
  await writeTenantVmFile(next, env);
  await appendEvent({ type: "tenant_vm_created", tenantVmId: vm.id, ownerUserId: vm.ownerUserId, status: vm.status }, env).catch(() => {});
  return vm;
}

export async function updateTenantVm(tenantVmId, patch = {}, env = process.env) {
  const id = safeTenantVmId(tenantVmId);
  const existing = await listTenantVms(env);
  const current = existing.find((item) => item.id === id);
  if (!current) throw tenantVmError("tenant_vm_not_found", 404);
  const requestedOwner = clean(patch.ownerUserId || patch.userId);
  if (requestedOwner && normalizeUserId(requestedOwner) !== current.ownerUserId) throw tenantVmError("tenant_vm_owner_immutable", 409);
  const now = nowIso();
  const updated = normalizeTenantVm({ ...current, ...patch, id: current.id, ownerUserId: current.ownerUserId, createdAt: current.createdAt, updatedAt: now }, env);
  const next = existing.map((item) => item.id === id ? updated : item);
  await writeTenantVmFile(next, env);
  await appendEvent({ type: "tenant_vm_updated", tenantVmId: updated.id, ownerUserId: updated.ownerUserId, status: updated.status }, env).catch(() => {});
  return updated;
}

export async function setTenantVmStatus(tenantVmId, status, patch = {}, env = process.env) {
  return updateTenantVm(tenantVmId, { ...patch, status }, env);
}

export async function deleteTenantVm(tenantVmId, env = process.env) {
  const vm = await updateTenantVm(tenantVmId, { status: "deleted", deletedAt: nowIso() }, env);
  await appendEvent({ type: "tenant_vm_deleted", tenantVmId: vm.id, ownerUserId: vm.ownerUserId }, env).catch(() => {});
  return vm;
}
