import { getThread, updateThread } from "../../core/src/threads.js";
import { withCanonicalPublicReferenceLock } from "../../core/src/canonical-public-reference-lock.js";
import { patchWhatsAppGroupProvisioningOperation, whatsappGroupProvisioningOperation } from "./whatsapp-group-provisioning.js";

function clean(value = "") {
  return String(value || "").trim();
}

function completeGroupId(value = "") {
  const id = clean(value);
  return /^[A-Za-z0-9._-]{1,180}@g\.us$/i.test(id) ? id : "";
}

export function whatsappGroupProvisioningContextMatches(operation = {}, context = {}, threadId = "") {
  return clean(operation.threadId) === clean(threadId) &&
    clean(operation.principalId) === clean(context.principalId) &&
    clean(operation.instanceId) === clean(context.instanceId) &&
    clean(operation.accountId) === clean(context.accountId);
}

export async function transitionWhatsAppGroupProvisioning({
  threadId = "",
  operationId = "",
  context = {},
  dependencies = {},
  env = process.env,
  transition,
} = {}) {
  return withCanonicalPublicReferenceLock(async () => {
    const readThread = dependencies.getThread || getThread;
    const persistThread = dependencies.updateThread || updateThread;
    const current = await readThread(threadId, env);
    const operation = whatsappGroupProvisioningOperation(current || {});
    if (!current || !operation || clean(operation.id) !== clean(operationId)) {
      return { accepted: false, reason: "operation_lost", current, operation };
    }
    if (!whatsappGroupProvisioningContextMatches(operation, context, current.id)) {
      return { accepted: false, reason: "context_mismatch", current, operation };
    }
    const change = await transition({ current, operation });
    if (!change || typeof change !== "object") return { accepted: true, current, operation };
    const requested = change.operation && typeof change.operation === "object"
      ? change.operation
      : patchWhatsAppGroupProvisioningOperation(operation, change.operationPatch || {});
    const next = {
      ...requested,
      id: operation.id,
      operation: "whatsapp_group_provisioning",
      threadId: operation.threadId,
      principalId: operation.principalId,
      instanceId: operation.instanceId,
      accountId: operation.accountId,
    };
    const knownGroupId = completeGroupId(operation.groupId);
    const nextGroupId = completeGroupId(next.groupId);
    if (knownGroupId && (nextGroupId !== knownGroupId || ["prepared", "dispatched", "outcome_unknown", "rejected"].includes(clean(next.state)))) {
      return { accepted: false, reason: "known_group_preserved", current, operation };
    }
    const updated = await persistThread(current.id, {
      ...(change.threadPatch && typeof change.threadPatch === "object" ? change.threadPatch : {}),
      whatsappGroupProvisioning: next,
    }, env);
    return { accepted: true, current: updated, operation: next };
  }, env);
}
