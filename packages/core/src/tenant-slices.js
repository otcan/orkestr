import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { appendEvent, readJson, writeJson } from "../../storage/src/store.js";
import { assertOwnerAccess, isAdminPrincipal } from "./policy.js";
import { adminUserId, normalizeUserId } from "./users.js";

const execFileAsync = promisify(execFile);
const statuses = new Set(["planned", "provisioning", "stopped", "warming", "running", "error", "deleting", "deleted"]);
const defaultTenantRoot = "/srv/orkestr-tenants";
const defaultPortBase = 21000;
const defaultPortBlockSize = 50;

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

function normalizeNumber(value, fallback, { min = 0, max = 1_000_000 } = {}) {
  const parsed = Number(value);
  const numeric = Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
  return Math.max(min, Math.min(max, numeric));
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

function safeTenantSliceId(value = "") {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

function safeUnixSuffix(value = "") {
  return safeTenantSliceId(value).replace(/[^a-z0-9]+/g, "").slice(0, 12) || "tenant";
}

function safeSystemdName(value = "") {
  return safeTenantSliceId(value).replace(/[^a-z0-9.-]+/g, "-").replace(/\.+/g, "-") || "tenant";
}

function normalizeStatus(value = "planned") {
  const status = clean(value).toLowerCase();
  return statuses.has(status) ? status : "planned";
}

function sliceRoot(env = process.env) {
  const root = clean(env.ORKESTR_TENANT_SLICE_ROOT) || defaultTenantRoot;
  return path.posix.normalize(root.startsWith("/") ? root : defaultTenantRoot);
}

function defaultPaths(id, env = process.env) {
  const root = path.posix.join(sliceRoot(env), id);
  return {
    root,
    home: path.posix.join(root, "home"),
    dataRoot: path.posix.join(root, "data"),
    workspaceRoot: path.posix.join(root, "workspace"),
    browserRoot: path.posix.join(root, "browsers"),
    oxrmRoot: path.posix.join(root, "oxrm"),
    runRoot: path.posix.join(root, "run"),
    logRoot: path.posix.join(root, "logs"),
    envFile: path.posix.join(root, "orkestr.env"),
    composeEnvFile: path.posix.join(root, "oxrm", ".env"),
  };
}

function normalizeAbsolutePath(value = "", fallback = "") {
  const raw = clean(value || fallback);
  if (!raw || raw.includes("\0") || !raw.startsWith("/")) return fallback;
  return path.posix.normalize(raw);
}

function normalizePaths(paths = {}, id = "", env = process.env) {
  const defaults = defaultPaths(id, env);
  const source = paths && typeof paths === "object" && !Array.isArray(paths) ? paths : {};
  return Object.fromEntries(
    Object.entries(defaults).map(([key, fallback]) => [key, normalizeAbsolutePath(source[key], fallback)]),
  );
}

function normalizeResources(resources = {}) {
  const source = resources && typeof resources === "object" && !Array.isArray(resources) ? resources : {};
  return {
    memoryHighMiB: normalizeNumber(source.memoryHighMiB ?? source.memoryHigh ?? 6144, 6144, { min: 512, max: 1048576 }),
    memoryMaxMiB: normalizeNumber(source.memoryMaxMiB ?? source.memoryMax ?? 9216, 9216, { min: 512, max: 1048576 }),
    cpuQuotaPercent: normalizeNumber(source.cpuQuotaPercent ?? source.cpuQuota ?? 200, 200, { min: 10, max: 6400 }),
    tasksMax: normalizeNumber(source.tasksMax ?? 4096, 4096, { min: 128, max: 1_000_000 }),
    diskSoftGiB: normalizeNumber(source.diskSoftGiB ?? source.diskGiB ?? source.disk ?? 80, 80, { min: 5, max: 16384 }),
  };
}

function normalizeBudget(budget = {}) {
  const source = budget && typeof budget === "object" && !Array.isArray(budget) ? budget : {};
  const dailyUsd = Number(source.dailyUsd ?? source.daily ?? 5);
  const monthlyUsd = Number(source.monthlyUsd ?? source.monthly ?? 50);
  return {
    dailyUsd: Number.isFinite(dailyUsd) ? Math.max(0, dailyUsd) : 5,
    monthlyUsd: Number.isFinite(monthlyUsd) ? Math.max(0, monthlyUsd) : 50,
  };
}

function normalizePortBlock(portBlock = {}, existing = [], env = process.env) {
  const source = portBlock && typeof portBlock === "object" && !Array.isArray(portBlock) ? portBlock : {};
  const size = normalizeNumber(source.size ?? env.ORKESTR_TENANT_SLICE_PORT_BLOCK_SIZE, defaultPortBlockSize, { min: 20, max: 1000 });
  const usedBases = new Set(existing.map((item) => normalizeNumber(item?.portBlock?.base, 0, { min: 0 })).filter(Boolean));
  let base = normalizeNumber(source.base ?? source.start ?? 0, 0, { min: 0, max: 65500 });
  if (!base) {
    base = normalizeNumber(env.ORKESTR_TENANT_SLICE_PORT_BASE, defaultPortBase, { min: 1024, max: 65000 });
    while (usedBases.has(base)) base += size;
  }
  const ports = {
    orkestr: normalizeNumber(source.ports?.orkestr ?? base, base, { min: 1, max: 65535 }),
    oxrmWeb: normalizeNumber(source.ports?.oxrmWeb ?? base + 10, base + 10, { min: 1, max: 65535 }),
    oxrmApi: normalizeNumber(source.ports?.oxrmApi ?? base + 11, base + 11, { min: 1, max: 65535 }),
    oxrmMcp: normalizeNumber(source.ports?.oxrmMcp ?? base + 12, base + 12, { min: 1, max: 65535 }),
    desktopNoVnc: normalizeNumber(source.ports?.desktopNoVnc ?? base + 20, base + 20, { min: 1, max: 65535 }),
    desktopChromeDebug: normalizeNumber(source.ports?.desktopChromeDebug ?? base + 21, base + 21, { min: 1, max: 65535 }),
  };
  return { base, size, ports };
}

function normalizeSystem(system = {}, id = "") {
  const source = system && typeof system === "object" && !Array.isArray(system) ? system : {};
  const suffix = safeUnixSuffix(source.user || source.unixUser || id);
  const unitId = safeSystemdName(id);
  return {
    user: clean(source.user || source.unixUser) || `orkt_${suffix}`,
    group: clean(source.group || source.unixGroup) || clean(source.user || source.unixUser) || `orkt_${suffix}`,
    sliceName: clean(source.sliceName || source.slice) || `orkestr-tenant-${unitId}.slice`,
    serviceName: clean(source.serviceName || source.orkestrServiceName) || `orkestr-tenant-${unitId}.service`,
    oxrmServiceName: clean(source.oxrmServiceName) || `orkestr-tenant-${unitId}-oxrm.service`,
    desktopServiceName: clean(source.desktopServiceName) || `orkestr-tenant-${unitId}-desktop.service`,
  };
}

function normalizeConnectors(connectors = {}) {
  const source = connectors && typeof connectors === "object" && !Array.isArray(connectors) ? connectors : {};
  return {
    whatsapp: {
      enabled: source.whatsapp?.enabled ?? source.whatsappEnabled ?? true,
      chatId: clean(source.whatsapp?.chatId || source.whatsappChatId || source.waChatId),
      accountId: clean(source.whatsapp?.accountId || source.whatsappAccountId || source.waAccountId || "sender"),
      routeMode: clean(source.whatsapp?.routeMode || source.whatsappRouteMode || "parent-forward") || "parent-forward",
    },
    gmail: {
      enabled: source.gmail?.enabled ?? source.gmailEnabled ?? true,
      accountId: clean(source.gmail?.accountId || source.gmailAccountId),
    },
    linkedin: {
      enabled: source.linkedin?.enabled ?? source.linkedinEnabled ?? true,
      desktopSlug: safeTenantSliceId(source.linkedin?.desktopSlug || source.linkedinDesktopSlug || "linkedin") || "linkedin",
    },
    oxrm: {
      enabled: source.oxrm?.enabled ?? source.oxrmEnabled ?? true,
    },
  };
}

function normalizeLifecycle(lifecycle = {}) {
  const source = lifecycle && typeof lifecycle === "object" && !Array.isArray(lifecycle) ? lifecycle : {};
  return {
    warmLimitEligible: source.warmLimitEligible !== false,
    idleStopMinutes: normalizeNumber(source.idleStopMinutes ?? 20, 20, { min: 1, max: 1440 }),
    desktopIdleStopMinutes: normalizeNumber(source.desktopIdleStopMinutes ?? source.idleStopMinutes ?? 20, 20, { min: 1, max: 1440 }),
    lastWarmAt: clean(source.lastWarmAt),
    lastColdAt: clean(source.lastColdAt),
    lastWakeReason: clean(source.lastWakeReason),
    activeTaskCount: normalizeNumber(source.activeTaskCount, 0, { min: 0, max: 1_000_000 }),
  };
}

function normalizeOxrm(oxrm = {}, id = "", portBlock = {}) {
  const source = oxrm && typeof oxrm === "object" && !Array.isArray(oxrm) ? oxrm : {};
  return {
    enabled: source.enabled !== false,
    composeProject: clean(source.composeProject || source.projectName) || `oxrm-tenant-${safeSystemdName(id)}`,
    webUrl: clean(source.webUrl) || `http://127.0.0.1:${portBlock.ports?.oxrmWeb || 0}`,
    apiUrl: clean(source.apiUrl) || `http://127.0.0.1:${portBlock.ports?.oxrmApi || 0}`,
    mcpUrl: clean(source.mcpUrl) || `http://127.0.0.1:${portBlock.ports?.oxrmMcp || 0}`,
  };
}

export function normalizeTenantSlice(input = {}, env = process.env, existing = []) {
  const ownerUserId = normalizeUserId(input.ownerUserId || input.userId || env.ORKESTR_ADMIN_USER_ID || adminUserId);
  const displayName = clean(input.displayName || input.name || ownerUserId);
  const id = safeTenantSliceId(input.id || input.tenantSliceId || `${ownerUserId}-slice`) || randomUUID();
  const portBlock = normalizePortBlock(input.portBlock, existing, env);
  const connectors = normalizeConnectors(input.connectors || {});
  return {
    id,
    boundary: "local-slice",
    ownerUserId,
    displayName,
    status: normalizeStatus(input.status),
    warm: ["warming", "running"].includes(normalizeStatus(input.status)),
    system: normalizeSystem(input.system, id),
    paths: normalizePaths(input.paths, id, env),
    portBlock,
    resources: normalizeResources(input.resources),
    budget: normalizeBudget(input.budget || input.openaiBudget),
    connectors,
    oxrm: normalizeOxrm(input.oxrm, id, portBlock),
    lifecycle: normalizeLifecycle(input.lifecycle),
    capabilities: normalizeStringList(input.capabilities || ["codex", "files", "timers", "whatsapp", "gmail", "linkedin", "oxrm"]),
    labels: normalizeLabels(input.labels),
    lastError: clean(input.lastError || input.error),
    createdAt: clean(input.createdAt) || nowIso(),
    updatedAt: clean(input.updatedAt) || nowIso(),
    deletedAt: clean(input.deletedAt),
  };
}

export function publicTenantSlice(slice = {}) {
  const normalized = normalizeTenantSlice(slice);
  return {
    id: normalized.id,
    boundary: normalized.boundary,
    ownerUserId: normalized.ownerUserId,
    displayName: normalized.displayName,
    status: normalized.status,
    warm: normalized.warm,
    system: { ...normalized.system },
    paths: { ...normalized.paths },
    portBlock: { ...normalized.portBlock, ports: { ...normalized.portBlock.ports } },
    resources: { ...normalized.resources },
    budget: { ...normalized.budget },
    connectors: JSON.parse(JSON.stringify(normalized.connectors)),
    oxrm: { ...normalized.oxrm },
    lifecycle: { ...normalized.lifecycle },
    capabilities: [...normalized.capabilities],
    labels: { ...normalized.labels },
    lastError: normalized.lastError,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    deletedAt: normalized.deletedAt || "",
  };
}

async function readTenantSliceFile(env = process.env) {
  const paths = await ensureDataDirs(env);
  const rows = await readJson(paths.tenantSlices, []);
  return Array.isArray(rows) ? rows : [];
}

async function writeTenantSliceFile(rows, env = process.env) {
  await writeJson(dataPaths(env).tenantSlices, rows);
}

function activeTenantSlice(slice = {}) {
  return !slice.deletedAt && slice.status !== "deleted";
}

export async function listTenantSlices(env = process.env) {
  return (await readTenantSliceFile(env)).map((item) => normalizeTenantSlice(item, env));
}

export async function listTenantSlicesForPrincipal(principal = {}, env = process.env) {
  const slices = await listTenantSlices(env);
  if (isAdminPrincipal(principal)) return slices;
  if (!clean(principal?.userId)) return [];
  const owner = normalizeUserId(principal.userId);
  return slices.filter((slice) => slice.ownerUserId === owner);
}

export async function getTenantSlice(tenantSliceId, env = process.env) {
  const id = safeTenantSliceId(tenantSliceId);
  return (await listTenantSlices(env)).find((slice) => slice.id === id) || null;
}

export async function getTenantSliceForOwner(ownerUserId, env = process.env) {
  const owner = normalizeUserId(ownerUserId);
  return (await listTenantSlices(env)).find((slice) => activeTenantSlice(slice) && slice.ownerUserId === owner) || null;
}

export async function getTenantSliceForPrincipal(tenantSliceId, principal = {}, env = process.env) {
  const slice = await getTenantSlice(tenantSliceId, env);
  if (!slice) return null;
  assertOwnerAccess(principal, slice.ownerUserId, "tenant_slice_access", env);
  return slice;
}

export async function createTenantSlice(input = {}, env = process.env) {
  if (!clean(input.ownerUserId || input.userId)) throw tenantSliceError("tenant_slice_owner_required", 400);
  const existing = await listTenantSlices(env);
  const now = nowIso();
  const slice = normalizeTenantSlice({ ...input, id: input.id || input.tenantSliceId || randomUUID(), createdAt: now, updatedAt: now }, env, existing);
  if (existing.some((item) => item.id === slice.id)) throw tenantSliceError("tenant_slice_already_exists", 409);
  if (activeTenantSlice(slice) && existing.some((item) => activeTenantSlice(item) && item.ownerUserId === slice.ownerUserId)) {
    throw tenantSliceError("tenant_slice_owner_already_has_instance", 409);
  }
  await writeTenantSliceFile([...existing, slice], env);
  await appendEvent({ type: "tenant_slice_created", tenantSliceId: slice.id, ownerUserId: slice.ownerUserId, status: slice.status }, env).catch(() => {});
  return slice;
}

export async function updateTenantSlice(tenantSliceId, patch = {}, env = process.env) {
  const id = safeTenantSliceId(tenantSliceId);
  const existing = await listTenantSlices(env);
  const current = existing.find((item) => item.id === id);
  if (!current) throw tenantSliceError("tenant_slice_not_found", 404);
  const requestedOwner = clean(patch.ownerUserId || patch.userId);
  if (requestedOwner && normalizeUserId(requestedOwner) !== current.ownerUserId) throw tenantSliceError("tenant_slice_owner_immutable", 409);
  const now = nowIso();
  const updated = normalizeTenantSlice({ ...current, ...patch, id: current.id, ownerUserId: current.ownerUserId, createdAt: current.createdAt, updatedAt: now }, env, existing.filter((item) => item.id !== id));
  await writeTenantSliceFile(existing.map((item) => item.id === id ? updated : item), env);
  await appendEvent({ type: "tenant_slice_updated", tenantSliceId: updated.id, ownerUserId: updated.ownerUserId, status: updated.status }, env).catch(() => {});
  return updated;
}

export async function setTenantSliceStatus(tenantSliceId, status, patch = {}, env = process.env) {
  const normalizedStatus = normalizeStatus(status);
  const lifecyclePatch = {};
  if (normalizedStatus === "running" || normalizedStatus === "warming") {
    lifecyclePatch.lastWarmAt = nowIso();
    lifecyclePatch.lastWakeReason = clean(patch.wakeReason || patch.reason);
  }
  if (normalizedStatus === "stopped") lifecyclePatch.lastColdAt = nowIso();
  return updateTenantSlice(tenantSliceId, {
    ...patch,
    status: normalizedStatus,
    lifecycle: { ...(patch.lifecycle || {}), ...lifecyclePatch },
  }, env);
}

export async function deleteTenantSlice(tenantSliceId, env = process.env) {
  const slice = await updateTenantSlice(tenantSliceId, { status: "deleted", deletedAt: nowIso() }, env);
  await appendEvent({ type: "tenant_slice_deleted", tenantSliceId: slice.id, ownerUserId: slice.ownerUserId }, env).catch(() => {});
  return slice;
}

function envFile(entries = {}) {
  return `${Object.entries(entries).map(([key, value]) => `${key}='${String(value).replace(/'/g, "'\\''")}'`).join("\n")}\n`;
}

function runtimeEnv(slice) {
  return {
    ORKESTR_HOME: slice.paths.dataRoot,
    ORKESTR_PORT: String(slice.portBlock.ports.orkestr),
    PORT: String(slice.portBlock.ports.orkestr),
    ORKESTR_SERVICE_NAME: slice.system.serviceName,
    ORKESTR_DEPLOYMENT_TRACK: "tenant-local-slice",
    ORKESTR_TENANT_SLICE_ID: slice.id,
    ORKESTR_ADMIN_USER_ID: slice.ownerUserId,
    ORKESTR_AUTH_REQUIRED: "1",
    ORKESTR_CONTAINED_USER_RUNTIME_POLICY: "1",
    ORKESTR_DEFAULT_DESKTOP_SLUG: slice.connectors.linkedin.desktopSlug,
    ORKESTR_INSTANCE_DESKTOPS_PROVISIONED: slice.connectors.linkedin.enabled ? "1" : "0",
    ORKESTR_API_AGENT_TENANT_BUDGETS_JSON: JSON.stringify({ [slice.ownerUserId]: slice.budget }),
  };
}

function oxrmEnv(slice) {
  return {
    COMPOSE_PROJECT_NAME: slice.oxrm.composeProject,
    OXRM_TENANT_ID: slice.id,
    OXRM_OWNER_USER_ID: slice.ownerUserId,
    OXRM_DATA_ROOT: slice.paths.oxrmRoot,
    OXRM_WEB_PORT: String(slice.portBlock.ports.oxrmWeb),
    OXRM_API_PORT: String(slice.portBlock.ports.oxrmApi),
    OXRM_MCP_PORT: String(slice.portBlock.ports.oxrmMcp),
  };
}

function serviceUnit(slice) {
  return `[Unit]
Description=Orkestr tenant slice ${slice.id}
After=network.target

[Service]
Type=simple
User=${slice.system.user}
Group=${slice.system.group}
Slice=${slice.system.sliceName}
EnvironmentFile=${slice.paths.envFile}
WorkingDirectory=/opt/orkestr/current
ExecStart=/usr/bin/node dist/server/apps/server/src/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=${slice.paths.root}
MemoryHigh=${slice.resources.memoryHighMiB}M
MemoryMax=${slice.resources.memoryMaxMiB}M
CPUQuota=${slice.resources.cpuQuotaPercent}%
TasksMax=${slice.resources.tasksMax}

[Install]
WantedBy=multi-user.target
`;
}

function sliceUnit(slice) {
  return `[Unit]
Description=Resource slice for Orkestr tenant ${slice.id}

[Slice]
MemoryHigh=${slice.resources.memoryHighMiB}M
MemoryMax=${slice.resources.memoryMaxMiB}M
CPUQuota=${slice.resources.cpuQuotaPercent}%
TasksMax=${slice.resources.tasksMax}
`;
}

function oxrmServiceUnit(slice) {
  return `[Unit]
Description=OxRM tenant stack ${slice.id}
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=true
WorkingDirectory=${slice.paths.oxrmRoot}
EnvironmentFile=${slice.paths.composeEnvFile}
ExecStart=/usr/bin/docker compose --project-name ${slice.oxrm.composeProject} up -d
ExecStop=/usr/bin/docker compose --project-name ${slice.oxrm.composeProject} stop
TimeoutStartSec=300
TimeoutStopSec=120

[Install]
WantedBy=multi-user.target
`;
}

export function buildTenantSliceProvisioningPlan(sliceInput = {}, input = {}, env = process.env) {
  const slice = normalizeTenantSlice(sliceInput, env);
  const unitDir = clean(input.systemdUnitDir || env.ORKESTR_TENANT_SLICE_SYSTEMD_DIR) || "/etc/systemd/system";
  const directories = [
    slice.paths.root,
    slice.paths.home,
    slice.paths.dataRoot,
    slice.paths.workspaceRoot,
    slice.paths.browserRoot,
    slice.paths.oxrmRoot,
    slice.paths.runRoot,
    slice.paths.logRoot,
  ];
  const files = [
    { path: slice.paths.envFile, mode: "0640", owner: `${slice.system.user}:${slice.system.group}`, content: envFile(runtimeEnv(slice)) },
    { path: slice.paths.composeEnvFile, mode: "0640", owner: `${slice.system.user}:${slice.system.group}`, content: envFile(oxrmEnv(slice)) },
    { path: path.posix.join(unitDir, slice.system.sliceName), mode: "0644", owner: "root:root", content: sliceUnit(slice) },
    { path: path.posix.join(unitDir, slice.system.serviceName), mode: "0644", owner: "root:root", content: serviceUnit(slice) },
    { path: path.posix.join(unitDir, slice.system.oxrmServiceName), mode: "0644", owner: "root:root", content: oxrmServiceUnit(slice) },
  ];
  return {
    tenantSlice: publicTenantSlice(slice),
    dryRun: !truthy(input.execute, false),
    directories,
    files,
    runtimeEnv: runtimeEnv(slice),
    oxrmEnv: oxrmEnv(slice),
    systemd: {
      sliceName: slice.system.sliceName,
      serviceName: slice.system.serviceName,
      oxrmServiceName: slice.system.oxrmServiceName,
    },
    commands: {
      provision: [
        ["id", "-u", slice.system.user],
        ["useradd", "--system", "--create-home", "--home-dir", slice.paths.home, "--shell", "/usr/sbin/nologin", slice.system.user],
        ["install", "-d", "-o", slice.system.user, "-g", slice.system.group, ...directories],
        ["systemctl", "daemon-reload"],
        ["systemctl", "enable", slice.system.serviceName, slice.system.oxrmServiceName],
      ],
      start: ["systemctl", "start", slice.system.serviceName, slice.system.oxrmServiceName],
      stop: ["systemctl", "stop", slice.system.serviceName, slice.system.oxrmServiceName],
      status: ["systemctl", "show", slice.system.serviceName, "-p", "ActiveState", "-p", "SubState", "-p", "MemoryCurrent", "-p", "CPUUsageNSec"],
    },
  };
}

export async function provisionTenantSlice(tenantSliceId, input = {}, env = process.env, options = {}) {
  const slice = await getTenantSlice(tenantSliceId, env);
  if (!slice) throw tenantSliceError("tenant_slice_not_found", 404);
  const plan = buildTenantSliceProvisioningPlan(slice, input, env);
  if (!truthy(input.execute, false)) return plan;
  if (typeof options.applyPlan !== "function") throw tenantSliceError("tenant_slice_execute_not_configured", 501);
  await setTenantSliceStatus(slice.id, "provisioning", {}, env);
  try {
    await options.applyPlan(plan);
  } catch (error) {
    await setTenantSliceStatus(slice.id, "error", { lastError: clean(error?.message || error) }, env);
    throw error;
  }
  const updated = await setTenantSliceStatus(slice.id, "stopped", {}, env);
  return { ...plan, dryRun: false, tenantSlice: publicTenantSlice(updated) };
}

function parseSystemctlShow(stdout = "") {
  return Object.fromEntries(String(stdout || "").split("\n").map((line) => {
    const index = line.indexOf("=");
    return index === -1 ? null : [line.slice(0, index), line.slice(index + 1)];
  }).filter(Boolean));
}

export async function tenantSliceRuntimeStatus(tenantSliceId, env = process.env, options = {}) {
  const slice = await getTenantSlice(tenantSliceId, env);
  if (!slice) throw tenantSliceError("tenant_slice_not_found", 404);
  const run = options.execFile || execFileAsync;
  try {
    const { stdout } = await run("systemctl", ["show", slice.system.serviceName, "-p", "ActiveState", "-p", "SubState", "-p", "MemoryCurrent", "-p", "CPUUsageNSec"], { timeout: 5000 });
    const parsed = parseSystemctlShow(stdout);
    return {
      ok: true,
      tenantSlice: publicTenantSlice(slice),
      service: {
        name: slice.system.serviceName,
        activeState: clean(parsed.ActiveState),
        subState: clean(parsed.SubState),
        memoryCurrentBytes: Number(parsed.MemoryCurrent || 0) || 0,
        cpuUsageNSec: Number(parsed.CPUUsageNSec || 0) || 0,
      },
      generatedAt: nowIso(),
    };
  } catch (error) {
    return {
      ok: false,
      tenantSlice: publicTenantSlice(slice),
      service: { name: slice.system.serviceName, activeState: "unknown", subState: "unknown", memoryCurrentBytes: 0, cpuUsageNSec: 0 },
      error: clean(error?.message || error),
      generatedAt: nowIso(),
    };
  }
}
