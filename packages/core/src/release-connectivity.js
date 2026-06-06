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

function expectedCommit(options = {}, env = process.env) {
  const explicit = clean(options.expectedCommit || options.commit || env.ORKESTR_DEPLOY_COMMIT || env.ORKESTR_BUILD_COMMIT);
  if (explicit) return explicit;
  const ref = clean(options.ref || env.ORKESTR_DEPLOY_REF || env.ORKESTR_UPDATE_REF);
  return /^[a-f0-9]{7,40}$/i.test(ref) ? ref : "";
}

function commitsMatch(actual = "", expected = "") {
  const left = clean(actual).toLowerCase();
  const right = clean(expected).toLowerCase();
  if (!right) return true;
  if (!left) return false;
  if (!/^[a-f0-9]{7,40}$/i.test(left) || !/^[a-f0-9]{7,40}$/i.test(right)) return left === right;
  return left.startsWith(right) || right.startsWith(left);
}

function versionDetail(payload = {}) {
  const git = payload?.git && typeof payload.git === "object" ? payload.git : {};
  return {
    releaseId: clean(payload?.releaseId),
    commit: clean(payload?.commit || git.commit),
  };
}

function assertExpectedVersion(instance, detail = {}, options = {}, env = process.env) {
  const wantedCommit = expectedCommit(options, env);
  if (wantedCommit && !commitsMatch(detail.commit, wantedCommit)) {
    throw new Error(`release_commit_mismatch:${wantedCommit}:${detail.commit || "missing"}`);
  }
  const wantedReleaseId = clean(options.expectedReleaseId || options.releaseId || "");
  if (wantedReleaseId && clean(detail.releaseId) !== wantedReleaseId) {
    throw new Error(`release_id_mismatch:${wantedReleaseId}:${clean(detail.releaseId) || "missing"}`);
  }
  return connectedResult(instance, detail);
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
  const detail = await verifyVersionProbe(instance, options);
  if (!releaseInstanceRequiresWhatsApp(instance)) return assertExpectedVersion(instance, { method: "http", ...detail }, options);
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
  return assertExpectedVersion(instance, {
    method: "http",
    ...detail,
    whatsapp: clean(whatsapp.payload?.state || whatsapp.payload?.status || "ready"),
  }, options);
}

async function verifyVersionProbe(instance, options = {}) {
  const timeoutMs = options.connectivityTimeoutMs || options.timeoutMs || 5000;
  const version = await fetchJsonWithTimeout(instance.versionUrl, {
    fetchImpl: options.fetchImpl,
    timeoutMs,
  });
  if (!version.ok) throw new Error(version.error || "version_probe_failed");
  return versionDetail(version.payload);
}

async function verifyCommandConnectivity(instance, options = {}, env = process.env) {
  const outcome = await spawnConnectivityCommand(instance, options, env);
  if (outcome.code !== 0) throw new Error(`connectivity_command_failed:${outcome.code}`);
  if (!clean(instance.versionUrl)) {
    return connectedResult(instance, { method: "command", code: outcome.code, signal: outcome.signal });
  }
  const detail = await verifyVersionProbe(instance, options);
  const verified = assertExpectedVersion(instance, { method: "command+http", ...detail }, options, env);
  return {
    ...verified,
    code: outcome.code,
    signal: outcome.signal,
  };
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
