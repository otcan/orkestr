import { spawn as defaultSpawn } from "node:child_process";
import {
  releaseInstanceRequiredWhatsAppAccounts,
  releaseInstanceRequiresWhatsApp,
} from "./release-whatsapp-policy.js";

function nowIso() {
  return new Date().toISOString();
}

function clean(value = "") {
  return String(value || "").trim();
}

export function releaseCommandConfigured(command) {
  return Array.isArray(command) ? command.length > 0 : Boolean(clean(command));
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

export async function deployReleaseInstancesWithResolver({ listReleaseInstances, normalizeReleaseInstance }, options = {}, env = process.env) {
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
    if (!releaseCommandConfigured(instance.deployCommand)) {
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
