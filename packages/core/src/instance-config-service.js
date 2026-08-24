import { randomUUID } from "node:crypto";
import { applyInstanceConfigPatch, changedInstanceConfigPointers, instanceConfigFieldIsSecret } from "../../shared/src/instance-config-schema.js";
import {
  compareAndSwapInstanceConfig,
  instanceConfigExists,
  readInstanceConfig,
  readInstanceStatus,
  writeInstanceStatus,
} from "../../storage/src/instance-config-repository.js";
import { appendEvent } from "../../storage/src/store.js";
import { readInstanceIdentity } from "./instance-identity.js";
import { readRuntimeSettings, writeRuntimeSettings } from "./runtime-settings.js";

function clean(value = "") {
  return String(value || "").trim();
}

function plainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function nonEmptyObject(value) {
  return plainObject(value) && Object.keys(value).length > 0;
}

async function localIdentity(env = process.env) {
  const identity = await readInstanceIdentity(env);
  if (!identity?.internalInstanceId) {
    throw Object.assign(new Error("instance_identity_required"), { statusCode: 503 });
  }
  return identity;
}

function desiredRuntimeProjection(config = {}) {
  const runtime = plainObject(config.runtime) ? config.runtime : {};
  return {
    ...(runtime.codex ? { codex: runtime.codex } : {}),
    ...(runtime.intervention ? { intervention: runtime.intervention } : {}),
    ...(nonEmptyObject(config.connectors) ? { connectors: config.connectors } : {}),
    ...(nonEmptyObject(config.desktops) ? { desktops: config.desktops } : {}),
  };
}

function valueContains(observed, desired) {
  if (Array.isArray(desired)) return Array.isArray(observed) && observed.length === desired.length && desired.every((entry, index) => valueContains(observed[index], entry));
  if (!plainObject(desired)) return JSON.stringify(observed) === JSON.stringify(desired);
  if (!plainObject(observed)) return false;
  return Object.entries(desired).every(([key, value]) => valueContains(observed[key], value));
}

function unsupportedSections(config = {}) {
  return ["capabilities", "mailboxes"].filter((section) => nonEmptyObject(config[section]));
}

function actorSummary(actor = {}) {
  return {
    kind: clean(actor.kind || "user"),
    userId: clean(actor.userId),
    role: clean(actor.role),
    source: clean(actor.source),
  };
}

function safeImportedValue(value) {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map(safeImportedValue).filter((entry) => entry !== undefined);
  if (!plainObject(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key, entry]) => !instanceConfigFieldIsSecret(key) && entry !== undefined)
    .map(([key, entry]) => [key, safeImportedValue(entry)]));
}

function importedRuntimeConfig(settings = {}, now = new Date().toISOString()) {
  const codex = plainObject(settings.codex) ? settings.codex : {};
  const desktops = plainObject(settings.desktops) ? settings.desktops : {};
  const connectors = plainObject(settings.connectors) ? settings.connectors : {};
  return {
    metadata: {
      migration: {
        source: "runtime-settings",
        importedAt: now,
      },
    },
    runtime: safeImportedValue({
      codex: {
        sandbox: codex.sandbox,
        approvalPolicy: codex.approvalPolicy,
        bypassApprovalsAndSandbox: codex.bypassApprovalsAndSandbox,
        permissionPrompts: codex.permissionPrompts,
      },
      intervention: settings.intervention,
    }),
    connectors: safeImportedValue(Object.fromEntries(Object.entries(connectors).filter(([key]) => key !== "mcp"))),
    desktops: safeImportedValue({
      enabled: desktops.enabled,
      provisioned: desktops.provisioned,
      mode: desktops.mode,
      default: desktops.default,
      gmailAuth: desktops.gmailAuth,
      manualIntervention: desktops.manualIntervention,
      items: Array.isArray(desktops.items) ? desktops.items.map((item) => ({
        slug: item?.slug,
        id: item?.id,
        label: item?.label,
        type: item?.type,
        connector: item?.connector,
        purpose: item?.purpose,
        enabled: item?.enabled,
      })) : [],
    }),
  };
}

async function ensureLocalInstanceConfig(identity, env = process.env) {
  if (await instanceConfigExists(identity.internalInstanceId, env)) {
    return readInstanceConfig(identity.internalInstanceId, env);
  }
  if (["0", "false", "no", "off"].includes(clean(env.ORKESTR_INSTANCE_CONFIG_AUTO_IMPORT).toLowerCase())) {
    return readInstanceConfig(identity.internalInstanceId, env);
  }
  const settings = await readRuntimeSettings(env);
  try {
    const result = await compareAndSwapInstanceConfig(
      identity.internalInstanceId,
      0,
      (current) => applyInstanceConfigPatch(current, importedRuntimeConfig(settings)),
      env,
    );
    await appendEvent({
      type: "instance_config_imported",
      instanceId: identity.internalInstanceId,
      instancePublicRef: identity.publicRef || "",
      source: "runtime-settings",
      generation: result.next.generation,
      changedPointers: changedInstanceConfigPointers(result.current, result.next),
    }, env);
    return result.next;
  } catch (error) {
    if (error?.message !== "instance_config_generation_conflict") throw error;
    return readInstanceConfig(identity.internalInstanceId, env);
  }
}

export async function getLocalInstanceContext(env = process.env) {
  const identity = await localIdentity(env);
  return {
    publicRef: identity.publicRef || "",
    canonicalPath: identity.publicRef ? `/instance/${encodeURIComponent(identity.publicRef)}/` : "",
  };
}

export async function getLocalInstanceConfig(env = process.env) {
  const identity = await localIdentity(env);
  const config = await ensureLocalInstanceConfig(identity, env);
  return { identity, config };
}

export async function observeLocalInstanceConfig(env = process.env) {
  const identity = await localIdentity(env);
  const [config, runtimeSettings, previous] = await Promise.all([
    ensureLocalInstanceConfig(identity, env),
    readRuntimeSettings(env),
    readInstanceStatus(identity.internalInstanceId, env),
  ]);
  const projection = desiredRuntimeProjection(config);
  const unsupported = unsupportedSections(config);
  const runtimeMatches = valueContains(runtimeSettings, projection);
  const ready = runtimeMatches && unsupported.length === 0;
  const now = new Date().toISOString();
  const status = {
    schemaVersion: 1,
    instancePublicRef: identity.publicRef || "",
    desiredGeneration: config.generation,
    observedGeneration: ready ? config.generation : Number(previous?.observedGeneration || 0),
    state: ready ? "Ready" : runtimeMatches ? "NeedsAttention" : "Degraded",
    generatedAt: now,
    lastSuccessfulReconciliationAt: ready ? now : clean(previous?.lastSuccessfulReconciliationAt),
    conditions: [
      {
        code: runtimeMatches ? "runtime_projection_current" : "runtime_projection_drift",
        status: runtimeMatches ? "true" : "false",
        subsystem: "runtime",
      },
      ...unsupported.map((section) => ({
        code: "reconciler_adapter_pending",
        status: "false",
        subsystem: section,
      })),
    ],
    subsystems: {
      runtime: { state: runtimeMatches ? "Ready" : "Degraded" },
      capabilities: { state: unsupported.includes("capabilities") ? "NeedsAttention" : "Disabled" },
      connectors: { state: runtimeMatches ? "Ready" : "Degraded" },
      desktops: { state: runtimeMatches ? "Ready" : "Degraded" },
      mailboxes: { state: unsupported.includes("mailboxes") ? "NeedsAttention" : "Disabled" },
    },
  };
  await writeInstanceStatus(identity.internalInstanceId, status, env);
  return { identity, config, status };
}

export async function reconcileLocalInstanceConfig(config, env = process.env) {
  const projection = desiredRuntimeProjection(config);
  if (Object.keys(projection).length) await writeRuntimeSettings(projection, env);
  return observeLocalInstanceConfig(env);
}

export async function patchLocalInstanceConfig({ expectedGeneration = -1, patch = {}, actor = {}, requestId = "" } = {}, env = process.env) {
  const identity = await localIdentity(env);
  await ensureLocalInstanceConfig(identity, env);
  const result = await compareAndSwapInstanceConfig(
    identity.internalInstanceId,
    expectedGeneration,
    (current) => applyInstanceConfigPatch(current, patch),
    env,
  );
  let reconciliation = null;
  let reconciliationError = "";
  try {
    reconciliation = await reconcileLocalInstanceConfig(result.next, env);
  } catch (error) {
    reconciliationError = clean(error?.message || error || "instance_reconciliation_failed");
  }
  await appendEvent({
    type: "instance_config_updated",
    instanceId: identity.internalInstanceId,
    instancePublicRef: identity.publicRef || "",
    requestId: clean(requestId) || randomUUID(),
    actor: actorSummary(actor),
    priorGeneration: result.current.generation,
    generation: result.next.generation,
    changedPointers: changedInstanceConfigPointers(result.current, result.next),
    reconciliation: reconciliationError ? "failed" : reconciliation?.status?.state || "pending",
    ...(reconciliationError ? { errorCode: reconciliationError } : {}),
  }, env);
  return {
    identity,
    config: result.next,
    status: reconciliation?.status || await readInstanceStatus(identity.internalInstanceId, env),
    reconciliationError,
  };
}
