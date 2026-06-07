import fs from "node:fs/promises";
import path from "node:path";
import { spawn as defaultSpawn } from "node:child_process";
import { dataPaths, ensureDataDirs } from "../../storage/src/paths.js";
import { readJson } from "../../storage/src/store.js";
import {
  releaseInstanceRequiredWhatsAppAccounts,
  releaseInstanceRequiresWhatsApp,
} from "./release-whatsapp-policy.js";
import { listTenantVms } from "./tenant-vm-registry.js";

const enabledValues = new Set(["1", "true", "yes", "on", "enabled"]);
const disabledValues = new Set(["0", "false", "no", "off", "disabled"]);

function nowIso() {
  return new Date().toISOString();
}

function clean(value = "") {
  return String(value || "").trim();
}

function cleanLower(value = "") {
  return clean(value).toLowerCase();
}

function boolValue(value, fallback = false) {
  if (value === true || value === false) return value;
  const text = cleanLower(value);
  if (enabledValues.has(text)) return true;
  if (disabledValues.has(text)) return false;
  return fallback;
}

function safeId(value = "") {
  return clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

function normalizeLabels(labels = {}) {
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) return {};
  return Object.fromEntries(
    Object.entries(labels)
      .map(([key, value]) => [clean(key).slice(0, 80), clean(value).slice(0, 240)])
      .filter(([key]) => key),
  );
}

function normalizeCommand(command) {
  if (Array.isArray(command)) return command.map((part) => clean(part)).filter(Boolean);
  const text = clean(command);
  return text || [];
}

function normalizeCommandEnv(commandEnv = {}) {
  if (!commandEnv || typeof commandEnv !== "object" || Array.isArray(commandEnv)) return {};
  return Object.fromEntries(
    Object.entries(commandEnv)
      .map(([key, value]) => [clean(key), clean(value)])
      .filter(([key]) => /^[A-Z_][A-Z0-9_]*$/i.test(key)),
  );
}

function commandConfigured(command) {
  return Array.isArray(command) ? command.length > 0 : Boolean(clean(command));
}

function joinUrl(baseUrl, suffix) {
  const base = clean(baseUrl).replace(/\/+$/g, "");
  if (!base) return "";
  return `${base}${suffix.startsWith("/") ? suffix : `/${suffix}`}`;
}

function configuredBaseUrl(env = process.env) {
  const configured = clean(
    env.ORKESTR_PUBLIC_APP_URL ||
      env.ORKESTR_PUBLIC_URL ||
      env.ORKESTR_APP_URL ||
      env.ORKESTR_PUBLIC_HTTPS_URL ||
      env.ORKESTR_HTTPS_URL ||
      "",
  );
  if (configured) return configured.replace(/\/+$/g, "");
  const host = clean(env.ORKESTR_HOST || "127.0.0.1");
  const port = clean(env.ORKESTR_PORT || env.PORT || "19812");
  return `http://${host}:${port}`;
}

function configuredLocalApiBase(env = process.env) {
  const configured = clean(env.ORKESTR_LOCAL_API_BASE || env.ORKESTR_DEPLOY_LOCAL_API_BASE || env.ORKESTR_API_BASE);
  if (configured) return configured.replace(/\/+$/g, "");
  const host = clean(env.ORKESTR_HOST || "127.0.0.1");
  const port = clean(env.ORKESTR_PORT || env.PORT || "19812");
  return `http://${host}:${port}`;
}

function normalizeVersionPayload(payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const git = payload.git && typeof payload.git === "object" ? payload.git : {};
  const version = {
    name: clean(payload.name),
    version: clean(payload.version),
    releaseId: clean(payload.releaseId),
    commit: clean(payload.commit || git.commit),
    shortCommit: clean(payload.shortCommit || git.shortCommit),
    branch: clean(payload.branch || git.branch),
    tag: clean(payload.tag || git.tag),
    describe: clean(payload.describe || git.describe),
    channel: clean(payload.channel),
    deployedAt: clean(payload.deployedAt),
    dirty: payload.dirty === true || git.dirty === true,
  };
  const meaningful = Object.entries(version).some(([key, value]) => key !== "dirty" && value !== "" && value !== null);
  if (!meaningful && version.dirty === false) return null;
  return Object.fromEntries(Object.entries(version).filter(([, value]) => value !== "" && value !== null));
}

function normalizeProbePayload(payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const checkedAt = clean(payload.checkedAt || payload.probedAt || payload.generatedAt);
  const probe = {
    ok: payload.ok === true,
    checkedAt,
    latencyMs: Number.isFinite(Number(payload.latencyMs)) ? Math.max(0, Math.round(Number(payload.latencyMs))) : null,
    statusCode: Number.isFinite(Number(payload.statusCode)) ? Math.round(Number(payload.statusCode)) : null,
    error: clean(payload.error),
  };
  return Object.fromEntries(Object.entries(probe).filter(([, value]) => value !== "" && value !== null));
}

function normalizeDowntimePayload(payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const state = clean(payload.state);
  const downtime = {
    state: state || (payload.down === true ? "down" : payload.up === true ? "up" : ""),
    since: clean(payload.since || payload.downSince || payload.upSince),
    lastUpAt: clean(payload.lastUpAt || payload.lastReachableAt),
    lastDownAt: clean(payload.lastDownAt || payload.lastUnreachableAt),
    durationSeconds: Number.isFinite(Number(payload.durationSeconds)) ? Math.max(0, Math.round(Number(payload.durationSeconds))) : null,
  };
  return Object.fromEntries(Object.entries(downtime).filter(([, value]) => value !== "" && value !== null));
}

function probeDowntime({ ok, checkedAt, previous = null } = {}) {
  const prior = normalizeDowntimePayload(previous) || {};
  if (ok) {
    return {
      state: "up",
      since: prior.state === "up" && prior.since ? prior.since : checkedAt,
      lastUpAt: checkedAt,
      lastDownAt: prior.lastDownAt || null,
      durationSeconds: 0,
    };
  }
  const since = prior.state === "down" && prior.since ? prior.since : checkedAt;
  const sinceMs = Date.parse(since);
  const checkedMs = Date.parse(checkedAt);
  const durationSeconds = Number.isFinite(sinceMs) && Number.isFinite(checkedMs)
    ? Math.max(0, Math.round((checkedMs - sinceMs) / 1000))
    : 0;
  return {
    state: "down",
    since,
    lastUpAt: prior.lastUpAt || null,
    lastDownAt: checkedAt,
    durationSeconds,
  };
}

async function readLocalReleaseManifest(env = process.env) {
  const candidates = [
    clean(env.ORKESTR_RELEASE_MANIFEST),
    path.resolve(process.cwd(), "release-manifest.json"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return JSON.parse(await fs.readFile(candidate, "utf8"));
    } catch {
      // Local development and unversioned installs do not always have a release manifest.
    }
  }
  return null;
}

async function localReleaseInstance(env = process.env) {
  const baseUrl = configuredBaseUrl(env);
  const localApiBase = configuredLocalApiBase(env);
  const manifest = await readLocalReleaseManifest(env);
  const instanceId = safeId(env.ORKESTR_INSTANCE_ID || env.ORKESTR_RELEASE_INSTANCE_ID || env.ORKESTR_SERVICE_NAME || "local");
  return normalizeReleaseInstance({
    id: instanceId || "local",
    displayName: clean(env.ORKESTR_INSTANCE_NAME || env.ORKESTR_SERVICE_NAME || "Local Orkestr"),
    kind: "local-service",
    status: "running",
    source: "local-env",
    baseUrl,
    healthUrl: clean(env.ORKESTR_DEPLOY_HEALTH_URL) || joinUrl(localApiBase, "/api/health"),
    versionUrl: clean(env.ORKESTR_DEPLOY_VERSION_URL) || joinUrl(localApiBase, "/api/version"),
    releaseTrainEnabled: boolValue(env.ORKESTR_RELEASE_TRAIN_LOCAL_ENABLED, true),
    updateStrategy: "local-deployer",
    serviceName: clean(env.ORKESTR_SERVICE_NAME || "orkestr"),
    home: clean(env.ORKESTR_HOME),
    deployRoot: clean(env.ORKESTR_DEPLOY_ROOT),
    channel: clean(env.ORKESTR_DEPLOY_CHANNEL || manifest?.channel || ""),
    currentVersion: normalizeVersionPayload({
      ...manifest,
      commit: env.ORKESTR_BUILD_COMMIT || manifest?.git?.commit,
      branch: env.ORKESTR_BUILD_BRANCH || manifest?.git?.branch,
      tag: env.ORKESTR_BUILD_TAG || manifest?.git?.tag,
    }),
  }, env);
}

function tenantReleaseTrainEnabled(vm = {}) {
  const labels = vm.labels || {};
  const explicit = labels.releaseTrainEnabled ?? labels["release-train-enabled"] ?? labels.release_train_enabled;
  if (explicit !== undefined) return boolValue(explicit, false);
  return vm.capabilities?.includes("release-train") || vm.capabilities?.includes("release_train");
}

function tenantReleaseInstance(vm = {}, env = process.env) {
  const labels = normalizeLabels(vm.labels);
  const baseUrl = clean(vm.endpoint?.baseUrl || vm.endpoint?.brokerBaseUrl);
  const id = safeId(labels.releaseInstanceId || labels["release-instance-id"] || `vm-${vm.id}`);
  return normalizeReleaseInstance({
    id,
    sourceId: clean(vm.id),
    displayName: clean(labels.releaseInstanceName || labels["release-instance-name"] || vm.displayName || vm.id),
    kind: "tenant-vm",
    status: clean(vm.status || "unknown"),
    source: "tenant-vms",
    baseUrl,
    healthUrl: clean(labels.healthUrl || labels["health-url"]) || joinUrl(baseUrl, "/api/health"),
    versionUrl: clean(labels.versionUrl || labels["version-url"]) || joinUrl(baseUrl, "/api/version"),
    releaseTrainEnabled: tenantReleaseTrainEnabled(vm),
    updateStrategy: clean(labels.updateStrategy || labels["update-strategy"]) || (clean(vm.endpoint?.sshHost) ? "ssh-orkestr-update" : "manual"),
    serviceName: clean(labels.serviceName || labels["service-name"]),
    home: clean(labels.home || labels.orkestrHome || labels["orkestr-home"]),
    deployRoot: clean(labels.deployRoot || labels["deploy-root"]),
    channel: clean(labels.channel),
    labels,
    lastError: clean(vm.lastError),
  }, env);
}

async function readReleaseInstanceFile(env = process.env) {
  const paths = await ensureDataDirs(env);
  const rows = await readJson(paths.releaseInstances, []);
  if (Array.isArray(rows)) return rows;
  if (Array.isArray(rows?.instances)) return rows.instances;
  return [];
}

function registryReleaseInstance(input = {}, env = process.env) {
  return normalizeReleaseInstance({ ...input, source: clean(input.source || "registry") }, env);
}

export function normalizeReleaseInstance(input = {}, env = process.env) {
  const labels = normalizeLabels(input.labels);
  const baseUrl = clean(input.baseUrl || input.url || input.publicUrl);
  const command = normalizeCommand(input.deployCommand ?? input.command ?? input.updateCommand);
  const connectivityCommand = normalizeCommand(
    input.connectivityCommand ??
      input.checkCommand ??
      input.verifyCommand ??
      input.postDeployCheckCommand,
  );
  const connectivityRecoveryCommand = normalizeCommand(
    input.connectivityRecoveryCommand ??
      input.recoveryCommand ??
      input.postConnectivityFailureCommand ??
      input.postDeployRecoveryCommand,
  );
  const enabled = input.enabled === undefined ? true : boolValue(input.enabled, true);
  const releaseTrainEnabled = boolValue(
    input.releaseTrainEnabled ?? input.release_train_enabled ?? input.releaseTrain ?? labels.releaseTrainEnabled ?? labels["release-train-enabled"],
    false,
  );
  const id = safeId(input.id || input.instanceId || input.name || input.displayName || "instance");
  return {
    id: id || "instance",
    displayName: clean(input.displayName || input.name || id || "instance"),
    kind: clean(input.kind || input.type || "service"),
    source: clean(input.source || "registry"),
    sourceId: clean(input.sourceId || input.tenantVmId),
    enabled,
    status: clean(input.status || "unknown"),
    releaseTrainEnabled,
    updateStrategy: clean(input.updateStrategy || input.strategy || (releaseTrainEnabled ? "custom-command" : "manual")),
    baseUrl,
    healthUrl: clean(input.healthUrl) || joinUrl(baseUrl, "/api/health"),
    versionUrl: clean(input.versionUrl) || joinUrl(baseUrl, "/api/version"),
    serviceName: clean(input.serviceName),
    home: clean(input.home || input.orkestrHome),
    deployRoot: clean(input.deployRoot),
    ref: clean(input.ref),
    channel: clean(input.channel),
    cwd: clean(input.cwd),
    labels,
    deployCommand: command,
    connectivityCommand,
    connectivityRecoveryCommand,
    commandEnv: normalizeCommandEnv(input.commandEnv || input.env),
    currentVersion: normalizeVersionPayload(input.currentVersion || input.version),
    targetVersion: normalizeVersionPayload(input.targetVersion || input.desiredVersion),
    lastProbe: normalizeProbePayload(input.lastProbe || input.probe || input.versionProbe),
    downtime: normalizeDowntimePayload(input.downtime || input.availability),
    lastReachableAt: clean(input.lastReachableAt),
    lastUnreachableAt: clean(input.lastUnreachableAt),
    lastError: clean(input.lastError || input.error),
    updatedAt: clean(input.updatedAt),
    createdAt: clean(input.createdAt),
  };
}

function mergeValue(key, existing, incoming) {
  if (incoming === undefined || incoming === null) return existing;
  if (typeof incoming === "string" && incoming === "") return existing;
  if (key === "status" && incoming === "unknown" && existing && existing !== "unknown") return existing;
  if (key === "kind" && incoming === "service" && existing && existing !== "service") return existing;
  if (Array.isArray(incoming) && incoming.length === 0) return existing;
  if (incoming && typeof incoming === "object" && !Array.isArray(incoming)) {
    return { ...(existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {}), ...incoming };
  }
  return incoming;
}

function mergeReleaseInstances(rows = []) {
  const byId = new Map();
  for (const row of rows) {
    const instance = normalizeReleaseInstance(row);
    const existing = byId.get(instance.id);
    if (!existing) {
      byId.set(instance.id, instance);
      continue;
    }
    const merged = { ...existing };
    for (const [key, value] of Object.entries(instance)) merged[key] = mergeValue(key, merged[key], value);
    merged.source = [...new Set([existing.source, instance.source].flatMap((value) => clean(value).split(",")).filter(Boolean))].join(",");
    byId.set(instance.id, merged);
  }
  return [...byId.values()].sort((left, right) => {
    if (left.kind === "local-service" && right.kind !== "local-service") return -1;
    if (right.kind === "local-service" && left.kind !== "local-service") return 1;
    return left.id.localeCompare(right.id);
  });
}

export async function listReleaseInstances(env = process.env, options = {}) {
  const includeLocal = options.includeLocal !== false;
  const includeTenantVms = options.includeTenantVms !== false;
  const rows = [];
  if (includeLocal) rows.push(await localReleaseInstance(env));
  if (includeTenantVms) {
    const tenantVms = await listTenantVms(env).catch(() => []);
    rows.push(...tenantVms.filter((vm) => !vm.deletedAt && vm.status !== "deleted").map((vm) => tenantReleaseInstance(vm, env)));
  }
  rows.push(...(await readReleaseInstanceFile(env)).map((item) => registryReleaseInstance(item, env)));
  const instances = mergeReleaseInstances(rows);
  if (!options.probe) return instances;
  return probeReleaseInstances(instances, { env, fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs });
}

export function publicReleaseInstance(instance = {}) {
  const normalized = normalizeReleaseInstance(instance);
  return {
    id: normalized.id,
    displayName: normalized.displayName,
    kind: normalized.kind,
    source: normalized.source,
    sourceId: normalized.sourceId,
    enabled: normalized.enabled,
    status: normalized.status,
    releaseTrainEnabled: normalized.releaseTrainEnabled,
    updateStrategy: normalized.updateStrategy,
    hasDeployCommand: commandConfigured(normalized.deployCommand),
    hasConnectivityCommand: commandConfigured(normalized.connectivityCommand),
    hasConnectivityRecoveryCommand: commandConfigured(normalized.connectivityRecoveryCommand),
    baseUrl: normalized.baseUrl,
    healthUrl: normalized.healthUrl,
    versionUrl: normalized.versionUrl,
    serviceName: normalized.serviceName,
    home: normalized.home,
    deployRoot: normalized.deployRoot,
    ref: normalized.ref,
    channel: normalized.channel,
    labels: { ...normalized.labels },
    currentVersion: normalized.currentVersion ? { ...normalized.currentVersion } : null,
    targetVersion: normalized.targetVersion ? { ...normalized.targetVersion } : null,
    lastProbe: normalized.lastProbe ? { ...normalized.lastProbe } : null,
    downtime: normalized.downtime ? { ...normalized.downtime } : null,
    lastReachableAt: normalized.lastReachableAt,
    lastUnreachableAt: normalized.lastUnreachableAt,
    lastError: normalized.lastError,
    updatedAt: normalized.updatedAt,
    createdAt: normalized.createdAt,
  };
}

async function fetchJsonWithTimeout(url, { fetchImpl = globalThis.fetch, timeoutMs = 5000 } = {}) {
  if (!url || typeof fetchImpl !== "function") return { ok: false, error: "missing_fetch_or_url" };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || 5000));
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    const text = await response.text();
    if (!response.ok) return { ok: false, statusCode: response.status, error: `HTTP ${response.status}` };
    return { ok: true, payload: text ? JSON.parse(text) : {} };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

export async function probeReleaseInstances(instances = [], options = {}) {
  const probed = [];
  for (const instance of instances) {
    const normalized = normalizeReleaseInstance(instance);
    const startedAt = Date.now();
    const checkedAt = nowIso();
    const result = await fetchJsonWithTimeout(normalized.versionUrl, options);
    const latencyMs = Date.now() - startedAt;
    if (result.ok) {
      probed.push({
        ...normalized,
        status: normalized.status === "unknown" ? "reachable" : normalized.status,
        currentVersion: normalizeVersionPayload(result.payload),
        lastProbe: normalizeProbePayload({ ok: true, checkedAt, latencyMs, statusCode: 200 }),
        downtime: probeDowntime({ ok: true, checkedAt, previous: normalized.downtime }),
        lastReachableAt: checkedAt,
        lastError: "",
      });
    } else {
      probed.push({
        ...normalized,
        status: normalized.status === "unknown" || normalized.status === "running" ? "unreachable" : normalized.status,
        lastProbe: normalizeProbePayload({ ok: false, checkedAt, latencyMs, statusCode: result.statusCode, error: result.error || "version_probe_failed" }),
        downtime: probeDowntime({ ok: false, checkedAt, previous: normalized.downtime }),
        lastUnreachableAt: checkedAt,
        lastError: result.error || "version_probe_failed",
      });
    }
  }
  return probed;
}

function interpolateToken(value, context = {}) {
  return clean(value).replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key) => clean(context[key] ?? ""));
}

function deployContext(instance = {}, options = {}) {
  return {
    id: instance.id,
    instanceId: instance.id,
    baseUrl: instance.baseUrl,
    serviceName: instance.serviceName,
    home: instance.home,
    deployRoot: instance.deployRoot,
    ref: clean(options.ref || instance.ref || process.env.ORKESTR_DEPLOY_REF || process.env.ORKESTR_UPDATE_REF || "main"),
    channel: clean(options.channel || instance.channel || process.env.ORKESTR_DEPLOY_CHANNEL || "production"),
    releaseId: clean(options.releaseId || ""),
  };
}

function interpolatedCommand(command, context) {
  if (Array.isArray(command)) return command.map((part) => interpolateToken(part, context)).filter(Boolean);
  return interpolateToken(command, context);
}

function spawnReleaseCommand(command, instance, options = {}) {
  const spawnImpl = options.spawnImpl || defaultSpawn;
  const context = deployContext(instance, options);
  const commandValue = interpolatedCommand(command, context);
  const requiredWhatsAppAccounts = releaseInstanceRequiredWhatsAppAccounts(instance, options, options.env || process.env).join(",");
  const env = {
    ...process.env,
    ...options.env,
    ...instance.commandEnv,
    ORKESTR_RELEASE_INSTANCE_ID: instance.id,
    ORKESTR_DEPLOY_REF: context.ref,
    ORKESTR_UPDATE_REF: context.ref,
    ORKESTR_DEPLOY_CHANNEL: context.channel,
  };
  if (requiredWhatsAppAccounts) env.ORKESTR_RELEASE_REQUIRED_WHATSAPP_ACCOUNTS = requiredWhatsAppAccounts;
  else if (!releaseInstanceRequiresWhatsApp(instance)) {
    delete env.ORKESTR_RELEASE_REQUIRED_WHATSAPP_ACCOUNTS;
    delete env.ORKESTR_REQUIRED_WHATSAPP_ACCOUNTS;
  }
  const cwd = instance.cwd || options.cwd || process.cwd();
  const child = Array.isArray(commandValue)
    ? spawnImpl(commandValue[0], commandValue.slice(1), { stdio: options.stdio || "inherit", env, cwd })
    : spawnImpl("sh", ["-lc", commandValue], { stdio: options.stdio || "inherit", env, cwd });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), signal: signal || "" }));
  });
}

function skippedResult(instance, reason) {
  return {
    id: instance.id,
    displayName: instance.displayName,
    kind: instance.kind,
    status: "skipped",
    reason,
  };
}

export async function deployReleaseInstances(options = {}, env = process.env) {
  const instances = options.instances || await listReleaseInstances(env, { probe: false });
  const results = [];
  for (const instanceInput of instances) {
    const instance = normalizeReleaseInstance(instanceInput, env);
    if (instance.enabled === false) {
      results.push(skippedResult(instance, "disabled"));
      continue;
    }
    if (options.skipLocal !== false && instance.kind === "local-service") {
      results.push(skippedResult(instance, "local_already_deployed"));
      continue;
    }
    if (!instance.releaseTrainEnabled) {
      results.push(skippedResult(instance, "release_train_disabled"));
      continue;
    }
    if (!commandConfigured(instance.deployCommand)) {
      results.push(skippedResult(instance, "missing_deploy_command"));
      continue;
    }
    if (options.dryRun) {
      results.push({ id: instance.id, displayName: instance.displayName, kind: instance.kind, status: "planned", reason: "dry_run" });
      continue;
    }
    try {
      const outcome = await spawnReleaseCommand(instance.deployCommand, instance, { ...options, env });
      results.push({
        id: instance.id,
        displayName: instance.displayName,
        kind: instance.kind,
        status: outcome.code === 0 ? "deployed" : "failed",
        code: outcome.code,
        signal: outcome.signal,
      });
    } catch (error) {
      results.push({
        id: instance.id,
        displayName: instance.displayName,
        kind: instance.kind,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const counts = results.reduce((acc, result) => {
    acc[result.status] = (acc[result.status] || 0) + 1;
    return acc;
  }, {});
  return {
    ok: !results.some((result) => result.status === "failed"),
    ref: clean(options.ref || env.ORKESTR_DEPLOY_REF || env.ORKESTR_UPDATE_REF || "main"),
    channel: clean(options.channel || env.ORKESTR_DEPLOY_CHANNEL || "production"),
    counts,
    results,
    generatedAt: nowIso(),
  };
}
