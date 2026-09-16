import crypto from "node:crypto";
import { publicWhatsAppGroupCreateFailure } from "./whatsapp-group-create-evidence.js";

const activeLocks = new Map();

function clean(value = "") {
  return String(value || "").trim();
}

function now() {
  return new Date().toISOString();
}

export function whatsappGroupProvisioningOperation(thread = {}) {
  const operation = thread.whatsappGroupProvisioning;
  return operation && typeof operation === "object" && !Array.isArray(operation) ? operation : null;
}

export function newWhatsAppGroupProvisioningOperation({ thread = {}, principalId = "", instanceId = "", accountId = "" } = {}) {
  const timestamp = now();
  return {
    id: `wgp_${crypto.randomUUID()}`,
    operation: "whatsapp_group_provisioning",
    threadId: clean(thread.id),
    principalId: clean(principalId),
    instanceId: clean(instanceId),
    accountId: clean(accountId),
    state: "prepared",
    stage: "prepared",
    externalOutcome: "not_dispatched",
    groupId: "",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function patchWhatsAppGroupProvisioningOperation(operation = {}, patch = {}) {
  return {
    ...operation,
    ...patch,
    id: clean(operation.id),
    operation: "whatsapp_group_provisioning",
    updatedAt: now(),
  };
}

export function publicWhatsAppGroupProvisioningOperation(operation = {}) {
  const failure = publicWhatsAppGroupCreateFailure(operation.failure);
  return {
    operationId: clean(operation.id),
    operation: "whatsapp_group_provisioning",
    stage: clean(operation.stage),
    state: clean(operation.state),
    externalOutcome: clean(operation.externalOutcome),
    retryable: operation.retryable === true,
    nextAction: clean(operation.nextAction),
    ...(failure ? { failure } : {}),
  };
}

export async function withWhatsAppGroupProvisioningLock(key, fn) {
  const normalized = clean(key);
  const previous = activeLocks.get(normalized) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  activeLocks.set(normalized, queued);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (activeLocks.get(normalized) === queued) activeLocks.delete(normalized);
  }
}
