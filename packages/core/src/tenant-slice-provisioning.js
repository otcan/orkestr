import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import {
  getTenantSlice,
  normalizeTenantSlice,
  publicTenantSlice,
  setTenantSliceStatus,
} from "./tenant-slices.js";

const execFileAsync = promisify(execFile);

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
