import { spawn as defaultSpawn } from "node:child_process";
import { normalizeReleaseInstance } from "./release-instances.js";

function nowIso() {
  return new Date().toISOString();
}

function clean(value = "") {
  return String(value || "").trim();
}

function cleanLower(value = "") {
  return clean(value).toLowerCase();
}

function commandConfigured(command) {
  return Array.isArray(command) ? command.length > 0 : Boolean(clean(command));
}

function joinUrl(baseUrl, suffix) {
  const base = clean(baseUrl).replace(/\/+$/g, "");
  if (!base) return "";
  return `${base}${suffix.startsWith("/") ? suffix : `/${suffix}`}`;
}

function interpolateToken(value, context = {}) {
  return clean(value).replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key) => clean(context[key] ?? ""));
}

function deployContext(instance = {}, options = {}, env = process.env) {
  return {
    id: instance.id,
    instanceId: instance.id,
    baseUrl: instance.baseUrl,
    serviceName: instance.serviceName,
    home: instance.home,
    deployRoot: instance.deployRoot,
    ref: clean(options.ref || instance.ref || env.ORKESTR_DEPLOY_REF || env.ORKESTR_UPDATE_REF || "main"),
    channel: clean(options.channel || instance.channel || env.ORKESTR_DEPLOY_CHANNEL || "production"),
    releaseId: clean(options.releaseId || ""),
  };
}

function interpolatedCommand(command, context) {
  if (Array.isArray(command)) return command.map((part) => interpolateToken(part, context)).filter(Boolean);
  return interpolateToken(command, context);
}

function spawnConnectivityCommand(instance, options = {}, env = process.env) {
  const spawnImpl = options.spawnImpl || defaultSpawn;
  const context = deployContext(instance, options, env);
  const commandValue = interpolatedCommand(instance.connectivityCommand, context);
  const childEnv = {
    ...process.env,
    ...env,
    ...options.env,
    ...instance.commandEnv,
    ORKESTR_RELEASE_INSTANCE_ID: instance.id,
    ORKESTR_DEPLOY_REF: context.ref,
    ORKESTR_UPDATE_REF: context.ref,
    ORKESTR_DEPLOY_CHANNEL: context.channel,
    ORKESTR_RELEASE_CONNECTIVITY_CHECK: "1",
  };
  const cwd = instance.cwd || options.cwd || process.cwd();
  const child = Array.isArray(commandValue)
    ? spawnImpl(commandValue[0], commandValue.slice(1), { stdio: options.stdio || "inherit", env: childEnv, cwd })
    : spawnImpl("sh", ["-lc", commandValue], { stdio: options.stdio || "inherit", env: childEnv, cwd });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), signal: signal || "" }));
  });
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

function connectedResult(instance, detail = {}) {
  return {
    id: instance.id,
    displayName: instance.displayName,
    kind: instance.kind,
    status: "connected",
    ...detail,
  };
}

function connectionFailedResult(instance, error, detail = {}) {
  return {
    id: instance.id,
    displayName: instance.displayName,
    kind: instance.kind,
    status: "connection_failed",
    error: error instanceof Error ? error.message : String(error || "connectivity_check_failed"),
    ...detail,
  };
}

function releaseInstanceRequiresWhatsApp(instance = {}) {
  const labels = instance.labels || {};
  if (["1", "true", "yes", "on", "required"].includes(cleanLower(labels.requireWhatsAppConnectivity || labels["require-whatsapp-connectivity"]))) return true;
  if (["1", "true", "yes", "on", "required"].includes(cleanLower(labels.whatsappConnectivityCheck || labels["whatsapp-connectivity-check"]))) return true;
  return cleanLower(labels.router) === "parent-whatsapp";
}

function whatsappStatusReady(payload = {}) {
  const state = cleanLower(payload.state || payload.status);
  if (["paired", "connected", "ready"].includes(state)) return true;
  const health = payload.health && typeof payload.health === "object" ? payload.health : {};
  if (health.ready === true || health.clientReady === true || health.authenticated === true) return true;
  const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
  return accounts.some((account) => account?.ready === true || ["ready", "connected", "paired"].includes(cleanLower(account?.state || account?.status)));
}

async function verifyHttpConnectivity(instance, options = {}) {
  const timeoutMs = options.connectivityTimeoutMs || options.timeoutMs || 5000;
  const version = await fetchJsonWithTimeout(instance.versionUrl, {
    fetchImpl: options.fetchImpl,
    timeoutMs,
  });
  if (!version.ok) throw new Error(version.error || "version_probe_failed");
  const detail = {
    releaseId: clean(version.payload?.releaseId),
    commit: clean(version.payload?.commit || version.payload?.git?.commit),
  };
  if (!releaseInstanceRequiresWhatsApp(instance)) return connectedResult(instance, { method: "http", ...detail });
  const whatsappUrl = joinUrl(instance.baseUrl, "/api/connectors/whatsapp/status");
  if (!whatsappUrl) throw new Error("whatsapp_status_url_missing");
  const whatsapp = await fetchJsonWithTimeout(whatsappUrl, {
    fetchImpl: options.fetchImpl,
    timeoutMs,
  });
  if (!whatsapp.ok) throw new Error(`whatsapp_status_failed:${whatsapp.error || "unknown"}`);
  if (!whatsappStatusReady(whatsapp.payload)) {
    throw new Error(`whatsapp_not_ready:${clean(whatsapp.payload?.state || whatsapp.payload?.status || "unknown")}`);
  }
  return connectedResult(instance, {
    method: "http",
    ...detail,
    whatsapp: clean(whatsapp.payload?.state || whatsapp.payload?.status || "ready"),
  });
}

async function verifyCommandConnectivity(instance, options = {}, env = process.env) {
  const outcome = await spawnConnectivityCommand(instance, options, env);
  if (outcome.code !== 0) throw new Error(`connectivity_command_failed:${outcome.code}`);
  return connectedResult(instance, { method: "command", code: outcome.code, signal: outcome.signal });
}

async function verifyInstanceConnectivity(instanceInput, options = {}, env = process.env) {
  const instance = normalizeReleaseInstance(instanceInput, env);
  try {
    if (commandConfigured(instance.connectivityCommand)) return await verifyCommandConnectivity(instance, options, env);
    return await verifyHttpConnectivity(instance, options);
  } catch (error) {
    return connectionFailedResult(instance, error, {
      method: commandConfigured(instance.connectivityCommand) ? "command" : "http",
    });
  }
}

function releaseConnectivityTargets(instances = [], options = {}, env = process.env) {
  return instances
    .map((instance) => normalizeReleaseInstance(instance, env))
    .filter((instance) => instance.enabled !== false)
    .filter((instance) => instance.releaseTrainEnabled)
    .filter((instance) => !(options.skipLocal !== false && instance.kind === "local-service"));
}

export async function verifyReleaseInstanceConnectivity(instances = [], options = {}, env = process.env) {
  const targets = releaseConnectivityTargets(instances, options, env);
  const results = [];
  for (const instance of targets) results.push(await verifyInstanceConnectivity(instance, options, env));
  const counts = results.reduce((acc, result) => {
    acc[result.status] = (acc[result.status] || 0) + 1;
    return acc;
  }, {});
  return {
    ok: !results.some((result) => result.status === "connection_failed"),
    counts,
    results,
    generatedAt: nowIso(),
  };
}
