import { spawn as defaultSpawn } from "node:child_process";
import { normalizeReleaseInstance } from "./release-instances.js";
import {
  firstList,
  releaseInstanceRequiredWhatsAppAccounts,
  releaseInstanceRequiresWhatsApp,
} from "./release-whatsapp-policy.js";

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
    requiredWhatsAppAccounts: releaseInstanceRequiredWhatsAppAccounts(instance, options, env).join(","),
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

function spawnReleaseConnectivityCommand(command, instance, options = {}, env = process.env, extraEnv = {}, extraContext = {}) {
  const spawnImpl = options.spawnImpl || defaultSpawn;
  const context = { ...deployContext(instance, options, env), ...extraContext };
  const commandValue = interpolatedCommand(command, context);
  const requiredWhatsAppAccounts = releaseInstanceRequiredWhatsAppAccounts(instance, options, env).join(",");
  const childEnv = {
    ...process.env,
    ...env,
    ...options.env,
    ...instance.commandEnv,
    ORKESTR_RELEASE_INSTANCE_ID: instance.id,
    ORKESTR_DEPLOY_REF: context.ref,
    ORKESTR_UPDATE_REF: context.ref,
    ORKESTR_DEPLOY_CHANNEL: context.channel,
    ...(requiredWhatsAppAccounts ? { ORKESTR_RELEASE_REQUIRED_WHATSAPP_ACCOUNTS: requiredWhatsAppAccounts } : {}),
    ...extraEnv,
  };
  if (!requiredWhatsAppAccounts && !releaseInstanceRequiresWhatsApp(instance)) {
    delete childEnv.ORKESTR_RELEASE_REQUIRED_WHATSAPP_ACCOUNTS;
    delete childEnv.ORKESTR_REQUIRED_WHATSAPP_ACCOUNTS;
  }
  const cwd = instance.cwd || options.cwd || process.cwd();
  const child = Array.isArray(commandValue)
    ? spawnImpl(commandValue[0], commandValue.slice(1), { stdio: options.stdio || "inherit", env: childEnv, cwd })
    : spawnImpl("sh", ["-lc", commandValue], { stdio: options.stdio || "inherit", env: childEnv, cwd });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), signal: signal || "" }));
  });
}

function spawnConnectivityCommand(instance, options = {}, env = process.env) {
  return spawnReleaseConnectivityCommand(instance.connectivityCommand, instance, options, env, {
    ORKESTR_RELEASE_CONNECTIVITY_CHECK: "1",
  });
}

function connectivityRecoveryCommand(instance = {}, options = {}, env = process.env) {
  if (commandConfigured(instance.connectivityRecoveryCommand)) return instance.connectivityRecoveryCommand;
  return options.connectivityRecoveryCommand ??
    options.recoveryCommand ??
    env.ORKESTR_RELEASE_CONNECTIVITY_RECOVERY_COMMAND ??
    [];
}

async function runConnectivityRecovery(instanceInput, result = {}, attempt = 1, options = {}, env = process.env) {
  const instance = normalizeReleaseInstance(instanceInput, env);
  const command = connectivityRecoveryCommand(instance, options, env);
  if (!commandConfigured(command)) return null;
  try {
    const outcome = await spawnReleaseConnectivityCommand(command, instance, options, env, {
      ORKESTR_RELEASE_CONNECTIVITY_RECOVERY: "1",
      ORKESTR_RELEASE_CONNECTIVITY_CHECK: "0",
      ORKESTR_RELEASE_CONNECTIVITY_ATTEMPT: String(attempt),
      ORKESTR_RELEASE_CONNECTIVITY_NEXT_ATTEMPT: String(attempt + 1),
      ORKESTR_RELEASE_CONNECTIVITY_ERROR: clean(result.error || ""),
    }, {
      attempt: String(attempt),
      nextAttempt: String(attempt + 1),
      error: clean(result.error || ""),
    });
    return {
      status: outcome.code === 0 ? "recovered" : "failed",
      code: outcome.code,
      signal: outcome.signal,
    };
  } catch (error) {
    return {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
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

function positiveInteger(value, fallback, minimum = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.floor(parsed)) : fallback;
}

function releaseConnectivityAttempts(options = {}, env = process.env) {
  return positiveInteger(
    options.connectivityAttempts ?? options.attempts ?? env.ORKESTR_RELEASE_CONNECTIVITY_ATTEMPTS,
    1,
  );
}

function releaseConnectivityRetryDelayMs(options = {}, env = process.env) {
  return positiveInteger(
    options.connectivityRetryDelayMs ?? options.retryDelayMs ?? env.ORKESTR_RELEASE_CONNECTIVITY_RETRY_DELAY_MS,
    0,
    0,
  );
}

function releaseConnectivityConcurrency(options = {}, env = process.env) {
  return positiveInteger(
    options.connectivityConcurrency ??
      options.concurrency ??
      env.ORKESTR_RELEASE_CONNECTIVITY_CONCURRENCY ??
      env.ORKESTR_RELEASE_FANOUT_CONCURRENCY,
    4,
  );
}

async function mapWithConcurrency(items = [], concurrency = 1, task) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await task(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(positiveInteger(concurrency, 1), items.length) }, () => worker()));
  return results;
}

function wait(ms) {
  const delay = Math.max(0, Number(ms) || 0);
  if (!delay) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function retryableConnectivityFailure(result = {}) {
  if (result.status !== "connection_failed") return false;
  const error = cleanLower(result.error);
  if (!error) return false;
  if (error.includes("release_commit_mismatch") || error.includes("release_id_mismatch")) return false;
  return error.includes("connectivity_command_failed") ||
    error.includes("whatsapp_") ||
    error.includes("version_probe_failed") ||
    error.includes("fetch") ||
    error.includes("timeout") ||
    error.includes("econnreset") ||
    error.includes("econnrefused");
}

function whatsappAccounts(payload = {}) {
  const health = payload.health && typeof payload.health === "object" ? payload.health : {};
  const rows = [
    ...(Array.isArray(payload.accounts) ? payload.accounts : []),
    ...(Array.isArray(health.accounts) ? health.accounts : []),
  ];
  const seen = new Set();
  return rows.filter((account) => {
    const key = clean(account?.accountId || account?.id || account?.label || JSON.stringify(account || {}));
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function whatsappAccountReady(account = {}) {
  if (account.ready === true || account.authenticated === true || account.clientReady === true) return true;
  return ["ready", "connected", "paired"].includes(cleanLower(account.state || account.status));
}

function whatsappAccountNames(account = {}) {
  return [
    account.accountId,
    account.id,
    account.label,
    account.runtimeAccountId,
    ...(Array.isArray(account.aliases) ? account.aliases : []),
    ...(Array.isArray(account.legacyRoleAliases) ? account.legacyRoleAliases : []),
  ].map((value) => cleanLower(value)).filter(Boolean);
}

function whatsappStatusCheck(payload = {}, requiredAccounts = []) {
  const required = firstList(requiredAccounts).map((value) => cleanLower(value));
  const accounts = whatsappAccounts(payload);
  const readyAccounts = accounts.filter((account) => whatsappAccountReady(account));
  if (required.length) {
    const missing = required.filter((accountId) => !readyAccounts.some((account) => whatsappAccountNames(account).includes(accountId)));
    return {
      ok: missing.length === 0,
      missing,
      readyAccounts: readyAccounts.map((account) => clean(account.accountId || account.id || account.label)).filter(Boolean),
    };
  }
  const state = cleanLower(payload.state || payload.status);
  if (["paired", "connected", "ready"].includes(state)) return { ok: true, missing: [], readyAccounts: [] };
  const health = payload.health && typeof payload.health === "object" ? payload.health : {};
  if (health.ready === true || health.clientReady === true || health.authenticated === true) return { ok: true, missing: [], readyAccounts: [] };
  return {
    ok: readyAccounts.length > 0,
    missing: [],
    readyAccounts: readyAccounts.map((account) => clean(account.accountId || account.id || account.label)).filter(Boolean),
  };
}

async function verifyHttpConnectivity(instance, options = {}, env = process.env) {
  const timeoutMs = options.connectivityTimeoutMs || options.timeoutMs || 5000;
  const detail = await verifyVersionProbe(instance, options);
  if (!releaseInstanceRequiresWhatsApp(instance)) return assertExpectedVersion(instance, { method: "http", ...detail }, options, env);
  const whatsappUrl = joinUrl(instance.baseUrl, "/api/connectors/whatsapp/status");
  if (!whatsappUrl) throw new Error("whatsapp_status_url_missing");
  const whatsapp = await fetchJsonWithTimeout(whatsappUrl, {
    fetchImpl: options.fetchImpl,
    timeoutMs,
  });
  if (!whatsapp.ok) throw new Error(`whatsapp_status_failed:${whatsapp.error || "unknown"}`);
  const requiredAccounts = releaseInstanceRequiredWhatsAppAccounts(instance, options, env);
  const check = whatsappStatusCheck(whatsapp.payload, requiredAccounts);
  if (!check.ok) {
    if (requiredAccounts.length) throw new Error(`whatsapp_required_accounts_not_ready:${check.missing.join(",") || "unknown"}`);
    throw new Error(`whatsapp_not_ready:${clean(whatsapp.payload?.state || whatsapp.payload?.status || "unknown")}`);
  }
  const verified = assertExpectedVersion(instance, {
    method: "http",
    ...detail,
    whatsapp: clean(whatsapp.payload?.state || whatsapp.payload?.status || "ready"),
  }, options, env);
  return {
    ...verified,
    ...(requiredAccounts.length ? { whatsappRequiredAccounts: requiredAccounts } : {}),
    ...(check.readyAccounts.length ? { whatsappReadyAccounts: check.readyAccounts } : {}),
  };
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
    return await verifyHttpConnectivity(instance, options, env);
  } catch (error) {
    return connectionFailedResult(instance, error, {
      method: commandConfigured(instance.connectivityCommand) ? "command" : "http",
    });
  }
}

async function verifyInstanceConnectivityWithRetries(instanceInput, options = {}, env = process.env) {
  const attempts = releaseConnectivityAttempts(options, env);
  const retryDelayMs = releaseConnectivityRetryDelayMs(options, env);
  let result = null;
  let recoveryAttempts = 0;
  let lastRecoveryError = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = await verifyInstanceConnectivity(instanceInput, options, env);
    if (result.status !== "connection_failed" || attempt >= attempts || !retryableConnectivityFailure(result)) {
      const detail = {};
      if (attempt > 1) detail.attempts = attempt;
      if (recoveryAttempts) detail.recoveryAttempts = recoveryAttempts;
      if (lastRecoveryError) detail.lastRecoveryError = lastRecoveryError;
      return Object.keys(detail).length ? { ...result, ...detail } : result;
    }
    const recovery = await runConnectivityRecovery(instanceInput, result, attempt, options, env);
    if (recovery) {
      recoveryAttempts += 1;
      if (recovery.status === "failed") {
        lastRecoveryError = recovery.error || `recovery_command_failed:${recovery.code ?? "unknown"}`;
      } else {
        lastRecoveryError = "";
      }
    }
    await wait(retryDelayMs);
  }
  return result;
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
  const results = await mapWithConcurrency(
    targets,
    releaseConnectivityConcurrency(options, env),
    (instance) => verifyInstanceConnectivityWithRetries(instance, options, env),
  );
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
